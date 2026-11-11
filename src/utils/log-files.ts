import type { LogFile } from '@/logging/types';

import { formatDecimal, formatTrimmed } from './format';

/** Textos da tela de registros a partir dos arquivos guardados. */

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

// Data e hora no nome do arquivo: `gym-burn-2026-11-10_21-30-05.txt`.
const NAME_TIMESTAMP = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

/**
 * Data e hora legíveis de um arquivo, "10/11/2026 21:30". Vem do nome (o
 * instante em que a gravação começou); sem data no nome, da última
 * modificação; sem nenhuma das duas, o próprio nome.
 */
export function logFileDate(file: Pick<LogFile, 'name' | 'modifiedAt'>): string {
  const match = NAME_TIMESTAMP.exec(file.name);
  if (match) {
    const [, year, month, day, hours, minutes] = match;
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
  if (file.modifiedAt !== null && Number.isFinite(file.modifiedAt)) {
    const date = new Date(file.modifiedAt);
    return (
      `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} ` +
      `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
    );
  }
  return file.name;
}

const KB = 1024;
const MB = 1024 * 1024;

/** Tamanho em KB (até 1 MB) ou MB, com vírgula decimal: "0,5 KB", "12 KB", "1,4 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 KB';
  }
  if (bytes < MB) {
    const kb = bytes / KB;
    return `${kb < 10 ? formatTrimmed(kb, 1) : formatDecimal(kb, 0)} KB`;
  }
  return `${formatDecimal(bytes / MB, 1)} MB`;
}
