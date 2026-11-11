import { ByteReader, FtmsParseError } from './bytes';

/** Faixa aceita por um alvo e o menor passo que a esteira distingue. */
export interface SupportedRange {
  min: number;
  max: number;
  step: number;
}

function ensureLength(bytes: Uint8Array, name: string): void {
  if (bytes.length < 6) {
    throw new FtmsParseError(`${name} com ${bytes.length} byte(s); o esperado são 6`);
  }
}

/** Supported Speed Range (0x2AD4), em km/h. */
export function parseSupportedSpeedRange(bytes: Uint8Array): SupportedRange {
  ensureLength(bytes, 'Supported Speed Range');
  const reader = new ByteReader(bytes);
  return {
    min: reader.u16() / 100,
    max: reader.u16() / 100,
    step: reader.u16() / 100,
  };
}

/** Supported Inclination Range (0x2AD5), em %. */
export function parseSupportedInclinationRange(bytes: Uint8Array): SupportedRange {
  ensureLength(bytes, 'Supported Inclination Range');
  const reader = new ByteReader(bytes);
  return {
    min: reader.s16() / 10,
    max: reader.s16() / 10,
    step: reader.u16() / 10,
  };
}
