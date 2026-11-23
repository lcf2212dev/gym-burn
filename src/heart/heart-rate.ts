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
  /**
   * Intervalos entre batimentos (RR) deste pacote, em ms inteiros, na ordem
   * em que aconteceram. Vazio quando o sensor não manda. A XOSS X2 Pro manda 1
   * ou 2 em todo pacote.
   */
  rrMs: number[];
}

/**
 * Decodifica Heart Rate Measurement (0x2A37). O primeiro byte são as flags: o
 * bit 0 diz se o BPM vem em 8 ou 16 bits, o bit 2 se o sensor detecta contato
 * com a pele e o bit 1 se há contato. O bit 3 diz se vem a energia gasta (2
 * bytes, não usada: só é pulada) e o bit 4 se vêm intervalos RR, que ocupam o
 * resto do pacote, 2 bytes cada, em 1/1024 s.
 */
export function parseHeartRateMeasurement(bytes: Uint8Array): HeartRateMeasurement {
  const flags = bytes[0];
  const wide = (flags & 0x01) !== 0;
  if (bytes.length < (wide ? 3 : 2)) {
    throw new Error(`Heart Rate Measurement com ${bytes.length} byte(s)`);
  }
  let offset = wide ? 3 : 2;
  if ((flags & 0x08) !== 0) {
    offset += 2;
  }
  const rrMs: number[] = [];
  if ((flags & 0x10) !== 0) {
    for (; offset + 1 < bytes.length; offset += 2) {
      rrMs.push(Math.round(((bytes[offset] | (bytes[offset + 1] << 8)) * 1000) / 1024));
    }
  }
  return {
    bpm: wide ? bytes[1] | (bytes[2] << 8) : bytes[1],
    contact: (flags & 0x04) !== 0 ? (flags & 0x02) !== 0 : null,
    rrMs,
  };
}
