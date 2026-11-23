/**
 * YMODEM como a XOSS X2 Pro fala sobre BLE (documento oficial da Xingzhe em
 * `ekspla/xoss_sync`, conferido na cinta em 22/11/2026 com
 * `tools/xoss/xoss.py`). Código puro: as duas máquinas de estado (receptor e
 * emissor) são alimentadas com os bytes que chegam (`push`) e com os prazos
 * estourados (`timeout`), e devolvem o que escrever e quanto esperar. Quem
 * chama cuida dos temporizadores e das escritas; os testes andam no relógio
 * que quiserem.
 *
 * Diferenças do YMODEM de livro: o CRC é o CRC-16/ARC (não o XMODEM), em 2
 * bytes big-endian; o bloco zero traz "nome tamanho" separados por espaço; e
 * as notificações chegam em pedaços de 20 bytes, então um bloco de 133 bytes
 * chega em 7 pedaços.
 */

export const SOH = 0x01;
export const STX = 0x02;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;
export const CAN = 0x18;
export const C = 0x43;

/** Prazo para chegar o resto de um bloco, ou o próximo bloco. */
export const BLOCK_WAIT_MS = 3000;
/** Silêncio pedido depois de um bloco ruim, antes do NAK: o resto dele ainda está chegando. */
export const DRAIN_MS = 300;
/** Prazo pelo segundo EOT (receptor) ou pela resposta a um EOT (emissor). */
export const EOT_WAIT_MS = 2000;
/** Prazo pelo primeiro `C` da cinta, quando o app envia. */
export const START_WAIT_MS = 5000;
/** Blocos ruins seguidos (ou prazos estourados) antes de desistir. */
export const MAX_ERRORS = 5;
/** Tentativas de cada bloco enviado sem ACK. */
export const MAX_TRIES = 3;
/** Um arquivo da cinta é pequeno (o FIT de 45 min tem uns 35 kB): mais que isto é lixo. */
export const MAX_FILE_BYTES = 1 << 20;
/**
 * Pausa antes das respostas ao EOT (e antes de cada EOT, ao enviar), como o
 * cliente de referência testado na cinta faz (`tools/xoss/xoss.py`).
 */
export const EOT_PAUSE_MS = 100;

/** CRC-16/ARC (polinômio 0x8005 refletido, início 0), o que a cinta usa. */
export function crc16Arc(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** Um bloco de 128 bytes: `SOH n ~n dados(128, completados com zero) CRC(2, big-endian)`. */
export function encodeBlock(number: number, payload: ArrayLike<number>): Uint8Array {
  if (payload.length > 128) {
    throw new Error('Bloco com mais de 128 bytes.');
  }
  const block = new Uint8Array(3 + 128 + 2);
  block[0] = SOH;
  block[1] = number & 0xff;
  block[2] = 0xff ^ (number & 0xff);
  block.set(Array.from(payload), 3);
  const crc = crc16Arc(block, 3, 131);
  block[131] = crc >>> 8;
  block[132] = crc & 0xff;
  return block;
}

/** O bloco zero: "nome tamanho" (separados por espaço, ou NUL em outros aparelhos). */
export function parseHeader(payload: ArrayLike<number>): { name: string; size: number | null } {
  let end = payload.length;
  while (end > 0 && payload[end - 1] === 0) end--;
  const text = String.fromCharCode(...Array.from(payload).slice(0, end)).replace(/\0/g, ' ');
  const [name = '', size] = text.trim().split(/\s+/);
  return { name, size: size && /^\d+$/.test(size) ? Number(size) : null };
}

export interface YmodemStep {
  /** O que escrever no canal de dados, na ordem: um byte de controle ou um bloco inteiro. */
  send: Uint8Array[];
  /** Pausa antes de escrever `send`, quando a cinta precisa de um respiro. */
  delayMs?: number;
  /** Quanto esperar pelo próximo byte antes de chamar `timeout()`; `null` quando acabou. */
  waitMs: number | null;
  /** A transferência terminou bem (falta só a confirmação no controle). */
  done: boolean;
  /** Por que desistiu; quando cabe, o CAN já está em `send`. */
  error: string | null;
}

const byte = (value: number) => Uint8Array.of(value);

/**
 * Recebe um arquivo da cinta. Depois de `05 <nome>` → `06 <nome>` no
 * controle, `start()` pede o `C`; a cinta manda o bloco zero, o app responde
 * ACK e `C`; cada bloco de dados pede um ACK; no EOT o app responde NAK,
 * recebe o segundo EOT e responde ACK.
 *
 * As armadilhas vistas na cinta: ela às vezes repete o bloco zero (o ACK ou o
 * `C` se perdeu) e às vezes repete um bloco de dados (o ACK se perdeu). O bloco
 * zero repetido antes do primeiro bloco de dados ganha ACK e `C` de novo; o
 * bloco de número repetido ganha ACK e não é anexado.
 */
export class YmodemReceiver {
  name: string | null = null;
  size: number | null = null;

  private state: 'header' | 'block' | 'drain' | 'eot' | 'done' | 'failed' = 'header';
  private buffer: number[] = [];
  private readonly data: number[] = [];
  private last = 0;
  private gotData = false;
  private errors = 0;

  start(): YmodemStep {
    return this.step([byte(C)], BLOCK_WAIT_MS);
  }

  /** O EOT veio antes do tamanho anunciado no bloco zero: o arquivo está incompleto. */
  private get short(): boolean {
    return this.size !== null && this.data.length < this.size;
  }

  /** O ACK final ao segundo EOT (ou ao prazo dele). Um arquivo incompleto é recusado. */
  private finish(send: Uint8Array[]): YmodemStep {
    if (this.short) {
      this.state = 'failed';
      return { send: [...send, byte(ACK)], delayMs: EOT_PAUSE_MS, waitMs: null, done: false, error: 'Arquivo incompleto.' };
    }
    this.state = 'done';
    return { send: [...send, byte(ACK)], delayMs: EOT_PAUSE_MS, waitMs: null, done: true, error: null };
  }

  /** O arquivo recebido, cortado no tamanho do bloco zero (os blocos vêm completados). */
  result(): Uint8Array {
    if (this.size !== null) {
      return Uint8Array.from(this.data.slice(0, this.size));
    }
    let end = this.data.length;
    while (end > 0 && this.data[end - 1] === 0) end--;
    return Uint8Array.from(this.data.slice(0, end));
  }

  push(bytes: ArrayLike<number>): YmodemStep {
    if (this.state === 'done' || this.state === 'failed') {
      return this.idle();
    }
    if (this.state === 'drain') {
      // O resto do bloco ruim: fora. O silêncio recomeça a contar.
      return this.step([], DRAIN_MS);
    }
    for (let i = 0; i < bytes.length; i++) this.buffer.push(bytes[i]);
    const send: Uint8Array[] = [];
    while (this.buffer.length > 0) {
      if (this.state === 'eot') {
        const head = this.buffer.shift();
        if (head === EOT) {
          return this.finish(send);
        }
        continue;
      }
      const head = this.buffer[0];
      if (head === CAN) {
        return this.fail(send, 'A cinta cancelou a transferência.', false);
      }
      if (head === EOT && this.state === 'block') {
        this.buffer.shift();
        this.state = 'eot';
        return { ...this.step([...send, byte(NAK)], EOT_WAIT_MS), delayMs: EOT_PAUSE_MS };
      }
      if (head !== SOH && head !== STX) {
        return this.bad(send);
      }
      const size = head === SOH ? 128 : 1024;
      if (this.buffer.length < size + 5) {
        break;
      }
      const block = this.buffer.splice(0, size + 5);
      const number = block[1];
      const crc = (block[size + 3] << 8) | block[size + 4];
      if ((number ^ block[2]) !== 0xff || crc16Arc(block, 3, size + 3) !== crc) {
        return this.bad(send);
      }
      const payload = block.slice(3, size + 3);
      if (this.state === 'header') {
        if (number !== 0) {
          return this.bad(send);
        }
        const header = parseHeader(payload);
        if (!header.name) {
          // Bloco zero vazio: a cinta não tem o arquivo.
          return this.fail([...send, byte(ACK)], 'A cinta não mandou o arquivo.', false);
        }
        this.name = header.name;
        this.size = header.size;
        this.state = 'block';
        this.errors = 0;
        send.push(byte(ACK), byte(C));
      } else if (number === 0 && !this.gotData) {
        // A cinta repetiu o bloco zero: o ACK ou o `C` se perdeu. Pede de novo.
        send.push(byte(ACK), byte(C));
      } else if (this.gotData && number === this.last) {
        // Retransmissão: o ACK anterior se perdeu. Confirma sem anexar.
        send.push(byte(ACK));
      } else if (number === (((this.gotData ? this.last : 0) + 1) & 0xff)) {
        for (const value of payload) this.data.push(value);
        if (this.data.length > MAX_FILE_BYTES) {
          return this.fail(send, 'Arquivo grande demais.', true);
        }
        this.last = number;
        this.gotData = true;
        this.errors = 0;
        send.push(byte(ACK));
      } else {
        return this.bad(send);
      }
    }
    return this.step(send, BLOCK_WAIT_MS);
  }

  timeout(): YmodemStep {
    switch (this.state) {
      case 'header':
        return this.fail([], 'A cinta não mandou o arquivo.', true);
      case 'drain':
        this.state = 'block';
        return this.step([byte(NAK)], BLOCK_WAIT_MS);
      case 'block':
        this.buffer = [];
        if (++this.errors > MAX_ERRORS) {
          return this.fail([], 'A cinta parou de mandar o arquivo.', true);
        }
        return this.step([byte(NAK)], BLOCK_WAIT_MS);
      case 'eot':
        // O segundo EOT não veio: confirma assim mesmo, se os dados estão completos.
        return this.finish([]);
      default:
        return this.idle();
    }
  }

  /**
   * Bloco ruim: espera o resto dele passar e pede de novo com NAK. No bloco
   * zero não há segunda chance (como no cliente de referência): cancela, e a
   * próxima conexão tenta de novo.
   */
  private bad(send: Uint8Array[]): YmodemStep {
    this.buffer = [];
    if (this.state === 'header') {
      return this.fail(send, 'O bloco zero veio ruim.', true);
    }
    if (++this.errors > MAX_ERRORS) {
      return this.fail(send, 'Blocos ruins demais.', true);
    }
    this.state = 'drain';
    return this.step(send, DRAIN_MS);
  }

  private fail(send: Uint8Array[], error: string, cancel: boolean): YmodemStep {
    this.state = 'failed';
    return { send: cancel ? [...send, byte(CAN)] : send, waitMs: null, done: false, error };
  }

  private step(send: Uint8Array[], waitMs: number): YmodemStep {
    return { send, waitMs, done: false, error: null };
  }

  private idle(): YmodemStep {
    return { send: [], waitMs: null, done: this.state === 'done', error: null };
  }
}

/**
 * Envia um arquivo à cinta. Depois de `07 <nome>` → `08 <nome>` no controle,
 * a cinta manda `C`; o app manda o bloco zero ("nome tamanho" completado com
 * zeros); a cinta responde ACK e `C`; os blocos de dados vão numerados a
 * partir de 1, um ACK por bloco; no fim, EOT → NAK, EOT → ACK.
 *
 * A escrita sem resposta não prova que os bytes saíram do celular: quem
 * confirma um bloco é o ACK da cinta. Sem ACK no prazo (ou com NAK), o bloco
 * vai de novo, até 3 vezes.
 */
export class YmodemSender {
  private state: 'start' | 'header' | 'headerC' | 'block' | 'eot1' | 'eot2' | 'done' | 'failed' =
    'start';
  private readonly header: Uint8Array;
  private readonly blocks: number;
  /** O bloco em curso: 0 é o bloco zero, 1 em diante são os dados. */
  private current = 0;
  private tries = 0;

  constructor(
    name: string,
    private readonly data: Uint8Array,
  ) {
    const text = `${name} ${data.length}`;
    this.header = encodeBlock(
      0,
      Array.from(text, (char) => char.charCodeAt(0) & 0x7f),
    );
    this.blocks = Math.ceil(data.length / 128);
  }

  start(): YmodemStep {
    return this.step([], START_WAIT_MS);
  }

  private block(number: number): Uint8Array {
    const offset = (number - 1) * 128;
    return encodeBlock(number, this.data.subarray(offset, offset + 128));
  }

  /** O que vem depois do bloco `current` confirmado: o próximo, ou o EOT. */
  private advance(): YmodemStep {
    this.current += 1;
    this.tries = 1;
    if (this.current > this.blocks) {
      this.state = 'eot1';
      return { ...this.step([byte(EOT)], EOT_WAIT_MS), delayMs: EOT_PAUSE_MS };
    }
    this.state = 'block';
    return this.step([this.block(this.current)], BLOCK_WAIT_MS);
  }

  push(bytes: ArrayLike<number>): YmodemStep {
    const send: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const value = bytes[i];
      if (value === CAN && this.state !== 'done' && this.state !== 'failed') {
        return this.fail(send, 'A cinta cancelou a transferência.', false);
      }
      switch (this.state) {
        case 'start':
          if (value === C) {
            this.state = 'header';
            this.tries = 1;
            send.push(this.header);
          }
          break;
        case 'header':
          // Um `C` aqui é sobra do pedido inicial: o bloco zero só vale com ACK.
          if (value === ACK) {
            this.state = 'headerC';
          } else if (value === NAK) {
            const retry = this.retry(this.header);
            if (retry.error) return this.merge(send, retry);
            send.push(...retry.send);
          }
          break;
        case 'headerC':
          if (value === C) {
            return this.merge(send, this.advance());
          }
          break;
        case 'block':
          if (value === ACK) {
            return this.merge(send, this.advance());
          }
          if (value === NAK) {
            const retry = this.retry(this.block(this.current));
            if (retry.error) return this.merge(send, retry);
            send.push(...retry.send);
          }
          break;
        case 'eot1':
          if (value === NAK) {
            this.state = 'eot2';
            return this.merge(send, { ...this.step([byte(EOT)], EOT_WAIT_MS), delayMs: EOT_PAUSE_MS });
          }
          if (value === ACK) {
            this.state = 'done';
            return { send, waitMs: null, done: true, error: null };
          }
          break;
        case 'eot2':
          if (value === ACK) {
            this.state = 'done';
            return { send, waitMs: null, done: true, error: null };
          }
          break;
        default:
          break;
      }
    }
    const waiting =
      this.state === 'start' ? START_WAIT_MS : this.state.startsWith('eot') ? EOT_WAIT_MS : BLOCK_WAIT_MS;
    return this.state === 'done' || this.state === 'failed'
      ? { send, waitMs: null, done: this.state === 'done', error: null }
      : this.step(send, waiting);
  }

  timeout(): YmodemStep {
    switch (this.state) {
      case 'start':
        return this.fail([], "A cinta não mandou o 'C' inicial.", true);
      case 'header':
        return this.retry(this.header);
      case 'headerC':
        return this.fail([], 'A cinta não aceitou o bloco zero.', true);
      case 'block':
        return this.retry(this.block(this.current));
      case 'eot1':
        // Sem NAK depois do EOT: o segundo vai assim mesmo, como no cliente de referência.
        this.state = 'eot2';
        return { ...this.step([byte(EOT)], EOT_WAIT_MS), delayMs: EOT_PAUSE_MS };
      case 'eot2':
        // Sem ACK do segundo EOT: quem diz se deu certo é a resposta no controle.
        this.state = 'done';
        return { send: [], waitMs: null, done: true, error: null };
      default:
        return { send: [], waitMs: null, done: this.state === 'done', error: null };
    }
  }

  private retry(block: Uint8Array): YmodemStep {
    if (++this.tries > MAX_TRIES) {
      return this.fail([], `Bloco ${this.current} sem ACK.`, true);
    }
    return this.step([block], BLOCK_WAIT_MS);
  }

  private merge(before: Uint8Array[], step: YmodemStep): YmodemStep {
    return { ...step, send: [...before, ...step.send] };
  }

  private fail(send: Uint8Array[], error: string, cancel: boolean): YmodemStep {
    this.state = 'failed';
    return { send: cancel ? [...send, byte(CAN)] : send, waitMs: null, done: false, error };
  }

  private step(send: Uint8Array[], waitMs: number): YmodemStep {
    return { send, waitMs, done: false, error: null };
  }
}
