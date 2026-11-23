import {
  BleUnavailableError,
  type BleConnection,
  type BleSubscription,
  type BleTransport,
  type CharacteristicInfo,
  type ScannedDevice,
} from '@/ble/transport';
import {
  DEVICE_INFORMATION_SERVICE,
  FTMS,
  normalizeUuid,
  uuid16,
} from '@/ftms';
import {
  ByteWriter,
  TREADMILL_FLAG,
} from '@/simulator/wire';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
} from '@/simulator/simulated-treadmill';
import { T600X_INCLINATION_RANGE, T600X_SPEED_RANGE } from '../t600x';
import { TreadmillSession, type TreadmillSessionOptions } from '../treadmill-session';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// --- Transporte falso ---------------------------------------------------------
//
// A esteira simulada cobre o caminho feliz; este transporte falso permite
// montar o aparelho que o teste precisar (faixas bizarras, característica
// ausente, leitura que falha, link que cai).

function text(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function readKey(service: string, characteristic: string): string {
  return `${normalizeUuid(service)}|${normalizeUuid(characteristic)}`;
}

interface FakeCharacteristic extends CharacteristicInfo {
  service: string;
}

interface FakeConfig {
  name?: string;
  characteristics: FakeCharacteristic[];
  /** Valor de cada leitura; `Error` faz falhar; função devolve a promise (pode travar). */
  reads: Record<string, Uint8Array | Error | (() => Promise<Uint8Array>)>;
}

const char = (
  service: string,
  uuid: string,
  props: Partial<Omit<CharacteristicInfo, 'uuid'>> = {},
): FakeCharacteristic => ({
  service,
  uuid,
  canRead: false,
  canNotify: false,
  canIndicate: false,
  ...props,
});

function defaultCharacteristics(): FakeCharacteristic[] {
  const deviceInformation = DEVICE_INFORMATION_SERVICE;
  return [
    char(FTMS.service, FTMS.feature, { canRead: true }),
    char(FTMS.service, FTMS.treadmillData, { canNotify: true }),
    char(FTMS.service, FTMS.trainingStatus, { canRead: true, canNotify: true }),
    char(FTMS.service, FTMS.supportedSpeedRange, { canRead: true }),
    char(FTMS.service, FTMS.supportedInclinationRange, { canRead: true }),
    char(FTMS.service, FTMS.machineStatus, { canNotify: true }),
    char(deviceInformation, uuid16(0x2a24), { canRead: true }),
    char(deviceInformation, uuid16(0x2a29), { canRead: true }),
    char(deviceInformation, uuid16(0x2a25), { canRead: true }),
    char(deviceInformation, uuid16(0x2a27), { canRead: true }),
    char(deviceInformation, uuid16(0x2a26), { canRead: true }),
    char(deviceInformation, uuid16(0x2a28), { canRead: true }),
    char(deviceInformation, uuid16(0x2a23), { canRead: true }),
  ];
}

function defaultReads(): FakeConfig['reads'] {
  const service = FTMS.service;
  const deviceInformation = DEVICE_INFORMATION_SERVICE;
  return {
    [readKey(service, FTMS.feature)]: new ByteWriter().u32(0x0000160d).u32(0).finish(),
    [readKey(service, FTMS.supportedSpeedRange)]: new ByteWriter()
      .u16(80)
      .u16(2200)
      .u16(10)
      .finish(),
    [readKey(service, FTMS.supportedInclinationRange)]: new ByteWriter()
      .s16(0)
      .s16(150)
      .u16(5)
      .finish(),
    [readKey(service, FTMS.trainingStatus)]: Uint8Array.of(0, 0x01),
    [readKey(deviceInformation, uuid16(0x2a24))]: text('000000'),
    [readKey(deviceInformation, uuid16(0x2a29))]: text('Johnson Health'),
    [readKey(deviceInformation, uuid16(0x2a25))]: text('TM781234'),
    [readKey(deviceInformation, uuid16(0x2a27))]: text('2.0'),
    [readKey(deviceInformation, uuid16(0x2a26))]: text('1.0.3'),
    [readKey(deviceInformation, uuid16(0x2a28))]: text('1.0'),
    [readKey(deviceInformation, uuid16(0x2a23))]: Uint8Array.of(
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    ),
  };
}

class FakeConnection implements BleConnection {
  readonly deviceId = 'dev-1';
  readonly name: string;
  disconnected = false;

  private readonly values = new Map<string, Set<(data: Uint8Array) => void>>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly reads: FakeConfig['reads'];
  private readonly characteristics: FakeCharacteristic[];

  constructor(config: FakeConfig) {
    this.name = config.name ?? 'Matrix T600X';
    this.reads = config.reads;
    this.characteristics = config.characteristics;
  }

  async getServices() {
    return [{ uuid: FTMS.service, characteristics: await this.getCharacteristics(FTMS.service) }];
  }

  async getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]> {
    return this.characteristics
      .filter(
        (characteristic) => normalizeUuid(characteristic.service) === normalizeUuid(serviceUuid),
      )
      .map((characteristic) => ({
        uuid: characteristic.uuid,
        canRead: characteristic.canRead,
        canNotify: characteristic.canNotify,
        canIndicate: characteristic.canIndicate,
      }));
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    const value = this.reads[readKey(serviceUuid, characteristicUuid)];
    if (value === undefined) {
      throw new Error(`Característica ${characteristicUuid} não permite leitura`);
    }
    if (value instanceof Error) {
      throw value;
    }
    if (typeof value === 'function') {
      return value();
    }
    return Uint8Array.from(value);
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription> {
    const key = readKey(serviceUuid, characteristicUuid);
    const listeners = this.values.get(key) ?? new Set();
    this.values.set(key, listeners);
    listeners.add(onValue);
    return { remove: () => void listeners.delete(onValue) };
  }

  onDisconnect(listener: () => void): BleSubscription {
    this.disconnectListeners.add(listener);
    return { remove: () => void this.disconnectListeners.delete(listener) };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.values.clear();
    this.disconnectListeners.clear();
  }

  /** Entrega uma notificação como se viesse da esteira. */
  emit(service: string, characteristic: string, bytes: Uint8Array): void {
    this.values.get(readKey(service, characteristic))?.forEach((listener) => listener(bytes));
  }

  /** Simula a queda do link (sem `disconnect()` do app). */
  drop(): void {
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    this.values.clear();
    listeners.forEach((listener) => listener());
  }
}

class FakeTransport implements BleTransport {
  config: FakeConfig;
  prepareError: Error | null = null;
  connectError: Error | null = null;
  scanCalls = 0;
  lastConnection: FakeConnection | null = null;

  private onDevice: ((device: ScannedDevice) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;

  constructor(config: FakeConfig = { characteristics: defaultCharacteristics(), reads: defaultReads() }) {
    this.config = config;
  }

  async prepare(): Promise<void> {
    if (this.prepareError) throw this.prepareError;
  }

  scan(
    onDevice: (device: ScannedDevice) => void,
    onError: (error: Error) => void,
  ): BleSubscription {
    this.scanCalls += 1;
    this.onDevice = onDevice;
    this.onError = onError;
    return {
      remove: () => {
        this.onDevice = null;
        this.onError = null;
      },
    };
  }

  async connect(): Promise<BleConnection> {
    if (this.connectError) throw this.connectError;
    this.lastConnection = new FakeConnection(this.config);
    return this.lastConnection;
  }

  emitDevice(device: ScannedDevice): void {
    this.onDevice?.(device);
  }

  failScan(error: Error): void {
    this.onError?.(error);
  }
}

async function settle(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await Promise.resolve();
  }
  await jest.advanceTimersByTimeAsync(0);
}

function makeSession(options: Partial<TreadmillSessionOptions> = {}) {
  const transport = new FakeTransport();
  const session = new TreadmillSession({
    ble: transport,
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
    ...options,
  });
  return { transport, session };
}

/**
 * Conecta pelo transporte falso e devolve a conexão que a sessão está usando.
 * Com `device`, passa pela busca: é o que dá nome/RSSI de anúncio à conexão.
 */
async function connectFake(
  transport: FakeTransport,
  session: TreadmillSession,
  device?: ScannedDevice,
): Promise<FakeConnection> {
  if (device) {
    session.actions.startScan();
    await settle();
    transport.emitDevice(device);
  }
  session.actions.connect(device?.id ?? 'dev-1');
  await settle();
  const connection = transport.lastConnection;
  if (!connection) throw new Error('a sessão não conectou');
  expect(session.getSnapshot().phase).toBe('connected');
  return connection;
}

const SPEED_KMH = 6.5;
const DISTANCE_M = 1234;
const INCLINATION_RAW = 100; // 10,0 % no campo; 1,5 % de verdade nesta família

/** Pacote de Treadmill Data completo, como o firmware desta T600X manda. */
function treadmillPacket(overrides: { heartRateBpm?: number; inclinationRaw?: number } = {}): Uint8Array {
  const F = TREADMILL_FLAG;
  const writer = new ByteWriter()
    .u16(F.totalDistance | F.inclination | F.expendedEnergy | F.heartRate | F.elapsedTime)
    .u16(SPEED_KMH * 100)
    .u24(DISTANCE_M)
    .s16(overrides.inclinationRaw ?? INCLINATION_RAW)
    .s16(20)
    .u16(432)
    .u16(600)
    .u8(10)
    .u8(overrides.heartRateBpm ?? 0)
    .u16(305);
  return writer.finish();
}

describe('busca', () => {
  it('procura sempre que a tela pedir e lista FTMS primeiro', async () => {
    const { transport, session } = makeSession();
    session.actions.startScan();
    await settle();

    expect(transport.scanCalls).toBe(1);
    expect(session.getSnapshot().scan).toBe('scanning');

    const other: ScannedDevice = {
      id: 'outro',
      name: 'Fone',
      rssi: -40,
      advertisesFtms: false,
      ftms: null,
    };
    const treadmill: ScannedDevice = {
      id: 'esteira',
      name: 'VISION',
      rssi: -60,
      advertisesFtms: true,
      ftms: null,
    };
    transport.emitDevice(other);
    transport.emitDevice(treadmill);
    expect(session.getSnapshot().devices.map((device) => device.id)).toEqual(['esteira', 'outro']);

    // O mesmo aparelho volta com o nome que só veio no scan response.
    transport.emitDevice({ ...treadmill, name: 'CTM781', rssi: -58 });
    const known = session.getSnapshot().devices.find((device) => device.id === 'esteira');
    expect(known).toMatchObject({ name: 'CTM781', rssi: -58 });

    session.actions.stopScan();
    expect(session.getSnapshot().scan).toBe('idle');
  });

  it('erro ao preparar o Bluetooth vira aviso e a próxima busca funciona', async () => {
    const { transport, session } = makeSession();
    transport.prepareError = new BleUnavailableError('poweredOff', 'O Bluetooth está desligado.');
    session.actions.startScan();
    await settle();

    expect(session.getSnapshot().scan).toBe('idle');
    expect(session.getSnapshot().notice).toMatchObject({ kind: 'error', message: 'O Bluetooth está desligado.' });

    transport.prepareError = null;
    session.actions.startScan();
    await settle();
    expect(session.getSnapshot().scan).toBe('scanning');
  });

  it('para sozinha e avisa quando não encontra nada', async () => {
    const { session } = makeSession({ scanTimeoutMs: 1000 });
    session.actions.startScan();
    await settle();
    await jest.advanceTimersByTimeAsync(1000);

    expect(session.getSnapshot().scan).toBe('idle');
    expect(session.getSnapshot().notice).toMatchObject({
      kind: 'info',
      message: expect.stringContaining('Nenhuma esteira encontrada'),
    });
  });

  it('erro do rádio durante a busca vira aviso', async () => {
    const { transport, session } = makeSession();
    session.actions.startScan();
    await settle();
    transport.failScan(new Error('a busca parou sozinha'));

    expect(session.getSnapshot().scan).toBe('idle');
    expect(session.getSnapshot().notice).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('a busca parou sozinha'),
    });
  });
});

describe('conexão', () => {
  it('lê a identidade e as capacidades, e não escreve nada', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session, {
      id: 'dev-1',
      name: 'VISION',
      rssi: -55,
      advertisesFtms: true,
      ftms: null,
    });
    const snapshot = session.getSnapshot();

    expect(snapshot.mode).toBe('ble');
    expect(snapshot.device).toEqual({ id: 'dev-1', name: 'Matrix T600X' });
    expect(snapshot.link.rssi).toBe(-55);
    expect(snapshot.equipment).toEqual({
      manufacturer: 'Johnson Health',
      model: '000000',
      serial: 'TM781234',
      firmware: '1.0.3',
      software: '1.0',
      hardware: '2.0',
      systemId: '01 02 03 04 05 06 07 08',
    });
    expect(snapshot.status.training).toMatchObject({ name: 'idle' });
    expect(snapshot.capabilities).toMatchObject({
      feature: { targetSettingsRaw: 0 },
      speedRange: { min: 0.8, max: 22, step: 0.1, source: 'device' },
      inclinationRange: { min: 0, max: 15, step: 0.5, source: 'device' },
    });
    expect(snapshot.capabilities?.characteristics).toContain(FTMS.treadmillData);
    // O contrato da conexão não tem escrita: o app só pode ler e assinar.
    expect((connection as unknown as { write?: unknown }).write).toBeUndefined();
  });

  it('sem feature nem faixas, cai na ficha técnica da T600X', async () => {
    const { transport, session } = makeSession();
    transport.config = {
      characteristics: [
        char(FTMS.service, FTMS.treadmillData, { canNotify: true }),
        char(FTMS.service, FTMS.machineStatus, { canNotify: true }),
      ],
      reads: {},
    };
    await connectFake(transport, session);
    const capabilities = session.getSnapshot().capabilities!;

    expect(capabilities.feature).toBeNull();
    expect(capabilities.speedRange).toEqual(T600X_SPEED_RANGE);
    expect(capabilities.inclinationRange).toEqual(T600X_INCLINATION_RANGE);
  });

  it('aparelho sem FTMS é recusado com aviso e a conexão é fechada', async () => {
    const { transport, session } = makeSession();
    transport.config = { characteristics: [], reads: {} };
    session.actions.connect('dev-1');
    await settle();

    const connection = transport.lastConnection!;
    expect(connection.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().device).toBeNull();
    expect(session.getSnapshot().notice).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('não oferece o serviço de equipamento fitness'),
    });
  });

  it('aparelho FTMS que não manda Treadmill Data é recusado', async () => {
    const { transport, session } = makeSession();
    transport.config = {
      characteristics: [char(FTMS.service, FTMS.feature, { canRead: true })],
      reads: { [readKey(FTMS.service, FTMS.feature)]: Uint8Array.of(1, 2, 3, 4) },
    };
    session.actions.connect('dev-1');
    await settle();

    expect(session.getSnapshot().notice).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('não envia dados de esteira'),
    });
  });

  it('falha ao conectar vira aviso e volta para idle', async () => {
    const { transport, session } = makeSession();
    transport.connectError = new Error('Falha ao conectar na esteira: tempo esgotado');
    session.actions.connect('dev-1');
    await settle();

    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().notice).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('tempo esgotado'),
    });
  });
});

describe('métricas', () => {
  it('traduz o Treadmill Data, zera a FC sem contato e corrige a inclinação', async () => {
    const { transport, session } = makeSession();
    transport.config = {
      characteristics: defaultCharacteristics(),
      reads: {
        ...defaultReads(),
        // O firmware declara o template 0–50 %/3 %: a leitura de inclinação é 6,667× maior.
        [readKey(FTMS.service, FTMS.supportedInclinationRange)]: new ByteWriter()
          .s16(0)
          .s16(500)
          .u16(30)
          .finish(),
      },
    };
    const connection = await connectFake(transport, session);
    const at = Date.now();
    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());

    const metrics = session.getSnapshot().metrics;
    expect(metrics).toMatchObject({
      speedKmh: SPEED_KMH,
      distanceM: DISTANCE_M,
      inclinationPercent: 1.5,
      totalEnergyKcal: 432,
      energyPerHourKcal: 600,
      energyPerMinuteKcal: 10,
      heartRateBpm: null,
      elapsedTimeS: 305,
      updatedAt: at,
      flags: expect.any(Number),
    });
    expect(metrics.rampAngleDeg).toBe(2);
    expect(session.getSnapshot().samples).toHaveLength(1);
    expect(session.getSnapshot().samples[0]).toMatchObject({
      speedKmh: SPEED_KMH,
      inclinationPercent: 1.5,
      heartRateBpm: null,
      energyKcal: 432,
      distanceM: DISTANCE_M,
    });
  });

  it('campos ausentes mantêm o último valor e a FC volta a aparecer com contato', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);
    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 128 }));
    expect(session.getSnapshot().metrics.heartRateBpm).toBe(128);

    // Só a velocidade: flags 0 e 4 octetos.
    const speedOnly = new ByteWriter().u16(0).u16(500).finish();
    connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);

    const metrics = session.getSnapshot().metrics;
    expect(metrics.speedKmh).toBe(5);
    expect(metrics.distanceM).toBe(DISTANCE_M);
    expect(metrics.heartRateBpm).toBe(128);
    expect(metrics.inclinationPercent).toBe(10); // faixa plausível: sem correção
  });

  it('diz que os batimentos vêm da esteira quando não há cinta', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);

    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
    expect(session.getSnapshot().metrics.heartRateSource).toBeNull();
    expect(session.getSnapshot().samples.at(-1)!.heartRateSource).toBeNull();

    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 128 }));
    expect(session.getSnapshot().metrics).toMatchObject({
      heartRateBpm: 128,
      heartRateSource: 'treadmill',
    });
    expect(session.getSnapshot().samples.at(-1)).toMatchObject({
      heartRateBpm: 128,
      heartRateSource: 'treadmill',
    });
  });

  describe('com a cinta de batimentos', () => {
    /** A cinta com uma leitura nova a cada consulta, como quando ela manda mais rápido que a esteira. */
    const live = (bpm: () => number | null) => (now: number) => {
      const value = bpm();
      return value === null ? null : { bpm: value, at: now };
    };

    it('a leitura da cinta vale no lugar da do sensor de mão', async () => {
      const heartRate = jest.fn(live(() => 142));
      const { transport, session } = makeSession({ heartRate });
      const connection = await connectFake(transport, session);

      // Sem contato nas alças: a esteira manda 0.
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(heartRate).toHaveBeenLastCalledWith(Date.now());
      expect(session.getSnapshot().metrics).toMatchObject({
        heartRateBpm: 142,
        heartRateSource: 'strap',
      });
      expect(session.getSnapshot().samples.at(-1)).toMatchObject({
        heartRateBpm: 142,
        heartRateSource: 'strap',
      });

      // Segurando as alças ao mesmo tempo, continua valendo a cinta.
      await jest.advanceTimersByTimeAsync(1000);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 128 }));
      expect(session.getSnapshot().metrics).toMatchObject({
        heartRateBpm: 142,
        heartRateSource: 'strap',
      });
      expect(session.getSnapshot().samples.at(-1)!.heartRateBpm).toBe(142);
    });

    it('cada leitura da cinta entra numa amostra só, mesmo com o registro da esteira dividido em dois pacotes', async () => {
      let reading = { bpm: 142, at: 1000 };
      const { transport, session } = makeSession({ heartRate: () => reading });
      const connection = await connectFake(transport, session);
      const speedOnly = new ByteWriter().u16(0).u16(500).finish();

      // Dois pacotes no mesmo segundo, com a mesma leitura da cinta em vigor.
      connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      const [first, second] = session.getSnapshot().samples;
      expect(first).toMatchObject({ heartRateBpm: 142, heartRateSource: 'strap' });
      // A segunda amostra sabe que a cinta está em uso, mas não repete a leitura.
      expect(second).toMatchObject({ heartRateBpm: null, heartRateSource: 'strap' });
      // O painel continua mostrando o número.
      expect(session.getSnapshot().metrics.heartRateBpm).toBe(142);

      // Chegou outra leitura (mesmo valor, hora nova): conta de novo.
      reading = { bpm: 142, at: 2000 };
      connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);
      expect(session.getSnapshot().samples.at(-1)!.heartRateBpm).toBe(142);
    });

    it('sem leitura da cinta, voltam os batimentos da esteira', async () => {
      let strap: number | null = 142;
      const { transport, session } = makeSession({ heartRate: live(() => strap) });
      const connection = await connectFake(transport, session);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 128 }));

      strap = null;
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 130 }));
      expect(session.getSnapshot().metrics).toMatchObject({
        heartRateBpm: 130,
        heartRateSource: 'treadmill',
      });
      expect(session.getSnapshot().samples.at(-1)).toMatchObject({
        heartRateBpm: 130,
        heartRateSource: 'treadmill',
      });

      // E sem contato nas alças não sobra leitura nenhuma: nada de segurar o valor da cinta.
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(session.getSnapshot().metrics).toMatchObject({
        heartRateBpm: null,
        heartRateSource: null,
      });
    });

    it('num pacote sem o campo de FC, o painel não repete a leitura velha da cinta', async () => {
      let strap: number | null = 142;
      const { transport, session } = makeSession({ heartRate: live(() => strap) });
      const connection = await connectFake(transport, session);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());

      strap = null;
      // Só a velocidade: flags 0 e 4 octetos.
      connection.emit(FTMS.service, FTMS.treadmillData, new ByteWriter().u16(0).u16(500).finish());

      expect(session.getSnapshot().metrics).toMatchObject({
        heartRateBpm: null,
        heartRateSource: null,
      });
      expect(session.getSnapshot().samples.at(-1)).toMatchObject({
        heartRateBpm: null,
        heartRateSource: null,
      });
    });

    it('uma conexão nova com a esteira volta a contar a leitura em vigor', async () => {
      const { transport, session } = makeSession({ heartRate: () => ({ bpm: 142, at: 1000 }) });
      const first = await connectFake(transport, session);
      first.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      session.actions.disconnect();
      await settle();

      const second = await connectFake(transport, session);
      second.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());

      expect(session.getSnapshot().samples).toHaveLength(1);
      expect(session.getSnapshot().samples[0].heartRateBpm).toBe(142);
    });

    it('os RR não se perdem nem se repetem com dois batimentos entre pacotes da esteira', async () => {
      const beats: { seq: number; rrMs: number }[] = [{ seq: 1, rrMs: 900 }];
      let at = 1000;
      const { transport, session } = makeSession({ heartRate: () => ({ bpm: 66, at, beats: [...beats] }) });
      const connection = await connectFake(transport, session);
      const speedOnly = new ByteWriter().u16(0).u16(500).finish();

      // A primeira amostra só marca onde o anel está: os RR de antes da conexão não caem nela.
      connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);
      expect(session.getSnapshot().samples.at(-1)!.rrMs).toEqual([]);

      // Duas notificações da cinta (três RR) antes do próximo pacote da esteira.
      beats.push({ seq: 2, rrMs: 910 }, { seq: 3, rrMs: 905 }, { seq: 4, rrMs: 915 });
      at = 3000;
      connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);
      expect(session.getSnapshot().samples.at(-1)!.rrMs).toEqual([910, 905, 915]);

      // O registro da esteira dividido: o segundo pacote do mesmo segundo não repete nada.
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(session.getSnapshot().samples.at(-1)!.rrMs).toEqual([]);

      // O anel girou (os antigos saíram): só os novos entram.
      beats.splice(0, 3);
      beats.push({ seq: 5, rrMs: 920 });
      at = 4000;
      connection.emit(FTMS.service, FTMS.treadmillData, speedOnly);
      expect(session.getSnapshot().samples.at(-1)!.rrMs).toEqual([920]);
      const all = session.getSnapshot().samples.flatMap((sample) => sample.rrMs ?? []);
      expect(all).toEqual([910, 905, 915, 920]);
    });

    it('a cadência é nível: vai em toda amostra enquanto recente; sem fonte, não existe', async () => {
      let cadence: { spm: number; steps: number; at: number } | null | undefined = {
        spm: 112,
        steps: 40,
        at: 1000,
      };
      const { transport, session } = makeSession({
        heartRate: (now) => ({ bpm: 120, at: now, ...(cadence !== undefined && { cadence }) }),
      });
      const connection = await connectFake(transport, session);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(session.getSnapshot().samples.map((sample) => sample.cadenceSpm)).toEqual([112, 112]);

      cadence = { spm: 0, steps: 40, at: 2000 };
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(session.getSnapshot().samples.at(-1)!.cadenceSpm).toBe(0);

      cadence = null;
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect(session.getSnapshot().samples.at(-1)!.cadenceSpm).toBeNull();

      cadence = undefined;
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
      expect('cadenceSpm' in session.getSnapshot().samples.at(-1)!).toBe(false);
    });

    it('sem a cinta, a amostra não tem RR nem cadência', async () => {
      const { transport, session } = makeSession();
      const connection = await connectFake(transport, session);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket({ heartRateBpm: 128 }));
      const sample = session.getSnapshot().samples.at(-1)!;
      expect('rrMs' in sample).toBe(false);
      expect('cadenceSpm' in sample).toBe(false);
    });
  });

  it('guarda no máximo 300 amostras, uma por notificação', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);
    for (let index = 0; index < 310; index++) {
      await jest.advanceTimersByTimeAsync(1000);
      connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
    }
    const samples = session.getSnapshot().samples;
    expect(samples).toHaveLength(300);
    expect(samples.at(-1)!.at).toBe(Date.now());
  });
});

describe('enlace e console', () => {
  it('conta pacotes, mede o intervalo e guarda o RSSI do anúncio', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session, {
      id: 'dev-1',
      name: 'VISION',
      rssi: -72,
      advertisesFtms: true,
      ftms: null,
    });

    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
    await jest.advanceTimersByTimeAsync(1000);
    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
    await jest.advanceTimersByTimeAsync(1000);
    connection.emit(FTMS.service, FTMS.machineStatus, Uint8Array.of(0x04));

    const link = session.getSnapshot().link;
    expect(link.packets).toBe(3);
    expect(link.intervalMs).toBe(1000);
    expect(link.lastPacketAt).toBe(Date.now());
    expect(link.rssi).toBe(-72);
  });

  it('registra os eventos do console, com o mais novo primeiro e no máximo 8', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);

    connection.emit(FTMS.service, FTMS.machineStatus, Uint8Array.of(0x03));
    let status = session.getSnapshot().status;
    expect(status.stoppedBySafetyKey).toBe(true);
    expect(status.consoleEvents[0].event).toEqual({ type: 'stoppedBySafetyKey' });
    expect(session.getSnapshot().notice).toMatchObject({ kind: 'warning' });

    connection.emit(FTMS.service, FTMS.machineStatus, Uint8Array.of(0x04));
    expect(session.getSnapshot().status.stoppedBySafetyKey).toBe(false);

    // 10 avisos de velocidade alvo; o firmware manda raw ×16 (8000 = 5,0 km/h).
    for (let index = 0; index < 10; index++) {
      connection.emit(FTMS.service, FTMS.machineStatus, Uint8Array.of(0x05, 0x40, 0x1f));
    }
    status = session.getSnapshot().status;
    expect(status.consoleEvents).toHaveLength(8);
    expect(status.consoleEvents[0].event).toEqual({ type: 'targetSpeedChanged', speedKmh: 5 });
    expect(status.consoleEvents.at(-1)!.event).toEqual({
      type: 'targetSpeedChanged',
      speedKmh: 5,
    });
  });

  it('Training Status alimenta o estado do treino', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);
    connection.emit(FTMS.service, FTMS.trainingStatus, Uint8Array.of(0, 0x0d));
    expect(session.getSnapshot().status.training).toEqual({
      code: 0x0d,
      name: 'manualMode',
      text: null,
    });
  });

  it('a queda do link volta para idle com um aviso útil', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);
    connection.emit(FTMS.service, FTMS.treadmillData, treadmillPacket());
    expect(session.getSnapshot().metrics.speedKmh).toBe(SPEED_KMH);

    connection.drop();
    await settle();

    const snapshot = session.getSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.device).toBeNull();
    expect(snapshot.equipment).toBeNull();
    expect(snapshot.capabilities).toBeNull();
    expect(snapshot.metrics.speedKmh).toBeNull();
    expect(snapshot.mode).toBe('ble');
    expect(snapshot.notice).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('A conexão com a esteira caiu'),
    });
  });

  it('desconectar pelo app volta para idle sem alarde', async () => {
    const { transport, session } = makeSession();
    const connection = await connectFake(transport, session);
    session.actions.disconnect();
    await settle();

    expect(connection.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().notice).toBeNull();
  });

  it('o aviso some ao ser dispensado', async () => {
    const { transport, session } = makeSession();
    transport.prepareError = new BleUnavailableError('poweredOff', 'Bluetooth desligado.');
    session.actions.startScan();
    await settle();
    expect(session.getSnapshot().notice).not.toBeNull();

    session.actions.dismissNotice();
    expect(session.getSnapshot().notice).toBeNull();
  });
});

describe('contrato de leitura', () => {
  it('as ações não incluem nenhum comando para a esteira', () => {
    const { session } = makeSession();
    expect(Object.keys(session.actions).sort()).toEqual([
      'connect',
      'disconnect',
      'dismissNotice',
      'openDemo',
      'startScan',
      'stopScan',
    ]);
  });

  it('o modo demonstração recebe dados vivos da esteira simulada', async () => {
    const { session } = makeSession();
    session.actions.openDemo();
    await jest.advanceTimersByTimeAsync(200);
    await settle();
    await jest.advanceTimersByTimeAsync(1000);
    await settle();

    const snapshot = session.getSnapshot();
    expect(snapshot.mode).toBe('demo');
    expect(snapshot.phase).toBe('connected');
    expect(snapshot.device).toEqual({ id: SIMULATED_DEVICE_ID, name: 'Esteira simulada' });
    expect(snapshot.metrics.speedKmh).toBeGreaterThan(0);
    expect(snapshot.samples.length).toBeGreaterThan(0);
    expect(snapshot.status.training).toMatchObject({ name: 'manualMode' });
    expect(snapshot.link.packets).toBeGreaterThan(0);
  });

  it('reabrir a demonstração logo depois de desconectar não a faz passar por esteira real', async () => {
    const { session } = makeSession();
    session.actions.openDemo();
    await jest.advanceTimersByTimeAsync(200);
    await settle();
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', mode: 'demo' });

    // A tela reabre a demonstração assim que a sessão fica livre, antes de a
    // desconexão terminar de arrumar o próprio estado.
    const stop = session.subscribe(() => {
      if (session.getSnapshot().phase !== 'idle') return;
      stop();
      session.actions.openDemo();
    });
    session.actions.disconnect();
    await jest.advanceTimersByTimeAsync(200);
    await settle();
    await jest.advanceTimersByTimeAsync(1000);
    await settle();

    // Com a origem trocada para "ble", os treinos simulados entrariam no histórico real.
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', mode: 'demo' });
  });
});
