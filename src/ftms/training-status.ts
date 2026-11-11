import { ByteReader, FtmsParseError, utf8Decode } from './bytes';

// A posição no array é o valor do campo Training Status (FTMS 1.0, tabela 4.13).
const TRAINING_STATUS_NAMES = [
  'other',
  'idle',
  'warmingUp',
  'lowIntensityInterval',
  'highIntensityInterval',
  'recoveryInterval',
  'isometric',
  'heartRateControl',
  'fitnessTest',
  'speedTooLow',
  'speedTooHigh',
  'coolDown',
  'wattControl',
  'manualMode',
  'preWorkout',
  'postWorkout',
] as const;

export type TrainingStatusName = (typeof TRAINING_STATUS_NAMES)[number] | 'reserved';

/** Característica Training Status (0x2AD3): em que etapa do treino a esteira está. */
export interface TrainingStatus {
  code: number;
  name: TrainingStatusName;
  /** Texto livre enviado pela esteira, quando presente. */
  text: string | null;
}

const FLAG_STRING_PRESENT = 1 << 0;

export function parseTrainingStatus(bytes: Uint8Array): TrainingStatus {
  if (bytes.length < 2) {
    throw new FtmsParseError(`Training Status com ${bytes.length} byte(s); o mínimo são 2`);
  }
  const reader = new ByteReader(bytes);
  const flags = reader.u8();
  const code = reader.u8();
  const hasText = (flags & FLAG_STRING_PRESENT) !== 0 && reader.remaining > 0;
  return {
    code,
    name: TRAINING_STATUS_NAMES[code] ?? 'reserved',
    text: hasText ? utf8Decode(reader.rest()) : null,
  };
}
