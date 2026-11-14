/**
 * Controle experimental pelo serviço proprietário 0xFFF0.
 *
 * O FTMS desta esteira recusa todo comando de velocidade/inclinação (Target Setting
 * Features = 0x10) e o protocolo do 0xFFF0 ainda não é conhecido. Este módulo guarda
 * o contrato que permite mandar bytes nesse canal: um "mapeamento" diz, para cada
 * ação da interface, qual payload enviar e em que característica.
 *
 * A ideia é ajustar o mapeamento na Sonda quando o protocolo for descoberto (pela
 * captura do app oficial, por exemplo) sem precisar mexer no código de novo.
 */

/** Ações que o controle experimental pode enviar. */
export type VendorAction =
  | 'start'
  | 'pause'
  | 'stop'
  | 'speedUp'
  | 'speedDown'
  | 'inclineUp'
  | 'inclineDown';

export const VENDOR_ACTIONS = [
  'start',
  'pause',
  'stop',
  'speedUp',
  'speedDown',
  'inclineUp',
  'inclineDown',
] as const satisfies readonly VendorAction[];

/** Nomes em português, na ordem em que aparecem na Sonda. */
export const VENDOR_ACTION_LABELS: Record<VendorAction, string> = {
  start: 'Iniciar',
  pause: 'Pausar',
  stop: 'Parar',
  speedUp: 'Aumentar velocidade',
  speedDown: 'Diminuir velocidade',
  inclineUp: 'Subir inclinação',
  inclineDown: 'Descer inclinação',
};

/** Característica de escrita do 0xFFF0: FFF3 (write-only) ou FFF1 (read/write). */
export type VendorTarget = 'fff1' | 'fff3';

/** Payload em hexadecimal (bytes separados por espaço) ou texto ASCII. */
export type VendorFormat = 'hex' | 'ascii';

export const SPEED_ENCODINGS = ['u16le-x100', 'u16le-x1600', 'ascii1'] as const;
export type SpeedEncoding = (typeof SPEED_ENCODINGS)[number];

export const INCLINE_ENCODINGS = ['s16le-x10', 'u8', 'ascii1'] as const;
export type InclineEncoding = (typeof INCLINE_ENCODINGS)[number];

export type VendorValueEncoding = SpeedEncoding | InclineEncoding;

export const SPEED_ENCODING_LABELS: Record<SpeedEncoding, string> = {
  'u16le-x100': 'u16 LE ×100 (FTMS)',
  'u16le-x1600': 'u16 LE ×1600 (×16)',
  ascii1: 'texto com 1 decimal',
};

export const INCLINE_ENCODING_LABELS: Record<InclineEncoding, string> = {
  's16le-x10': 's16 LE ×10 (FTMS)',
  u8: '1 byte inteiro',
  ascii1: 'texto com 1 decimal',
};

/**
 * Conjunto de payloads de um protocolo experimental.
 *
 * - `target`: FFF1 ou FFF3 (as duas características que aceitam escrita).
 * - `format`: como o payload é escrito.
 * - `speedEncoding`/`inclineEncoding`: como o número do alvo entra no `%v`.
 * - `actions`: o template de cada ação. No formato hex, `%v` vira 1 ou 2 bytes;
 *   no formato ascii, vira o número em texto. Ação ausente = botão sem efeito.
 */
export interface VendorMapping {
  version: 1;
  name: string;
  target: VendorTarget;
  format: VendorFormat;
  speedEncoding: SpeedEncoding;
  inclineEncoding: InclineEncoding;
  actions: Partial<Record<VendorAction, string>>;
}

/** Último valor recebido em FFF4 (o canal de resposta do fabricante). */
export interface VendorReply {
  at: number;
  hex: string;
}

/** Resultado da última tentativa de envio, para aparecer na tela. */
export interface VendorSendOutcome {
  action: VendorAction;
  hex: string;
  at: number;
  ok: boolean;
  error: string | null;
}

/** Uma linha da varredura segura de bytes no 0xFFF0. */
export interface VendorDiscoveryObservation {
  label: string;
  target: VendorTarget;
  hex: string;
  at: number;
  error: string | null;
  replies: string[];
  fff1Before: string | null;
  fff1After: string | null;
  fff2Before: string | null;
  fff2After: string | null;
  speedBefore: number | null;
  speedAfter: number | null;
  inclinationBefore: number | null;
  inclinationAfter: number | null;
}

export interface VendorDiscoveryState {
  running: boolean;
  index: number;
  total: number;
  observations: VendorDiscoveryObservation[];
}

/** Estado do controle experimental dentro do snapshot da sessão. */
export interface VendorState {
  /** A conexão atual expõe FFF1, FFF3 e FFF4 do serviço 0xFFF0. */
  available: boolean;
  /** O usuário ligou o modo experimental; os botões passam a escrever no 0xFFF0. */
  enabled: boolean;
  /** Protocolo configurado na Sonda; `null` = nenhum. */
  mapping: VendorMapping | null;
  lastReply: VendorReply | null;
  lastSend: VendorSendOutcome | null;
  discovery: VendorDiscoveryState | null;
}

/** Estado inicial/inocente, para a sessão e para os testes. */
export function emptyVendorState(): VendorState {
  return {
    available: false,
    enabled: false,
    mapping: null,
    lastReply: null,
    lastSend: null,
    discovery: null,
  };
}
