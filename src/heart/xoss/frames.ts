/**
 * Quadros do canal proprietário da cinta XOSS X2 Pro, decifrado em 22/11/2026
 * na cinta do usuário (firmware 1.1.0009) e conferido com o cliente de
 * referência em `tools/xoss/xoss.py`. Código puro.
 *
 * O canal é o Nordic UART. Comandos e respostas vão pelo controle (6e400004:
 * escrita com resposta e notificação). Os arquivos vão por YMODEM nos outros
 * dois: a cinta manda pelo 6e400003 (notificação) e recebe pelo 6e400002
 * (escrita sem resposta).
 *
 * Um quadro é `[código, conteúdo…, XOR de todos os bytes anteriores]`, até 20
 * bytes; conteúdo vazio vira um byte `00`. A resposta tem o mesmo formato.
 */

export const XOSS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  /** App → cinta, bytes do YMODEM (escrita sem resposta). */
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  /** Cinta → app, bytes do YMODEM (notificação). */
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  /** Comandos e respostas (escrita com resposta e notificação). */
  control: '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
} as const;

/** O Model Number (0x2A24) da X2 Pro: só ela fala este protocolo. */
export const XOSS_MODEL = 'X2PRO';

/** Códigos de comando e o código da resposta de cada um. */
export const OP = {
  /** `FF 00` → `04 00` (livre). */
  status: 0xff,
  statusReply: 0x04,
  /** `09 00` → `0A "970/972"` (kB livres/total, em texto). */
  space: 0x09,
  spaceReply: 0x0a,
  /** `54 <epoch, 4 bytes LE>` → `55 …`. */
  clock: 0x54,
  clockReply: 0x55,
  /** `71 00 00` lê; `71 01 <bpm>` liga, `71 01 00` desliga → `71 <bpm> 00 00`. */
  alert: 0x71,
  /** `72 00` lê; `72 01|00 00 00 00 00` liga ou desliga → `72 <ligado> <passos/min> <total LE32>`. */
  steps: 0x72,
  /** `75 00` lê (`75 FF` livre, `75 01` gravando); `75 01` inicia; `75 02` encerra (`75 04`). */
  recording: 0x75,
  /** `76 FF` → `76 00` manual ou `76 01` automático. */
  recordMode: 0x76,
  /** `05 <nome>` → `06 <nome>`, e o arquivo vem por YMODEM. */
  fetch: 0x05,
  fetchReply: 0x06,
  /** `07 <nome>` → `08 <nome>`, e o arquivo vai por YMODEM. */
  send: 0x07,
  sendReply: 0x08,
} as const;

export function xor(bytes: ArrayLike<number>, end = bytes.length): number {
  let value = 0;
  for (let i = 0; i < end; i++) {
    value ^= bytes[i];
  }
  return value;
}

/** Monta um quadro de controle. Sem conteúdo vai um `00`, como o app da XOSS faz. */
export function frame(opcode: number, content: ArrayLike<number> = [0x00]): Uint8Array {
  const body = content.length === 0 ? [0x00] : Array.from(content);
  const bytes = Uint8Array.from([opcode, ...body, 0]);
  bytes[bytes.length - 1] = xor(bytes, bytes.length - 1);
  if (bytes.length > 20) {
    throw new Error(`Quadro de ${bytes.length} bytes; o limite é 20.`);
  }
  return bytes;
}

/** O último byte é o XOR dos anteriores (e há ao menos código e XOR). */
export function validFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && xor(bytes, bytes.length - 1) === bytes[bytes.length - 1];
}

/** O conteúdo de uma resposta: sem o código e sem o XOR. */
export function content(reply: Uint8Array): Uint8Array {
  return reply.subarray(1, reply.length - 1);
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0) & 0x7f);
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

// --- Comandos ----------------------------------------------------------------

export const statusFrame = () => frame(OP.status);
export const spaceFrame = () => frame(OP.space);

/** Acerta o relógio da cinta: segundos desde 1970, 4 bytes little-endian. */
export function clockFrame(epochS: number): Uint8Array {
  const value = Math.max(0, Math.floor(epochS)) >>> 0;
  return frame(OP.clock, [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]);
}

export const alertQueryFrame = () => frame(OP.alert, [0x00, 0x00]);
/** Liga o alerta de FC em `bpm`; `null` (ou 0) desliga. */
export function alertSetFrame(bpm: number | null): Uint8Array {
  const value = bpm === null ? 0 : Math.max(0, Math.min(255, Math.round(bpm)));
  return frame(OP.alert, [0x01, value]);
}

export const stepsQueryFrame = () => frame(OP.steps, [0x00]);
export const stepsSetFrame = (on: boolean) => frame(OP.steps, [on ? 1 : 0, 0, 0, 0, 0, 0]);

export const recordingQueryFrame = () => frame(OP.recording, [0x00]);
export const recordingStartFrame = () => frame(OP.recording, [0x01]);
export const recordingStopFrame = () => frame(OP.recording, [0x02]);
export const recordModeFrame = () => frame(OP.recordMode, [0xff]);

export const fetchFrame = (name: string) => frame(OP.fetch, ascii(name));
export const sendFrame = (name: string) => frame(OP.send, ascii(name));

// --- Respostas ---------------------------------------------------------------

export interface XossSteps {
  /** A contagem de passos está ligada. */
  on: boolean;
  /**
   * Cadência em passos por minuto. Medido em 22/11/2026: numa gravação, o
   * total subiu 24, 20 e 13 passos em janelas de 15 s (96, 80 e 52 por minuto)
   * com a cadência informada em 76, 90 e 64, a mesma média; e este byte
   * coincide com o campo `cadence` do FIT. É passo, não ciclo: não se
   * multiplica por 2.
   */
  spm: number;
  /** Passos desde que a contagem ligou (zera quando uma gravação termina). */
  steps: number;
}

/** `72 <ligado> <passos/min> <total, 4 bytes LE>`. */
export function decodeSteps(reply: Uint8Array): XossSteps | null {
  const body = content(reply);
  if (reply[0] !== OP.steps || body.length < 6) {
    return null;
  }
  return {
    on: body[0] === 1,
    spm: body[1],
    steps: (body[2] | (body[3] << 8) | (body[4] << 16) | (body[5] << 24)) >>> 0,
  };
}

/** `71 <bpm> 00 00`: o alerta programado; `null` = desligado. */
export function decodeAlert(reply: Uint8Array): number | null | undefined {
  const body = content(reply);
  if (reply[0] !== OP.alert || body.length < 1) {
    return undefined;
  }
  return body[0] === 0 ? null : body[0];
}

/** `75 FF` livre, `75 01` gravando; outro valor é desconhecido (`null`). */
export function decodeRecording(reply: Uint8Array): boolean | null {
  const body = content(reply);
  if (reply[0] !== OP.recording || body.length < 1) {
    return null;
  }
  return body[0] === 0x01 ? true : body[0] === 0xff ? false : null;
}

/** `76 00` manual, `76 01` automático. */
export function decodeRecordMode(reply: Uint8Array): 'manual' | 'auto' | null {
  const body = content(reply);
  if (reply[0] !== OP.recordMode || body.length < 1) {
    return null;
  }
  return body[0] === 0 ? 'manual' : body[0] === 1 ? 'auto' : null;
}

export interface XossSpace {
  freeKb: number;
  totalKb: number;
}

/** `0A "970/972"`: kB livres e total, em texto. */
export function decodeSpace(reply: Uint8Array): XossSpace | null {
  if (reply[0] !== OP.spaceReply) {
    return null;
  }
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text(content(reply)));
  return match ? { freeKb: Number(match[1]), totalKb: Number(match[2]) } : null;
}

/** Fim de uma transferência no controle: `04 00` é aceito; `15` é a cinta não ter entendido. */
export function transferAccepted(reply: Uint8Array): boolean {
  return validFrame(reply) && reply[0] === OP.statusReply && content(reply)[0] === 0x00;
}

/** Os treinos de `filelist.txt`: uma linha `AAAAMMDDhhmmss.fit tamanho` cada, nome em UTC. */
export function parseFileList(listing: Uint8Array | string): { name: string; at: number; size: number | null }[] {
  const raw = typeof listing === 'string' ? listing : text(listing);
  const files: { name: string; at: number; size: number | null }[] = [];
  const pattern = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.fit(?:[ \t]+(\d+))?/g;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const [, y, mo, d, h, mi, s, size] = match;
    const name = `${y}${mo}${d}${h}${mi}${s}.fit`;
    if (!files.some((file) => file.name === name)) {
      const at = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
      files.push({ name, at, size: size ? Number(size) : null });
    }
  }
  return files;
}
