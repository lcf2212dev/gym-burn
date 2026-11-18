/**
 * Codificação little-endian dos payloads GATT da esteira simulada. Escrita à
 * parte de `@/ftms` de propósito: assim os testes confrontam duas leituras
 * independentes da mesma especificação.
 */

/** Arredonda e limita ao intervalo representável pelo campo. */
function clampRound(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Acumula octetos em little-endian; o arredondamento acontece aqui, na codificação. */
export class ByteWriter {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(clampRound(value, 0, 0xff));
    return this;
  }

  u16(value: number): this {
    const raw = clampRound(value, 0, 0xffff);
    this.bytes.push(raw & 0xff, raw >> 8);
    return this;
  }

  s16(value: number): this {
    const raw = clampRound(value, -0x8000, 0x7fff) & 0xffff;
    this.bytes.push(raw & 0xff, raw >> 8);
    return this;
  }

  u24(value: number): this {
    const raw = clampRound(value, 0, 0xffffff);
    this.bytes.push(raw & 0xff, (raw >> 8) & 0xff, raw >> 16);
    return this;
  }

  u32(value: number): this {
    const raw = clampRound(value, 0, 0xffffffff);
    this.bytes.push(raw & 0xff, (raw >>> 8) & 0xff, (raw >>> 16) & 0xff, raw >>> 24);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Bits do campo Flags de Treadmill Data (FTMS 1.0, tabela 4.9). */
export const TREADMILL_FLAG = {
  moreData: 1 << 0,
  totalDistance: 1 << 2,
  inclination: 1 << 3,
  instantaneousPace: 1 << 5,
  expendedEnergy: 1 << 7,
  heartRate: 1 << 8,
  metabolicEquivalent: 1 << 9,
  elapsedTime: 1 << 10,
} as const;

/** Bits do campo Fitness Machine Features (tabela 4.3) que o simulador liga. */
export const MACHINE_FEATURE_BIT = {
  totalDistance: 2,
  inclination: 3,
  pace: 5,
  expendedEnergy: 9,
  heartRate: 10,
  metabolicEquivalent: 11,
  elapsedTime: 12,
} as const;

/** Op codes do Fitness Machine Status (tabela 4.26). */
export const STATUS_OP = {
  reset: 0x01,
  stoppedOrPaused: 0x02,
  stoppedBySafetyKey: 0x03,
  startedOrResumed: 0x04,
  targetSpeedChanged: 0x05,
  targetInclinationChanged: 0x06,
  controlLost: 0xff,
} as const;

/** Valores do campo Training Status (tabela 4.13). */
export const TRAINING_STATUS_CODE = {
  idle: 0x01,
  manualMode: 0x0d,
  postWorkout: 0x0f,
} as const;

/** Foto do estado físico que vira um registro de Treadmill Data. */
export interface TreadmillReading {
  speedKmh: number;
  distanceM: number;
  inclinationPercent: number;
  energyKcal: number;
  energyPerMinuteKcal: number;
  heartRateBpm: number;
  /** METs calculados pelo console, como o firmware da T600X manda. */
  metabolicEquivalent: number;
  elapsedS: number;
}

/** Ritmo instantâneo no formato da largura escolhida; 0 com a lona parada. */
function encodePace(speedKmh: number, width: 1 | 2): number {
  if (speedKmh <= 0) return 0;
  // Largura 1: 0,1 km/min. Largura 2: segundos por 500 m.
  return width === 1 ? (speedKmh / 60) * 10 : 500 / (speedKmh / 3.6);
}

function writePace(writer: ByteWriter, value: number, width: 1 | 2): void {
  if (width === 1) writer.u8(value);
  else writer.u16(value);
}

/**
 * Monta uma ou duas notificações de Treadmill Data. Com `split`, o registro
 * vai dividido usando o bit More Data (a 1ª parte não leva velocidade).
 */
export function buildTreadmillData(
  reading: TreadmillReading,
  paceWidth: 0 | 1 | 2,
  split: boolean,
): Uint8Array[] {
  const F = TREADMILL_FLAG;
  const rampDeg = (Math.atan(reading.inclinationPercent / 100) * 180) / Math.PI;
  const pace = paceWidth === 0 ? 0 : encodePace(reading.speedKmh, paceWidth);
  const paceFlag = paceWidth === 0 ? 0 : F.instantaneousPace;

  const writeDistance = (w: ByteWriter) => w.u24(reading.distanceM);
  const writeInclination = (w: ByteWriter) =>
    w.s16(reading.inclinationPercent * 10).s16(rampDeg * 10);
  const writeEnergy = (w: ByteWriter) =>
    w
      .u16(reading.energyKcal)
      .u16(reading.energyPerMinuteKcal * 60)
      .u8(reading.energyPerMinuteKcal);

  if (!split) {
    const flags =
      F.totalDistance |
      F.inclination |
      paceFlag |
      F.expendedEnergy |
      F.heartRate |
      F.metabolicEquivalent |
      F.elapsedTime;
    const w = new ByteWriter().u16(flags).u16(reading.speedKmh * 100);
    writeDistance(w);
    writeInclination(w);
    if (paceWidth !== 0) writePace(w, pace, paceWidth);
    writeEnergy(w);
    w.u8(reading.heartRateBpm).u8(reading.metabolicEquivalent * 10).u16(reading.elapsedS);
    return [w.finish()];
  }

  const first = new ByteWriter().u16(
    F.moreData | F.totalDistance | F.inclination | F.expendedEnergy,
  );
  writeDistance(first);
  writeInclination(first);
  writeEnergy(first);

  const second = new ByteWriter().u16(paceFlag | F.heartRate | F.elapsedTime).u16(
    reading.speedKmh * 100,
  );
  if (paceWidth !== 0) writePace(second, pace, paceWidth);
  second.u8(reading.heartRateBpm).u8(reading.metabolicEquivalent * 10).u16(reading.elapsedS);
  return [first.finish(), second.finish()];
}

/**
 * Fitness Machine Status de "velocidade alvo alterada" como o firmware desta
 * família manda: o campo de 0,01 km/h da especificação vem multiplicado por 16
 * (5,0 km/h → raw 8000). O parser de `@/ftms` corrige esse desvio.
 */
export function machineStatusTargetSpeed(kmh: number): Uint8Array {
  const raw = clampRound(kmh * 1600, 0, 0xffff);
  return Uint8Array.of(STATUS_OP.targetSpeedChanged, raw & 0xff, raw >> 8);
}

/** Fitness Machine Status de "inclinação alvo alterada" (0,1 %, com sinal). */
export function machineStatusTargetInclination(percent: number): Uint8Array {
  const raw = clampRound(percent * 10, -0x8000, 0x7fff) & 0xffff;
  return Uint8Array.of(STATUS_OP.targetInclinationChanged, raw & 0xff, raw >> 8);
}
