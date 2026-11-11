import type { BleConnection, ScannedDevice } from '@/ble/transport';
import {
  ControlPointOp,
  ControlPointResult,
  FTMS,
  encodePause,
  encodeRequestControl,
  encodeReset,
  encodeSetTargetInclination,
  encodeSetTargetSpeed,
  encodeStartOrResume,
  encodeStop,
  parseControlPointResponse,
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
  jest.useRealTimers();
});

interface Rig {
  transport: SimulatedTreadmillTransport;
  conn: BleConnection;
  data: TreadmillData[];
  status: MachineStatusEvent[];
  responses: { op: number; result: number }[];
  training: number[];
  rawData: Uint8Array[];
}

/** Conecta e assina todas as características notificáveis que existirem. */
async function setup(options: SimulatedTreadmillOptions = {}, subscribeAll = true): Promise<Rig> {
  const transport = new SimulatedTreadmillTransport(options);
  const promise = transport.connect(SIMULATED_DEVICE_ID);
  await jest.advanceTimersByTimeAsync(200);
  const conn = await promise;
  const rig: Rig = { transport, conn, data: [], status: [], responses: [], training: [], rawData: [] };
  if (subscribeAll) {
    const chars = await conn.getCharacteristics(SERVICE);
    const has = (uuid: string) => chars.some((c) => c.uuid === uuid);
    await conn.subscribe(SERVICE, FTMS.treadmillData, (d) => {
      rig.rawData.push(d);
      rig.data.push(parseTreadmillData(d));
    });
    await conn.subscribe(SERVICE, FTMS.trainingStatus, (d) => rig.training.push(parseTrainingStatus(d).code));
    if (has(FTMS.controlPoint)) {
      await conn.subscribe(SERVICE, FTMS.controlPoint, (d) => {
        const r = parseControlPointResponse(d)!;
        rig.responses.push({ op: r.requestOpCode, result: r.resultCode });
      });
      await conn.subscribe(SERVICE, FTMS.machineStatus, (d) => rig.status.push(parseMachineStatus(d)));
    }
  }
  return rig;
}

/** Escreve um comando e devolve o result code da indication. */
async function command(rig: Rig, bytes: Uint8Array): Promise<number> {
  const before = rig.responses.length;
  await rig.conn.write(SERVICE, FTMS.controlPoint, bytes);
  await jest.advanceTimersByTimeAsync(40);
  expect(rig.responses.length).toBe(before + 1);
  const last = rig.responses[before];
  expect(last.op).toBe(bytes[0]);
  return last.result;
}

async function withControl(options: SimulatedTreadmillOptions = {}): Promise<Rig> {
  const rig = await setup(options);
  expect(await command(rig, encodeRequestControl())).toBe(ControlPointResult.Success);
  return rig;
}

const R = ControlPointResult;

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
          machineTypes: expect.objectContaining({ treadmill: true, indoorBike: false, rower: false }),
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
    const rig = await withControl();
    await command(rig, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(5000);
    await rig.conn.disconnect();

    const again = await setup();
    await jest.advanceTimersByTimeAsync(1000);
    expect(again.data.at(-1)).toMatchObject({ instantaneousSpeedKmh: 0, totalDistanceM: 0, elapsedTimeS: 0 });
    expect(parseTrainingStatus(await again.conn.read(SERVICE, FTMS.trainingStatus)).name).toBe('idle');
    // O controle também não sobrevive à nova conexão.
    expect(await command(again, encodeStartOrResume())).toBe(R.ControlNotPermitted);
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
      FTMS.controlPoint,
      FTMS.machineStatus,
    ]);
    const by = (uuid: string) => list.find((c) => c.uuid === uuid)!;
    expect(by(FTMS.feature)).toMatchObject({ canRead: true, canNotify: false });
    expect(by(FTMS.treadmillData)).toMatchObject({ canNotify: true, canRead: false });
    expect(by(FTMS.trainingStatus)).toMatchObject({ canRead: true, canNotify: true });
    expect(by(FTMS.controlPoint)).toMatchObject({ canWrite: true, canIndicate: true, canNotify: false });
    expect(by(FTMS.machineStatus)).toMatchObject({ canNotify: true });
    expect(await conn.getCharacteristics('180d')).toEqual([]);
  });

  it('sem Control Point', async () => {
    const { conn } = await setup({ hasControlPoint: false }, false);
    const list = uuids(await conn.getCharacteristics(SERVICE));
    expect(list).not.toContain(FTMS.controlPoint);
    expect(list).not.toContain(FTMS.machineStatus);
    expect(list).toContain(FTMS.supportedSpeedRange);
  });

  it('sem faixas', async () => {
    const { conn } = await setup({ exposeRanges: false }, false);
    const list = uuids(await conn.getCharacteristics(SERVICE));
    expect(list).not.toContain(FTMS.supportedSpeedRange);
    expect(list).not.toContain(FTMS.supportedInclinationRange);
    expect(list).toContain(FTMS.controlPoint);
    await expect(conn.read(SERVICE, FTMS.supportedSpeedRange)).rejects.toThrow();
  });

  it('sem Control Point e sem faixas', async () => {
    const { conn } = await setup({ hasControlPoint: false, exposeRanges: false }, false);
    expect(uuids(await conn.getCharacteristics(SERVICE))).toEqual([
      FTMS.feature,
      FTMS.treadmillData,
      FTMS.trainingStatus,
    ]);
  });

  it('feature e faixas decodificadas pelos parsers de @/ftms', async () => {
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
    expect(feature.targets).toMatchObject({ speed: true, inclination: true, resistance: false });
    expect(parseSupportedSpeedRange(await conn.read(SERVICE, FTMS.supportedSpeedRange))).toEqual({
      min: 0.8,
      max: 22,
      step: 0.1,
    });
    expect(parseSupportedInclinationRange(await conn.read(SERVICE, FTMS.supportedInclinationRange))).toEqual({
      min: 0,
      max: 15,
      step: 0.5,
    });
  });

  it('feature com ritmo, sem Control Point e faixas personalizadas (inclinação negativa)', async () => {
    const { conn } = await setup(
      {
        paceFieldWidth: 2,
        hasControlPoint: false,
        speedRange: { min: 1, max: 18, step: 0.5 },
        inclinationRange: { min: -3, max: 12, step: 1 },
      },
      false,
    );
    const feature = parseFitnessMachineFeature(await conn.read(SERVICE, FTMS.feature));
    expect(feature.machine.pace).toBe(true);
    expect(feature.targets.speed).toBe(false);
    expect(feature.targets.inclination).toBe(false);
    expect(parseSupportedSpeedRange(await conn.read(SERVICE, FTMS.supportedSpeedRange))).toEqual({
      min: 1,
      max: 18,
      step: 0.5,
    });
    expect(parseSupportedInclinationRange(await conn.read(SERVICE, FTMS.supportedInclinationRange))).toEqual({
      min: -3,
      max: 12,
      step: 1,
    });
  });

  it('read de característica sem leitura ou inexistente rejeita; UUID em qualquer formato', async () => {
    const { conn } = await setup({}, false);
    await expect(conn.read(SERVICE, FTMS.treadmillData)).rejects.toThrow();
    await expect(conn.read(SERVICE, FTMS.controlPoint)).rejects.toThrow();
    await expect(conn.read(SERVICE, '2a00')).rejects.toThrow();
    await expect(conn.read('180d', FTMS.feature)).rejects.toThrow();
    await expect(conn.read('0x1826', '0x2ACC')).resolves.toHaveLength(8);
  });
});

describe('Control Point', () => {
  it('fluxo completo: controle, start, alvo, aceleração, pausa e stop', async () => {
    const rig = await setup();
    expect(await command(rig, encodeRequestControl())).toBe(R.Success);
    expect(await command(rig, encodeStartOrResume())).toBe(R.Success);
    // Start leva o alvo à velocidade mínima.
    await jest.advanceTimersByTimeAsync(1000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0.8);
    expect(await command(rig, encodeSetTargetSpeed(5))).toBe(R.Success);

    await jest.advanceTimersByTimeAsync(2000);
    const speeds = rig.data.slice(-2).map((d) => d.instantaneousSpeedKmh!);
    expect(speeds[1]).toBeGreaterThan(speeds[0]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(5);
    expect(rig.data.at(-1)!.totalDistanceM).toBeGreaterThan(5);
    expect(rig.data.at(-1)!.elapsedTimeS).toBeGreaterThanOrEqual(8);
    expect(rig.training.at(-1)).toBe(0x0d);

    expect(await command(rig, encodePause())).toBe(R.Success);
    expect(rig.training.at(-1)).toBe(0x0f);
    await jest.advanceTimersByTimeAsync(5000);
    const paused = rig.data.at(-1)!;
    expect(paused.instantaneousSpeedKmh).toBe(0);
    const distance = paused.totalDistanceM;
    const elapsed = paused.elapsedTimeS;

    // Resume preserva o alvo de 5 km/h.
    expect(await command(rig, encodeStartOrResume())).toBe(R.Success);
    await jest.advanceTimersByTimeAsync(6000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(5);
    expect(rig.data.at(-1)!.totalDistanceM).toBeGreaterThan(distance ?? 0);
    expect(rig.data.at(-1)!.elapsedTimeS).toBeGreaterThan(elapsed ?? 0);

    expect(await command(rig, encodeStop())).toBe(R.Success);
    expect(rig.training.at(-1)).toBe(0x01);
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0);
    expect(rig.data.at(-1)!.totalDistanceM).toBeGreaterThan(distance ?? 0); // fica até o Reset

    expect(rig.status.map((s) => s.type)).toEqual([
      'startedOrResumedByUser',
      'targetSpeedChanged',
      'stoppedOrPausedByUser',
      'startedOrResumedByUser',
      'stoppedOrPausedByUser',
    ]);
  });

  it('modelo físico: aceleração de 1 km/h/s, inclinação de 1 %/s, energia e frequência cardíaca', async () => {
    const rig = await withControl();
    await command(rig, encodeSetTargetSpeed(6));
    await command(rig, encodeSetTargetInclination(3));
    await command(rig, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(1000);
    const t1 = rig.data.at(-1)!;
    // 40 ms de atraso do comando + tick: a velocidade sobe 1 km/h por tick.
    expect(t1.instantaneousSpeedKmh).toBeCloseTo(1, 5);
    expect(t1.inclinationPercent).toBe(1);
    expect(t1.rampAngleDeg).toBeCloseTo(0.6, 1);
    await jest.advanceTimersByTimeAsync(9000);
    const t = rig.data.at(-1)!;
    expect(t.instantaneousSpeedKmh).toBe(6);
    expect(t.inclinationPercent).toBe(3);
    expect(t.totalEnergyKcal).toBeGreaterThan(0);
    expect(t.heartRateBpm).toBeGreaterThan(70);
    expect(t.heartRateBpm).toBeLessThanOrEqual(185);
    expect(t.energyPerMinuteKcal).toBeGreaterThan(0);
  });

  it('alvo guardado com a lona parada não move a lona; inclinação se move', async () => {
    const rig = await withControl();
    await command(rig, encodeSetTargetSpeed(8));
    await command(rig, encodeSetTargetInclination(2));
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)).toMatchObject({ instantaneousSpeedKmh: 0, inclinationPercent: 2 });
    await command(rig, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(10000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(8);
  });

  it('result codes de erro', async () => {
    const rig = await setup();
    // Sem controle.
    expect(await command(rig, encodeStartOrResume())).toBe(R.ControlNotPermitted);
    expect(await command(rig, encodeSetTargetSpeed(5))).toBe(R.ControlNotPermitted);
    expect(await command(rig, Uint8Array.of(0x42))).toBe(R.ControlNotPermitted);
    expect(await command(rig, encodeRequestControl())).toBe(R.Success);

    // Parâmetro fora da faixa ou com tamanho errado.
    expect(await command(rig, encodeSetTargetSpeed(0.5))).toBe(R.InvalidParameter);
    expect(await command(rig, encodeSetTargetSpeed(22.1))).toBe(R.InvalidParameter);
    expect(await command(rig, encodeSetTargetSpeed(0))).toBe(R.InvalidParameter);
    expect(await command(rig, Uint8Array.of(ControlPointOp.SetTargetSpeed, 0x10))).toBe(R.InvalidParameter);
    expect(await command(rig, encodeSetTargetInclination(15.5))).toBe(R.InvalidParameter);
    expect(await command(rig, encodeSetTargetInclination(-0.5))).toBe(R.InvalidParameter);
    expect(await command(rig, Uint8Array.of(ControlPointOp.SetTargetInclination))).toBe(R.InvalidParameter);
    expect(await command(rig, Uint8Array.of(ControlPointOp.StopOrPause))).toBe(R.InvalidParameter);
    expect(await command(rig, Uint8Array.of(ControlPointOp.StopOrPause, 0x03))).toBe(R.InvalidParameter);
    // Limites inclusivos.
    expect(await command(rig, encodeSetTargetSpeed(0.8))).toBe(R.Success);
    expect(await command(rig, encodeSetTargetSpeed(22))).toBe(R.Success);
    expect(await command(rig, encodeSetTargetInclination(15))).toBe(R.Success);

    // Operação impossível no estado atual.
    expect(await command(rig, encodeStop())).toBe(R.OperationFailed);
    expect(await command(rig, encodePause())).toBe(R.OperationFailed);
    expect(await command(rig, encodeStartOrResume())).toBe(R.Success);
    expect(await command(rig, encodeStartOrResume())).toBe(R.OperationFailed);
    expect(await command(rig, encodePause())).toBe(R.Success);
    expect(await command(rig, encodePause())).toBe(R.OperationFailed);
    expect(await command(rig, encodeStop())).toBe(R.Success);
    expect(await command(rig, encodeStop())).toBe(R.OperationFailed);

    // Op code desconhecido.
    expect(await command(rig, Uint8Array.of(0x42))).toBe(R.OpCodeNotSupported);
  });

  it('Reset zera o treino e tira o controle do cliente', async () => {
    const rig = await withControl();
    await command(rig, encodeSetTargetInclination(4));
    await command(rig, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(10000);
    expect(await command(rig, encodeReset())).toBe(R.Success);
    expect(rig.status.at(-1)).toEqual({ type: 'reset' });
    expect(rig.training.at(-1)).toBe(0x01);
    expect(await command(rig, encodeStartOrResume())).toBe(R.ControlNotPermitted);
    await jest.advanceTimersByTimeAsync(10000);
    expect(rig.data.at(-1)).toMatchObject({
      instantaneousSpeedKmh: 0,
      totalDistanceM: expect.any(Number),
      inclinationPercent: 0,
      totalEnergyKcal: 0,
      elapsedTimeS: 0,
    });
    // O Reset limpa distância (a lona já havia desacelerado até 0 nos ticks posteriores).
    const distanceAfter = rig.data.at(-1)!.totalDistanceM;
    expect(distanceAfter).toBeLessThan(1);
  });

  it('regras de escrita: característica errada, sem assinatura, procedimento em andamento', async () => {
    const rig = await setup({}, false);
    await expect(rig.conn.write(SERVICE, FTMS.feature, encodeRequestControl())).rejects.toThrow();
    await expect(rig.conn.write(SERVICE, FTMS.treadmillData, encodeRequestControl())).rejects.toThrow();
    // Sem ter assinado as indications.
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl())).rejects.toThrow(/CCCD/);

    const responses: Uint8Array[] = [];
    const sub = await rig.conn.subscribe(SERVICE, FTMS.controlPoint, (d) => responses.push(d));
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl());
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeStartOrResume())).rejects.toThrow(/In Progress/);
    await jest.advanceTimersByTimeAsync(40);
    expect(responses).toHaveLength(1);
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(40);
    expect(responses).toHaveLength(2);

    // remove() desabilita as indications.
    sub.remove();
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeStop())).rejects.toThrow(/CCCD/);
  });

  it('responseDelayMs: a indication só chega depois do atraso', async () => {
    const rig = await setup({ responseDelayMs: 500 });
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl());
    await jest.advanceTimersByTimeAsync(499);
    expect(rig.responses).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(rig.responses).toEqual([{ op: ControlPointOp.RequestControl, result: R.Success }]);
  });

  it('grantControl: false responde Control Not Permitted ao Request Control', async () => {
    const rig = await setup({ grantControl: false });
    expect(await command(rig, encodeRequestControl())).toBe(R.ControlNotPermitted);
    expect(await command(rig, encodeStartOrResume())).toBe(R.ControlNotPermitted);
  });

  it('muteControlPoint aplica o comando, nunca indica e libera o procedimento após o atraso', async () => {
    const rig = await setup({ muteControlPoint: true });
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl());
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeStartOrResume())).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(40);
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(10000);
    expect(rig.responses).toEqual([]);
    // Comando aplicado: a lona está rodando.
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0.8);
    expect(rig.status.map((s) => s.type)).toContain('startedOrResumedByUser');
  });

  it('hasControlPoint: false não aceita escrita nem assinatura de Control Point/Status', async () => {
    const rig = await setup({ hasControlPoint: false });
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl())).rejects.toThrow();
    await expect(rig.conn.subscribe(SERVICE, FTMS.controlPoint, jest.fn())).rejects.toThrow();
    await expect(rig.conn.subscribe(SERVICE, FTMS.machineStatus, jest.fn())).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(1000);
    // Os dados continuam fluindo.
    expect(rig.data).toHaveLength(1);
  });

  it('notifyStatusToCommander controla o status de mudanças pedidas pelo cliente', async () => {
    const silent = await withControl({ notifyStatusToCommander: false });
    await command(silent, encodeStartOrResume());
    await command(silent, encodeSetTargetSpeed(4));
    await command(silent, encodeSetTargetInclination(2));
    await command(silent, encodePause());
    expect(silent.status).toEqual([]);
    // Mudanças pelo console sempre notificam.
    silent.transport.consoleStart();
    expect(silent.status).toEqual([{ type: 'startedOrResumedByUser' }]);

    const loud = await withControl();
    await command(loud, encodeSetTargetSpeed(4.25));
    await command(loud, encodeSetTargetInclination(-0.0));
    await command(loud, encodePause().slice(0, 2)); // não rodando: falha e não notifica
    expect(loud.status).toEqual([
      { type: 'targetSpeedChanged', speedKmh: 4.25 },
      { type: 'targetInclineChanged', inclinationPercent: 0 },
    ]);
  });
});

describe('Treadmill Data', () => {
  it('registro padrão: sem ritmo, flags e campos íntegros', async () => {
    const rig = await withControl();
    await jest.advanceTimersByTimeAsync(1000);
    const data = rig.data.at(-1)!;
    expect(data.moreData).toBe(false);
    expect(data.paceFieldWidth).toBeUndefined();
    expect(data.truncated).toBe(false);
    expect(data.trailingBytes).toBe(0);
    expect(data.flags).toBe(0b101_1000_1100); // distância, inclinação, energia, FC, tempo
    expect(data).toMatchObject({ heartRateBpm: 70, elapsedTimeS: 0, totalEnergyKcal: 0 });
  });

  it('só notifica enquanto houver assinante e respeita tickMs', async () => {
    const rig = await setup({ tickMs: 250 }, false);
    await jest.advanceTimersByTimeAsync(1000); // sem assinante: nada, mas sem erro
    const received: Uint8Array[] = [];
    const sub = await rig.conn.subscribe(SERVICE, FTMS.treadmillData, (d) => received.push(d));
    await jest.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(4);
    sub.remove();
    await jest.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(4);
  });

  it.each([1, 2] as const)('paceFieldWidth %i: parser detecta a largura e demais campos íntegros', async (width) => {
    const rig = await withControl({ paceFieldWidth: width });
    await command(rig, encodeSetTargetSpeed(6));
    await command(rig, encodeStartOrResume());
    await jest.advanceTimersByTimeAsync(10000);
    const data = rig.data.at(-1)!;
    expect(data.paceFieldWidth).toBe(width);
    expect(data.truncated).toBe(false);
    expect(data.trailingBytes).toBe(0);
    expect(data.instantaneousSpeedKmh).toBe(6);
    expect(data.heartRateBpm).toBeGreaterThan(70);
    expect(data.elapsedTimeS).toBeGreaterThan(5);
    expect(data.totalDistanceM).toBeGreaterThan(10);
    // Largura 1: 0,1 km/min (6 km/h = 0,1 km/min = 1). Largura 2: 500 m a 6 km/h = 300 s.
    expect(data.instantaneousPaceRaw).toBe(width === 1 ? 1 : 300);
    // Parado, o ritmo é 0 e o layout continua íntegro.
    await command(rig, encodeStop());
    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data.at(-1)).toMatchObject({ paceFieldWidth: width, instantaneousPaceRaw: 0, truncated: false });
  });

  it.each([0, 1, 2] as const)('splitRecords (ritmo %i): duas notificações por registro', async (width) => {
    const rig = await withControl({ splitRecords: true, paceFieldWidth: width });
    await command(rig, encodeSetTargetSpeed(6));
    await command(rig, encodeSetTargetInclination(2));
    await command(rig, encodeStartOrResume());
    rig.data.length = 0;
    await jest.advanceTimersByTimeAsync(10000);
    expect(rig.data).toHaveLength(20);
    for (let i = 0; i < rig.data.length; i += 2) {
      const [first, second] = [rig.data[i], rig.data[i + 1]];
      expect(first.moreData).toBe(true);
      expect(first.instantaneousSpeedKmh).toBeUndefined();
      expect(first.totalDistanceM).toBeDefined();
      expect(first.inclinationPercent).toBeDefined();
      expect(first.totalEnergyKcal).toBeDefined();
      expect(first.heartRateBpm).toBeUndefined();
      expect(first.truncated).toBe(false);
      expect(first.trailingBytes).toBe(0);

      expect(second.moreData).toBe(false);
      expect(second.instantaneousSpeedKmh).toBeDefined();
      expect(second.heartRateBpm).toBeDefined();
      expect(second.elapsedTimeS).toBeDefined();
      expect(second.totalDistanceM).toBeUndefined();
      expect(second.truncated).toBe(false);
      expect(second.trailingBytes).toBe(0);
      expect(second.paceFieldWidth).toBe(width === 0 ? undefined : width);
    }
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(6);
    expect(rig.data.at(-2)!.inclinationPercent).toBe(2);
  });
});

describe('ações do console', () => {
  it('geram o Fitness Machine Status e o Training Status certos', async () => {
    const rig = await setup();
    const { transport } = rig;
    transport.consoleStart();
    transport.consoleStart(); // já rodando: nada
    transport.consoleSetSpeed(7.5);
    transport.consoleSetInclination(5);
    transport.consolePause();
    transport.consolePause(); // já pausada: nada
    transport.consoleStart();
    transport.consoleStop();
    transport.consoleStop(); // já parada: nada
    transport.pullSafetyKey();
    transport.revokeControl();
    expect(rig.status).toEqual([
      { type: 'startedOrResumedByUser' },
      { type: 'targetSpeedChanged', speedKmh: 7.5 },
      { type: 'targetInclineChanged', inclinationPercent: 5 },
      { type: 'stoppedOrPausedByUser', action: 'pause' },
      { type: 'startedOrResumedByUser' },
      { type: 'stoppedOrPausedByUser', action: 'stop' },
      { type: 'stoppedBySafetyKey' },
      { type: 'controlPermissionLost' },
    ]);
    expect(rig.training).toEqual([0x0d, 0x0f, 0x0d, 0x01]);
  });

  it('a lona obedece ao console; chave de segurança zera o alvo; revokeControl tira o controle', async () => {
    const rig = await withControl();
    rig.transport.consoleSetSpeed(4);
    rig.transport.consoleStart();
    await jest.advanceTimersByTimeAsync(6000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(4);
    rig.transport.pullSafetyKey();
    await jest.advanceTimersByTimeAsync(3000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0);
    expect(rig.status.at(-1)).toEqual({ type: 'stoppedBySafetyKey' });
    // Depois da chave, o start do cliente vai para a velocidade mínima (alvo foi a 0).
    expect(await command(rig, encodeStartOrResume())).toBe(R.Success);
    await jest.advanceTimersByTimeAsync(2000);
    expect(rig.data.at(-1)!.instantaneousSpeedKmh).toBe(0.8);

    rig.transport.revokeControl();
    expect(rig.status.at(-1)).toEqual({ type: 'controlPermissionLost' });
    expect(await command(rig, encodePause())).toBe(R.ControlNotPermitted);
    // Pode pedir de novo.
    expect(await command(rig, encodeRequestControl())).toBe(R.Success);
  });

  it('ações do console sem conexão não fazem nada', () => {
    const transport = new SimulatedTreadmillTransport();
    expect(() => {
      transport.consoleStart();
      transport.consoleStop();
      transport.consolePause();
      transport.consoleSetSpeed(3);
      transport.consoleSetInclination(1);
      transport.pullSafetyKey();
      transport.revokeControl();
      transport.dropLink();
    }).not.toThrow();
  });
});

describe('desconexão', () => {
  it('dropLink chama onDisconnect uma vez, rejeita operações e para os timers', async () => {
    const rig = await withControl();
    const listener = jest.fn();
    const removed = jest.fn();
    rig.conn.onDisconnect(listener);
    rig.conn.onDisconnect(removed).remove();
    await command(rig, encodeStartOrResume());
    // Deixa um procedimento pendente (timer de resposta) para conferir que ele também some.
    await rig.conn.write(SERVICE, FTMS.controlPoint, encodeSetTargetSpeed(5));
    const received = rig.data.length;

    rig.transport.dropLink();
    rig.transport.dropLink();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(5000);
    expect(rig.data).toHaveLength(received);
    await expect(rig.conn.read(SERVICE, FTMS.feature)).rejects.toThrow();
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeStop())).rejects.toThrow();
    await expect(rig.conn.subscribe(SERVICE, FTMS.treadmillData, jest.fn())).rejects.toThrow();
    await expect(rig.conn.getCharacteristics(SERVICE)).rejects.toThrow();

    // Pode reconectar.
    const again = await setup();
    expect(again.conn).not.toBe(rig.conn);
  });

  it('disconnect não chama onDisconnect, rejeita operações e para os timers', async () => {
    const rig = await withControl();
    const listener = jest.fn();
    rig.conn.onDisconnect(listener);
    await rig.conn.disconnect();
    await rig.conn.disconnect();
    rig.transport.dropLink(); // já desconectado: nada
    expect(listener).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await expect(rig.conn.read(SERVICE, FTMS.feature)).rejects.toThrow();
    await expect(rig.conn.write(SERVICE, FTMS.controlPoint, encodeRequestControl())).rejects.toThrow();
    await expect(rig.conn.subscribe(SERVICE, FTMS.treadmillData, jest.fn())).rejects.toThrow();
  });
});
