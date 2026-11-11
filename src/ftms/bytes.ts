/** Erro de decodificação de um valor FTMS (payload curto demais ou malformado). */
export class FtmsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FtmsParseError';
  }
}

/**
 * Leitor sequencial little-endian. No FTMS (seção 3.2) todo campo multi-octeto
 * é transmitido com o octeto menos significativo primeiro.
 */
export class ByteReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  canRead(size: number): boolean {
    return this.remaining >= size;
  }

  u8(): number {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  u16(): number {
    this.ensure(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  s16(): number {
    const value = this.u16();
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  u24(): number {
    this.ensure(3);
    const value =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16);
    this.offset += 3;
    return value;
  }

  u32(): number {
    this.ensure(4);
    // `>>> 0` mantém o resultado sem sinal quando o bit 31 está ligado.
    const value =
      (this.bytes[this.offset] |
        (this.bytes[this.offset + 1] << 8) |
        (this.bytes[this.offset + 2] << 16) |
        (this.bytes[this.offset + 3] << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  /** Devolve os bytes restantes e consome o leitor. */
  rest(): Uint8Array {
    const value = this.bytes.slice(this.offset);
    this.offset = this.bytes.length;
    return value;
  }

  private ensure(size: number): void {
    if (!this.canRead(size)) {
      throw new FtmsParseError(
        `Faltam bytes: precisava de ${size}, restam ${this.remaining} (tamanho total ${this.bytes.length})`,
      );
    }
  }
}

/** `[0x02, 0x1a, 0x04]` → `"02 1A 04"`. Usado no log de diagnóstico. */
export function bytesToHex(bytes: ArrayLike<number>, separator = ' '): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push((bytes[i] & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(separator);
}

/** `"02 1A 04"`, `"021a04"` ou `"02:1A:04"` → bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const digits = hex.replace(/[\s:,-]/g, '');
  if (digits.length % 2 !== 0 || /[^0-9a-fA-F]/.test(digits)) {
    throw new FtmsParseError(`Hexadecimal inválido: "${hex}"`);
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decodifica UTF-8 sem depender de `TextDecoder`, que não existe em todas as
 * versões do Hermes. Sequências inválidas viram U+FFFD.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i++];
    let codePoint: number;
    let extra: number;
    if (first < 0x80) {
      codePoint = first;
      extra = 0;
    } else if (first >= 0xc2 && first < 0xe0) {
      codePoint = first & 0x1f;
      extra = 1;
    } else if (first >= 0xe0 && first < 0xf0) {
      codePoint = first & 0x0f;
      extra = 2;
    } else if (first >= 0xf0 && first < 0xf5) {
      codePoint = first & 0x07;
      extra = 3;
    } else {
      text += '�';
      continue;
    }
    let valid = true;
    for (let k = 0; k < extra; k++) {
      const next = bytes[i];
      if (next === undefined || (next & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
      i++;
    }
    text += valid ? String.fromCodePoint(codePoint) : '�';
  }
  return text;
}
