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
  elapsedTime: 1 << 10,
} as const;

/** Bits do campo Fitness Machine Features (tabela 4.3) que o simulador liga. */
export const MACHINE_FEATURE_BIT = {
  totalDistance: 2,
  inclination: 3,
  pace: 5,
  expendedEnergy: 9,
  heartRate: 10,
  elapsedTime: 12,
} as const;

/** Bits do campo Target Setting Features (tabela 4.4) que o simulador liga. */
export const TARGET_SETTING_BIT = {
  speed: 0,
  inclination: 1,
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
export interface TreadmillSnapshot {
  speedKmh: number;
  distanceM: number;
  inclinationPercent: number;
  energyKcal: number;
  energyPerMinuteKcal: number;
  heartRateBpm: number;
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
  snapshot: TreadmillSnapshot,
  paceWidth: 0 | 1 | 2,
  split: boolean,
): Uint8Array[] {
  const F = TREADMILL_FLAG;
  const rampDeg = (Math.atan(snapshot.inclinationPercent / 100) * 180) / Math.PI;
  const pace = paceWidth === 0 ? 0 : encodePace(snapshot.speedKmh, paceWidth);
  const paceFlag = paceWidth === 0 ? 0 : F.instantaneousPace;

  const writeDistance = (w: ByteWriter) => w.u24(snapshot.distanceM);
  const writeInclination = (w: ByteWriter) =>
    w.s16(snapshot.inclinationPercent * 10).s16(rampDeg * 10);
  const writeEnergy = (w: ByteWriter) =>
    w
      .u16(snapshot.energyKcal)
      .u16(snapshot.energyPerMinuteKcal * 60)
      .u8(snapshot.energyPerMinuteKcal);

  if (!split) {
    const flags = F.totalDistance | F.inclination | paceFlag | F.expendedEnergy | F.heartRate | F.elapsedTime;
    const w = new ByteWriter().u16(flags).u16(snapshot.speedKmh * 100);
    writeDistance(w);
    writeInclination(w);
    if (paceWidth !== 0) writePace(w, pace, paceWidth);
    writeEnergy(w);
    w.u8(snapshot.heartRateBpm).u16(snapshot.elapsedS);
    return [w.finish()];
  }

  const first = new ByteWriter().u16(F.moreData | F.totalDistance | F.inclination | F.expendedEnergy);
  writeDistance(first);
  writeInclination(first);
  writeEnergy(first);

  const second = new ByteWriter().u16(paceFlag | F.heartRate | F.elapsedTime).u16(snapshot.speedKmh * 100);
  if (paceWidth !== 0) writePace(second, pace, paceWidth);
  second.u8(snapshot.heartRateBpm).u16(snapshot.elapsedS);
  return [first.finish(), second.finish()];
}
