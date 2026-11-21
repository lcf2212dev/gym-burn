import { uuid16 } from '@/ftms';

/** Heart Rate Service, o perfil padrão das cintas e relógios de batimentos. */
export const HEART_RATE = {
  service: uuid16(0x180d),
  measurement: uuid16(0x2a37),
} as const;

export const BATTERY = {
  service: uuid16(0x180f),
  level: uuid16(0x2a19),
} as const;

export interface HeartRateMeasurement {
  /** Batimentos por minuto; 0 quando o sensor não tem leitura. */
  bpm: number;
  /** `null` quando o sensor não informa se está em contato com a pele. */
  contact: boolean | null;
}

/**
 * Decodifica Heart Rate Measurement (0x2A37). O primeiro byte são as flags: o
 * bit 0 diz se o BPM vem em 8 ou 16 bits, o bit 2 se o sensor detecta contato
 * com a pele e o bit 1 se há contato. Energia gasta e intervalos RR, que podem
 * vir depois, não são usados.
 */
export function parseHeartRateMeasurement(bytes: Uint8Array): HeartRateMeasurement {
  const flags = bytes[0];
  const wide = (flags & 0x01) !== 0;
  if (bytes.length < (wide ? 3 : 2)) {
    throw new Error(`Heart Rate Measurement com ${bytes.length} byte(s)`);
  }
  return {
    bpm: wide ? bytes[1] | (bytes[2] << 8) : bytes[1],
    contact: (flags & 0x04) !== 0 ? (flags & 0x02) !== 0 : null,
  };
}
