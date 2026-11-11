import { ByteReader, FtmsParseError } from './bytes';

/**
 * Um valor da característica Treadmill Data (0x2ACD). Campos ausentes na
 * notificação — ou marcados pela esteira como "dado não disponível" — ficam
 * `undefined`.
 *
 * Um registro pode vir dividido em várias notificações (FTMS 1.0, seção 4.19):
 * enquanto `moreData` for `true` o registro continua na próxima.
 */
export interface TreadmillData {
  /** Campo Flags bruto (uint16). */
  flags: number;
  /** Bit 0: o registro continua na próxima notificação (e não traz velocidade instantânea). */
  moreData: boolean;
  instantaneousSpeedKmh?: number;
  averageSpeedKmh?: number;
  totalDistanceM?: number;
  inclinationPercent?: number;
  rampAngleDeg?: number;
  positiveElevationGainM?: number;
  negativeElevationGainM?: number;
  /** Valor bruto do campo de ritmo; a unidade depende de `paceFieldWidth`. */
  instantaneousPaceRaw?: number;
  averagePaceRaw?: number;
  /**
   * Largura detectada dos campos de ritmo. 1 octeto: definição original de
   * 2017 (0,1 km/min). 2 octetos: GATT Specification Supplement atual
   * (segundos por 500 m).
   */
  paceFieldWidth?: 1 | 2;
  totalEnergyKcal?: number;
  energyPerHourKcal?: number;
  energyPerMinuteKcal?: number;
  heartRateBpm?: number;
  /** Em METs, assumindo resolução de 0,1 (definição original do FTMS). */
  metabolicEquivalent?: number;
  elapsedTimeS?: number;
  remainingTimeS?: number;
  forceOnBeltN?: number;
  powerOutputW?: number;
  /** O payload acabou antes de todos os campos anunciados nas flags. */
  truncated: boolean;
  /** Bytes sobrando depois do último campo conhecido. */
  trailingBytes: number;
}

const FLAG = {
  moreData: 1 << 0,
  averageSpeed: 1 << 1,
  totalDistance: 1 << 2,
  inclination: 1 << 3,
  elevationGain: 1 << 4,
  instantaneousPace: 1 << 5,
  averagePace: 1 << 6,
  expendedEnergy: 1 << 7,
  heartRate: 1 << 8,
  metabolicEquivalent: 1 << 9,
  elapsedTime: 1 << 10,
  remainingTime: 1 << 11,
  forceAndPower: 1 << 12,
} as const;

// Valores especiais "Data Not Available" (FTMS 1.0, seções 4.4.1.5 a 4.4.1.18).
const SINT16_NOT_AVAILABLE = 0x7fff;
const UINT16_NOT_AVAILABLE = 0xffff;
const UINT8_NOT_AVAILABLE = 0xff;

function has(flags: number, bit: number): boolean {
  return (flags & bit) !== 0;
}

/** Tamanho esperado do payload para um conjunto de flags e uma largura de ritmo. */
function expectedLength(flags: number, paceWidth: 1 | 2): number {
  let length = 2;
  if (!has(flags, FLAG.moreData)) length += 2;
  if (has(flags, FLAG.averageSpeed)) length += 2;
  if (has(flags, FLAG.totalDistance)) length += 3;
  if (has(flags, FLAG.inclination)) length += 4;
  if (has(flags, FLAG.elevationGain)) length += 4;
  if (has(flags, FLAG.instantaneousPace)) length += paceWidth;
  if (has(flags, FLAG.averagePace)) length += paceWidth;
  if (has(flags, FLAG.expendedEnergy)) length += 5;
  if (has(flags, FLAG.heartRate)) length += 1;
  if (has(flags, FLAG.metabolicEquivalent)) length += 1;
  if (has(flags, FLAG.elapsedTime)) length += 2;
  if (has(flags, FLAG.remainingTime)) length += 2;
  if (has(flags, FLAG.forceAndPower)) length += 4;
  return length;
}

/**
 * Os campos de ritmo mudaram de tamanho entre a definição original (uint8) e o
 * GSS atual (uint16), e o equipamento não informa qual implementa. Como as
 * flags fixam o tamanho de todo o resto, o comprimento do payload desempata.
 */
function resolvePaceWidth(flags: number, length: number): 1 | 2 | undefined {
  if (!has(flags, FLAG.instantaneousPace) && !has(flags, FLAG.averagePace)) {
    return undefined;
  }
  if (length === expectedLength(flags, 2)) return 2;
  if (length === expectedLength(flags, 1)) return 1;
  // Nenhum dos dois bate: fica com o maior layout que ainda cabe no payload.
  return length >= expectedLength(flags, 2) ? 2 : 1;
}

export function parseTreadmillData(bytes: Uint8Array): TreadmillData {
  if (bytes.length < 2) {
    throw new FtmsParseError(`Treadmill Data sem o campo Flags (${bytes.length} byte(s))`);
  }
  const reader = new ByteReader(bytes);
  const flags = reader.u16();
  const data: TreadmillData = {
    flags,
    moreData: has(flags, FLAG.moreData),
    truncated: false,
    trailingBytes: 0,
  };
  const paceWidth = resolvePaceWidth(flags, bytes.length);
  if (paceWidth !== undefined) data.paceFieldWidth = paceWidth;
  const readPace = () => (paceWidth === 1 ? reader.u8() : reader.u16());

  // Na ordem em que os campos aparecem no payload.
  const fields: { present: boolean; size: number; read: () => void }[] = [
    {
      present: !data.moreData,
      size: 2,
      read: () => {
        data.instantaneousSpeedKmh = reader.u16() / 100;
      },
    },
    {
      present: has(flags, FLAG.averageSpeed),
      size: 2,
      read: () => {
        data.averageSpeedKmh = reader.u16() / 100;
      },
    },
    {
      present: has(flags, FLAG.totalDistance),
      size: 3,
      read: () => {
        data.totalDistanceM = reader.u24();
      },
    },
    {
      present: has(flags, FLAG.inclination),
      size: 4,
      read: () => {
        const inclination = reader.s16();
        const rampAngle = reader.s16();
        if (inclination !== SINT16_NOT_AVAILABLE) data.inclinationPercent = inclination / 10;
        if (rampAngle !== SINT16_NOT_AVAILABLE) data.rampAngleDeg = rampAngle / 10;
      },
    },
    {
      present: has(flags, FLAG.elevationGain),
      size: 4,
      read: () => {
        data.positiveElevationGainM = reader.u16() / 10;
        data.negativeElevationGainM = reader.u16() / 10;
      },
    },
    {
      present: has(flags, FLAG.instantaneousPace),
      size: paceWidth ?? 2,
      read: () => {
        data.instantaneousPaceRaw = readPace();
      },
    },
    {
      present: has(flags, FLAG.averagePace),
      size: paceWidth ?? 2,
      read: () => {
        data.averagePaceRaw = readPace();
      },
    },
    {
      present: has(flags, FLAG.expendedEnergy),
      size: 5,
      read: () => {
        const total = reader.u16();
        const perHour = reader.u16();
        const perMinute = reader.u8();
        if (total !== UINT16_NOT_AVAILABLE) data.totalEnergyKcal = total;
        if (perHour !== UINT16_NOT_AVAILABLE) data.energyPerHourKcal = perHour;
        if (perMinute !== UINT8_NOT_AVAILABLE) data.energyPerMinuteKcal = perMinute;
      },
    },
    {
      present: has(flags, FLAG.heartRate),
      size: 1,
      read: () => {
        data.heartRateBpm = reader.u8();
      },
    },
    {
      present: has(flags, FLAG.metabolicEquivalent),
      size: 1,
      read: () => {
        data.metabolicEquivalent = reader.u8() / 10;
      },
    },
    {
      present: has(flags, FLAG.elapsedTime),
      size: 2,
      read: () => {
        data.elapsedTimeS = reader.u16();
      },
    },
    {
      present: has(flags, FLAG.remainingTime),
      size: 2,
      read: () => {
        data.remainingTimeS = reader.u16();
      },
    },
    {
      present: has(flags, FLAG.forceAndPower),
      size: 4,
      read: () => {
        const force = reader.s16();
        const power = reader.s16();
        if (force !== SINT16_NOT_AVAILABLE) data.forceOnBeltN = force;
        if (power !== SINT16_NOT_AVAILABLE) data.powerOutputW = power;
      },
    },
  ];

  for (const field of fields) {
    if (!field.present) continue;
    if (!reader.canRead(field.size)) {
      // Os campos já lidos continuam válidos: o layout é sequencial.
      data.truncated = true;
      return data;
    }
    field.read();
  }
  data.trailingBytes = reader.remaining;
  return data;
}
