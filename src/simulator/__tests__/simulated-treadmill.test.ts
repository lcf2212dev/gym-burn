import type { BleConnection, ScannedDevice } from '@/ble/transport';
import {
  FTMS,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedInclinationRange,
  parseSupportedSpeedRange,
  parseTrainingStatus,
  parseTreadmillData,
  type MachineStatusEvent,
  type TreadmillData,
} from '@/ftms';

import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
  type SimulatedTreadmillOptions,
} from '../simulated-treadmill';

const SERVICE = FTMS.service;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

interface Rig {
  transport: SimulatedTreadmillTransport;
  conn: BleConnection;
  data: TreadmillData[];
  status: MachineStatusEvent[];
  training: number[];
}

/** Conecta e assina todas as características notificáveis. */
async function setup(options: SimulatedTreadmillOptions = {}, subscribeAll = true): Promise<Rig> {
  const transport = new SimulatedTreadmillTransport(options);
  const promise = transport.connect(SIMULATED_DEVICE_ID);
  await jest.advanceTimersByTimeAsync(200);
  const conn = await promise;
  const rig: Rig = { transport, conn, data: [], status: [], training: [] };
  if (subscribeAll) {
    await conn.subscribe(SERVICE, FTMS.treadmillData, (d) => rig.data.push(parseTreadmillData(d)));
    await conn.subscribe(SERVICE, FTMS.trainingStatus, (d) =>
      rig.training.push(parseTrainingStatus(d).code),
    );
    await conn.subscribe(SERVICE, FTMS.machineStatus, (d) => rig.status.push(parseMachineStatus(d)));
  }
  return rig;
}

describe('scan e conexão', () => {
  it('entrega o aparelho depois de scanDelayMs e remove() cancela', async () => {
    const transport = new SimulatedTreadmillTransport({ name: 'Minha esteira' });
    await expect(transport.prepare()).resolves.toBeUndefined();
    const found: ScannedDevice[] = [];
    transport.scan((d) => found.push(d), jest.fn());
    await jest.advanceTimersByTimeAsync(299);
    expect(found).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(found).toEqual([
      expect.objectContaining({
        id: SIMULATED_DEVICE_ID,
        name: 'Minha esteira',
        rssi: -48,
        advertisesFtms: true,
        ftms: expect.objectContaining({
          available: true,
          machineTypes: expect.objectContaining({ treadmill: true, indoorBike: false }),
        }),
      }),
    ]);

    const cancelled: ScannedDevice[] = [];
    const sub = transport.scan((d) => cancelled.push(d), jest.fn());
    sub.remove();
    await jest.advanceTimersByTimeAsync(1000);
    expect(cancelled).toHaveLength(0);
  });

  it('rejeita id desconhecido e só aceita uma conexão por vez', async () => {
    const transport = new SimulatedTreadmillTransport();
    await expect(transport.connect('outra')).rejects.toThrow();
    const first = transport.connect(SIMULATED_DEVICE_ID);
    await expect(transport.connect(SIMULATED_DEVICE_ID)).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(200);
    const conn = await first;
    expect(conn.deviceId).toBe(SIMULATED_DEVICE_ID);
    await expect(transport.connect(SIMULATED_DEVICE_ID)).rejects.toThrow();
  });

  it('reconecta com o estado do treino zerado', async () => {
    const rig = await setup({ autoStart: false });
    rig.transport.consoleStart();
    rig.transport.consoleSetSpeed(8);
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)!.totalDistanceM).toBeGreaterThan(0);
    await rig.conn.disconnect();

    const again = await setup({ autoStart: false });
    await jest.advanceTimersByTimeAsync(1000);
    expect(again.data.at(-1)).toMatchObject({
      instantaneousSpeedKmh: 0,
      totalDistanceM: 0,
      elapsedTimeS: 0,
    });
    expect(parseTrainingStatus(await again.conn.read(SERVICE, FTMS.trainingStatus)).name).toBe(
      'idle',
    );
  });
});

describe('características', () => {
  const uuids = (list: { uuid: string }[]) => list.map((c) => c.uuid);

  it('lista completa por padrão, com propriedades corretas', async () => {
    const { conn } = await setup({}, false);
    const list = await conn.getCharacteristics('1826');
    expect(uuids(list)).toEqual([
      FTMS.feature,
      FTMS.treadmillData,
      FTMS.trainingStatus,
      FTMS.supportedSpeedRange,
      FTMS.supportedInclinationRange,
      FTMS.machineStatus,
    ]);
    const by = (uuid: string) => list.find((c) => c.uuid === uuid)!;
    expect(by(FTMS.feature)).toMatchObject({ canRead: true, canNotify: false });
    expect(by(FTMS.treadmillData)).toMatchObject({ canNotify: true, canRead: false });
    expect(by(FTMS.trainingStatus)).toMatchObject({ canRead: true, canNotify: true });
    expect(by(FTMS.machineStatus)).toMatchObject({ canNotify: true });
    expect(await conn.getCharacteristics('180d')).toEqual([]);
  });

  it('sem faixas, o aparelho só anuncia o essential de dados', async () => {
    const { conn } = await setup({ exposeRanges: false }, false);
    const list = uuids(await conn.getCharacteristics(SERVICE));
    expect(list).toEqual([FTMS.feature, FTMS.treadmillData, FTMS.trainingStatus, FTMS.machineStatus]);
    await expect(conn.read(SERVICE, FTMS.supportedSpeedRange)).rejects.toThrow();
  });

  it('feature diz que a esteira mede, mas não aceita nenhum alvo', async () => {
    const { conn } = await setup({}, false);
    const feature = parseFitnessMachineFeature(await conn.read(SERVICE, FTMS.feature));
    expect(feature.machine).toMatchObject({
      totalDistance: true,
      inclination: true,
      expendedEnergy: true,
      heartRate: true,
      elapsedTime: true,
      pace: false,
      averageSpeed: false,
    });
    expect(Object.values(feature.targets)).not.toContain(true);
    expect(parseSupportedSpeedRange(await conn.read(SERVICE, FTMS.supportedSpeedRange))).toEqual({
      min: 0.8,
      max: 22,
      step: 0.1,
    });
    expect(
      parseSupportedInclinationRange(await conn.read(SERVICE, FTMS.supportedInclinationRange)),
    ).toEqual({ min: 0, max: 15, step: 0.5 });
  });

  it('feature com ritmo e faixas personalizadas (inclinação negativa)', async () => {
    const { conn } = await setup(
      {
        paceFieldWidth: 2,
        speedRange: { min: 1, max: 18, step: 0.5 },
        inclinationRange: { min: -3, max: 12, step: 1 },
      },
      false,
    );
    const feature = parseFitnessMachineFeature(await conn.read(SERVICE, FTMS.feature));
    expect(feature.machine.pace).toBe(true);
    expect(parseSupportedSpeedRange(await conn.read(SERVICE, FTMS.supportedSpeedRange))).toEqual({
      min: 1,
      max: 18,
      step: 0.5,
    });
    expect(
      parseSupportedInclinationRange(await conn.read(SERVICE, FTMS.supportedInclinationRange)),
    ).toEqual({ min: -3, max: 12, step: 1 });
  });

  it('read de característica sem leitura ou inexistente rejeita; UUID em qualquer formato', async () => {
    const { conn } = await setup({}, false);
    await expect(conn.read(SERVICE, FTMS.treadmillData)).rejects.toThrow();
    await expect(conn.read(SERVICE, '2a00')).rejects.toThrow();
    await expect(conn.read('180d', FTMS.feature)).rejects.toThrow();
    await expect(conn.read('0x1826', '0x2ACC')).resolves.toHaveLength(8);
  });

  it('não existe escrita: o contrato da conexão é só de leitura', async () => {
    const { conn } = await setup({}, false);
    expect((conn as unknown as { write?: unknown }).write).toBeUndefined();
    expect((conn as unknown as { controlPoint?: unknown }).controlPoint).toBeUndefined();
  });
});

describe('dados de esteira', () => {
  it('autoStart liga a lona e o console avisa pelo Machine Status', async () => {
    const rig = await setup();
    await jest.advanceTimersByTimeAsync(1000);

    expect(rig.status).toContainEqual({ type: 'startedOrResumedByUser' });
    expect(rig.training.at(-1)).toBe(0x0d); // manualMode
    const reading = rig.data.at(-1)!;
    expect(reading.instantaneousSpeedKmh).toBeGreaterThan(0);
    expect(reading.heartRateBpm).toBeGreaterThan(0);
    expect(reading.elapsedTimeS).toBeGreaterThanOrEqual(1);
  });

  it('o console mantém a velocidade alvo e o firmware avisa em ×16', async () => {
    const rig = await setup({ autoStart: false });
    rig.transport.consoleStart();
    rig.transport.consoleSetSpeed(5);
    await jest.advanceTimersByTimeAsync(6000);

    expect(rig.status).toContainEqual({ type: 'targetSpeedChanged', speedKmh: 5 });
    const reading = rig.data.at(-1)!;
    expect(reading.instantaneousSpeedKmh).toBe(5);
    expect(reading.totalDistanceM).toBeGreaterThan(5);
    expect(reading.elapsedTimeS).toBeGreaterThanOrEqual(6);
    expect(rig.training.at(-1)).toBe(0x0d);
  });

  it('a inclinação do console chega pelo Machine Status e no Treadmill Data', async () => {
    const rig = await setup({ autoStart: false });
    rig.transport.consoleStart();
    rig.transport.consoleSetInclination(2.5);
    await jest.advanceTimersByTimeAsync(4000);

    expect(rig.status).toContainEqual({ type: 'targetInclineChanged', inclinationPercent: 2.5 });
    expect(rig.data.at(-1)!.inclinationPercent).toBe(2.5);
    expect(rig.data.at(-1)!.rampAngleDeg).toBeGreaterThan(0);
  });

  it('pausar e parar no console avisam o app', async () => {
    const rig = await setup({ autoStart: false });
    rig.transport.consoleStart();
    await jest.advanceTimersByTimeAsync(2000);
    rig.transport.consolePause();
    await jest.advanceTimersByTimeAsync(3000);

    expect(rig.status).toContainEqual({ type: 'stoppedOrPausedByUser', action: 'pause' });
    expect(rig.training.at(-1)).toBe(0x0f); // postWorkout
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0);

    rig.transport.consoleStop();
    expect(rig.status).toContainEqual({ type: 'stoppedOrPausedByUser', action: 'stop' });
    expect(rig.training.at(-1)).toBe(0x01); // idle
  });

  it('a chave de segurança para a lona e avisa pelo status', async () => {
    const rig = await setup({ autoStart: false });
    rig.transport.consoleStart();
    rig.transport.consoleSetSpeed(10);
    await jest.advanceTimersByTimeAsync(5000);

    rig.transport.pullSafetyKey();
    expect(rig.status).toContainEqual({ type: 'stoppedBySafetyKey' });
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0);
    expect(rig.training.at(-1)).toBe(0x01);
  });

  it('registro dividido em duas notificações é remontado pelo parser', async () => {
    const rig = await setup({ autoStart: false, splitRecords: true });
    rig.transport.consoleStart();
    await jest.advanceTimersByTimeAsync(1000);

    // Cada tick gera duas notificações: a 1ª sem velocidade (More Data) e a 2ª completa.
    expect(rig.data).toHaveLength(2);
    expect(rig.data[0].moreData).toBe(true);
    expect(rig.data[1].moreData).toBe(false);
    expect(rig.data[1].instantaneousSpeedKmh).toBeGreaterThan(0);
  });

  it('ritmo de 1 e 2 octetos é identificado pelo tamanho do pacote', async () => {
    const pace1 = await setup({ autoStart: false, paceFieldWidth: 1 });
    pace1.transport.consoleStart();
    await jest.advanceTimersByTimeAsync(1000);
    expect(pace1.data.at(-1)!.paceFieldWidth).toBe(1);

    const pace2 = await setup({ autoStart: false, paceFieldWidth: 2 });
    pace2.transport.consoleStart();
    await jest.advanceTimersByTimeAsync(1000);
    expect(pace2.data.at(-1)!.paceFieldWidth).toBe(2);
  });
});

describe('link', () => {
  it('dropLink avisa uma vez; disconnect() não avisa', async () => {
    const transport = new SimulatedTreadmillTransport({ autoStart: false });
    const promise = transport.connect(SIMULATED_DEVICE_ID);
    await jest.advanceTimersByTimeAsync(200);
    const conn = await promise;
    const listener = jest.fn();
    conn.onDisconnect(listener);

    transport.dropLink();
    transport.dropLink();
    expect(listener).toHaveBeenCalledTimes(1);

    const again = await setup({ autoStart: false }, false);
    const noDrop = jest.fn();
    again.conn.onDisconnect(noDrop);
    await again.conn.disconnect();
    expect(noDrop).not.toHaveBeenCalled();
  });
});
