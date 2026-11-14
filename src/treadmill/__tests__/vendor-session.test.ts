import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ServiceInfo,
} from '@/ble/transport';
import { FTMS, bytesToHex, sameUuid, uuid16 } from '@/ftms';
import { buildTreadmillData } from '@/simulator/wire';
import { DEFAULT_VENDOR_MAPPING } from '@/vendor/presets';
import type { VendorState } from '@/vendor/types';

import { TreadmillSession } from '../treadmill-session';
import type { TreadmillSnapshot } from '../types';

const VENDOR_SERVICE = uuid16(0xfff0);
const FFF1 = uuid16(0xfff1);
const FFF2 = uuid16(0xfff2);
const FFF3 = uuid16(0xfff3);
const FFF4 = uuid16(0xfff4);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

function characteristic(
  uuid: string,
  properties: Partial<Omit<CharacteristicInfo, 'uuid'>> = {},
): CharacteristicInfo {
  return {
    uuid,
    canRead: false,
    canWrite: false,
    canNotify: false,
    canIndicate: false,
    ...properties,
  };
}

const FTMS_CHARACTERISTICS: CharacteristicInfo[] = [
  characteristic(FTMS.feature, { canRead: true }),
  characteristic(FTMS.treadmillData, { canNotify: true }),
  characteristic(FTMS.trainingStatus, { canRead: true, canNotify: true }),
  characteristic(FTMS.machineStatus, { canNotify: true }),
  characteristic(FTMS.controlPoint, { canWrite: true, canIndicate: true }),
  characteristic(FTMS.supportedSpeedRange, { canRead: true }),
  characteristic(FTMS.supportedInclinationRange, { canRead: true }),
];

const VENDOR_CHARACTERISTICS: CharacteristicInfo[] = [
  characteristic(FFF1, { canRead: true, canWrite: true }),
  characteristic(FFF2, { canRead: true }),
  characteristic(FFF3, { canWrite: true }),
  characteristic(FFF4, { canNotify: true }),
];

interface Write {
  service: string;
  uuid: string;
  hex: string;
}

interface Rig {
  session: TreadmillSession;
  writes: Write[];
  emitTreadmillData: (speedKmh: number, inclinationPercent: number) => void;
  emitMachineStatus: (bytes: Uint8Array) => void;
  emitVendorReply: (bytes: Uint8Array) => void;
  snapshot: () => TreadmillSnapshot;
  vendor: () => VendorState;
}

function createRig(): Rig {
  const writes: Write[] = [];
  const subscriptions = new Map<string, (data: Uint8Array) => void>();

  const key = (service: string, uuid: string) => `${service}|${uuid}`;

  const emit = (service: string, uuid: string, bytes: Uint8Array) => {
    const listener = [...subscriptions.entries()].find(([entryKey]) => {
      const [entryService, entryUuid] = entryKey.split('|');
      return sameUuid(entryService, service) && sameUuid(entryUuid, uuid);
    });
    listener?.[1](bytes);
  };

  const connection: BleConnection = {
    deviceId: 'fake',
    name: 'Esteira de teste',
    getServices: async (): Promise<ServiceInfo[]> => [
      { uuid: FTMS.service, characteristics: FTMS_CHARACTERISTICS },
      { uuid: VENDOR_SERVICE, characteristics: VENDOR_CHARACTERISTICS },
    ],
    getCharacteristics: async (service: string) => {
      if (sameUuid(service, FTMS.service)) return FTMS_CHARACTERISTICS;
      if (sameUuid(service, VENDOR_SERVICE)) return VENDOR_CHARACTERISTICS;
      return [];
    },
    read: async (service: string, uuid: string) => {
      if (sameUuid(service, FTMS.service)) {
        if (sameUuid(uuid, FTMS.feature)) return Uint8Array.of(0x2c, 0x3e, 0, 0, 0x10, 0, 0, 0);
        if (sameUuid(uuid, FTMS.supportedSpeedRange)) {
          return Uint8Array.of(0x50, 0, 0x98, 0x08, 0x0a, 0);
        }
        if (sameUuid(uuid, FTMS.supportedInclinationRange)) {
          return Uint8Array.of(0, 0, 0xf4, 0x01, 0x1e, 0);
        }
        if (sameUuid(uuid, FTMS.trainingStatus)) return Uint8Array.of(0, 1);
      }
      if (sameUuid(service, VENDOR_SERVICE) && (sameUuid(uuid, FFF1) || sameUuid(uuid, FFF2))) {
        return Uint8Array.of(0);
      }
      throw new Error(`leitura inesperada de ${uuid}`);
    },
    write: async (service: string, uuid: string, data: Uint8Array) => {
      writes.push({ service, uuid, hex: bytesToHex(data) });
    },
    subscribe: async (service: string, uuid: string, onValue) => {
      subscriptions.set(key(service, uuid), onValue);
      return {
        remove: () => {
          subscriptions.delete(key(service, uuid));
        },
      } satisfies BleSubscription;
    },
    onDisconnect: () => ({ remove: () => undefined }) satisfies BleSubscription,
    disconnect: async () => {
      await Promise.resolve();
    },
  };

  const transport: BleTransport = {
    prepare: async () => undefined,
    scan: () => {
      throw new Error('a busca não é usada neste teste');
    },
    connect: async () => connection,
  };

  const session = new TreadmillSession({
    ble: transport,
    demo: { transport, deviceId: 'fake' },
    responseTimeoutMs: 1000,
    unconfirmedGraceMs: 100,
    scanTimeoutMs: 1000,
  });

  return {
    session,
    writes,
    emitTreadmillData: (speedKmh, inclinationPercent) => {
      const bytes = buildTreadmillData(
        {
          speedKmh,
          distanceM: 0,
          inclinationPercent,
          energyKcal: 0,
          energyPerMinuteKcal: 0,
          heartRateBpm: 100,
          elapsedS: 0,
        },
        0,
        false,
      )[0];
      emit(FTMS.service, FTMS.treadmillData, bytes);
    },
    emitMachineStatus: (bytes) => emit(FTMS.service, FTMS.machineStatus, bytes),
    emitVendorReply: (bytes) => emit(VENDOR_SERVICE, FFF4, bytes),
    snapshot: () => session.getSnapshot(),
    vendor: () => session.getSnapshot().vendor,
  };
}

async function connect(rig: Rig): Promise<void> {
  rig.session.actions.connect('fake');
  await advance(50);
  expect(rig.snapshot().phase).toBe('connected');
  rig.session.actions.confirmIdentity();
}

async function enableVendor(rig: Rig): Promise<void> {
  rig.session.actions.setVendorMapping(DEFAULT_VENDOR_MAPPING);
  await advance(0);
  rig.session.actions.setVendorMode(true);
  await advance(0);
  expect(rig.vendor().enabled).toBe(true);
}

describe('controle experimental pelo 0xFFF0', () => {
  it('detecta o serviço proprietário na conexão', async () => {
    const rig = createRig();
    await connect(rig);
    expect(rig.vendor().available).toBe(true);
    expect(rig.vendor().enabled).toBe(false);
  });

  it('não ativa sem um mapeamento configurado', async () => {
    const rig = createRig();
    await connect(rig);
    rig.session.actions.setVendorMode(true);
    await advance(0);
    expect(rig.vendor().enabled).toBe(false);
    expect(rig.snapshot().notice?.message).toMatch(/Escolha um protocolo experimental/);
  });

  it('manda velocidade e inclinação pelo FFF3, sem escrever no Control Point', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    // Nesta família a leitura do 0x2ACD vem inflada ~6,667×: 13,3 ≈ 2,0 % real.
    rig.emitTreadmillData(5, 13.3);
    await advance(0);

    rig.session.actions.changeSpeed(0.1);
    await advance(0);
    rig.session.actions.changeInclination(0.5);
    await advance(0);

    const vendorWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(vendorWrites.map((write) => write.hex)).toEqual(['02 FE 01', '03 19 00']);
    expect(vendorWrites.every((write) => sameUuid(write.uuid, FFF3))).toBe(true);
    expect(rig.writes.some((write) => sameUuid(write.uuid, FTMS.controlPoint))).toBe(false);
    expect(rig.snapshot().targetSpeedKmh).toBeCloseTo(5.1);
    expect(rig.snapshot().targetInclinationPercent).toBeCloseTo(2.5);
  });

  it('manda Iniciar, Pausar e Parar pelo canal proprietário', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);

    rig.session.actions.start();
    await advance(0);
    rig.session.actions.pause();
    await advance(0);
    rig.session.actions.stop();
    await advance(0);

    const vendorWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(vendorWrites.map((write) => write.hex)).toEqual(['07', '08 02', '08 01']);
  });

  it('assina o FFF4 e registra as respostas', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    rig.emitVendorReply(Uint8Array.of(0xaa, 0x01));
    await advance(0);
    expect(rig.vendor().lastReply?.hex).toBe('AA 01');
  });

  it('a varredura escreve um byte por vez e registra o que voltar', async () => {
    const rig = createRig();
    await connect(rig);
    rig.session.actions.runVendorDiscovery();
    await advance(50);
    // Um canal que respondesse durante a espera do primeiro candidato.
    rig.emitVendorReply(Uint8Array.of(0xaa));
    await advance(100_000);

    const discovery = rig.vendor().discovery;
    expect(discovery?.running).toBe(false);
    expect(discovery?.observations).toHaveLength(10);
    expect(discovery?.observations.some((item) => item.replies.includes('AA'))).toBe(true);
    const discoveryWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(discoveryWrites).toHaveLength(10);
    expect(discoveryWrites.map((write) => write.hex)).toContain('00');
  });

  it('não deixa o alvo notificado em ×16 envenenar a velocidade (raw 8000 = 5,0 km/h)', async () => {
    const rig = createRig();
    await connect(rig);
    // A esteira avisa targetSpeedChanged 05 40 1F. O app antigo leria 80 km/h.
    rig.emitMachineStatus(Uint8Array.of(0x05, 0x40, 0x1f));
    await advance(0);
    expect(rig.snapshot().targetSpeedKmh).toBeCloseTo(5.0);
    await enableVendor(rig);
    rig.emitTreadmillData(5, 0);
    await advance(0);
    rig.session.actions.changeSpeed(0.1);
    await advance(0);
    const vendorWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(vendorWrites.map((write) => write.hex)).toEqual(['02 FE 01']);
  });

  it('desempata a escala ×16 pela velocidade medida em velocidades baixas', async () => {
    const rig = createRig();
    await connect(rig);
    rig.emitTreadmillData(0.8, 0);
    await advance(0);
    // 0,8 km/h em ×16 chega como 12,8 (05 00 05). Sem a medida, 12,8 caberia na faixa.
    rig.emitMachineStatus(Uint8Array.of(0x05, 0x00, 0x05));
    await advance(0);
    expect(rig.snapshot().targetSpeedKmh).toBeCloseTo(0.8);
  });

  it('converte a leitura inflada mesmo quando ela ainda cabe na faixa (10,0 = 1,5 %)', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    // 1,5 % real aparece como 10,0 na leitura crua; sem converter, o "+" mandaria 10,5 %.
    rig.emitTreadmillData(5, 10);
    await advance(0);
    rig.session.actions.changeInclination(0.5);
    await advance(0);
    const vendorWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(vendorWrites.map((write) => write.hex)).toEqual(['03 14 00']);
    expect(rig.snapshot().targetInclinationPercent).toBeCloseTo(2.0);
  });

  it('corrige a inclinação inflada do 0x2ACD antes de calcular o alvo', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    // Inclinação real ~3 % aparece como 20 % na leitura crua desta unidade.
    rig.emitTreadmillData(5, 20);
    await advance(0);
    rig.session.actions.changeInclination(0.5);
    await advance(0);
    const vendorWrites = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE));
    expect(vendorWrites.map((write) => write.hex)).toEqual(['03 23 00']);
    expect(rig.snapshot().targetInclinationPercent).toBeCloseTo(3.5);
  });

  it('depois de Parar, não aceita ajuste de velocidade enquanto a lona freia', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    rig.emitTreadmillData(5, 0);
    await advance(0);
    rig.session.actions.stop();
    await advance(10);
    const writesAfterStop = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE)).length;
    // A lona ainda gira a 4,0 km/h enquanto freia; um "+" não pode mandar alvo novo.
    rig.emitTreadmillData(4, 0);
    await advance(0);
    rig.session.actions.changeSpeed(0.1);
    await advance(0);
    const writesNow = rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE)).length;
    expect(writesNow).toBe(writesAfterStop);
  });

  it('o Parar pelo canal proprietário também tenta o Control Point do FTMS', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    rig.session.actions.stop();
    await advance(10);
    expect(rig.writes.some((write) => sameUuid(write.uuid, FTMS.controlPoint))).toBe(true);
  });

  it('desliga o modo experimental e volta a não escrever no 0xFFF0', async () => {
    const rig = createRig();
    await connect(rig);
    await enableVendor(rig);
    rig.session.actions.setVendorMode(false);
    await advance(0);
    expect(rig.vendor().enabled).toBe(false);

    rig.emitTreadmillData(5, 2);
    await advance(0);
    rig.session.actions.changeSpeed(0.1);
    await advance(0);
    expect(rig.writes.filter((write) => sameUuid(write.service, VENDOR_SERVICE))).toHaveLength(0);
  });
});
