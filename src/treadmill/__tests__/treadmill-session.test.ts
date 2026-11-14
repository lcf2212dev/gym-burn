import {
  BleUnavailableError,
  type BleConnection,
  type BleSubscription,
  type BleTransport,
  type CharacteristicInfo,
  type ScannedDevice,
} from '@/ble/transport';
import {
  ControlPointOp,
  ControlPointResult,
  DEVICE_INFORMATION_SERVICE,
  FTMS,
  bytesToHex,
  hexToBytes,
  encodePause,
  encodeRequestControl,
  encodeSetTargetInclination,
  encodeSetTargetSpeed,
  encodeStartOrResume,
  encodeStop,
  sameUuid,
  uuid16,
} from '@/ftms';
import { parseGizwitsFrame } from '@/gizwits/frame';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
  type SimulatedTreadmillOptions,
} from '@/simulator/simulated-treadmill';
import { buildTreadmillData } from '@/simulator/wire';

import { TreadmillSession, type TreadmillSessionOptions } from '../treadmill-session';
import type { TreadmillSnapshot } from '../types';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const R = ControlPointResult;

// UUIDs do canal proprietário 0xFFF0 (o mesmo do app AFG Pro).
const VENDOR_SERVICE = uuid16(0xfff0);
const VENDOR_FFF1 = uuid16(0xfff1);
const VENDOR_FFF3 = uuid16(0xfff3);
const VENDOR_FFF4 = uuid16(0xfff4);

// Comandos em hexadecimal, como aparecem no log e no transporte.
const REQUEST_CONTROL = bytesToHex(encodeRequestControl());
const START = bytesToHex(encodeStartOrResume());
const PAUSE = bytesToHex(encodePause());
const STOP = bytesToHex(encodeStop());
const speedCmd = (kmh: number) => bytesToHex(encodeSetTargetSpeed(kmh));
const inclinationCmd = (percent: number) => bytesToHex(encodeSetTargetInclination(percent));

const SET_SPEED_OP = bytesToHex(Uint8Array.of(ControlPointOp.SetTargetSpeed)).slice(0, 2);
const isSpeedWrite = (hex: string) => hex.startsWith(SET_SPEED_OP);
const isInclinationWrite = (hex: string) =>
  hex.startsWith(bytesToHex(Uint8Array.of(ControlPointOp.SetTargetInclination)).slice(0, 2));

// --- Transporte de teste ------------------------------------------------------
//
// O simulador faz o papel da esteira; esta camada fina por cima dele registra o
// que a sessão escreve e permite provocar o que o simulador não cobre (escrita
// que falha, indication adulterada, Machine Status que não chega...).

interface Hooks {
  prepare?: () => Promise<void>;
  connect?: (open: () => Promise<BleConnection>) => Promise<BleConnection>;
  getCharacteristics?: (
    open: () => Promise<CharacteristicInfo[]>,
    service: string,
  ) => Promise<CharacteristicInfo[]>;
  /** Intercepta a escrita no Control Point; `forward` entrega ao simulador. */
  write?: (data: Uint8Array, forward: () => Promise<void>) => Promise<void>;
  /** Não assina o Fitness Machine Status: a esteira "não avisa" nada. */
  suppressMachineStatus?: boolean;
  /** Troca ou engole (`null`) cada indication do Control Point. */
  indication?: (data: Uint8Array) => Uint8Array | null;
  /** Troca ou engole (`null`) cada notificação de Treadmill Data. */
  treadmillData?: (data: Uint8Array) => Uint8Array | null;
  /**
   * Faz o aparelho expor o Device Information Service (0x180A) com estas
   * características (UUID → valor). Um `Error` faz a leitura falhar; uma função
   * dá o resultado da leitura (pode nunca resolver); `null` expõe a
   * característica sem a propriedade Read. Sem isso o aparelho não tem o
   * serviço, como o simulador.
   *
   * Como no transporte real, listar as características vem do cache e funciona
   * com o link fechado, mas ler com o link fechado falha.
   */
  deviceInformation?: Record<string, Uint8Array | Error | null | (() => Promise<Uint8Array>)>;
  /**
   * `getCharacteristics` do FTMS responde do cache feito na conexão, mesmo com o
   * link fechado, como o transporte real (`info.characteristics`). O simulador
   * lança nesse caso, o que esconde o que a sessão faria depois de a conexão acabar.
   */
  cacheCharacteristics?: boolean;
  /**
   * Canal proprietário 0xFFF0: faz o aparelho expor `FFF1`/`FFF3`/`FFF4` e
   * responde à escrita no `FFF3` entregando `reply(...)` no `FFF4` assinado.
   * Sem isso o simulador não tem o serviço, como a esteira de teste.
   */
  vendor?: {
    reply?: (data: Uint8Array, service: string, uuid: string) => Uint8Array | null;
  };
}

interface Rig {
  sim: SimulatedTreadmillTransport;
  session: TreadmillSession;
  hooks: Hooks;
  /** Tudo o que a sessão tentou escrever no Control Point, em hexadecimal. */
  writes: string[];
  /** Os UUIDs que a sessão tentou ler no Device Information, na ordem. */
  deviceInformationReads: string[];
  /** Quantas vezes a sessão chamou `disconnect()` na conexão. */
  disconnects: { count: number };
  /** Entrega uma indication ao ouvinte da sessão, sem passar pelo simulador. */
  deliverIndication: (data: Uint8Array) => void;
}

function createRig(
  options: SimulatedTreadmillOptions = {},
  sessionOptions: Partial<TreadmillSessionOptions> = {},
): Rig {
  const sim = new SimulatedTreadmillTransport(options);
  const hooks: Hooks = {};
  const writes: string[] = [];
  const deviceInformationReads: string[] = [];
  const disconnects = { count: 0 };
  let sink: ((data: Uint8Array) => void) | null = null;
  let vendorSink: ((data: Uint8Array) => void) | null = null;

  const tap = (inner: BleConnection, cachedFtms: CharacteristicInfo[] | null): BleConnection => {
    const base: BleConnection = {
      getServices: () => inner.getServices(),
      deviceId: inner.deviceId,
      name: inner.name,
      getCharacteristics: async (service) => {
        if (hooks.vendor && sameUuid(service, VENDOR_SERVICE)) {
          return [
            { uuid: VENDOR_FFF1, canRead: true, canWrite: false, canNotify: false, canIndicate: false },
            { uuid: VENDOR_FFF3, canRead: false, canWrite: true, canNotify: false, canIndicate: false },
            { uuid: VENDOR_FFF4, canRead: false, canWrite: false, canNotify: true, canIndicate: false },
          ] satisfies CharacteristicInfo[];
        }
        const open = () =>
          cachedFtms && sameUuid(service, FTMS.service)
            ? Promise.resolve(cachedFtms)
            : inner.getCharacteristics(service);
        if (hooks.getCharacteristics) {
          return hooks.getCharacteristics(open, service);
        }
        if (hooks.deviceInformation && sameUuid(service, DEVICE_INFORMATION_SERVICE)) {
          return Object.entries(hooks.deviceInformation).map(([uuid, value]) => ({
            uuid,
            canRead: value !== null,
            canWrite: false,
            canNotify: false,
            canIndicate: false,
          }));
        }
        return open();
      },
      read: async (service, uuid) => {
        if (hooks.deviceInformation && sameUuid(service, DEVICE_INFORMATION_SERVICE)) {
          deviceInformationReads.push(uuid);
          // Link fechado: o simulador recusa, como o BleManager faria.
          await inner.getCharacteristics(FTMS.service);
          const entry = Object.entries(hooks.deviceInformation).find(([key]) =>
            sameUuid(key, uuid),
          );
          const value = entry?.[1];
          if (value === undefined || value === null) {
            throw new Error(`Característica ${uuid} não existe ou não permite leitura`);
          }
          if (value instanceof Error) throw value;
          return typeof value === 'function' ? value() : value;
        }
        return inner.read(service, uuid);
      },
      write: async (service, uuid, data) => {
        writes.push(bytesToHex(data));
        if (
          hooks.vendor &&
          sameUuid(service, VENDOR_SERVICE) &&
          (sameUuid(uuid, VENDOR_FFF3) || sameUuid(uuid, VENDOR_FFF1))
        ) {
          // O módulo responde no FFF4 (o mesmo callback da assinatura abaixo).
          const reply = hooks.vendor.reply ? hooks.vendor.reply(data, service, uuid) : null;
          if (reply) vendorSink?.(reply);
          return;
        }
        const forward = () => inner.write(service, uuid, data);
        if (hooks.write) {
          await hooks.write(data, forward);
        } else {
          await forward();
        }
      },
      subscribe: async (service, uuid, onValue) => {
        if (hooks.vendor && sameUuid(service, VENDOR_SERVICE) && sameUuid(uuid, VENDOR_FFF4)) {
          vendorSink = onValue;
          return { remove: () => { vendorSink = null; } } satisfies BleSubscription;
        }
        if (sameUuid(uuid, FTMS.machineStatus) && hooks.suppressMachineStatus) {
          return { remove: () => undefined } satisfies BleSubscription;
        }
        if (sameUuid(uuid, FTMS.controlPoint)) {
          sink = onValue;
          return inner.subscribe(service, uuid, (data) => {
            const out = hooks.indication ? hooks.indication(data) : data;
            if (out) onValue(out);
          });
        }
        if (sameUuid(uuid, FTMS.treadmillData)) {
          return inner.subscribe(service, uuid, (data) => {
            const out = hooks.treadmillData ? hooks.treadmillData(data) : data;
            if (out) onValue(out);
          });
        }
        return inner.subscribe(service, uuid, onValue);
      },
      onDisconnect: (listener) => inner.onDisconnect(listener),
      disconnect: async () => {
        disconnects.count++;
        await inner.disconnect();
      },
    };
    return base;
  };

  const transport: BleTransport = {
    prepare: () => (hooks.prepare ? hooks.prepare() : sim.prepare()),
    scan: (onDevice, onError) => sim.scan(onDevice, onError),
    connect: async (deviceId) => {
      const open = () => sim.connect(deviceId);
      const inner = hooks.connect ? await hooks.connect(open) : await open();
      const cachedFtms = hooks.cacheCharacteristics
        ? await inner.getCharacteristics(FTMS.service)
        : null;
      return tap(inner, cachedFtms);
    },
  };

  const session = new TreadmillSession({
    ble: transport,
    demo: { transport, deviceId: SIMULATED_DEVICE_ID },
    responseTimeoutMs: 3000,
    unconfirmedGraceMs: 500,
    controlRetryDelayMs: 500,
    scanTimeoutMs: 5000,
    ...sessionOptions,
  });

  return {
    sim,
    session,
    hooks,
    writes,
    deviceInformationReads,
    disconnects,
    deliverIndication: (data) => sink?.(data),
  };
}

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

const snap = (rig: Rig): TreadmillSnapshot => rig.session.getSnapshot();

/** Registra os valores distintos que `pick` assume, na ordem. */
function track<T>(rig: Rig, pick: (snapshot: TreadmillSnapshot) => T): T[] {
  const seen = [pick(snap(rig))];
  rig.session.subscribe(() => {
    const value = pick(snap(rig));
    if (value !== seen[seen.length - 1]) seen.push(value);
  });
  return seen;
}

/** Conecta à esteira simulada e espera a sessão ficar pronta. */
async function connect(rig: Rig): Promise<void> {
  rig.session.actions.connect(SIMULATED_DEVICE_ID);
  await advance(200);
  expect(snap(rig).phase).toBe('connected');
  // O usuário confere no painel que a esteira é a dele; sem isso nada é comandado.
  rig.session.actions.confirmIdentity();
}

/** Conecta, inicia a lona e espera a primeira amostra de velocidade (0,8 km/h). */
async function startBelt(rig: Rig): Promise<void> {
  await connect(rig);
  rig.session.actions.start();
  await advance(1100);
  expect(snap(rig).belt).toBe('running');
  expect(snap(rig).metrics.speedKmh).toBeCloseTo(0.8, 5);
  expect(snap(rig).control).toBe('granted');
}

/** Faz a indication de um op code voltar com outro result code. */
function rewriteResult(rig: Rig, opCode: number, resultCode: number): void {
  rig.hooks.indication = (data) =>
    data[1] === opCode ? Uint8Array.of(ControlPointOp.ResponseCode, opCode, resultCode) : data;
}

const speedWrites = (rig: Rig) => rig.writes.filter(isSpeedWrite);
const inclinationWrites = (rig: Rig) => rig.writes.filter(isInclinationWrite);

function ftmsDevice(id: string, extra: Partial<ScannedDevice> = {}): ScannedDevice {
  return {
    id,
    name: null,
    rssi: -60,
    advertisesFtms: true,
    ftms: null,
    ...extra,
  };
}

const TREADMILL_ADVERTISEMENT = {
  available: true,
  machineTypes: {
    treadmill: true,
    crossTrainer: false,
    stepClimber: false,
    stairClimber: false,
    rower: false,
    indoorBike: false,
  },
};

describe('busca', () => {
  it('passa por starting e scanning, lista o aparelho FTMS e para sozinha depois de scanTimeoutMs', async () => {
    const rig = createRig();
    const states = track(rig, (s) => s.scan);

    rig.session.actions.startScan();
    expect(snap(rig).scan).toBe('starting');
    await advance(0);
    expect(snap(rig).scan).toBe('scanning');

    await advance(300);
    expect(snap(rig).devices).toEqual([
      expect.objectContaining({ id: SIMULATED_DEVICE_ID, advertisesFtms: true }),
    ]);
    expect(snap(rig).scan).toBe('scanning');

    await advance(4600);
    expect(snap(rig).scan).toBe('scanning');
    await advance(200);
    expect(snap(rig).scan).toBe('idle');
    expect(states).toEqual(['idle', 'starting', 'scanning', 'idle']);
    // A lista encontrada continua disponível para o usuário tocar.
    expect(snap(rig).devices).toHaveLength(1);
  });

  it('stopScan() volta a idle e nada mais é listado', async () => {
    const rig = createRig();
    rig.session.actions.startScan();
    await advance(100);
    expect(snap(rig).scan).toBe('scanning');

    rig.session.actions.stopScan();
    expect(snap(rig).scan).toBe('idle');
    await advance(1000);
    expect(snap(rig).devices).toEqual([]);
  });

  it('stopScan() enquanto ainda prepara cancela a busca sem começar a procurar', async () => {
    const rig = createRig();
    let release: () => void = () => undefined;
    rig.hooks.prepare = () => new Promise<void>((resolve) => (release = resolve));
    rig.session.actions.startScan();
    expect(snap(rig).scan).toBe('starting');

    rig.session.actions.stopScan();
    release();
    await advance(1000);
    expect(snap(rig).scan).toBe('idle');
    expect(snap(rig).devices).toEqual([]);
  });

  it('prepare() que falha volta a idle e o aviso de erro traz a mensagem', async () => {
    const rig = createRig();
    rig.hooks.prepare = () =>
      Promise.reject(new BleUnavailableError('poweredOff', 'O Bluetooth está desligado.'));

    rig.session.actions.startScan();
    await advance(0);

    expect(snap(rig).scan).toBe('idle');
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({ kind: 'error', message: 'O Bluetooth está desligado.' }),
    );
  });

  describe('lista de aparelhos', () => {
    function scanRig() {
      let emit: (device: ScannedDevice) => void = () => undefined;
      const ble: BleTransport = {
        prepare: async () => undefined,
        scan: (onDevice) => {
          emit = onDevice;
          return { remove: () => undefined };
        },
        connect: () => Promise.reject(new Error('não usado')),
      };
      const rig = createRig({}, { ble });
      return { rig, emit: (device: ScannedDevice) => emit(device) };
    }

    async function started() {
      const ctx = scanRig();
      ctx.rig.session.actions.startScan();
      await advance(0);
      return ctx;
    }

    it('não duplica o mesmo aparelho e põe os FTMS antes dos demais', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('relogio', { name: 'Relógio', advertisesFtms: false }));
      emit(ftmsDevice('esteira', { name: 'Esteira' }));
      emit(ftmsDevice('esteira', { name: 'Esteira' }));
      emit(ftmsDevice('relogio', { name: 'Relógio', advertisesFtms: false }));
      emit(ftmsDevice('bike', { name: 'Bike' }));

      expect(snap(rig).devices.map((d) => d.id)).toEqual(['esteira', 'bike', 'relogio']);
    });

    it('não perde nome nem serviço já vistos quando o anúncio seguinte vem sem eles', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('esteira', { name: 'Matrix T600X', ftms: TREADMILL_ADVERTISEMENT }));
      emit(ftmsDevice('esteira', { name: null, advertisesFtms: false, ftms: null }));

      expect(snap(rig).devices).toEqual([
        expect.objectContaining({
          id: 'esteira',
          name: 'Matrix T600X',
          advertisesFtms: true,
          ftms: TREADMILL_ADVERTISEMENT,
        }),
      ]);
    });

    it('completa o nome e o serviço quando chegam depois', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('esteira', { name: null, advertisesFtms: false }));
      emit(
        ftmsDevice('esteira', {
          name: 'Matrix',
          advertisesFtms: true,
          ftms: TREADMILL_ADVERTISEMENT,
        }),
      );

      expect(snap(rig).devices).toEqual([
        expect.objectContaining({
          name: 'Matrix',
          advertisesFtms: true,
          ftms: TREADMILL_ADVERTISEMENT,
        }),
      ]);
    });

    it('um aparelho que passa a anunciar FTMS sobe para o grupo dos FTMS', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('a', { advertisesFtms: false }));
      emit(ftmsDevice('b', { advertisesFtms: false }));
      emit(ftmsDevice('b', { advertisesFtms: true }));

      expect(snap(rig).devices.map((d) => d.id)).toEqual(['b', 'a']);
    });

    it('dentro de cada grupo, o sinal mais forte vem na frente', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('longe', { rssi: -80 }));
      emit(ftmsDevice('perto', { rssi: -40 }));
      emit(ftmsDevice('meio', { rssi: -60 }));
      emit(ftmsDevice('relogio', { rssi: -30, advertisesFtms: false }));

      expect(snap(rig).devices.map((d) => d.id)).toEqual(['perto', 'meio', 'longe', 'relogio']);
    });

    it('oscilação pequena de RSSI não redesenha a lista; uma grande, sim', async () => {
      const { rig, emit } = await started();
      emit(ftmsDevice('esteira', { rssi: -60 }));
      const before = snap(rig).devices;

      emit(ftmsDevice('esteira', { rssi: -62 }));
      expect(snap(rig).devices).toBe(before);

      emit(ftmsDevice('esteira', { rssi: -80 }));
      expect(snap(rig).devices).not.toBe(before);
      expect(snap(rig).devices[0].rssi).toBe(-80);
    });
  });
});

describe('conexão', () => {
  it('connect() passa por connecting e connected com as capacidades preenchidas, sem pedir controle', async () => {
    const rig = createRig({ name: 'Esteira da sala' });
    const phases = track(rig, (s) => s.phase);

    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    expect(snap(rig).phase).toBe('connecting');
    expect(snap(rig).device).toEqual({ id: SIMULATED_DEVICE_ID, name: null });
    await advance(200);

    const s = snap(rig);
    expect(phases).toEqual(['idle', 'connecting', 'connected']);
    expect(s.mode).toBe('ble');
    expect(s.device).toEqual({ id: SIMULATED_DEVICE_ID, name: 'Esteira da sala' });
    expect(s.capabilities).toEqual(
      expect.objectContaining({
        hasControlPoint: true,
        speedRange: { min: 0.8, max: 22, step: 0.1, source: 'device' },
        inclinationRange: { min: 0, max: 15, step: 0.5, source: 'device' },
      }),
    );
    expect(s.capabilities?.feature).not.toBeNull();
    expect(s.capabilities?.feature?.targets.speed).toBe(true);
    expect(s.capabilities?.characteristics).toEqual(
      expect.arrayContaining([
        FTMS.feature,
        FTMS.treadmillData,
        FTMS.controlPoint,
        FTMS.machineStatus,
        FTMS.supportedSpeedRange,
      ]),
    );
    // O controle só é pedido no primeiro comando.
    expect(s.control).toBe('idle');
    expect(rig.writes).toEqual([]);
    expect(s.log.filter((entry) => entry.kind === 'tx')).toEqual([]);
  });

  it('usa as faixas informadas pela esteira', async () => {
    const rig = createRig({
      speedRange: { min: 1, max: 12, step: 0.5 },
      inclinationRange: { min: -2, max: 10, step: 1 },
    });
    await connect(rig);
    expect(snap(rig).capabilities?.speedRange).toEqual({
      min: 1,
      max: 12,
      step: 0.5,
      source: 'device',
    });
    expect(snap(rig).capabilities?.inclinationRange).toEqual({
      min: -2,
      max: 10,
      step: 1,
      source: 'device',
    });
  });

  it('sem as características de faixa, assume as da T600X', async () => {
    const rig = createRig({ exposeRanges: false });
    await connect(rig);

    expect(snap(rig).capabilities?.speedRange).toEqual({
      min: 0.8,
      max: 22,
      step: 0.1,
      source: 'assumed',
    });
    expect(snap(rig).capabilities?.inclinationRange).toEqual({
      min: 0,
      max: 15,
      step: 0.5,
      source: 'assumed',
    });
  });

  it('esteira sem Control Point: control "unavailable", dados chegam e nenhum comando escreve', async () => {
    const rig = createRig({ hasControlPoint: false });
    await connect(rig);
    expect(snap(rig).control).toBe('unavailable');
    expect(snap(rig).capabilities?.hasControlPoint).toBe(false);

    await advance(1000);
    expect(snap(rig).metrics.speedKmh).toBe(0);
    expect(snap(rig).metrics.updatedAt).not.toBeNull();
    const target = snap(rig).targetSpeedKmh;

    const { actions } = rig.session;
    actions.start();
    actions.pause();
    actions.stop();
    actions.changeSpeed(0.1);
    actions.changeInclination(0.5);
    await advance(2000);

    expect(rig.writes).toEqual([]);
    expect(snap(rig).log.filter((entry) => entry.kind === 'tx')).toEqual([]);
    expect(snap(rig).targetSpeedKmh).toBe(target);
    expect(snap(rig).targetInclinationPercent).toBeNull();
    expect(snap(rig).busy).toBe(false);
    expect(snap(rig).control).toBe('unavailable');
    expect(snap(rig).phase).toBe('connected');
  });

  describe('aparelhos que não servem', () => {
    it('sem o serviço FTMS: volta a idle, avisa e fecha a conexão aberta', async () => {
      const rig = createRig();
      rig.hooks.getCharacteristics = async () => [];

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);

      const s = snap(rig);
      expect(s.phase).toBe('idle');
      expect(s.device).toBeNull();
      expect(s.mode).toBe('ble');
      expect(s.notice).toEqual(
        expect.objectContaining({ kind: 'error', message: expect.stringContaining('FTMS') }),
      );
      expect(rig.disconnects.count).toBe(1);

      // O simulador só aceita uma conexão por vez: a anterior foi mesmo fechada.
      rig.hooks.getCharacteristics = undefined;
      await connect(rig);
    });

    it('FTMS sem Treadmill Data: volta a idle, avisa e fecha a conexão', async () => {
      const rig = createRig();
      rig.hooks.getCharacteristics = async (open) =>
        (await open()).filter((c) => !sameUuid(c.uuid, FTMS.treadmillData));

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);

      const s = snap(rig);
      expect(s.phase).toBe('idle');
      expect(s.device).toBeNull();
      expect(s.notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Treadmill Data'),
        }),
      );
      expect(rig.disconnects.count).toBe(1);
    });

    it('Treadmill Data que não notifica também é recusado', async () => {
      const rig = createRig();
      rig.hooks.getCharacteristics = async (open) =>
        (await open()).map((c) =>
          sameUuid(c.uuid, FTMS.treadmillData) ? { ...c, canNotify: false } : c,
        );

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);

      expect(snap(rig).phase).toBe('idle');
      expect(snap(rig).notice?.kind).toBe('error');
      expect(rig.disconnects.count).toBe(1);
    });

    it('connect() que rejeita: volta a idle com a mensagem do erro', async () => {
      const rig = createRig();
      rig.hooks.connect = () => Promise.reject(new Error('Dispositivo fora de alcance'));

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(0);

      const s = snap(rig);
      expect(s.phase).toBe('idle');
      expect(s.device).toBeNull();
      expect(s.mode).toBe('ble');
      expect(s.notice).toEqual(
        expect.objectContaining({ kind: 'error', message: 'Dispositivo fora de alcance' }),
      );
    });

    it('prepare() que lança durante connect() avisa e não deixa a sessão presa em connecting', async () => {
      const rig = createRig();
      rig.hooks.prepare = () =>
        Promise.reject(new BleUnavailableError('unauthorized', 'Sem permissão de Bluetooth.'));

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(0);

      expect(snap(rig).phase).toBe('idle');
      expect(snap(rig).notice?.message).toBe('Sem permissão de Bluetooth.');
    });

    it('a lista de aparelhos encontrados sobrevive a uma falha de conexão', async () => {
      const rig = createRig();
      rig.session.actions.startScan();
      await advance(400);
      expect(snap(rig).devices).toHaveLength(1);

      rig.hooks.connect = () => Promise.reject(new Error('falhou'));
      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(0);

      expect(snap(rig).phase).toBe('idle');
      expect(snap(rig).devices).toHaveLength(1);
    });
  });

  describe('desconexão', () => {
    it('disconnect() durante connecting não deixa a sessão conectar depois', async () => {
      const rig = createRig();
      const phases = track(rig, (s) => s.phase);

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(100);
      expect(snap(rig).phase).toBe('connecting');
      rig.session.actions.disconnect();
      await advance(1000);

      expect(snap(rig).phase).toBe('idle');
      expect(snap(rig).device).toBeNull();
      expect(phases).not.toContain('connected');
      // A conexão que chegou atrasada foi fechada.
      expect(rig.disconnects.count).toBe(1);
      expect(snap(rig).metrics.updatedAt).toBeNull();

      // E dá para conectar de novo.
      await connect(rig);
    });

    it('disconnect() conectado volta a idle, zera as métricas e o modo volta a "ble"', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.session.actions.changeSpeed(0.1);
      await advance(100);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);

      rig.session.actions.disconnect();
      await advance(0);

      const s = snap(rig);
      expect(s.phase).toBe('idle');
      expect(s.mode).toBe('ble');
      expect(s.device).toBeNull();
      expect(s.capabilities).toBeNull();
      expect(s.control).toBe('idle');
      expect(s.belt).toBe('unknown');
      expect(s.targetSpeedKmh).toBeNull();
      expect(s.targetInclinationPercent).toBeNull();
      expect(s.busy).toBe(false);
      expect(Object.values(s.metrics).every((value) => value === null)).toBe(true);
      expect(rig.disconnects.count).toBe(1);

      // Nada mais chega depois de desconectar.
      await advance(3000);
      expect(snap(rig).metrics.updatedAt).toBeNull();
    });

    it('a lista de aparelhos sobrevive à desconexão (reconectar é um toque só)', async () => {
      const rig = createRig();
      rig.session.actions.startScan();
      await advance(400);
      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);
      expect(snap(rig).phase).toBe('connected');
      expect(snap(rig).scan).toBe('idle');

      rig.session.actions.disconnect();
      await advance(0);

      expect(snap(rig).devices).toHaveLength(1);
    });

    it('connect() com uma conexão em andamento é ignorado', async () => {
      const rig = createRig();
      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);

      expect(snap(rig).phase).toBe('connected');
      expect(snap(rig).notice).toBeNull();
    });
  });

  describe('modo demonstração', () => {
    it('openDemo() usa o transporte da demonstração, não o rádio, e o modo volta a "ble" ao desconectar', async () => {
      const unusable: BleTransport = {
        prepare: () => Promise.reject(new Error('o rádio não deve ser usado')),
        scan: () => {
          throw new Error('o rádio não deve ser usado');
        },
        connect: () => Promise.reject(new Error('o rádio não deve ser usado')),
      };
      const sim = new SimulatedTreadmillTransport();
      const session = new TreadmillSession({
        ble: unusable,
        demo: { transport: sim, deviceId: SIMULATED_DEVICE_ID },
      });
      const modes: string[] = [];
      session.subscribe(() => {
        const mode = session.getSnapshot().mode;
        if (modes[modes.length - 1] !== mode) modes.push(mode);
      });

      session.actions.openDemo();
      expect(session.getSnapshot().mode).toBe('demo');
      expect(session.getSnapshot().phase).toBe('connecting');
      await advance(200);
      expect(session.getSnapshot().phase).toBe('connected');
      expect(session.getSnapshot().mode).toBe('demo');
      expect(session.getSnapshot().notice).toBeNull();

      session.actions.disconnect();
      await advance(0);
      expect(session.getSnapshot().phase).toBe('idle');
      expect(session.getSnapshot().mode).toBe('ble');
      expect(modes).toEqual(['demo', 'ble']);
    });
  });

  describe('queda de link', () => {
    it('dropLink(): volta a idle e avisa que a lona continua como estava', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.session.actions.changeSpeed(0.1);
      await advance(100);

      rig.sim.dropLink();
      await advance(0);

      const s = snap(rig);
      expect(s.phase).toBe('idle');
      expect(s.device).toBeNull();
      expect(s.mode).toBe('ble');
      expect(s.belt).toBe('unknown');
      expect(s.targetSpeedKmh).toBeNull();
      expect(s.notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('A lona continua como estava'),
        }),
      );
      // O transporte é avisado para soltar os ouvintes.
      expect(rig.disconnects.count).toBe(1);
    });

    it('um comando esperando resposta não prende a sessão: busy volta a false sem esperar o timeout', async () => {
      const rig = createRig({ muteControlPoint: true });
      await connect(rig);

      rig.session.actions.start();
      await advance(100);
      expect(snap(rig).busy).toBe(true);

      rig.sim.dropLink();
      await advance(0);
      expect(snap(rig).busy).toBe(false);
      expect(snap(rig).phase).toBe('idle');
      const notice = snap(rig).notice;

      // O timeout do comando abandonado não gera aviso nenhum depois.
      await advance(30_000);
      expect(snap(rig).notice).toBe(notice);
      expect(snap(rig).busy).toBe(false);
    });

    it('queda durante a espera para repetir o Request Control: reconectar logo e comandar funciona', async () => {
      const rig = createRig();
      await connect(rig);
      rig.hooks.write = () => Promise.reject(new Error('Insufficient Encryption'));

      rig.session.actions.start();
      await advance(100);
      expect(rig.writes).toEqual([REQUEST_CONTROL]);
      expect(snap(rig).busy).toBe(true);

      rig.sim.dropLink();
      await advance(0);
      expect(snap(rig).busy).toBe(false);

      // Reconecta antes de o intervalo de repetição da fila antiga vencer.
      rig.hooks.write = undefined;
      rig.writes.length = 0;
      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(200);
      expect(snap(rig).phase).toBe('connected');
      // Conexão nova, confirmação nova: a anterior não vale mais.
      expect(snap(rig).identityConfirmed).toBe(false);
      rig.session.actions.confirmIdentity();
      rig.session.actions.start();
      await advance(100);
      expect(rig.writes).toEqual([REQUEST_CONTROL, START]);

      // A fila velha acorda aqui e não pode mexer na conexão nova.
      await advance(2000);
      expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
      expect(snap(rig).belt).toBe('running');
      expect(snap(rig).control).toBe('granted');
      expect(snap(rig).busy).toBe(false);
    });
  });
});

describe('Device Information ao conectar', () => {
  const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  const MODEL = uuid16(0x2a24);
  const MANUFACTURER = uuid16(0x2a29);
  const SERIAL = uuid16(0x2a25);
  const SYSTEM_ID = uuid16(0x2a23);

  /** As linhas do registro que vieram do Device Information, só com o que importa. */
  const infoLines = (rig: Rig) =>
    snap(rig)
      .log.filter((entry) => entry.label.startsWith('Device Information'))
      .map(({ kind, label, hex }) => ({ kind, label, hex }));

  /** Tudo o que o registro ganhou depois de "Desconectando". */
  const afterDisconnecting = (rig: Rig) => {
    const labels = snap(rig).log.map((entry) => entry.label);
    const at = labels.indexOf('Desconectando');
    expect(at).toBeGreaterThan(-1);
    return labels.slice(at + 1);
  };

  it('lê e registra modelo, fabricante e série, na ordem da sessão e antes de a esteira ficar pronta', async () => {
    const rig = createRig();
    // Fora da ordem de propósito: o registro segue a ordem da sessão, não a do aparelho.
    rig.hooks.deviceInformation = {
      [SERIAL]: ascii('TM781B2307C00018'),
      [MANUFACTURER]: ascii('Matrix'),
      [MODEL]: ascii('T600X'),
    };
    await connect(rig);

    expect(infoLines(rig)).toEqual([
      {
        kind: 'rx',
        label: 'Device Information, Model Number: "T600X"',
        hex: bytesToHex(ascii('T600X')),
      },
      {
        kind: 'rx',
        label: 'Device Information, Manufacturer Name: "Matrix"',
        hex: bytesToHex(ascii('Matrix')),
      },
      {
        kind: 'rx',
        label: 'Device Information, Serial Number: "TM781B2307C00018"',
        hex: bytesToHex(ascii('TM781B2307C00018')),
      },
    ]);
    expect(rig.deviceInformationReads).toEqual([MODEL, MANUFACTURER, SERIAL]);
    const labels = snap(rig).log.map((entry) => entry.label);
    expect(labels.indexOf('Device Information, Serial Number: "TM781B2307C00018"')).toBeLessThan(
      labels.indexOf('Esteira pronta'),
    );
  });

  it('o System ID, que é binário, vai só em hexadecimal', async () => {
    const rig = createRig();
    const systemId = Uint8Array.of(0xa0, 0xbb, 0x3e, 0xff, 0xfe, 0x40, 0x19, 0x31);
    rig.hooks.deviceInformation = { [SYSTEM_ID]: systemId };
    await connect(rig);

    expect(infoLines(rig)).toEqual([
      { kind: 'rx', label: 'Device Information, System ID', hex: bytesToHex(systemId) },
    ]);
  });

  it('uma leitura que falha vira uma linha de erro e as outras seguem, sem aviso ao usuário', async () => {
    const rig = createRig();
    rig.hooks.deviceInformation = {
      [MODEL]: new Error('Insufficient authentication'),
      [MANUFACTURER]: ascii('Matrix'),
      [SERIAL]: ascii('TM781B2307C00018'),
    };
    await connect(rig);

    expect(infoLines(rig)).toEqual([
      {
        kind: 'error',
        label: 'Device Information, Model Number: Insufficient authentication',
        hex: null,
      },
      expect.objectContaining({
        kind: 'rx',
        label: 'Device Information, Manufacturer Name: "Matrix"',
      }),
      expect.objectContaining({
        kind: 'rx',
        label: 'Device Information, Serial Number: "TM781B2307C00018"',
      }),
    ]);
    expect(snap(rig).phase).toBe('connected');
    expect(snap(rig).notice).toBeNull();
  });

  it('uma leitura que nunca responde não segura a conexão e as seguintes são abandonadas', async () => {
    const rig = createRig();
    rig.hooks.deviceInformation = {
      [MODEL]: ascii('T600X'),
      [MANUFACTURER]: () => new Promise<Uint8Array>(() => undefined),
      [SERIAL]: ascii('TM781B2307C00018'),
    };

    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    expect(snap(rig).phase).toBe('connecting'); // esperando o Manufacturer Name
    await advance(2000);

    expect(snap(rig).phase).toBe('connected');
    expect(snap(rig).notice).toBeNull();
    expect(infoLines(rig)).toEqual([
      expect.objectContaining({ kind: 'rx', label: 'Device Information, Model Number: "T600X"' }),
      {
        kind: 'error',
        label: 'Device Information, Manufacturer Name: sem resposta em 2000 ms',
        hex: null,
      },
    ]);
    expect(rig.deviceInformationReads).toEqual([MODEL, MANUFACTURER]);
  });

  it('um aparelho sem o serviço não ganha linha nenhuma', async () => {
    const rig = createRig();
    await connect(rig);

    expect(infoLines(rig)).toEqual([]);
    expect(rig.deviceInformationReads).toEqual([]);
    expect(snap(rig).phase).toBe('connected');
  });

  it('pula a característica que não tem a propriedade Read, sem tentar lê-la', async () => {
    const rig = createRig();
    rig.hooks.deviceInformation = { [MODEL]: null, [MANUFACTURER]: ascii('Matrix') };
    await connect(rig);

    expect(rig.deviceInformationReads).toEqual([MANUFACTURER]);
    expect(infoLines(rig)).toEqual([
      expect.objectContaining({
        kind: 'rx',
        label: 'Device Information, Manufacturer Name: "Matrix"',
      }),
    ]);
  });

  it('se não dá nem para listar as características, registra o erro e conecta mesmo assim', async () => {
    const rig = createRig();
    rig.hooks.getCharacteristics = (open, service) =>
      sameUuid(service, DEVICE_INFORMATION_SERVICE) ? Promise.reject(new Error('GATT falhou')) : open();
    await connect(rig);

    expect(infoLines(rig)).toEqual([
      { kind: 'error', label: 'Device Information indisponível: GATT falhou', hex: null },
    ]);
    expect(snap(rig).phase).toBe('connected');
    expect(snap(rig).notice).toBeNull();
  });

  it('caracteres de controle do aparelho não quebram o registro em duas linhas', async () => {
    const rig = createRig();
    rig.hooks.deviceInformation = { [MODEL]: Uint8Array.of(0x54, 0x0a, 0x36) };
    await connect(rig);

    const [line] = infoLines(rig);
    expect(line.label).toBe('Device Information, Model Number: "T\\x0A6"');
    expect(line.label).not.toContain('\n');
  });

  it('aspas e "hex=" no valor não imitam a coluna do hexadecimal', async () => {
    const rig = createRig();
    rig.hooks.deviceInformation = { [MODEL]: ascii('T600X"  hex=AA') };
    await connect(rig);

    const [line] = infoLines(rig);
    expect(line.label).toBe('Device Information, Model Number: "T600X\\x22  hex\\x3DAA"');
    expect(line.hex).toBe(bytesToHex(ascii('T600X"  hex=AA')));
  });

  describe('o usuário desconecta no meio das leituras', () => {
    it('a leitura que responde depois não é registrada e nada mais é lido nem configurado', async () => {
      const rig = createRig();
      rig.hooks.cacheCharacteristics = true;
      rig.hooks.deviceInformation = {
        [MODEL]: async () => {
          rig.session.actions.disconnect();
          return ascii('T600X');
        },
        [MANUFACTURER]: ascii('Matrix'),
      };

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(500);

      expect(snap(rig).phase).toBe('idle');
      expect(infoLines(rig)).toEqual([]);
      expect(rig.deviceInformationReads).toEqual([MODEL]);
      // Sem erros falsos de "Fitness Machine Feature: Conexão encerrada" e companhia.
      expect(afterDisconnecting(rig)).toEqual([]);
    });

    it('a leitura que falha depois também não vira linha de erro', async () => {
      const rig = createRig();
      rig.hooks.cacheCharacteristics = true;
      rig.hooks.deviceInformation = {
        [MODEL]: async () => {
          rig.session.actions.disconnect();
          throw new Error('Conexão encerrada');
        },
        [MANUFACTURER]: ascii('Matrix'),
      };

      rig.session.actions.connect(SIMULATED_DEVICE_ID);
      await advance(500);

      expect(snap(rig).phase).toBe('idle');
      expect(infoLines(rig)).toEqual([]);
      expect(rig.deviceInformationReads).toEqual([MODEL]);
      expect(afterDisconnecting(rig)).toEqual([]);
    });
  });
});

describe('dados da esteira', () => {
  it('Treadmill Data alimenta as métricas e updatedAt', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(5);
    rig.sim.consoleSetInclination(3);
    await advance(15_000);

    const m = snap(rig).metrics;
    expect(m.speedKmh).toBeCloseTo(5, 5);
    expect(m.inclinationPercent).toBeCloseTo(3, 5);
    expect(m.distanceM).toBeGreaterThan(10);
    expect(m.elapsedTimeS).toBeGreaterThanOrEqual(14);
    expect(m.energyKcal).toBeGreaterThan(0);
    expect(m.heartRateBpm).toBeGreaterThan(70);
    expect(m.heartRateBpm).toBeLessThanOrEqual(185);
    expect(m.updatedAt).not.toBeNull();
    expect(Date.now() - (m.updatedAt as number)).toBeLessThan(1000);
  });

  /** Mesmo roteiro, devolvendo as métricas sem o carimbo de hora. */
  async function metricsOf(options: SimulatedTreadmillOptions) {
    const rig = createRig(options);
    await startBelt(rig);
    rig.sim.consoleSetSpeed(4);
    rig.sim.consoleSetInclination(2);
    await advance(10_000);
    const { updatedAt, ...rest } = snap(rig).metrics;
    expect(updatedAt).not.toBeNull();
    rig.session.actions.disconnect();
    await advance(0);
    return rest;
  }

  it('com splitRecords as duas notificações se fundem: nenhum campo some', async () => {
    const reference = await metricsOf({});
    const split = await metricsOf({ splitRecords: true });

    expect(split.speedKmh).toBeCloseTo(4, 5);
    expect(split.distanceM).not.toBeNull();
    expect(split.heartRateBpm).not.toBeNull();
    expect(split.elapsedTimeS).not.toBeNull();
    expect(split.energyKcal).not.toBeNull();
    expect(split.inclinationPercent).not.toBeNull();
    expect(split).toEqual(reference);
  });

  it.each([1, 2] as const)(
    'com paceFieldWidth %d os demais campos continuam corretos',
    async (width) => {
      const reference = await metricsOf({});
      const withPace = await metricsOf({ paceFieldWidth: width });

      expect(withPace.speedKmh).toBeCloseTo(4, 5);
      expect(withPace).toEqual(reference);
    },
  );

  it.each([1, 2] as const)(
    'paceFieldWidth %d junto com splitRecords também não perde campos',
    async (width) => {
      const reference = await metricsOf({});
      expect(await metricsOf({ paceFieldWidth: width, splitRecords: true })).toEqual(reference);
    },
  );

  it('pacote ilegível vai para o log como erro e não derruba a sessão', async () => {
    const rig = createRig();
    await connect(rig);
    rig.hooks.treadmillData = () => Uint8Array.of(0x00);
    await advance(2000);

    expect(snap(rig).phase).toBe('connected');
    expect(snap(rig).metrics.updatedAt).toBeNull();
    expect(
      snap(rig).log.some((entry) => entry.kind === 'error' && entry.label.includes('ilegível')),
    ).toBe(true);

    rig.hooks.treadmillData = undefined;
    await advance(1000);
    expect(snap(rig).metrics.updatedAt).not.toBeNull();
  });

  describe('estado da lona deduzido dos dados', () => {
    it('sem Machine Status para quem comandou, o estado vem da confirmação do comando', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      expect(snap(rig).log.some((e) => e.label.startsWith('Fitness Machine Status'))).toBe(false);

      rig.session.actions.pause();
      await advance(200);
      expect(snap(rig).belt).toBe('paused');

      // O Iniciar só vale com a lona parada (startLockoutMs e startSettleMs).
      await advance(3000);
      rig.session.actions.start();
      await advance(200);
      expect(snap(rig).belt).toBe('running');

      rig.session.actions.stop();
      await advance(200);
      expect(snap(rig).belt).toBe('stopped');
      expect(snap(rig).targetSpeedKmh).toBeNull();
    });

    it('partida e parada pelo console, sem nenhum aviso de status, saem da velocidade medida', async () => {
      const rig = createRig();
      rig.hooks.suppressMachineStatus = true;
      await connect(rig);
      expect(snap(rig).belt).toBe('unknown');

      await advance(1000);
      expect(snap(rig).belt).toBe('stopped');

      rig.sim.consoleStart();
      await advance(1000);
      expect(snap(rig).belt).toBe('running');

      rig.sim.consoleSetSpeed(3);
      await advance(3000);
      expect(snap(rig).belt).toBe('running');

      rig.sim.consoleStop();
      await advance(3000);
      expect(snap(rig).belt).toBe('stopped');
    });

    it('lona já girando ao conectar é reconhecida como "running"', async () => {
      const rig = createRig();
      rig.hooks.suppressMachineStatus = true;
      await connect(rig);
      rig.sim.consoleStart();
      rig.sim.consoleSetSpeed(3);
      await advance(1000);
      expect(snap(rig).belt).toBe('running');
    });
  });
});

describe('comandos', () => {
  describe('controle e estado da lona', () => {
    it('o primeiro comando pede o controle antes de sair; os seguintes não pedem de novo', async () => {
      const rig = createRig();
      await connect(rig);
      const control = track(rig, (s) => s.control);

      rig.session.actions.start();
      await advance(300);

      expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
      expect(control).toEqual(['idle', 'requesting', 'granted']);

      rig.session.actions.pause();
      await advance(300);
      expect(rig.writes).toEqual([REQUEST_CONTROL, START, PAUSE]);
      expect(snap(rig).control).toBe('granted');
    });

    it('start, pause e stop atualizam a lona; stop limpa o alvo de velocidade', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.session.actions.changeSpeed(0.1);
      await advance(1000);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);

      rig.session.actions.pause();
      await advance(200);
      expect(snap(rig).belt).toBe('paused');

      // O Iniciar só vale com a lona parada (startLockoutMs e startSettleMs).
      await advance(3000);
      rig.session.actions.start();
      await advance(200);
      expect(snap(rig).belt).toBe('running');

      rig.session.actions.stop();
      await advance(200);
      expect(snap(rig).belt).toBe('stopped');
      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(rig.writes.slice(-1)).toEqual([STOP]);
      expect(snap(rig).busy).toBe(false);
    });

    it('toques repetidos em start() geram um Start só, mesmo com o primeiro já em voo', async () => {
      const rig = createRig();
      await connect(rig);
      rig.session.actions.start();
      rig.session.actions.start();
      rig.session.actions.start();
      await advance(500);

      expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
      expect(snap(rig).notice).toBeNull();
    });

    it('toques repetidos em pause() também geram um Pause só', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.writes.length = 0;
      rig.session.actions.pause();
      rig.session.actions.pause();
      await advance(500);

      expect(rig.writes).toEqual([PAUSE]);
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).belt).toBe('paused');
    });

    it('stop() repetido durante um Stop em voo é ignorado', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.writes.length = 0;
      rig.session.actions.stop();
      rig.session.actions.stop();
      rig.session.actions.stop();
      await advance(1000);

      expect(rig.writes).toEqual([STOP]);
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).belt).toBe('stopped');
    });

    it('pause() depois de start() em voo ainda entra na fila (comandos diferentes)', async () => {
      const rig = createRig();
      await connect(rig);
      rig.session.actions.start();
      rig.session.actions.pause();
      await advance(500);

      expect(rig.writes).toEqual([REQUEST_CONTROL, START, PAUSE]);
    });

    it('o pedido de controle também grava no log, com o hexadecimal enviado', async () => {
      const rig = createRig();
      await connect(rig);
      rig.session.actions.start();
      await advance(300);

      expect(snap(rig).log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'tx', label: 'Request Control', hex: REQUEST_CONTROL }),
          expect.objectContaining({ kind: 'tx', label: 'Start or Resume', hex: START }),
        ]),
      );
    });
  });

  describe('changeSpeed', () => {
    it('com a lona parada nada é escrito, o alvo não muda e aparece um aviso informativo', async () => {
      const rig = createRig();
      await connect(rig);
      await advance(1000);
      expect(snap(rig).metrics.speedKmh).toBe(0);

      rig.session.actions.changeSpeed(0.1);
      await advance(500);

      expect(rig.writes).toEqual([]);
      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).control).toBe('idle');
      expect(snap(rig).notice).toEqual(expect.objectContaining({ kind: 'info' }));
      expect(snap(rig).belt).toBe('stopped');
    });

    it('antes de chegar qualquer dado também não escreve nada', async () => {
      const rig = createRig();
      await connect(rig);
      rig.session.actions.changeSpeed(1);
      await advance(500);

      expect(rig.writes).toEqual([]);
      expect(snap(rig).notice?.kind).toBe('info');
    });

    it('depois de parar, a velocidade não é ajustada nem com a lona ainda freando', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.sim.consoleSetSpeed(5);
      await advance(6000);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(5, 5);

      rig.sim.consoleStop();
      expect(snap(rig).belt).toBe('stopped');
      // A última amostra ainda diz 5 km/h: a lona está freando.
      expect(snap(rig).metrics.speedKmh).toBeGreaterThan(0);
      rig.writes.length = 0;

      rig.session.actions.changeSpeed(0.1);
      await advance(100);
      expect(rig.writes).toEqual([]);
      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).notice?.kind).toBe('info');
    });

    it('com a lona pausada e ainda freando, a velocidade também não é ajustada', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.sim.consoleSetSpeed(5);
      await advance(6000);

      rig.sim.consolePause();
      expect(snap(rig).belt).toBe('paused');
      expect(snap(rig).metrics.speedKmh).toBeGreaterThan(0);
      rig.writes.length = 0;

      rig.session.actions.changeSpeed(0.1);
      await advance(100);
      expect(rig.writes).toEqual([]);
    });

    it('+0,1 com a lona rodando: alvo = velocidade medida + 0,1, a esteira recebe e a velocidade converge', async () => {
      const rig = createRig();
      await startBelt(rig);

      rig.session.actions.changeSpeed(0.1);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      await advance(100);
      expect(speedWrites(rig)).toEqual([speedCmd(0.9)]);

      await advance(3000);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(0.9, 5);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
    });

    it('os ajustes seguintes partem do alvo, são quantizados ao passo e limitados à faixa', async () => {
      const rig = createRig({ speedRange: { min: 1, max: 3, step: 0.5 } });
      await startBelt0(rig, 1);

      // 1,0 + 0,7 = 1,7 -> o passo de 0,5 o leva a 1,5.
      rig.session.actions.changeSpeed(0.7);
      expect(snap(rig).targetSpeedKmh).toBe(1.5);
      await advance(3000);
      expect(speedWrites(rig)).toEqual([speedCmd(1.5)]);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(1.5, 5);

      // Extremo de cima: nunca passa do máximo.
      rig.session.actions.changeSpeed(10);
      expect(snap(rig).targetSpeedKmh).toBe(3);
      await advance(3000);
      expect(speedWrites(rig)).toEqual([speedCmd(1.5), speedCmd(3)]);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(3, 5);

      // Já no máximo: nada a enviar.
      rig.session.actions.changeSpeed(0.5);
      await advance(1000);
      expect(speedWrites(rig)).toEqual([speedCmd(1.5), speedCmd(3)]);
      expect(snap(rig).targetSpeedKmh).toBe(3);

      // Extremo de baixo: nunca desce do mínimo (e jamais chega a zero).
      rig.session.actions.changeSpeed(-10);
      expect(snap(rig).targetSpeedKmh).toBe(1);
      await advance(3000);
      expect(speedWrites(rig)).toEqual([speedCmd(1.5), speedCmd(3), speedCmd(1)]);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(1, 5);

      rig.session.actions.changeSpeed(-0.5);
      await advance(1000);
      expect(speedWrites(rig)).toHaveLength(3);
      expect(snap(rig).targetSpeedKmh).toBe(1);
      expect(snap(rig).belt).toBe('running');
    });

    it('somas de ponto flutuante não vazam para o comando (0,8 + 0,1 + 0,1 ...)', async () => {
      const rig = createRig();
      await startBelt(rig);
      for (let i = 0; i < 3; i++) {
        rig.session.actions.changeSpeed(0.1);
        await advance(100);
      }
      expect(snap(rig).targetSpeedKmh).toBe(1.1);
      expect(speedWrites(rig).slice(-1)).toEqual([speedCmd(1.1)]);
    });

    it('vários toques rápidos viram menos comandos que toques, e o último alvo vale', async () => {
      const rig = createRig();
      await startBelt(rig);

      for (let i = 0; i < 5; i++) rig.session.actions.changeSpeed(0.1);
      expect(snap(rig).targetSpeedKmh).toBe(1.3);
      await advance(500);

      const sent = speedWrites(rig);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.length).toBeLessThan(5);
      expect(sent[sent.length - 1]).toBe(speedCmd(1.3));
      expect(snap(rig).targetSpeedKmh).toBe(1.3);
      expect(snap(rig).busy).toBe(false);

      await advance(3000);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(1.3, 5);
    });

    it('um alvo igual ao já confirmado não é reenviado', async () => {
      const rig = createRig();
      await startBelt(rig);

      rig.session.actions.changeSpeed(0.1); // 0,9 sai agora
      rig.session.actions.changeSpeed(0.1); // 1,0 fica na fila...
      rig.session.actions.changeSpeed(-0.1); // ...e volta a 0,9, o que a esteira já tem
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      await advance(1000);

      expect(speedWrites(rig)).toEqual([speedCmd(0.9)]);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      expect(snap(rig).busy).toBe(false);
    });
  });

  describe('changeInclination', () => {
    it('funciona com a lona parada, respeitando passo e faixa', async () => {
      const rig = createRig();
      await connect(rig);
      await advance(1000);
      expect(snap(rig).belt).toBe('stopped');

      // 0,0 + 0,3 -> o passo de 0,5 leva a 0,5.
      rig.session.actions.changeInclination(0.3);
      expect(snap(rig).targetInclinationPercent).toBe(0.5);
      await advance(300);
      expect(rig.writes).toEqual([REQUEST_CONTROL, inclinationCmd(0.5)]);
      expect(snap(rig).belt).toBe('stopped');

      // 0,5 + 0,2 = 0,7 -> volta a 0,5, que já é o alvo: nada a enviar.
      rig.session.actions.changeInclination(0.2);
      await advance(300);
      expect(inclinationWrites(rig)).toEqual([inclinationCmd(0.5)]);

      rig.session.actions.changeInclination(100);
      expect(snap(rig).targetInclinationPercent).toBe(15);
      await advance(16_000);
      expect(inclinationWrites(rig)).toEqual([inclinationCmd(0.5), inclinationCmd(15)]);
      expect(snap(rig).metrics.inclinationPercent).toBeCloseTo(15, 5);

      rig.session.actions.changeInclination(1);
      await advance(500);
      expect(inclinationWrites(rig)).toHaveLength(2);
      expect(snap(rig).targetInclinationPercent).toBe(15);

      rig.session.actions.changeInclination(-100);
      expect(snap(rig).targetInclinationPercent).toBe(0);
      await advance(16_000);
      expect(inclinationWrites(rig)).toEqual([
        inclinationCmd(0.5),
        inclinationCmd(15),
        inclinationCmd(0),
      ]);
      expect(snap(rig).metrics.inclinationPercent).toBeCloseTo(0, 5);
    });
  });

  describe('changeInclination sem inclinação medida', () => {
    it('parte do plano (0 %), não do mínimo da faixa', async () => {
      const rig = createRig({ inclinationRange: { min: -2, max: 10, step: 0.5 } });
      await connect(rig); // ainda sem nenhuma amostra de Treadmill Data
      expect(snap(rig).metrics.inclinationPercent).toBeNull();

      rig.session.actions.changeInclination(0.5);
      expect(snap(rig).targetInclinationPercent).toBe(0.5);
      await advance(300);
      expect(inclinationWrites(rig)).toEqual([inclinationCmd(0.5)]);
    });

    it('limita o ponto de partida à faixa quando o plano fica fora dela', async () => {
      const rig = createRig({ inclinationRange: { min: 1, max: 10, step: 0.5 } });
      await connect(rig);

      rig.session.actions.changeInclination(0.5);
      expect(snap(rig).targetInclinationPercent).toBe(1.5);
    });
  });

  describe('stop com comandos na fila', () => {
    it('descarta a fila, devolve os alvos exibidos ao último confirmado e o Stop é o próximo a sair', async () => {
      // Sem Machine Status para quem comanda: o "confirmado" vem só das indications.
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      rig.session.actions.changeSpeed(0.1);
      await advance(200);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      rig.writes.length = 0;

      rig.session.actions.changeSpeed(0.1); // 1,0 em andamento
      rig.session.actions.changeSpeed(0.1); // 1,1 na fila
      rig.session.actions.changeInclination(0.5); // na fila
      expect(snap(rig).targetSpeedKmh).toBe(1.1);
      expect(snap(rig).targetInclinationPercent).toBe(0.5);

      rig.session.actions.stop();
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      expect(snap(rig).targetInclinationPercent).toBeNull();

      await advance(500);
      expect(rig.writes).toEqual([speedCmd(1), STOP]);
      expect(snap(rig).belt).toBe('stopped');
      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).busy).toBe(false);
    });

    it('descarta também start e pause que esperavam', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.writes.length = 0;

      rig.session.actions.pause(); // em andamento
      rig.session.actions.start(); // na fila
      rig.session.actions.stop();
      await advance(500);

      expect(rig.writes).toEqual([PAUSE, STOP]);
      expect(snap(rig).belt).toBe('stopped');
    });
  });

  describe('respostas da esteira', () => {
    it('grantControl: false -> control "denied", aviso de erro, nada enviado além do pedido, busy volta a false', async () => {
      const rig = createRig({ grantControl: false });
      await connect(rig);

      rig.session.actions.start();
      await advance(300);

      expect(rig.writes).toEqual([REQUEST_CONTROL]);
      expect(snap(rig).control).toBe('denied');
      expect(snap(rig).notice).toEqual(expect.objectContaining({ kind: 'error' }));
      expect(snap(rig).busy).toBe(false);
      expect(snap(rig).belt).not.toBe('running');
    });

    it('grantControl: false -> o alvo de velocidade exibido é revertido', async () => {
      const rig = createRig({ grantControl: false });
      await connect(rig);
      rig.sim.consoleStart(); // o console não precisa de controle
      await advance(1100);
      expect(snap(rig).belt).toBe('running');
      const targets = track(rig, (s) => s.targetSpeedKmh);

      rig.session.actions.changeSpeed(0.1);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      await advance(300);

      expect(targets).toEqual([null, 0.9, null]);
      expect(snap(rig).control).toBe('denied');
      expect(snap(rig).busy).toBe(false);
      expect(snap(rig).notice?.kind).toBe('error');
      expect(speedWrites(rig)).toEqual([]);
    });

    it('stop() quando o controle é negado orienta a usar o Emergency Stop', async () => {
      const rig = createRig({ grantControl: false });
      await connect(rig);

      rig.session.actions.stop();
      await advance(300);

      expect(rig.writes).toEqual([REQUEST_CONTROL]);
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Emergency Stop'),
        }),
      );
    });

    it('Invalid Parameter: o alvo volta ao último confirmado e o aviso diz que o valor foi recusado', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      rig.session.actions.changeSpeed(0.1);
      await advance(200);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);

      rewriteResult(rig, ControlPointOp.SetTargetSpeed, R.InvalidParameter);
      rig.session.actions.changeSpeed(0.1);
      expect(snap(rig).targetSpeedKmh).toBe(1);
      await advance(200);

      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('recusou o valor'),
        }),
      );
      expect(snap(rig).phase).toBe('connected');
      expect(snap(rig).control).toBe('granted');
      expect(snap(rig).busy).toBe(false);
    });

    it('Operation Failed num ajuste de inclinação: reverte e avisa', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await connect(rig);
      rewriteResult(rig, ControlPointOp.SetTargetInclination, R.OperationFailed);

      rig.session.actions.changeInclination(1);
      expect(snap(rig).targetInclinationPercent).toBe(1);
      await advance(300);

      expect(snap(rig).targetInclinationPercent).toBeNull();
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('ajustar a inclinação'),
        }),
      );
    });

    it('Op Code Not Supported: avisa que a esteira não permite o comando por Bluetooth', async () => {
      const rig = createRig();
      await connect(rig);
      rewriteResult(rig, ControlPointOp.StartOrResume, R.OpCodeNotSupported);

      rig.session.actions.start();
      await advance(300);

      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('não permite iniciar a lona por Bluetooth'),
        }),
      );
      expect(snap(rig).busy).toBe(false);
    });

    it('Op Code Not Supported em Set Target Speed reverte o alvo', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      rewriteResult(rig, ControlPointOp.SetTargetSpeed, R.OpCodeNotSupported);

      rig.session.actions.changeSpeed(0.1);
      await advance(200);

      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).notice?.message).toContain('não permite ajustar a velocidade');
    });

    it('Operation Failed no Stop: o aviso orienta a usar o Emergency Stop', async () => {
      const rig = createRig();
      await startBelt(rig);
      rewriteResult(rig, ControlPointOp.StopOrPause, R.OperationFailed);

      rig.session.actions.stop();
      await advance(300);

      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'warning',
          message: expect.stringContaining('Emergency Stop'),
        }),
      );
    });

    it('Operation Failed fora do Stop (ex.: Start) não menciona o Emergency Stop', async () => {
      const rig = createRig();
      await connect(rig);
      rewriteResult(rig, ControlPointOp.StartOrResume, R.OperationFailed);

      rig.session.actions.start();
      await advance(300);

      expect(snap(rig).notice?.kind).toBe('error');
      expect(snap(rig).notice?.message).not.toContain('Emergency Stop');
    });

    it('código de resultado desconhecido: reverte e avisa com o código', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      rewriteResult(rig, ControlPointOp.SetTargetSpeed, 0x7f);

      rig.session.actions.changeSpeed(0.1);
      await advance(200);

      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({ kind: 'error', message: expect.stringContaining('0x7F') }),
      );
    });

    it('escrita que falha num ajuste: reverte e o aviso traz a mensagem do erro', async () => {
      const rig = createRig({ notifyStatusToCommander: false });
      await startBelt(rig);
      rig.hooks.write = () => Promise.reject(new Error('GATT error 133'));

      rig.session.actions.changeSpeed(0.1);
      await advance(200);

      expect(snap(rig).targetSpeedKmh).toBeNull();
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('GATT error 133'),
        }),
      );
      expect(snap(rig).busy).toBe(false);
    });

    it('escrita que falha no Stop: insiste até o prazo e então orienta o Emergency Stop', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.hooks.write = () => Promise.reject(new Error('GATT error 133'));

      rig.session.actions.stop();
      await advance(11_000);

      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Não foi possível parar a lona pelo app'),
        }),
      );
      expect(snap(rig).notice?.message).toContain('GATT error 133');
      expect(snap(rig).notice?.message).toContain('Emergency Stop');
      // Não deu para parar: o app não finge que a lona parou.
      expect(snap(rig).belt).toBe('running');
      expect(snap(rig).busy).toBe(false);
    });
  });

  describe('Stop com falha de escrita', () => {
    /** Falha as `failures` primeiras escritas do Stop; o resto passa. */
    function failStopWrites(rig: Rig, failures: number) {
      let attempts = 0;
      rig.hooks.write = (data, forward) => {
        if (data[0] === ControlPointOp.StopOrPause) {
          attempts++;
          if (attempts <= failures) return Promise.reject(new Error('GATT error 133'));
        }
        return forward();
      };
    }
    const stopWrites = (rig: Rig) => rig.writes.filter((write) => write === STOP).length;

    it('falha nas duas primeiras escritas e funciona na terceira: nenhum aviso, lona parada', async () => {
      const rig = createRig();
      await startBelt(rig);
      failStopWrites(rig, 2);

      rig.session.actions.stop();
      expect(stopWrites(rig)).toBe(1);
      await advance(299);
      expect(stopWrites(rig)).toBe(1);
      await advance(1);
      expect(stopWrites(rig)).toBe(2);
      await advance(299);
      expect(stopWrites(rig)).toBe(2);
      expect(snap(rig).notice).toBeNull();
      await advance(1);
      expect(stopWrites(rig)).toBe(3);

      await advance(200);
      expect(snap(rig).belt).toBe('stopped');
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).busy).toBe(false);
    });

    it('falha em todas as escritas: repete a cada stopRetryDelayMs e só avisa quando o prazo (stopDeadlineMs) acaba', async () => {
      const rig = createRig();
      await startBelt(rig);
      failStopWrites(rig, Infinity);

      rig.session.actions.stop();
      // O app para de insistir um pouco antes do prazo: não começa uma tentativa
      // que não teria tempo de terminar (repetição de 300 ms + folga de 500 ms).
      await advance(9000);
      // Sem limite fixo de repetições: segue tentando durante todo o prazo.
      expect(stopWrites(rig)).toBeGreaterThan(20);
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).busy).toBe(true);

      await advance(1500);
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Emergency Stop'),
        }),
      );
      expect(snap(rig).busy).toBe(false);
      const total = stopWrites(rig);
      expect(total).toBeLessThanOrEqual(35);
      await advance(5000);
      expect(stopWrites(rig)).toBe(total);
    });

    it('só o Stop é repetido: um ajuste de velocidade cuja escrita falha não é', async () => {
      const rig = createRig();
      await startBelt(rig);
      rig.hooks.write = () => Promise.reject(new Error('GATT error 133'));
      rig.writes.length = 0;

      rig.session.actions.changeSpeed(0.1);
      await advance(2000);

      expect(rig.writes).toEqual([speedCmd(0.9)]);
    });
  });

  describe('esteira que não confirma (muteControlPoint)', () => {
    it('termina cada comando por timeout, avisa, segue conectada e usa a espera curta nos seguintes', async () => {
      const rig = createRig({ muteControlPoint: true });
      await connect(rig);

      rig.session.actions.start();
      await advance(2999);
      expect(snap(rig).busy).toBe(true);
      expect(rig.writes).toEqual([REQUEST_CONTROL]);
      expect(snap(rig).control).toBe('requesting');

      // Request Control sem resposta: segue como concedido e manda o Start.
      await advance(1);
      expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
      expect(snap(rig).control).toBe('granted');
      expect(snap(rig).busy).toBe(true);

      // Depois de um comando sem indication, a espera cai para unconfirmedGraceMs.
      await advance(499);
      expect(snap(rig).busy).toBe(true);
      await advance(1);
      expect(snap(rig).busy).toBe(false);
      expect(snap(rig).belt).toBe('running');
      expect(snap(rig).phase).toBe('connected');
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'warning',
          message: expect.stringContaining('não confirmou'),
        }),
      );

      // A sessão segue utilizável: ajuste de velocidade usa a espera curta.
      await advance(1000);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(0.8, 5);
      rig.session.actions.changeSpeed(0.1);
      await advance(499);
      expect(snap(rig).busy).toBe(true);
      await advance(1);
      expect(snap(rig).busy).toBe(false);
      expect(speedWrites(rig)).toEqual([speedCmd(0.9)]);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);

      rig.session.actions.pause();
      await advance(500);
      expect(snap(rig).belt).toBe('paused');
      expect(snap(rig).phase).toBe('connected');
      expect(snap(rig).notice).toEqual(expect.objectContaining({ kind: 'warning' }));
    });

    it('sem confirmação do Stop, o aviso orienta a usar o Emergency Stop', async () => {
      const rig = createRig({ muteControlPoint: true });
      await startBelt0Mute(rig);

      rig.session.actions.stop();
      await advance(600);

      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'warning',
          message: expect.stringContaining('Emergency Stop'),
        }),
      );
    });

    it('uma indication que chega depois do timeout é ignorada e a sessão continua usável', async () => {
      const rig = createRig();
      await startBelt(rig);
      let held: Uint8Array | null = null;
      rig.hooks.indication = (data) => {
        held ??= data;
        return null;
      };

      rig.session.actions.changeSpeed(0.1);
      await advance(3100);
      expect(snap(rig).notice?.kind).toBe('warning');
      expect(held).not.toBeNull();
      const before = snap(rig);

      rig.hooks.indication = undefined;
      rig.deliverIndication(held as unknown as Uint8Array);
      expect(snap(rig).notice).toBe(before.notice);
      expect(snap(rig).targetSpeedKmh).toBe(before.targetSpeedKmh);
      expect(snap(rig).busy).toBe(false);

      rig.session.actions.changeSpeed(0.1);
      await advance(100);
      expect(snap(rig).targetSpeedKmh).toBe(1);
      expect(speedWrites(rig)).toEqual([speedCmd(0.9), speedCmd(1)]);
      expect(snap(rig).busy).toBe(false);
    });
  });

  describe('Request Control com falha de escrita', () => {
    it('falha na primeira tentativa e funciona na segunda: tenta de novo depois de controlRetryDelayMs e o comando executa', async () => {
      const rig = createRig();
      await connect(rig);
      let failed = false;
      rig.hooks.write = (_data, forward) => {
        if (!failed) {
          failed = true;
          return Promise.reject(new Error('Insufficient Encryption'));
        }
        return forward();
      };

      rig.session.actions.start();
      await advance(499);
      expect(rig.writes).toEqual([REQUEST_CONTROL]);
      expect(snap(rig).busy).toBe(true);
      expect(snap(rig).notice).toBeNull();

      await advance(1);
      expect(rig.writes).toEqual([REQUEST_CONTROL, REQUEST_CONTROL]);

      await advance(300);
      expect(rig.writes).toEqual([REQUEST_CONTROL, REQUEST_CONTROL, START]);
      expect(snap(rig).control).toBe('granted');
      expect(snap(rig).belt).toBe('running');
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).busy).toBe(false);
    });

    it('falha nas duas tentativas: control volta a "idle" e o aviso traz o erro e a dica de pareamento', async () => {
      const rig = createRig();
      await connect(rig);
      rig.hooks.write = () => Promise.reject(new Error('Insufficient Encryption'));

      rig.session.actions.start();
      await advance(1000);

      expect(rig.writes).toEqual([REQUEST_CONTROL, REQUEST_CONTROL]);
      // A escrita falhou: não houve recusa da esteira, então o controle não é "denied".
      expect(snap(rig).control).toBe('idle');
      expect(snap(rig).notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Insufficient Encryption'),
        }),
      );
      expect(snap(rig).notice?.message).toContain('parear');
      expect(snap(rig).busy).toBe(false);
      expect(snap(rig).belt).not.toBe('running');
    });
  });

  describe('controle perdido sem aviso', () => {
    it('Control Not Permitted com a sessão achando que tinha controle: pede de novo, uma vez, e repete o comando', async () => {
      const rig = createRig();
      rig.hooks.suppressMachineStatus = true;
      await startBelt(rig);
      rig.sim.revokeControl(); // a esteira tira o controle e a sessão não fica sabendo
      expect(snap(rig).control).toBe('granted');
      rig.writes.length = 0;

      rig.session.actions.pause();
      await advance(500);

      expect(rig.writes).toEqual([PAUSE, REQUEST_CONTROL, PAUSE]);
      expect(snap(rig).control).toBe('granted');
      expect(snap(rig).belt).toBe('paused');
      expect(snap(rig).notice).toBeNull();
      expect(snap(rig).busy).toBe(false);
    });

    it('se a esteira recusar de novo, não insiste: 2 tentativas do comando, control "denied" e aviso', async () => {
      const rig = createRig();
      rig.hooks.suppressMachineStatus = true;
      await startBelt(rig);
      rewriteResult(rig, ControlPointOp.StopOrPause, R.ControlNotPermitted);
      rig.writes.length = 0;

      rig.session.actions.pause();
      await advance(1000);

      expect(rig.writes).toEqual([PAUSE, REQUEST_CONTROL, PAUSE]);
      expect(snap(rig).control).toBe('denied');
      expect(snap(rig).notice?.kind).toBe('error');
      expect(snap(rig).busy).toBe(false);
    });

    it('o mesmo vale para um ajuste de velocidade', async () => {
      const rig = createRig();
      rig.hooks.suppressMachineStatus = true;
      await startBelt(rig);
      rig.sim.revokeControl();
      rig.writes.length = 0;

      rig.session.actions.changeSpeed(0.1);
      await advance(500);

      expect(rig.writes).toEqual([speedCmd(0.9), REQUEST_CONTROL, speedCmd(0.9)]);
      expect(snap(rig).targetSpeedKmh).toBe(0.9);
      expect(snap(rig).notice).toBeNull();
      await advance(1500);
      expect(snap(rig).metrics.speedKmh).toBeCloseTo(0.9, 5);
    });
  });
});

describe('eventos do console (Fitness Machine Status)', () => {
  it('consoleSetSpeed e consoleSetInclination atualizam os alvos', async () => {
    const rig = createRig();
    await startBelt(rig);

    rig.sim.consoleSetSpeed(5);
    rig.sim.consoleSetInclination(2.5);
    await advance(0);

    expect(snap(rig).targetSpeedKmh).toBe(5);
    expect(snap(rig).targetInclinationPercent).toBe(2.5);
  });

  it('o alvo do console não atropela um pedido do app que ainda está na fila', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1); // em andamento
    rig.session.actions.changeSpeed(0.1); // na fila: 1,0
    rig.sim.consoleSetSpeed(5);

    expect(snap(rig).targetSpeedKmh).toBe(1);
  });

  it('consoleStop, consolePause e consoleStart atualizam a lona', async () => {
    const rig = createRig();
    await startBelt(rig);

    rig.sim.consolePause();
    expect(snap(rig).belt).toBe('paused');
    rig.sim.consoleStart();
    expect(snap(rig).belt).toBe('running');
    rig.sim.consoleStop();
    expect(snap(rig).belt).toBe('stopped');
    // O console não usa o controle: nada foi escrito além do pedido e do Start.
    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
  });

  it('parar pelo console limpa o alvo de velocidade e descarta os comandos na fila', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(5);
    await advance(6000);
    expect(snap(rig).targetSpeedKmh).toBe(5);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1); // 5,1 em andamento
    rig.session.actions.changeSpeed(0.1); // 5,2 na fila
    rig.session.actions.changeInclination(1); // na fila
    rig.sim.consoleStop();

    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).targetSpeedKmh).toBeNull();
    expect(snap(rig).targetInclinationPercent).toBeNull();
    await advance(500);
    expect(rig.writes).toEqual([speedCmd(5.1)]);
    expect(snap(rig).busy).toBe(false);
  });

  it('pausar pelo console também descarta a fila, mas mantém o alvo', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(3);
    await advance(3000);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeSpeed(0.1);
    rig.sim.consolePause();

    expect(snap(rig).belt).toBe('paused');
    expect(snap(rig).targetSpeedKmh).toBe(3.1);
    await advance(500);
    expect(rig.writes).toEqual([speedCmd(3.1)]);
  });

  it('depois de parar pelo console com um ajuste em andamento, o ajuste seguinte ainda chega à esteira', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1); // 0,9 em andamento: a indication ainda vai chegar
    rig.sim.consoleStop();
    await advance(500);
    expect(snap(rig).belt).toBe('stopped');

    // A esteira recomeça no mínimo (0,8); o app mede 0,8 e pede 0,9.
    rig.sim.consoleStart();
    await advance(1100);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(0.8, 5);
    rig.session.actions.changeSpeed(0.1);
    await advance(300);

    expect(speedWrites(rig)).toEqual([speedCmd(0.9), speedCmd(0.9)]);
  });

  it('a chave de segurança puxada: belt "safetyKey", alvo limpo e fila descartada', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(4);
    await advance(4000);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeInclination(1);
    rig.sim.pullSafetyKey();

    expect(snap(rig).belt).toBe('safetyKey');
    expect(snap(rig).targetSpeedKmh).toBeNull();
    expect(snap(rig).targetInclinationPercent).toBeNull();
    await advance(500);
    expect(rig.writes).toEqual([speedCmd(4.1)]);
    expect(snap(rig).busy).toBe(false);
  });

  it('revokeControl(): control "lost" com aviso; o próximo comando pede o controle de novo e funciona', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.sim.revokeControl();
    expect(snap(rig).control).toBe('lost');
    expect(snap(rig).notice).toEqual(expect.objectContaining({ kind: 'warning' }));

    rig.session.actions.pause();
    await advance(300);

    expect(rig.writes).toEqual([REQUEST_CONTROL, PAUSE]);
    expect(snap(rig).control).toBe('granted');
    expect(snap(rig).belt).toBe('paused');
  });

  it('revokeControl() com comando em andamento: descarta a fila e o app volta a conseguir comandar', async () => {
    const rig = createRig();
    await startBelt(rig);

    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeSpeed(0.1);
    rig.sim.revokeControl();
    await advance(500);

    expect(snap(rig).busy).toBe(false);
    rig.writes.length = 0;
    rig.session.actions.changeSpeed(0.1);
    await advance(300);
    expect(rig.writes[0]).toBe(REQUEST_CONTROL);
    expect(snap(rig).control).toBe('granted');
  });
});

describe('alvo velho (esteira que não avisa mudanças do console)', () => {
  it('velocidade: quando a lona assenta noutro valor, o alvo some e o próximo ajuste parte da velocidade medida', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(300);
    expect(snap(rig).targetSpeedKmh).toBe(0.9);

    rig.sim.consoleSetSpeed(5); // ninguém avisa o app
    // Enquanto a lona ainda acelera, o alvo não é descartado.
    await advance(3000);
    expect(snap(rig).targetSpeedKmh).toBe(0.9);

    await advance(15_000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(5, 5);
    expect(snap(rig).targetSpeedKmh).toBeNull();

    rig.writes.length = 0;
    rig.session.actions.changeSpeed(0.1);
    expect(snap(rig).targetSpeedKmh).toBe(5.1);
    await advance(300);
    expect(rig.writes).toEqual([speedCmd(5.1)]);
  });

  it('um alvo que a esteira cumpriu não é descartado', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(2);
    await advance(20_000);

    expect(snap(rig).metrics.speedKmh).toBeCloseTo(2.8, 5);
    expect(snap(rig).targetSpeedKmh).toBe(2.8);
  });

  it('inclinação: idem', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await connect(rig);
    rig.session.actions.changeInclination(2);
    await advance(3000);
    expect(snap(rig).targetInclinationPercent).toBe(2);
    expect(snap(rig).metrics.inclinationPercent).toBeCloseTo(2, 5);

    rig.sim.consoleSetInclination(6);
    await advance(2000);
    expect(snap(rig).targetInclinationPercent).toBe(2);

    await advance(30_000);
    expect(snap(rig).metrics.inclinationPercent).toBeCloseTo(6, 5);
    expect(snap(rig).targetInclinationPercent).toBeNull();

    rig.writes.length = 0;
    rig.session.actions.changeInclination(0.5);
    expect(snap(rig).targetInclinationPercent).toBe(6.5);
    await advance(300);
    expect(rig.writes).toEqual([inclinationCmd(6.5)]);
  });

  it('sem o descarte (esteira que avisa), o alvo do console vale e nada é descartado', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(5);
    await advance(20_000);

    expect(snap(rig).targetSpeedKmh).toBe(5);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(5, 5);
  });
});

describe('estado da lona sem confirmação do comando', () => {
  /** A esteira ignora, sem resposta nenhuma, as escritas com este op code. */
  function swallow(rig: Rig, opCode: number) {
    rig.hooks.write = (data, forward) => (data[0] === opCode ? Promise.resolve() : forward());
  }

  it('timeout do Start não afirma que a lona está andando', async () => {
    const rig = createRig();
    await connect(rig);
    await advance(1000);
    expect(snap(rig).belt).toBe('stopped');
    swallow(rig, ControlPointOp.StartOrResume);

    rig.session.actions.start();
    await advance(3100);

    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'warning',
        message: expect.stringContaining('iniciar a lona'),
      }),
    );
    expect(snap(rig).belt).toBe('stopped');
  });

  it('timeout do Stop: o aviso orienta o Emergency Stop e o estado da lona não muda', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(3);
    await advance(4000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(3, 5);
    swallow(rig, ControlPointOp.StopOrPause);

    rig.session.actions.stop();
    await advance(3100);
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'warning',
        message: expect.stringContaining('Emergency Stop'),
      }),
    );
    expect(snap(rig).belt).toBe('running');

    // Cinco amostras depois a lona continua a 3 km/h, e o app continua dizendo que roda.
    await advance(5000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(3, 5);
    expect(snap(rig).belt).toBe('running');
  });

  it('Stop confirmado com a lona seguindo firme a 3 km/h: a velocidade medida corrige o estado', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(3);
    await advance(4000);
    swallow(rig, ControlPointOp.StopOrPause);

    rig.session.actions.stop();
    await advance(10);
    // A indication de sucesso chega, mas a lona não parou.
    rig.deliverIndication(
      Uint8Array.of(ControlPointOp.ResponseCode, ControlPointOp.StopOrPause, R.Success),
    );
    await advance(100);
    expect(snap(rig).belt).toBe('stopped');

    await advance(6000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(3, 5);
    expect(snap(rig).belt).toBe('running');
  });

  it('depois de pausar, a lona freando não volta a "running"', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(5);
    await advance(6000);

    rig.sim.consolePause();
    for (let i = 0; i < 5; i++) {
      await advance(1000);
      expect(snap(rig).belt).toBe('paused');
    }
    expect(snap(rig).metrics.speedKmh).toBe(0);
  });
});

describe('Stop com um comando em voo', () => {
  it('esteira que não responde: o Stop sai stopPreemptDelayMs depois do toque, não depois do timeout', async () => {
    const rig = createRig({ muteControlPoint: true }, { unconfirmedGraceMs: 2000 });
    await connect(rig);

    rig.session.actions.start();
    await advance(3500); // Request Control expirou (3 s); o Start espera a indication
    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
    expect(snap(rig).busy).toBe(true);

    rig.session.actions.stop();
    await advance(249);
    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
    await advance(1);
    expect(rig.writes).toEqual([REQUEST_CONTROL, START, STOP]);
    // O Start encerrado à força não vira aviso.
    expect(snap(rig).notice?.message ?? '').not.toContain('iniciar a lona');
  });

  it('esteira normal: o comando em voo termina e o Stop sai logo depois, sem escrita recusada', async () => {
    const rig = createRig();
    await startBelt(rig);
    const stamps: [string, number][] = [];
    rig.hooks.write = (data, forward) => {
      stamps.push([bytesToHex(data), Date.now()]);
      return forward();
    };
    const taps = Date.now();

    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.stop();
    await advance(1000);

    expect(stamps.map(([hex]) => hex)).toEqual([speedCmd(0.9), STOP]);
    expect(stamps[1][1]).toBeLessThan(taps + 250);
    expect(snap(rig).log.filter((entry) => entry.kind === 'error')).toEqual([]);
    expect(snap(rig).notice).toBeNull();
    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).busy).toBe(false);
  });

  it('Request Control em voo sem resposta: o controle volta a "idle", o Stop pede de novo e o Start é abandonado', async () => {
    const rig = createRig();
    await connect(rig);
    let swallowed = false;
    rig.hooks.write = (data, forward) => {
      if (data[0] === ControlPointOp.RequestControl && !swallowed) {
        swallowed = true;
        return Promise.resolve();
      }
      return forward();
    };

    rig.session.actions.start();
    await advance(100);
    expect(snap(rig).control).toBe('requesting');
    expect(rig.writes).toEqual([REQUEST_CONTROL]);

    rig.session.actions.stop();
    await advance(249);
    expect(rig.writes).toEqual([REQUEST_CONTROL]);
    await advance(1);
    expect(snap(rig).control).not.toBe('granted');

    await advance(300);
    expect(rig.writes).toEqual([REQUEST_CONTROL, REQUEST_CONTROL, STOP]);
    expect(snap(rig).control).toBe('granted');
    // O Start foi abandonado: a lona nunca andou (e parar uma lona parada é recusado pela esteira).
    expect(rig.writes).not.toContain(START);
    expect(snap(rig).belt).not.toBe('running');
    expect(snap(rig).busy).toBe(false);
  });

  it('esteira normal com Request Control em voo: o Start não sai mais e só o Stop chega à esteira', async () => {
    const rig = createRig();
    await connect(rig);

    rig.session.actions.start();
    rig.session.actions.stop();
    await advance(1000);

    expect(rig.writes).toEqual([REQUEST_CONTROL, STOP]);
    expect(snap(rig).control).toBe('granted');
    expect(snap(rig).belt).not.toBe('running');
    // Parar uma lona que nunca andou é recusado pela esteira (Operation Failed):
    // vira aviso com a orientação do botão Stop, não erro.
    expect(snap(rig).notice?.kind).toBe('warning');
    expect(snap(rig).busy).toBe(false);
  });
});

/** Valor, em km/h, de um Set Target Speed em hexadecimal ("02 5A 00" -> 0,9). */
function speedOfWrite(hex: string): number {
  const [, low, high] = hex.split(' ').map((byte) => parseInt(byte, 16));
  return (low | (high << 8)) / 100;
}

describe('Parar: prioridade sobre a esteira lenta, muda ou que recusa', () => {
  const stopWrites = (rig: Rig) => rig.writes.filter((write) => write === STOP);

  it('R1: esteira leva 3 s para concluir o Start; as escritas do Stop são recusadas até lá e a seguinte é aceita', async () => {
    const rig = createRig({ notifyStatusToCommander: false });
    await connect(rig);
    let busyUntil = 0;
    rig.hooks.write = (data, forward) => {
      if (Date.now() < busyUntil) {
        return Promise.reject(new Error('Procedure Already In Progress'));
      }
      if (data[0] === ControlPointOp.StartOrResume) busyUntil = Date.now() + 3000;
      return forward();
    };
    // A indication do Start só chega 3 s depois da escrita.
    rig.hooks.indication = (data) => {
      if (data[1] !== ControlPointOp.StartOrResume) return data;
      setTimeout(() => rig.deliverIndication(data), 2960);
      return null;
    };

    rig.session.actions.start();
    await advance(500);
    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);

    rig.session.actions.stop();
    await advance(2000);
    // Recusado várias vezes enquanto o Start não conclui.
    expect(stopWrites(rig).length).toBeGreaterThan(2);
    expect(snap(rig).busy).toBe(true);
    expect(snap(rig).notice).toBeNull();

    await advance(3000);
    expect(snap(rig).busy).toBe(false);
    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).notice).toBeNull();
    expect(rig.writes.filter((write) => write === START)).toHaveLength(1);
    expect(snap(rig).log.some((entry) => entry.label.includes('sem resposta'))).toBe(false);

    // A esteira de fato parou.
    await advance(3000);
    expect(snap(rig).metrics.speedKmh).toBe(0);
  });

  it('R1b: esteira que nunca aceita o Stop: avisa depois de stopDeadlineMs, libera o busy e um novo toque tenta de novo', async () => {
    const rig = createRig({}, { stopDeadlineMs: 2000 });
    await startBelt(rig);
    rig.hooks.write = (data, forward) =>
      data[0] === ControlPointOp.StopOrPause
        ? Promise.reject(new Error('Procedure Already In Progress'))
        : forward();

    rig.session.actions.stop();
    // Com prazo de 2 s, a última tentativa começa até 1,2 s (repetição + folga).
    await advance(1000);
    expect(snap(rig).notice).toBeNull();
    expect(snap(rig).busy).toBe(true);

    await advance(1100);
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Emergency Stop'),
      }),
    );
    expect(snap(rig).busy).toBe(false);
    expect(snap(rig).belt).toBe('running');
    const tried = stopWrites(rig).length;

    // Novo toque: tenta outra vez (agora a esteira aceita).
    rig.hooks.write = undefined;
    rig.session.actions.stop();
    await advance(500);
    expect(stopWrites(rig).length).toBeGreaterThan(tried);
    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).busy).toBe(false);
  });

  it('H: enquanto o Stop não é aceito, + e - não geram comandos, nem depois que o Stop termina ou falha', async () => {
    const rig = createRig({}, { stopDeadlineMs: 2000 });
    await startBelt(rig);
    rig.hooks.write = (data, forward) =>
      data[0] === ControlPointOp.StopOrPause
        ? Promise.reject(new Error('Procedure Already In Progress'))
        : forward();
    rig.writes.length = 0;

    rig.session.actions.stop();
    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeInclination(1);
    rig.session.actions.pause();
    rig.session.actions.start();
    await advance(5000); // o prazo acaba e o Stop falha

    expect(snap(rig).notice?.kind).toBe('error');
    expect(snap(rig).busy).toBe(false);
    expect(speedWrites(rig)).toEqual([]);
    expect(inclinationWrites(rig)).toEqual([]);
    expect(rig.writes.filter((write) => write === PAUSE || write === START)).toEqual([]);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    expect(snap(rig).targetInclinationPercent).toBeNull();
  });

  it('H: o mesmo vale quando o Stop é aceito depois de algumas recusas', async () => {
    const rig = createRig();
    await startBelt(rig);
    let refusals = 2;
    rig.hooks.write = (data, forward) =>
      data[0] === ControlPointOp.StopOrPause && refusals-- > 0
        ? Promise.reject(new Error('Procedure Already In Progress'))
        : forward();
    rig.writes.length = 0;

    rig.session.actions.stop();
    await advance(100);
    rig.session.actions.changeSpeed(0.1);
    await advance(3000);

    expect(rig.writes.filter((write) => write === STOP)).toHaveLength(3);
    expect(speedWrites(rig)).toEqual([]);
    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).notice).toBeNull();
  });

  it('A: com um Parar pendente nenhum outro comando é escrito, mesmo o que já estava na fila', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.changeInclination(0.5); // em voo
    rig.session.actions.changeSpeed(0.1); // na fila
    rig.session.actions.stop();
    await advance(1000);

    expect(rig.writes).toEqual([inclinationCmd(0.5), STOP]);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    expect(snap(rig).belt).toBe('stopped');
  });

  it('C: Control Permission Lost com ajuste em voo e Stop pendente não descarta o Stop: ele sai, com novo Request Control antes', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.hooks.indication = (data) => (data[1] === ControlPointOp.SetTargetSpeed ? null : data);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(10);
    rig.session.actions.stop();
    rig.sim.revokeControl();
    expect(snap(rig).control).toBe('lost');

    rig.hooks.indication = undefined;
    await advance(1000);

    expect(rig.writes).toEqual([speedCmd(0.9), REQUEST_CONTROL, STOP]);
    expect(snap(rig).control).toBe('granted');
    expect(snap(rig).belt).toBe('stopped');
  });

  it('C: pausa feita no console com Stop pendente também não descarta o Stop', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.hooks.indication = (data) => (data[1] === ControlPointOp.SetTargetSpeed ? null : data);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(10);
    rig.session.actions.stop();
    rig.sim.consolePause();
    rig.hooks.indication = undefined;
    await advance(1000);

    expect(rig.writes.filter((write) => write === STOP)).toHaveLength(1);
  });

  it('R3: Start recusado com Control Not Permitted e Stop tocado durante o novo Request Control: o Start não é reenviado', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await connect(rig);
    rig.session.actions.changeInclination(0.5);
    await advance(300);
    expect(snap(rig).control).toBe('granted');

    rig.sim.revokeControl(); // a sessão não fica sabendo
    let requestResponses = 0;
    rig.hooks.indication = (data) =>
      data[1] === ControlPointOp.RequestControl && ++requestResponses === 1 ? null : data;
    rig.writes.length = 0;

    rig.session.actions.start();
    await advance(200);
    // O Start foi recusado e o novo Request Control espera a resposta.
    expect(rig.writes).toEqual([START, REQUEST_CONTROL]);

    rig.session.actions.stop();
    await advance(1500);

    expect(rig.writes.filter((write) => write === START)).toHaveLength(1);
    expect(stopWrites(rig)).toHaveLength(1);
    expect(rig.writes[rig.writes.length - 1]).toBe(STOP);
    expect(snap(rig).belt).not.toBe('running');
    expect(snap(rig).busy).toBe(false);
  });

  it('R3 (variante): o novo Request Control responde logo, antes de o Parar passar por cima, e mesmo assim o Start não é reenviado', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await connect(rig);
    rig.session.actions.changeInclination(0.5);
    await advance(300);
    expect(snap(rig).control).toBe('granted');

    rig.sim.revokeControl(); // a sessão não fica sabendo
    rig.writes.length = 0;

    rig.session.actions.start();
    await advance(50);
    // O Start foi recusado (Control Not Permitted) e o novo Request Control acabou de sair.
    expect(rig.writes).toEqual([START, REQUEST_CONTROL]);

    // O Request Control responde Success em seguida, bem antes de stopPreemptDelayMs.
    rig.session.actions.stop();
    await advance(1500);

    expect(rig.writes).toEqual([START, REQUEST_CONTROL, STOP]);
    expect(snap(rig).control).toBe('granted');
    expect(snap(rig).belt).not.toBe('running');
    expect(snap(rig).busy).toBe(false);
  });

  it('R9: Stop tocado durante a pausa de controlRetryDelayMs sai logo, sem esperar o intervalo nem o timeout', async () => {
    const rig = createRig({}, { controlRetryDelayMs: 8000, responseTimeoutMs: 10_000 });
    await connect(rig);
    let failed = false;
    rig.hooks.write = (_data, forward) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('Insufficient Encryption'));
      }
      return forward();
    };

    rig.session.actions.start();
    await advance(100);
    expect(rig.writes).toEqual([REQUEST_CONTROL]);

    rig.session.actions.stop();
    await advance(300);

    expect(rig.writes).toEqual([REQUEST_CONTROL, REQUEST_CONTROL, STOP]);
    expect(snap(rig).busy).toBe(false);
  });

  it('R11: Stop em repetição, queda de link e reconexão antes de stopRetryDelayMs: nada do Stop antigo vai para a conexão nova', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.hooks.write = (data, forward) =>
      data[0] === ControlPointOp.StopOrPause
        ? Promise.reject(new Error('Procedure Already In Progress'))
        : forward();

    rig.session.actions.stop();
    await advance(50);
    expect(stopWrites(rig)).toHaveLength(1);
    expect(snap(rig).busy).toBe(true);

    rig.sim.dropLink();
    await advance(0);
    expect(snap(rig).phase).toBe('idle');
    expect(snap(rig).busy).toBe(false);

    rig.hooks.write = undefined;
    rig.writes.length = 0;
    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200); // menos que stopRetryDelayMs (300) desde o toque
    expect(snap(rig).phase).toBe('connected');
    await advance(1500);
    expect(rig.writes).toEqual([]);
    expect(snap(rig).notice?.message ?? '').not.toContain('parar a lona');

    rig.session.actions.confirmIdentity();
    rig.session.actions.start();
    await advance(1000);
    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
    expect(snap(rig).belt).toBe('running');
    expect(snap(rig).busy).toBe(false);
  });
});

describe('escrita no Control Point que nunca resolve', () => {
  const hang = (rig: Rig, opCode: number) => {
    rig.hooks.write = (data, forward) =>
      data[0] === opCode ? new Promise<void>(() => undefined) : forward();
  };

  it('R4: com um Parar, o Stop sai stopPreemptDelayMs depois do toque e o busy volta a false', async () => {
    const rig = createRig();
    await startBelt(rig);
    hang(rig, ControlPointOp.SetTargetSpeed);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(100);
    expect(rig.writes).toEqual([speedCmd(0.9)]);
    expect(snap(rig).busy).toBe(true);

    rig.session.actions.stop();
    await advance(249);
    expect(rig.writes).toEqual([speedCmd(0.9)]);
    await advance(1);
    expect(rig.writes).toEqual([speedCmd(0.9), STOP]);

    await advance(300);
    expect(snap(rig).busy).toBe(false);
    expect(snap(rig).belt).toBe('stopped');
    expect(snap(rig).notice).toBeNull();
    expect(snap(rig).targetSpeedKmh).toBeNull();
  });

  it('R4: sem Parar, a escrita pendurada vira aviso de erro depois de writeTimeoutMs e o alvo é revertido', async () => {
    const rig = createRig();
    await startBelt(rig);
    hang(rig, ControlPointOp.SetTargetSpeed);

    rig.session.actions.changeSpeed(0.1);
    await advance(3999);
    expect(snap(rig).busy).toBe(true);
    expect(snap(rig).notice).toBeNull();

    await advance(1);
    expect(snap(rig).busy).toBe(false);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('ajustar a velocidade'),
      }),
    );
  });

  it('Request Control pendurado também expira, e o Stop não fica preso atrás dele', async () => {
    const rig = createRig();
    await connect(rig);
    hang(rig, ControlPointOp.RequestControl);

    rig.session.actions.start();
    await advance(100);
    expect(snap(rig).busy).toBe(true);

    rig.hooks.write = undefined;
    rig.session.actions.stop();
    await advance(400);
    expect(rig.writes).toContain(STOP);
    expect(snap(rig).busy).toBe(false);
  });
});

describe('Pausar, Iniciar e ajustes pendentes', () => {
  it('R2b: dois toques em + e Pausar em seguida: nenhum Set Target Speed sai depois do Pause', async () => {
    const rig = createRig({ notifyStatusToCommander: false });
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1); // em voo
    rig.session.actions.changeSpeed(0.1); // na fila
    rig.session.actions.pause();
    await advance(1000);

    const pauseAt = rig.writes.indexOf(PAUSE);
    expect(pauseAt).toBeGreaterThanOrEqual(0);
    expect(rig.writes.slice(pauseAt + 1).filter(isSpeedWrite)).toEqual([]);
    expect(snap(rig).belt).toBe('paused');
    expect(snap(rig).targetSpeedKmh).not.toBe(1);
  });

  it('Pausar descarta um Iniciar ainda na fila', async () => {
    const rig = createRig();
    await connect(rig);
    rig.session.actions.changeInclination(0.5); // em voo
    rig.session.actions.start(); // na fila
    rig.session.actions.pause();
    await advance(500);

    expect(rig.writes).not.toContain(START);
    expect(rig.writes).toContain(PAUSE);
  });

  it('R6: toque duplo em Pausar não retoma a lona; passado startLockoutMs o Iniciar funciona', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.pause();
    rig.session.actions.start(); // o botão virou "Retomar" no mesmo lugar
    await advance(200);
    rig.session.actions.start();
    await advance(500);

    expect(rig.writes).toEqual([PAUSE]);
    expect(snap(rig).belt).toBe('paused');

    // A lona freia (2 km/h por segundo) e para; depois do assentamento o Iniciar vale.
    await advance(2500);
    expect(snap(rig).startBlocked).toBe(false);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([PAUSE, START]);
    expect(snap(rig).belt).toBe('running');
  });

  it('o bloqueio de Iniciar vale também depois de um Parar do app', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.stop();
    await advance(200);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([STOP]);

    await advance(2500);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([STOP, START]);
  });

  it('o bloqueio de Iniciar vale depois de parada, pausa ou chave de segurança no console', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.sim.pullSafetyKey();
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([]);

    await advance(3000);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toContain(START);
  });
});

describe('alvo de velocidade velho na hora do toque', () => {
  /** Esteira que não avisa mudanças do console, com a lona a 9,8 km/h há muito tempo. */
  async function runningAt98() {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9);
    await advance(15_000);
    expect(snap(rig).targetSpeedKmh).toBe(9.8);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(9.8, 5);
    return rig;
  }

  it('R7: console baixa para 3 km/h e o toque em + enquanto a lona desacelera parte da velocidade medida', async () => {
    const rig = await runningAt98();
    rig.sim.consoleSetSpeed(3);
    await advance(1000);
    const measured = snap(rig).metrics.speedKmh as number;
    expect(measured).toBeCloseTo(7.8, 5);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(300);

    const sent = speedWrites(rig);
    expect(sent).toEqual([speedCmd(7.9)]);
    expect(speedOfWrite(sent[0])).toBeLessThanOrEqual(measured + 0.1 + 1e-9);
  });

  it('R7: o mesmo depois que a lona assenta em 3 km/h', async () => {
    const rig = await runningAt98();
    rig.sim.consoleSetSpeed(3);
    await advance(8000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(3, 5);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(300);

    expect(speedWrites(rig)).toEqual([speedCmd(3.1)]);
  });

  it('R7b: lona acelerando rumo ao alvo (definido há mais de 3 s): + soma ao alvo, não à velocidade medida', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9); // alvo 9,8; a lona sobe 1 km/h por segundo
    await advance(5000);
    const measured = snap(rig).metrics.speedKmh as number;
    expect(measured).toBeGreaterThan(4);
    expect(measured).toBeLessThan(8);
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    expect(snap(rig).targetSpeedKmh).toBe(9.9);
    await advance(300);
    expect(speedWrites(rig)).toEqual([speedCmd(9.9)]);
  });

  it('um alvo recém-definido (menos de targetTrustMs) é somado mesmo sem a lona ter chegado nele', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9);
    await advance(300);
    rig.session.actions.changeSpeed(0.1);

    expect(snap(rig).targetSpeedKmh).toBe(9.9);
  });
});

/** Faz a sessão receber estas velocidades, uma por notificação, no lugar das do simulador. */
function feedSpeeds(rig: Rig, next: () => number) {
  rig.hooks.treadmillData = () =>
    buildTreadmillData(
      {
        speedKmh: next(),
        distanceM: 0,
        inclinationPercent: 0,
        energyKcal: 0,
        energyPerMinuteKcal: 0,
        heartRateBpm: 100,
        elapsedS: 0,
      },
      0,
      false,
    )[0];
}

describe('rastreamento do alvo de velocidade (esteira que não avisa o console)', () => {
  /** Leituras que alternam ±0,02 em torno de `value`. */
  const noisy = (value: number) => {
    let i = 0;
    return () => value + (i++ % 2) * 0.02;
  };

  it('N1: console baixa para 3 km/h e as leituras ficam alternando 3,00/3,02: o alvo cai e + envia 3,1', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9);
    await advance(15_000);
    expect(snap(rig).targetSpeedKmh).toBe(9.8);

    rig.sim.consoleSetSpeed(3);
    const approach = [7.8, 5.8, 3.8, 3.0];
    const alternate = noisy(3);
    let i = 0;
    feedSpeeds(rig, () => (i < approach.length ? approach[i++] : alternate()));

    // Assim que a lona se afasta do alvo, ele é descartado.
    await advance(1000);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    await advance(8000);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    rig.writes.length = 0;

    rig.session.actions.changeSpeed(0.1);
    await advance(300);
    expect(speedWrites(rig)).toEqual([speedCmd(3.1)]);
  });

  it('N1: lona parada longe do alvo (duas amostras iguais) também descarta o alvo, passado targetTrustMs', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    feedSpeeds(rig, noisy(5));
    await advance(1000);
    rig.session.actions.changeSpeed(4.8);
    await advance(300);
    expect(snap(rig).targetSpeedKmh).toBe(9.8);

    // Ainda dentro do prazo de confiança: a esteira pode estar começando a reagir.
    await advance(1500);
    expect(snap(rig).targetSpeedKmh).toBe(9.8);

    await advance(5000);
    expect(snap(rig).targetSpeedKmh).toBeNull();
    rig.writes.length = 0;
    rig.session.actions.changeSpeed(0.1);
    await advance(300);
    expect(speedWrites(rig)).toEqual([speedCmd(5.1)]);
  });

  it('N2: alvo 11,8 atingido, o console baixa para 9 e sobe para 10: o + com a lona subindo parte da velocidade medida', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(11);
    await advance(15_000);
    expect(snap(rig).targetSpeedKmh).toBe(11.8);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(11.8, 5);

    rig.sim.consoleSetSpeed(9);
    await advance(1000);
    // A lona se afastou do alvo: ele foi descartado.
    expect(snap(rig).targetSpeedKmh).toBeNull();
    await advance(5000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(9, 5);

    rig.sim.consoleSetSpeed(10);
    // Subindo de novo na direção do alvo antigo, mas ele não ressuscita.
    expect(snap(rig).targetSpeedKmh).toBeNull();
    rig.writes.length = 0;
    rig.session.actions.changeSpeed(0.1);
    await advance(300);

    expect(speedWrites(rig)).toEqual([speedCmd(9.1)]);
  });

  it('contraprova: lona acelerando sem parar rumo ao alvo (passados 3 s) mantém o alvo e + soma a ele', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9); // 9,8; a lona sobe 1 km/h por segundo
    await advance(5000);
    expect(snap(rig).metrics.speedKmh as number).toBeLessThan(8);
    expect(snap(rig).targetSpeedKmh).toBe(9.8);

    rig.session.actions.changeSpeed(0.1);
    expect(snap(rig).targetSpeedKmh).toBe(9.9);
  });

  it('contraprova: lona no alvo com ruído de ±0,02 km/h não perde o alvo', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(9);
    await advance(300);
    feedSpeeds(rig, noisy(9.8));
    await advance(20_000);

    expect(snap(rig).targetSpeedKmh).toBe(9.8);
    rig.session.actions.changeSpeed(0.1);
    expect(snap(rig).targetSpeedKmh).toBe(9.9);
  });

  it('contraprova: pausar e retomar mantém o alvo', async () => {
    const rig = createRig();
    rig.hooks.suppressMachineStatus = true;
    await startBelt(rig);
    rig.session.actions.changeSpeed(2);
    await advance(3000);
    expect(snap(rig).targetSpeedKmh).toBe(2.8);

    rig.session.actions.pause();
    await advance(8000);
    expect(snap(rig).belt).toBe('paused');
    expect(snap(rig).metrics.speedKmh).toBe(0);
    expect(snap(rig).targetSpeedKmh).toBe(2.8);

    rig.session.actions.start();
    await advance(300);
    expect(snap(rig).belt).toBe('running');
    await advance(6000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(2.8, 5);
    expect(snap(rig).targetSpeedKmh).toBe(2.8);
  });
});

describe('Iniciar bloqueado enquanto a lona ainda gira (startBlocked)', () => {
  it('N3: Retomar 2 s depois de Pausar com a lona ainda a vários km/h não escreve nada; com a lona parada, funciona', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(8);
    await advance(9000);
    expect(snap(rig).metrics.speedKmh).toBeCloseTo(8, 5);
    expect(snap(rig).startBlocked).toBe(false);
    const blocked = track(rig, (s) => s.startBlocked);
    rig.writes.length = 0;

    rig.session.actions.pause();
    expect(snap(rig).startBlocked).toBe(true);
    await advance(2000);
    expect(snap(rig).metrics.speedKmh as number).toBeGreaterThan(2);
    expect(snap(rig).startBlocked).toBe(true);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([PAUSE]);

    // A lona para (8 km/h a 2 km/h por segundo) e o bloqueio cai sozinho.
    await advance(4500);
    expect(snap(rig).metrics.speedKmh).toBe(0);
    expect(snap(rig).startBlocked).toBe(false);
    expect(blocked).toEqual([false, true, false]);

    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([PAUSE, START]);
    expect(snap(rig).belt).toBe('running');
  });

  it('N3: o bloqueio também vale depois de um Parar e se solta com a lona parada', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.sim.consoleSetSpeed(6);
    await advance(7000);

    rig.session.actions.stop();
    await advance(300);
    expect(snap(rig).startBlocked).toBe(true);
    await advance(6000);
    expect(snap(rig).metrics.speedKmh).toBe(0);
    expect(snap(rig).startBlocked).toBe(false);
  });

  it('N3: esteira cuja velocidade nunca zera libera o Iniciar só depois de startMaxLockoutMs (15 s)', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.session.actions.pause();
    await advance(300);
    feedSpeeds(rig, () => 2);
    rig.writes.length = 0;

    await advance(13_500); // ~14 s depois do toque em Pausar
    expect(snap(rig).startBlocked).toBe(true);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([]);

    await advance(1500);
    expect(snap(rig).startBlocked).toBe(false);
    rig.session.actions.start();
    await advance(300);
    expect(rig.writes).toEqual([START]);
  });

  it('startBlocked volta a false ao desconectar', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.session.actions.pause();
    expect(snap(rig).startBlocked).toBe(true);

    rig.session.actions.disconnect();
    await advance(0);
    expect(snap(rig).startBlocked).toBe(false);
  });
});

describe('Parar dentro do prazo e escritas presas', () => {
  it('N4: com todas as escritas penduradas, o aviso de falha sai em ~stopDeadlineMs, não depois', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.hooks.write = () => new Promise<void>(() => undefined);

    rig.session.actions.stop();
    await advance(9900);
    expect(snap(rig).notice).toBeNull();
    expect(snap(rig).busy).toBe(true);

    await advance(200);
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Emergency Stop'),
      }),
    );
    expect(snap(rig).busy).toBe(false);
  });

  it('N5: escrita presa bloqueia os comandos comuns (sem escrever), não o Parar; ao resolver, tudo volta a funcionar', async () => {
    const rig = createRig();
    await startBelt(rig);
    let release: () => void = () => undefined;
    let hung = true;
    rig.hooks.write = (data, forward) =>
      hung && data[0] === ControlPointOp.SetTargetSpeed
        ? new Promise<void>((resolve) => (release = resolve))
        : forward();

    rig.session.actions.changeSpeed(0.1);
    await advance(4000);
    expect(snap(rig).notice).toEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('ajustar a velocidade'),
      }),
    );
    expect(snap(rig).targetSpeedKmh).toBeNull();
    const before = rig.writes.length;

    // Enquanto a escrita antiga não resolve, outro comando falha na hora, sem escrever.
    rig.session.actions.changeInclination(0.5);
    await advance(10);
    expect(rig.writes).toHaveLength(before);
    expect(snap(rig).notice?.message).toContain('ainda não respondeu');
    expect(snap(rig).busy).toBe(false);

    // O Parar continua escrevendo.
    rig.session.actions.stop();
    await advance(300);
    expect(rig.writes.slice(before)).toEqual([STOP]);
    expect(snap(rig).belt).toBe('stopped');

    // A escrita presa resolve e os comandos voltam.
    hung = false;
    release();
    await advance(0);
    rig.session.actions.changeInclination(0.5);
    await advance(300);
    expect(rig.writes.slice(before)).toEqual([STOP, inclinationCmd(0.5)]);
    expect(snap(rig).targetInclinationPercent).toBe(0.5);
  });

  it('N5: Request Control cuja escrita ficou presa não é repetido', async () => {
    const rig = createRig();
    await connect(rig);
    rig.hooks.write = (data, forward) =>
      data[0] === ControlPointOp.RequestControl ? new Promise<void>(() => undefined) : forward();

    rig.session.actions.start();
    await advance(4100);
    expect(rig.writes).toEqual([REQUEST_CONTROL]);
    expect(snap(rig).notice?.kind).toBe('error');
    expect(snap(rig).control).toBe('idle');

    await advance(5000);
    expect(rig.writes).toEqual([REQUEST_CONTROL]);
    expect(snap(rig).busy).toBe(false);
  });

  it('N5: Success do Request Control que chega sem pedido pendente passa o controle para "granted"', async () => {
    const rig = createRig();
    await connect(rig);
    expect(snap(rig).control).toBe('idle');

    rig.deliverIndication(
      Uint8Array.of(ControlPointOp.ResponseCode, ControlPointOp.RequestControl, R.Success),
    );
    expect(snap(rig).control).toBe('granted');
  });

  it('escrita presa que resolve com erro depois do prazo também libera os comandos', async () => {
    const rig = createRig();
    await startBelt(rig);
    let fail: (error: Error) => void = () => undefined;
    let hung = true;
    rig.hooks.write = (data, forward) =>
      hung && data[0] === ControlPointOp.SetTargetSpeed
        ? new Promise<void>((_resolve, reject) => (fail = reject))
        : forward();

    rig.session.actions.changeSpeed(0.1);
    await advance(4000);
    hung = false;
    fail(new Error('GATT error 133'));
    await advance(0);

    rig.writes.length = 0;
    rig.session.actions.changeInclination(0.5);
    await advance(300);
    expect(rig.writes).toEqual([inclinationCmd(0.5)]);
  });
});

describe('confirmação de que a esteira é a do usuário', () => {
  async function connectWithoutConfirming(rig: Rig): Promise<void> {
    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    expect(snap(rig).phase).toBe('connected');
  }

  it('antes da confirmação nenhum comando é escrito: nem ajuste, nem Iniciar, nem Parar', async () => {
    const rig = createRig();
    await connectWithoutConfirming(rig);
    expect(snap(rig).identityConfirmed).toBe(false);

    rig.session.actions.start();
    rig.session.actions.changeInclination(0.5);
    rig.session.actions.changeSpeed(1);
    rig.session.actions.pause();
    rig.session.actions.stop();
    await advance(2000);

    expect(rig.writes).toEqual([]);
    expect(snap(rig).control).toBe('idle');
    expect(snap(rig).targetInclinationPercent).toBeNull();
    expect(snap(rig).busy).toBe(false);
    // Os dados continuam chegando: é por eles que o usuário confere a esteira.
    expect(snap(rig).metrics.updatedAt).not.toBeNull();
  });

  it('depois da confirmação os comandos saem normalmente', async () => {
    const rig = createRig();
    await connectWithoutConfirming(rig);

    rig.session.actions.confirmIdentity();
    expect(snap(rig).identityConfirmed).toBe(true);
    rig.session.actions.start();
    await advance(200);

    expect(rig.writes).toEqual([REQUEST_CONTROL, START]);
    expect(snap(rig).belt).toBe('running');
  });

  it('a confirmação não sobrevive à desconexão', async () => {
    const rig = createRig();
    await connect(rig);
    expect(snap(rig).identityConfirmed).toBe(true);

    rig.session.actions.disconnect();
    await advance(100);
    expect(snap(rig).identityConfirmed).toBe(false);

    await connectWithoutConfirming(rig);
    expect(snap(rig).identityConfirmed).toBe(false);
  });

  it('a confirmação também não sobrevive a uma queda de link', async () => {
    const rig = createRig();
    await connect(rig);
    expect(snap(rig).identityConfirmed).toBe(true);

    rig.sim.dropLink();
    await advance(100);
    expect(snap(rig).phase).toBe('idle');
    expect(snap(rig).identityConfirmed).toBe(false);

    // Reconectou (talvez em outra esteira): sem confirmar de novo, nada é comandado.
    await connectWithoutConfirming(rig);
    rig.session.actions.start();
    rig.session.actions.stop();
    await advance(1000);
    expect(snap(rig).identityConfirmed).toBe(false);
    expect(rig.writes).toEqual([]);
  });

  it('esteira que só transmite dados não pede confirmação', async () => {
    const rig = createRig({ hasControlPoint: false });
    await connectWithoutConfirming(rig);
    expect(snap(rig).identityConfirmed).toBe(true);
  });

  it('o modo demonstração já vem confirmado', async () => {
    const rig = createRig();
    rig.session.actions.openDemo();
    await advance(200);
    expect(snap(rig).mode).toBe('demo');
    expect(snap(rig).identityConfirmed).toBe(true);
  });

  it('confirmar sem conexão não faz nada', () => {
    const rig = createRig();
    rig.session.actions.confirmIdentity();
    expect(snap(rig).identityConfirmed).toBe(false);
  });
});

describe('log e avisos', () => {
  it('registra comandos (tx) e respostas (rx) com o hexadecimal', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(200);

    const { log } = snap(rig);
    const tx = log.filter((entry) => entry.kind === 'tx');
    expect(tx.map((entry) => entry.hex)).toEqual([REQUEST_CONTROL, START, speedCmd(0.9)]);
    expect(tx[2].label).toContain('Set Target Speed');

    const rx = log.filter((entry) => entry.kind === 'rx' && entry.label.startsWith('Resposta a'));
    expect(rx.map((entry) => entry.hex)).toEqual(['80 00 01', '80 07 01', '80 02 01']);
    expect(rx[0].label).toContain('Request Control');
    expect(rx[0].label).toContain('Success');
    log.forEach((entry) => {
      expect(entry.at).toEqual(expect.any(Number));
      expect(entry.id).toEqual(expect.any(Number));
    });
  });

  it('Treadmill Data não inunda o log: um registro por formato de pacote', async () => {
    const rig = createRig();
    await connect(rig);
    await advance(30_000);

    const entries = snap(rig).log.filter((e) => e.label.startsWith('Treadmill Data'));
    expect(entries).toHaveLength(1);
    expect(entries[0].hex).not.toBeNull();

    const split = createRig({ splitRecords: true });
    await connect(split);
    await advance(30_000);
    expect(snap(split).log.filter((e) => e.label.startsWith('Treadmill Data'))).toHaveLength(2);
  });

  it('o log não passa de maxLogEntries e guarda os mais novos', async () => {
    const rig = createRig({}, { maxLogEntries: 8 });
    await startBelt(rig);
    for (let i = 0; i < 6; i++) {
      rig.session.actions.changeSpeed(0.1);
      await advance(200);
    }

    const { log } = snap(rig);
    expect(log).toHaveLength(8);
    const ids = log.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(log[log.length - 1].hex).not.toBeNull();
    expect(log.some((entry) => entry.label === 'Request Control')).toBe(false);
  });

  it('clearLog() esvazia o log e dismissNotice() remove o aviso', async () => {
    const rig = createRig();
    await connect(rig);
    rig.session.actions.changeSpeed(0.1); // gera o aviso "Inicie a lona"
    expect(snap(rig).notice).not.toBeNull();
    expect(snap(rig).log.length).toBeGreaterThan(0);

    rig.session.actions.dismissNotice();
    expect(snap(rig).notice).toBeNull();
    rig.session.actions.clearLog();
    expect(snap(rig).log).toEqual([]);
  });

  it('cada aviso novo tem um id diferente', async () => {
    const rig = createRig();
    await connect(rig);
    rig.session.actions.changeSpeed(0.1);
    const first = snap(rig).notice;
    rig.session.actions.changeSpeed(0.1);
    const second = snap(rig).notice;

    expect(first?.id).not.toBe(second?.id);
  });
});

describe('subscribe e getSnapshot', () => {
  it('ouvintes são chamados nas mudanças e deixam de ser depois de cancelar a assinatura', async () => {
    const rig = createRig();
    const listener = jest.fn();
    const unsubscribe = rig.session.subscribe(listener);

    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    expect(listener).toHaveBeenCalled();
    await advance(200);
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThan(1);

    unsubscribe();
    await advance(3000);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('getSnapshot() devolve a mesma referência enquanto nada muda; uma ação sem efeito não notifica', async () => {
    const rig = createRig();
    await connect(rig);
    const listener = jest.fn();
    rig.session.subscribe(listener);
    const before = rig.session.getSnapshot();

    expect(rig.session.getSnapshot()).toBe(before);
    rig.session.actions.dismissNotice();
    rig.session.actions.stopScan();
    expect(rig.session.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('as partes que não mudaram mantêm a referência quando só as métricas mudam', async () => {
    const rig = createRig();
    await connect(rig);
    await advance(1000); // primeira amostra: já entrou no log
    const before = snap(rig);
    expect(before.metrics.updatedAt).not.toBeNull();

    await advance(1000);
    const after = snap(rig);

    expect(after).not.toBe(before);
    expect(after.metrics).not.toBe(before.metrics);
    expect(after.capabilities).toBe(before.capabilities);
    expect(after.log).toBe(before.log);
    expect(after.devices).toBe(before.devices);
    expect(after.device).toBe(before.device);
    expect(after.notice).toBe(before.notice);
  });

  it('o snapshot é imutável: cada mudança gera um objeto novo', async () => {
    const rig = createRig();
    const initial = snap(rig);
    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);

    expect(initial.phase).toBe('idle');
    expect(initial.capabilities).toBeNull();
    expect(snap(rig)).not.toBe(initial);
  });
});

// --- Roteiros auxiliares --------------------------------------------------------

/**
 * Conecta e deixa a lona andando na velocidade mínima da faixa informada, para
 * esteiras simuladas com faixa diferente da padrão.
 */
async function startBelt0(rig: Rig, minimum: number): Promise<void> {
  await connect(rig);
  rig.session.actions.start();
  await advance(1100);
  expect(snap(rig).belt).toBe('running');
  expect(snap(rig).metrics.speedKmh).toBeCloseTo(minimum, 5);
}

/** Esteira muda: conecta e deixa a lona andando, esperando os timeouts. */
async function startBelt0Mute(rig: Rig): Promise<void> {
  await connect(rig);
  rig.session.actions.start();
  await advance(4000);
  expect(snap(rig).belt).toBe('running');
}

// --- Sonda GATT (coleta e engenharia reversa) ----------------------------------

describe('sonda GATT', () => {
  it('recusa leitura antes de confirmar que a esteira é a do usuário', async () => {
    const rig = createRig();
    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    expect(snap(rig).phase).toBe('connected');
    await expect(rig.session.probe.read(FTMS.service, FTMS.feature)).rejects.toThrow(
      'Confirme que esta é a sua esteira',
    );
  });

  it('depois da confirmação lista os serviços e lê uma característica', async () => {
    const rig = createRig();
    await connect(rig);
    expect(rig.session.probe.available()).toBe(true);
    const services = await rig.session.probe.services();
    expect(services.some((service) => sameUuid(service.uuid, FTMS.service))).toBe(true);
    const hex = await rig.session.probe.read(FTMS.service, FTMS.feature);
    expect(hex).toMatch(/^[0-9A-F]{2}( [0-9A-F]{2})+$/);
  });
});


describe('opcodes vendor do FTMS (0x7E/0x7F)', () => {
  const VENDOR_7E = '7E';
  const VENDOR_7F = '7F';

  it('não envia com a lona andando e explica o bloqueio', async () => {
    const rig = createRig();
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.sendVendorOpcode(0x7e);

    expect(rig.writes).not.toContain(VENDOR_7E);
    expect(snap(rig).vendorOpcodeProbe).toEqual(
      expect.objectContaining({
        opCode: 0x7e,
        status: 'blocked',
        detail: expect.stringContaining('lona'),
      }),
    );
  });

  it('envia 0x7E com a esteira parada, pede o controle e lê o delay da resposta', async () => {
    const rig = createRig();
    await connect(rig);
    // O teste exige uma leitura de velocidade mostrando a esteira parada.
    await advance(1100);
    expect(snap(rig).metrics.speedKmh).toBe(0);
    rig.hooks.indication = (data) =>
      data[1] === 0x7e ? Uint8Array.of(ControlPointOp.ResponseCode, 0x7e, R.Success, 0x0a) : data;

    rig.session.actions.sendVendorOpcode(0x7e);
    await advance(1500);

    expect(rig.writes).toContain(REQUEST_CONTROL);
    expect(rig.writes).toContain(VENDOR_7E);
    expect(snap(rig).control).toBe('granted');
    expect(snap(rig).vendorOpcodeProbe).toEqual(
      expect.objectContaining({
        opCode: 0x7e,
        status: 'answered',
        resultCode: R.Success,
        parameterHex: '0A',
        detail: 'Success',
      }),
    );
    expect(snap(rig).notice?.kind).toBe('success');
  });

  it('registra a recusa da esteira (Op Code Not Supported) sem inventar sucesso', async () => {
    const rig = createRig();
    await connect(rig);
    await advance(1100);

    rig.session.actions.sendVendorOpcode(0x7f);
    await advance(1500);

    expect(rig.writes).toContain(VENDOR_7F);
    expect(snap(rig).vendorOpcodeProbe).toEqual(
      expect.objectContaining({
        opCode: 0x7f,
        status: 'answered',
        resultCode: R.OpCodeNotSupported,
        parameterHex: null,
        detail: 'Op Code Not Supported',
      }),
    );
  });

  it('ignora op code que não é vendor', async () => {
    const rig = createRig();
    await connect(rig);
    rig.writes.length = 0;

    rig.session.actions.sendVendorOpcode(0x02);
    await advance(200);

    expect(rig.writes).toEqual([]);
    expect(snap(rig).vendorOpcodeProbe).toBeNull();
  });

  it('bloqueia no modo demonstração (não existe rádio)', async () => {
    const rig = createRig();
    rig.session.actions.openDemo();
    await advance(200);
    expect(snap(rig).mode).toBe('demo');
    rig.writes.length = 0;

    rig.session.actions.sendVendorOpcode(0x7e);

    expect(rig.writes).toEqual([]);
    expect(snap(rig).vendorOpcodeProbe).toEqual(
      expect.objectContaining({ status: 'blocked', detail: expect.stringContaining('esteira real') }),
    );
  });
});

// --- Teste automático do protocolo Gizwits (AFG Pro) --------------------------

describe('teste automático do canal Gizwits (0xFFF0)', () => {
  const MACHINE_INFO_FRAME = '55 AA 00 00 01 02 00 00 00 00';
  const replyFrame = () =>
    Uint8Array.of(0x55, 0xaa, 0x00, 0x00, 0x01, 0x02, 0x04, 0x00, 0xaa, 0xbb, 0x0d, 0xf0, 0x00, 0x01, 0x02, 0x03);

  it('pede machine info, segue nos testes seguros e termina compatível', async () => {
    const rig = createRig();
    rig.hooks.vendor = { reply: () => replyFrame() };
    await connect(rig);

    rig.session.actions.runGizwitsProbe();
    await advance(300);

    const probe = snap(rig).gizwitsProbe;
    expect(probe.status).toBe('compatible');
    expect(probe.compatible).toBe(true);
    expect(probe.replyHex).toMatch(/^55 AA/);
    expect(probe.replyCommand).toBe('machine info');
    expect(probe.attempts.map((attempt) => attempt.name)).toEqual([
      'machine-info',
      'workout-data',
      'stop-idle',
      'pause-idle',
    ]);
    expect(probe.attempts.every((attempt) => attempt.status === 'reply')).toBe(true);
    expect(rig.writes).toContain(MACHINE_INFO_FRAME);
  });

  it('sem resposta, tenta FFF1, sequência, CRC invertido e ack, e termina incompatível', async () => {
    const rig = createRig();
    rig.hooks.vendor = { reply: () => null };
    await connect(rig);

    rig.session.actions.runGizwitsProbe();
    await advance(45000);

    const probe = snap(rig).gizwitsProbe;
    expect(probe.status).toBe('incompatible');
    expect(probe.compatible).toBe(false);
    expect(probe.attempts.map((attempt) => attempt.name)).toEqual([
      'machine-info',
      'fff1',
      'seq',
      'crc-be',
      'aa55',
      'pause-std',
      'ack',
      'disc-fff3-00',
      'disc-fff3-01',
      'disc-fff3-55',
      'disc-fff3-aa',
      'disc-fff3-at',
      'disc-fff1-00',
      'disc-fff1-55',
      'disc-fff1-aa',
    ]);
    expect(probe.attempts.every((attempt) => attempt.status === 'timeout')).toBe(true);
    expect(rig.writes).toContain(MACHINE_INFO_FRAME);
  });

  it('se só o FFF1 responde, marca compatível pela variante', async () => {
    const rig = createRig();
    rig.hooks.vendor = {
      reply: (_data, _service, uuid) => (sameUuid(uuid, VENDOR_FFF1) ? replyFrame() : null),
    };
    await connect(rig);

    rig.session.actions.runGizwitsProbe();
    await advance(8000);

    const probe = snap(rig).gizwitsProbe;
    expect(probe.status).toBe('compatible');
    expect(probe.compatible).toBe(true);
    expect(probe.attempts.find((attempt) => attempt.name === 'fff1')?.status).toBe('reply');
  });

  it('com a lona andando não escreve e pede para parar no painel', async () => {
    const rig = createRig();
    rig.hooks.vendor = {};
    await startBelt(rig);
    rig.writes.length = 0;

    rig.session.actions.runGizwitsProbe();
    await advance(200);

    const probe = snap(rig).gizwitsProbe;
    expect(probe.status).toBe('waitingBelt');
    expect(probe.hint).toContain('pare a esteira');
    expect(rig.writes).not.toContain(MACHINE_INFO_FRAME);
  });

  it('se a varredura de bytes receber qualquer dado, marca compatível', async () => {
    const rig = createRig();
    rig.hooks.vendor = {
      reply: (data, _service, uuid) =>
        sameUuid(uuid, VENDOR_FFF1) && data.length === 1 && data[0] === 0
          ? Uint8Array.of(0x7e)
          : null,
    };
    await connect(rig);

    rig.session.actions.runGizwitsProbe();
    await advance(35000);

    const probe = snap(rig).gizwitsProbe;
    expect(probe.status).toBe('compatible');
    expect(probe.compatible).toBe(true);
    expect(probe.detail).toContain('varredura');
    expect(probe.attempts.find((attempt) => attempt.name === 'disc-fff1-00')?.status).toBe('reply');
  });

  it('no modo demonstração só marca indisponível, sem escrever', async () => {
    const rig = createRig();
    rig.hooks.vendor = {};
    rig.session.actions.openDemo();
    await advance(200);

    rig.session.actions.runGizwitsProbe();
    await advance(50);

    expect(snap(rig).gizwitsProbe.status).toBe('unavailable');
    expect(rig.writes).not.toContain(MACHINE_INFO_FRAME);
  });
});


describe('controle pelo canal alternativo (Gizwits)', () => {
  const replyFrame = () =>
    Uint8Array.of(0x55, 0xaa, 0x00, 0x00, 0x01, 0x02, 0x04, 0x00, 0xaa, 0xbb, 0x0d, 0xf0, 0x00, 0x01, 0x02, 0x03);

  const lastFrame = (rig: Rig) => parseGizwitsFrame(hexToBytes(rig.writes[rig.writes.length - 1]));

  async function compatibleRig(): Promise<Rig> {
    const rig = createRig();
    rig.hooks.vendor = { reply: () => replyFrame() };
    await connect(rig);
    rig.session.actions.runGizwitsProbe();
    await advance(300);
    expect(snap(rig).gizwitsProbe.status).toBe('compatible');
    rig.writes.length = 0;
    return rig;
  }

  it('Iniciar vira o frame de start workout (lingo 3, cmd 2, 17 bytes)', async () => {
    const rig = await compatibleRig();

    rig.session.actions.start();
    await advance(10);

    expect(rig.writes).toHaveLength(1);
    const frame = lastFrame(rig)!;
    expect(frame.lingo).toBe(3);
    expect(frame.command).toBe(2);
    expect(frame.payload).toHaveLength(17);
  });

  it('Inclinação e Parar viram frames do canal alternativo', async () => {
    const rig = await compatibleRig();

    rig.session.actions.changeInclination(0.5);
    await advance(10);
    expect(lastFrame(rig)).toEqual(expect.objectContaining({ lingo: 3, command: 6 }));

    await advance(300);
    rig.session.actions.stop();
    await advance(10);
    expect(lastFrame(rig)).toEqual(expect.objectContaining({ lingo: 1, command: 20 }));
  });

  it('sem canal compatível, os controles não escrevem no FFF3', async () => {
    const rig = createRig();
    rig.hooks.vendor = { reply: () => null };
    await connect(rig);
    rig.writes.length = 0;

    rig.session.actions.changeInclination(0.5);
    await advance(10);

    expect(rig.writes.filter((write) => write.startsWith('55 AA'))).toHaveLength(0);
  });
});
