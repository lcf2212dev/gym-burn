/**
 * Decodificador mínimo de arquivo FIT (Garmin Flexible and Interoperable Data
 * Transfer), só para o que a XOSS X2 Pro grava: um `record` por segundo com FC
 * e cadência. Código puro.
 *
 * O arquivo é um cabeçalho (12 ou 14 bytes, com ".FIT" nos bytes 8 a 11) e uma
 * sequência de mensagens. Cada mensagem de dados segue uma de definição, que
 * diz os campos, os tamanhos e a ordem dos bytes; o cabeçalho de cada mensagem
 * diz a qual definição local (0 a 15) ela pertence. Há também o cabeçalho de
 * carimbo comprimido, que traz só os 5 bits baixos do horário. Distância e
 * velocidade a cinta grava vazias, e a `session` não interessa aqui.
 */

/** Diferença entre a época do FIT (31/12/1989 00:00 UTC) e a Unix, em segundos. */
export const FIT_EPOCH_OFFSET_S = 631065600;

const RECORD = 20;
const FILE_ID = 0;
const TIMESTAMP = 253;
const HEART_RATE = 3;
const CADENCE = 4;
const TIME_CREATED = 4;

export interface FitRecord {
  /** Horário do registro, em ms desde 1970 (o relógio da cinta, que o app acerta). */
  at: number;
  /** `null` quando vazio (0xFF). */
  bpm: number | null;
  /** Passos por minuto (medido assim na cinta, ver `XossSteps.spm`); `null` quando vazio. */
  cadence: number | null;
}

export interface FitActivity {
  /** Quando o arquivo foi criado (`file_id.time_created`), senão o primeiro registro; `null` sem nenhum. */
  startMs: number | null;
  records: FitRecord[];
}

interface Definition {
  global: number;
  littleEndian: boolean;
  fields: { number: number; size: number }[];
  /** Bytes dos campos de desenvolvedor, que vêm depois e são pulados. */
  developerBytes: number;
}

/** Valor sem sinal de 1, 2 ou 4 bytes; `null` se for o "vazio" do tipo (todos os bits em 1). */
function unsigned(bytes: Uint8Array, offset: number, size: number, littleEndian: boolean): number | null {
  if (size !== 1 && size !== 2 && size !== 4) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < size; i++) {
    const b = bytes[littleEndian ? offset + size - 1 - i : offset + i];
    value = value * 256 + b;
  }
  return value === 2 ** (8 * size) - 1 ? null : value;
}

export function decodeFit(bytes: Uint8Array): FitActivity {
  const headerSize = bytes[0];
  const signature = String.fromCharCode(...bytes.subarray(8, 12));
  if ((headerSize !== 12 && headerSize !== 14) || bytes.length < headerSize || signature !== '.FIT') {
    throw new Error('Não é um arquivo FIT.');
  }
  const dataSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const end = Math.min(bytes.length, headerSize + dataSize);
  const definitions = new Map<number, Definition>();
  const records: FitRecord[] = [];
  let created: number | null = null;
  /** O último carimbo completo, em segundos FIT: base dos cabeçalhos comprimidos. */
  let lastTimestamp: number | null = null;

  let offset = headerSize;
  while (offset < end) {
    const header = bytes[offset++];
    let local: number;
    let compressed: number | null = null;
    if (header & 0x80) {
      // Carimbo comprimido: 2 bits de tipo local e 5 bits de deslocamento do horário.
      local = (header >> 5) & 0x03;
      const delta = header & 0x1f;
      if (lastTimestamp !== null) {
        compressed = (lastTimestamp & ~0x1f) + delta;
        if (delta < (lastTimestamp & 0x1f)) compressed += 0x20;
        lastTimestamp = compressed;
      }
    } else {
      local = header & 0x0f;
      if (header & 0x40) {
        // Definição: reservado, arquitetura, mensagem global, campos (e os de desenvolvedor).
        if (offset + 5 > end) break;
        const littleEndian = bytes[offset + 1] === 0;
        const global = littleEndian
          ? bytes[offset + 2] | (bytes[offset + 3] << 8)
          : (bytes[offset + 2] << 8) | bytes[offset + 3];
        const count = bytes[offset + 4];
        offset += 5;
        if (offset + count * 3 > end) break;
        const fields: Definition['fields'] = [];
        for (let i = 0; i < count; i++, offset += 3) {
          fields.push({ number: bytes[offset], size: bytes[offset + 1] });
        }
        let developerBytes = 0;
        if (header & 0x20) {
          const developer = bytes[offset++];
          if (offset + developer * 3 > end) break;
          for (let i = 0; i < developer; i++, offset += 3) {
            developerBytes += bytes[offset + 1];
          }
        }
        definitions.set(local, { global, littleEndian, fields, developerBytes });
        continue;
      }
    }

    const definition = definitions.get(local);
    if (!definition) {
      // Sem definição não dá para saber o tamanho: o resto do arquivo não se lê.
      break;
    }
    const size = definition.fields.reduce((sum, field) => sum + field.size, 0) + definition.developerBytes;
    if (offset + size > end) break;
    const values = new Map<number, number | null>();
    let at = offset;
    for (const field of definition.fields) {
      values.set(field.number, unsigned(bytes, at, field.size, definition.littleEndian));
      at += field.size;
    }
    offset += size;

    const stamp = values.get(TIMESTAMP);
    if (stamp != null) {
      lastTimestamp = stamp;
    }
    if (definition.global === FILE_ID) {
      const time = values.get(TIME_CREATED);
      if (time != null) created = (time + FIT_EPOCH_OFFSET_S) * 1000;
    } else if (definition.global === RECORD) {
      const seconds = stamp ?? compressed;
      if (seconds == null) continue;
      records.push({
        at: (seconds + FIT_EPOCH_OFFSET_S) * 1000,
        bpm: values.get(HEART_RATE) ?? null,
        cadence: values.get(CADENCE) ?? null,
      });
    }
  }
  return { startMs: created ?? records[0]?.at ?? null, records };
}
