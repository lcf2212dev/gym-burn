import type { TraceLine } from '@/treadmill/types';

/**
 * Formato dos arquivos de registro (texto puro, UTF-8, uma linha por evento).
 *
 * Nome: `gym-burn-AAAA-MM-DD_HH-mm-ss.txt`, com a hora local do início da execução.
 *
 * Cabeçalho: linhas que começam com `# `. Para ignorá-las: `grep -v '^#'`.
 *
 * Cada evento é UMA linha física (quebras de linha do texto viram ` ⏎ `):
 *
 *   HH:mm:ss.SSS TIPO   texto  hex=BYTES
 *
 * - hora local com milissegundos (a data está no cabeçalho);
 * - TIPO em 6 colunas (`rx`, `tx`, `info`, `error`, `state`, `action`, `guide`), completado com
 *   espaços, então ` rx ` e ` error ` funcionam como filtro: `grep ' tx ' registro.txt`;
 * - `hex=` só aparece quando a linha é um pacote, e vai sempre no fim da linha:
 *   `grep 'hex='` lista só os pacotes e `grep -o 'hex=.*'` extrai os bytes.
 */

const KIND_COLUMN_WIDTH = 6;
const NEWLINE_MARK = ' ⏎ ';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `2026-11-10_21-30-05` (hora local). */
function fileStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** `2026-11-10 21:30:05` (hora local). */
function localDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Nome do arquivo de uma execução que começou em `date`. */
export function logFileName(date: Date): string {
  return `gym-burn-${fileStamp(date)}.txt`;
}

const LOG_FILE_NAME = /^gym-burn-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/;

/** O nome é de um arquivo de registro (e não, por exemplo, do JSON de configuração)? */
export function isLogFileName(name: string): boolean {
  return LOG_FILE_NAME.test(name);
}

/** `21:30:05.123`, hora local. */
function clockWithMillis(timestampMs: number): string {
  const date = new Date(timestampMs);
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/** A linha de texto de um evento, sem a quebra de linha final. */
export function formatTraceLine(line: TraceLine): string {
  const text = line.text.replace(/\r?\n/g, NEWLINE_MARK);
  const hex = line.hex ? `  hex=${line.hex}` : '';
  return `${clockWithMillis(line.at)} ${line.kind.padEnd(KIND_COLUMN_WIDTH)} ${text}${hex}`;
}

export interface HeaderInfo {
  /** Por exemplo `Gym Burn 1.0.0`. */
  app: string;
  /** Por exemplo `Google Pixel 7`. */
  device: string;
  /** Por exemplo `Android 15 (API 35)`. */
  system: string;
}

/** `UTC-03:00`, o deslocamento do fuso local em `date`. */
function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** O cabeçalho do arquivo: linhas `# ...`, sem a quebra de linha final. */
export function formatHeader(info: HeaderInfo, startedAt: number): string {
  const date = new Date(startedAt);
  return [
    '# Gym Burn — registro de execução',
    `# Início: ${localDateTime(date)} (${utcOffset(date)})`,
    `# App: ${info.app}`,
    `# Aparelho: ${info.device}`,
    `# Sistema: ${info.system}`,
    '# Formato: HH:mm:ss.SSS TIPO texto [hex=BYTES]   (uma linha por evento; hora local)',
    '# Tipos: rx e tx = pacotes; state = estado da sessão; action = toque do usuário; guide = roteiro; info; error',
    "# Dica: grep ' tx ' (por tipo); grep 'hex=' (só pacotes); grep -v '^#' (sem este cabeçalho)",
  ].join('\n');
}

/**
 * Nome da pasta para exibir, a partir da URI `content://` do seletor do Android:
 * `.../tree/primary%3ADocuments%2FGymBurn` vira `Documents/GymBurn`.
 */
export function mirrorLabel(uri: string): string {
  const marker = '/tree/';
  const start = uri.indexOf(marker);
  if (start < 0) {
    return uri;
  }
  const tail = uri.slice(start + marker.length).split('/document/')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    decoded = tail;
  }
  // "primary:Documents/GymBurn" → "Documents/GymBurn"; "1A2B-3C4D:Fotos" é um cartão de memória.
  const colon = decoded.indexOf(':');
  const volume = colon >= 0 ? decoded.slice(0, colon) : '';
  const path = (colon >= 0 ? decoded.slice(colon + 1) : decoded).replace(/\/+$/, '');
  if (volume !== '' && volume !== 'primary') {
    return path ? `${volume}: ${path}` : volume;
  }
  return path || 'Armazenamento interno';
}
