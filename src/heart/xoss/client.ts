import type { BleConnection, BleSubscription, BleWriter, WriteMode } from '@/ble/transport';
import { MAX_WRITE_BYTES } from '@/ble/transport';
import { decodeDeviceInformationText, DEVICE_INFORMATION_SERVICE, sameUuid, uuid16 } from '@/ftms';

import {
  alertQueryFrame,
  alertSetFrame,
  clockFrame,
  decodeAlert,
  decodeRecording,
  decodeRecordMode,
  decodeSpace,
  decodeSteps,
  fetchFrame,
  OP,
  parseFileList,
  recordingQueryFrame,
  recordingStartFrame,
  recordingStopFrame,
  recordModeFrame,
  sendFrame,
  spaceFrame,
  statusFrame,
  stepsQueryFrame,
  stepsSetFrame,
  transferAccepted,
  validFrame,
  XOSS,
  XOSS_MODEL,
  type XossSpace,
  type XossSteps,
} from './frames';
import { CAN, YmodemReceiver, YmodemSender, type YmodemStep } from './ymodem';

/** Prazo de cada comando: a cinta responde em ~0,1 s. */
export const COMMAND_TIMEOUT_MS = 1500;
/** Prazo da leitura do modelo ao anexar. */
const MODEL_TIMEOUT_MS = 2000;
/** Prazo de uma assinatura de notificação ao anexar. */
const SUBSCRIBE_TIMEOUT_MS = 5000;
/**
 * Uma escrita que não volta neste tempo é a fila nativa presa: a biblioteca
 * não tem prazo próprio, e numa falha de autenticação (status 5 ou 137) a fila
 * do periférico trava para sempre (issue #1463 do react-native-ble-manager).
 * Um prazo em JavaScript não solta a fila: o cliente se desliga de vez.
 */
export const WRITE_STALL_MS = 5000;
/** Espera pela confirmação no controle (`04 00`) depois do fim do YMODEM. */
const FETCH_END_MS = 3000;
const SEND_END_MS = 6000;
/** Silêncio depois de uma transferência que falhou, para o resto dela não cair no próximo comando. */
const SETTLE_MS = 300;
/**
 * O ritmo do cliente de referência testado na cinta (`tools/xoss/xoss.py`):
 * 50 ms entre duas respostas seguidas (o ACK e o `C` do bloco zero) e 10 ms
 * entre os pedaços de 20 bytes de um bloco enviado. Sem a cinta no aparelho
 * não se sabe se ela precisa deles; com eles, o app fala como o cliente que
 * funcionou.
 */
const ITEM_GAP_MS = 50;
const CHUNK_GAP_MS = 10;
/**
 * Depois de um prazo estourado, a resposta atrasada ainda pode chegar e casaria
 * com o comando seguinte de mesmo código: o próximo comando só vai depois deste
 * silêncio, e o que chegar nele é descartado.
 */
export const LATE_REPLY_WINDOW_MS = 300;

const MODEL_NUMBER = uuid16(0x2a24);

/** O comando ficou sem resposta no prazo. */
export class XossTimeoutError extends Error {
  constructor() {
    super('A cinta não respondeu ao comando.');
    this.name = 'XossTimeoutError';
  }
}

/** O canal está ocupado; a consulta periódica desiste em vez de esperar. */
export class XossBusyError extends Error {
  constructor() {
    super('O canal da cinta está ocupado.');
    this.name = 'XossBusyError';
  }
}

/** O cliente foi fechado (link caiu, a sessão soltou a cinta ou a fila nativa travou). */
export class XossClosedError extends Error {
  constructor() {
    super('O canal da cinta foi fechado.');
    this.name = 'XossClosedError';
  }
}

export interface XossClientOptions {
  now: () => number;
  commandTimeoutMs?: number;
  writeStallMs?: number;
}

export interface XossFile {
  name: string;
  /** O nome em UTC, em ms desde 1970: é o início da gravação. */
  at: number;
  size: number | null;
}

interface ControlWaiter {
  onReply(reply: Uint8Array): void;
  onClose(): void;
}

type Machine = { push(bytes: Uint8Array): YmodemStep; timeout(): YmodemStep };

function noop(): void {}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Corre `promise` contra um prazo; no estouro rejeita (e quem chegar depois é ignorado). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new XossTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * O canal proprietário da XOSS X2 Pro (ver `frames.ts` e `ymodem.ts`).
 *
 * Regras, todas medidas ou impostas pela biblioteca BLE:
 * - um comando por vez (mutex de protocolo); uma transferência de arquivo
 *   segura o canal inteiro, do pedido à confirmação;
 * - a resposta é casada pelo código, com o XOR conferido, e a espera é
 *   registrada antes da escrita: a notificação pode chegar ao JavaScript antes
 *   de a promise da escrita resolver;
 * - nenhuma etapa se apoia na promise da escrita (sem resposta ela resolve
 *   antes de os bytes saírem): o que confirma é a notificação da cinta;
 * - escritas em série e de no máximo 20 bytes, cada uma correndo contra o fim
 *   do cliente e contra o prazo de fila presa;
 * - 1,5 s por comando; a consulta de passos desiste na hora se o canal está
 *   ocupado; um cancelamento manda CAN.
 *
 * Nada disto toca os batimentos: o Heart Rate Service segue pelo perfil
 * padrão, e qualquer falha aqui só desliga este cliente.
 */
export class XossClient {
  private readonly options: Required<XossClientOptions>;
  private readonly subscriptions: BleSubscription[] = [];
  private readonly waiters = new Set<ControlWaiter>();
  /** Escritas em curso: o fechamento rejeita todas, porque uma presa na fila nativa nunca volta. */
  private readonly closers = new Set<() => void>();
  private readonly deadListeners = new Set<() => void>();
  private lock: Promise<void> = Promise.resolve();
  private holders = 0;
  private transferring = false;
  private isClosed = false;
  /** `release` em curso: nenhum outro comando passa, nem os que estavam na fila. */
  private retiring = false;
  /** Até quando descartar respostas atrasadas de um comando que estourou o prazo. */
  private quietUntil = 0;
  /** Recebe os bytes do canal de dados durante uma transferência; fora dela eles são descartados. */
  private dataSink: ((bytes: Uint8Array) => void) | null = null;
  /** Acorda a transferência em curso (fechamento ou cancelamento). */
  private wakeTransfer: (() => void) | null = null;
  private readonly rxMode: WriteMode;

  private constructor(
    private readonly connection: BleConnection,
    private readonly writer: BleWriter,
    readonly model: string,
    rxWithoutResponse: boolean,
    options: XossClientOptions,
  ) {
    this.options = {
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      writeStallMs: WRITE_STALL_MS,
      ...options,
    };
    this.rxMode = rxWithoutResponse ? 'noResponse' : 'response';
  }

  /**
   * Anexa o cliente a uma conexão já aberta. Confere o serviço 6e400001, lê o
   * Model Number e exige "X2PRO", assina o controle e os dados e sonda com
   * `FF 00`. Devolve `null` em qualquer falha: a cinta segue só com o perfil
   * padrão, como qualquer outra.
   */
  static async attach(
    connection: BleConnection,
    options: XossClientOptions,
  ): Promise<XossClient | null> {
    const writer = connection.writer;
    if (!writer) {
      return null;
    }
    let client: XossClient | null = null;
    try {
      const characteristics = await connection.getCharacteristics(XOSS.service);
      const find = (uuid: string) => characteristics.find((c) => sameUuid(c.uuid, uuid));
      const control = find(XOSS.control);
      const tx = find(XOSS.tx);
      const rx = find(XOSS.rx);
      if (
        !control?.canNotify ||
        !control.canWrite ||
        !tx?.canNotify ||
        !(rx?.canWriteWithoutResponse || rx?.canWrite)
      ) {
        return null;
      }
      const information = await connection.getCharacteristics(DEVICE_INFORMATION_SERVICE);
      if (!information.some((c) => c.canRead && sameUuid(c.uuid, MODEL_NUMBER))) {
        return null;
      }
      const model = decodeDeviceInformationText(
        await withTimeout(connection.read(DEVICE_INFORMATION_SERVICE, MODEL_NUMBER), MODEL_TIMEOUT_MS),
      ).trim();
      if (model !== XOSS_MODEL) {
        return null;
      }
      client = new XossClient(connection, writer, model, !!rx.canWriteWithoutResponse, options);
      await client.open();
      return client;
    } catch {
      client?.close();
      return null;
    }
  }

  private async open(): Promise<void> {
    this.subscriptions.push(this.connection.onDisconnect(() => this.close()));
    await this.subscribe(XOSS.control, (bytes) => this.handleControl(bytes));
    await this.subscribe(XOSS.tx, (bytes) => this.dataSink?.(bytes));
    // A sonda: `FF 00` → `04 00`. Sem resposta no prazo, não é a cinta que o app conhece.
    await this.run(() => this.exchange(statusFrame(), OP.statusReply));
  }

  /** Assina com prazo; uma assinatura que voltar depois do prazo é desfeita. */
  private async subscribe(characteristic: string, onValue: (bytes: Uint8Array) => void) {
    let abandoned = false;
    const pending = this.connection.subscribe(XOSS.service, characteristic, onValue);
    pending.then((subscription) => abandoned && subscription.remove(), noop);
    try {
      this.subscriptions.push(await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS));
    } catch (error) {
      abandoned = true;
      throw error;
    }
    if (this.isClosed) {
      throw new XossClosedError();
    }
  }

  /** Há um comando ou uma transferência em curso (ou na fila). */
  get busy(): boolean {
    return this.holders > 0;
  }

  /** Há uma transferência de arquivo em curso. */
  get transferBusy(): boolean {
    return this.transferring;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Avisa quando o cliente se desliga sozinho porque a fila nativa travou. */
  onDead(listener: () => void): () => void {
    this.deadListeners.add(listener);
    return () => {
      this.deadListeners.delete(listener);
    };
  }

  /** Solta as assinaturas e encerra tudo o que está em curso. Não desconecta. */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.remove();
    }
    const waiters = [...this.waiters];
    this.waiters.clear();
    waiters.forEach((waiter) => waiter.onClose());
    const closers = [...this.closers];
    this.closers.clear();
    closers.forEach((closer) => closer());
    this.wakeTransfer?.();
  }

  /** A fila nativa travou: o cliente se desliga de vez nesta conexão. */
  private die(): void {
    if (this.isClosed) {
      return;
    }
    this.close();
    const listeners = [...this.deadListeners];
    this.deadListeners.clear();
    listeners.forEach((listener) => listener());
  }

  // --- Canal ---------------------------------------------------------------

  private handleControl(bytes: Uint8Array): void {
    [...this.waiters].forEach((waiter) => waiter.onReply(bytes));
  }

  /**
   * Um comando por vez. Com `failFast`, desiste se o canal está ocupado em vez
   * de entrar na fila. Durante um `release` só ele passa (`privileged`).
   */
  private run<T>(task: () => Promise<T>, failFast = false, privileged = false): Promise<T> {
    if (this.isClosed || (this.retiring && !privileged)) {
      return Promise.reject(new XossClosedError());
    }
    if (failFast && this.holders > 0) {
      return Promise.reject(new XossBusyError());
    }
    this.holders += 1;
    const result = this.lock.then(() => {
      if (this.isClosed || (this.retiring && !privileged)) throw new XossClosedError();
      return task();
    });
    this.lock = result.then(noop, noop);
    return result.finally(() => {
      this.holders -= 1;
    });
  }

  /**
   * Escreve em pedaços de até 20 bytes, um de cada vez. Cada escrita corre
   * contra o fechamento do cliente (uma escrita presa na fila nativa quando o
   * link cai nunca volta) e contra o prazo de fila presa, que desliga o cliente.
   */
  private async write(
    characteristic: string,
    bytes: Uint8Array,
    mode: WriteMode,
    gapMs = 0,
  ): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
      if (offset > 0 && gapMs > 0) await this.pause(gapMs);
      if (this.isClosed) throw new XossClosedError();
      const slice = bytes.subarray(offset, offset + MAX_WRITE_BYTES);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const closer = () => finish(() => reject(new XossClosedError()));
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(stall);
          this.closers.delete(closer);
          settle();
        };
        const stall = setTimeout(() => {
          finish(() => reject(new XossClosedError()));
          this.die();
        }, this.options.writeStallMs);
        this.closers.add(closer);
        this.writer
          .write(XOSS.service, characteristic, slice, mode)
          .then(
            () => finish(resolve),
            (error: unknown) => finish(() => reject(error)),
          );
      });
    }
  }

  /**
   * Manda um quadro no controle e espera a resposta com o código dado. Só com o
   * canal na mão. Depois de um prazo estourado, espera antes o silêncio de
   * `LATE_REPLY_WINDOW_MS`: o que chega nele não tem dono e é descartado.
   */
  private async exchange(bytes: Uint8Array, replyOpcode: number): Promise<Uint8Array> {
    const quiet = this.quietUntil - this.options.now();
    if (quiet > 0) await this.pause(quiet);
    if (this.isClosed) throw new XossClosedError();
    return this.exchangeNow(bytes, replyOpcode);
  }

  /**
   * Limite conhecido: uma resposta que atrasa mais que a janela de
   * `LATE_REPLY_WINDOW_MS` ainda pode casar com o comando seguinte de mesmo
   * código (a resposta não traz número de pedido). O perfil é conferido por
   * releitura, e os estados (passos, gravação, alerta) pela leitura periódica e
   * pela reconciliação seguinte, então um engano desses não fica.
   */
  private exchangeNow(bytes: Uint8Array, replyOpcode: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        settle();
      };
      const waiter: ControlWaiter = {
        onReply: (reply) => {
          if (reply[0] === replyOpcode && validFrame(reply)) finish(() => resolve(reply));
        },
        onClose: () => finish(() => reject(new XossClosedError())),
      };
      // Antes da escrita: a resposta pode chegar antes de a escrita confirmar.
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.quietUntil = this.options.now() + LATE_REPLY_WINDOW_MS;
        finish(() => reject(new XossTimeoutError()));
      }, this.options.commandTimeoutMs);
      this.write(XOSS.control, bytes, 'response').catch((error: unknown) =>
        finish(() => reject(error)),
      );
    });
  }

  private command(bytes: Uint8Array, replyOpcode: number, failFast = false): Promise<Uint8Array> {
    return this.run(() => this.exchange(bytes, replyOpcode), failFast);
  }

  // --- Comandos --------------------------------------------------------------

  /**
   * Passos e cadência, com a hora da resposta. Desiste na hora
   * (`XossBusyError`) se o canal está ocupado, em vez de entrar na fila.
   */
  async steps(): Promise<XossSteps & { at: number }> {
    const steps = decodeSteps(await this.command(stepsQueryFrame(), OP.steps, true));
    if (!steps) throw new XossTimeoutError();
    return { ...steps, at: this.options.now() };
  }

  /** Passos e cadência, esperando a vez no canal (a reconciliação lê antes de ligar). */
  async readSteps(): Promise<XossSteps> {
    const steps = decodeSteps(await this.command(stepsQueryFrame(), OP.steps));
    if (!steps) throw new XossTimeoutError();
    return steps;
  }

  /** Liga ou desliga a contagem de passos. */
  async setSteps(on: boolean): Promise<void> {
    await this.command(stepsSetFrame(on), OP.steps);
  }

  /** Acerta o relógio da cinta (segundos desde 1970). */
  async setClock(epochS: number): Promise<void> {
    await this.command(clockFrame(epochS), OP.clockReply);
  }

  /** `true` gravando, `false` livre, `null` estado desconhecido. */
  async recording(): Promise<boolean | null> {
    return decodeRecording(await this.command(recordingQueryFrame(), OP.recording));
  }

  async recordMode(): Promise<'manual' | 'auto' | null> {
    return decodeRecordMode(await this.command(recordModeFrame(), OP.recordMode));
  }

  async startRecording(): Promise<void> {
    await this.command(recordingStartFrame(), OP.recording);
  }

  async stopRecording(): Promise<void> {
    await this.command(recordingStopFrame(), OP.recording);
  }

  /** O alerta de FC programado; `null` = desligado. */
  async alert(): Promise<number | null> {
    const value = decodeAlert(await this.command(alertQueryFrame(), OP.alert));
    if (value === undefined) throw new XossTimeoutError();
    return value;
  }

  /**
   * Programa o alerta de FC (`null` desliga) e confere por leitura, sem soltar
   * o canal entre as duas. `true` quando a leitura bate com o pedido.
   */
  setAlert(bpm: number | null): Promise<boolean> {
    const wanted = bpm && bpm > 0 ? Math.min(255, Math.round(bpm)) : null;
    return this.run(async () => {
      await this.exchange(alertSetFrame(wanted), OP.alert);
      return decodeAlert(await this.exchange(alertQueryFrame(), OP.alert)) === wanted;
    });
  }

  async space(): Promise<XossSpace | null> {
    return decodeSpace(await this.command(spaceFrame(), OP.spaceReply));
  }

  /**
   * A última conversa antes de soltar a cinta: desfaz o que o app ligou, com o
   * canal na mão do começo ao fim, e fecha o cliente. Os comandos que estavam
   * na fila, ou que chegarem depois, são recusados: nada religa o que foi
   * desligado aqui. Cada passo confere antes e vai por conta própria (a falha
   * de um não impede os outros), na ordem gravação, alerta, passos:
   * - a gravação só é encerrada se está em curso;
   * - o alerta só volta ao valor anterior se a cinta mostra um dos valores que
   *   o app programou.
   * Devolve, para cada passo, se ele ficou resolvido (feito, ou conferido que não
   * era preciso); `false` é passo sem resposta.
   */
  release(plan: {
    recording?: boolean;
    alert?: { owned: number[]; restore: number | null } | null;
    stepsOff?: boolean;
  }): Promise<{ recording: boolean; alert: boolean; steps: boolean }> {
    const done = { recording: !plan.recording, alert: !plan.alert, steps: !plan.stepsOff };
    if (this.isClosed) return Promise.resolve(done);
    this.retiring = true;
    const attempt = async (step: () => Promise<void>): Promise<boolean> => {
      try {
        await step();
        return true;
      } catch {
        // Sem resposta, segue para o próximo: a cinta vai ser solta de qualquer jeito.
        return false;
      }
    };
    return this.run(
      async () => {
        if (plan.recording) {
          done.recording = await attempt(async () => {
            if (decodeRecording(await this.exchange(recordingQueryFrame(), OP.recording)) !== true) return;
            await this.exchange(recordingStopFrame(), OP.recording);
          });
        }
        const alert = plan.alert;
        if (alert) {
          done.alert = await attempt(async () => {
            const current = decodeAlert(await this.exchange(alertQueryFrame(), OP.alert));
            if (current === undefined) throw new XossTimeoutError();
            if (current === null || !alert.owned.includes(current)) return;
            const wanted = alert.restore && alert.restore > 0 ? alert.restore : null;
            await this.exchange(alertSetFrame(wanted), OP.alert);
            if (decodeAlert(await this.exchange(alertQueryFrame(), OP.alert)) !== wanted) {
              throw new XossTimeoutError();
            }
          });
        }
        if (plan.stepsOff) {
          done.steps = await attempt(async () => {
            await this.exchange(stepsSetFrame(false), OP.steps);
          });
        }
        return done;
      },
      false,
      true,
    )
      .catch(() => done)
      .finally(() => this.close());
  }

  // --- Arquivos ----------------------------------------------------------------

  /**
   * Os treinos de `filelist.txt`. `null` quando a leitura falhou; lista vazia
   * é "nada por ora": depois de gravar um perfil novo a cinta já devolveu a
   * lista vazia por algumas conexões com o arquivo ainda na memória.
   */
  async listFiles(signal?: AbortSignal): Promise<XossFile[] | null> {
    const listing = await this.fetch('filelist.txt', signal);
    return listing ? parseFileList(listing) : null;
  }

  /** Baixa um arquivo; `null` se a cinta não o tem, se falhou ou se foi cancelado. */
  fetch(name: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    return this.run(() => this.fetchNow(name, signal));
  }

  /** O download, com o canal já na mão. */
  private async fetchNow(name: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const receiver = new YmodemReceiver();
    const result = await this.transfer(
      fetchFrame(name),
      OP.fetchReply,
      receiver,
      () => receiver.start(),
      FETCH_END_MS,
      signal,
    );
    // A confirmação no controle não é exigida: os dados já vieram conferidos bloco a bloco.
    return result.done ? receiver.result() : null;
  }

  /**
   * Envia um arquivo; `true` só com a resposta final `04 00` no controle. O
   * cancelamento só vale até a cinta aceitar o pedido (`08 <nome>`): daí em
   * diante o envio vai até o fim (2 ou 3 blocos, menos de 2 s), porque não se
   * sabe o que a cinta faz com um arquivo cortado no meio, e um perfil
   * truncado sem chave nenhuma não teria mais conserto.
   */
  send(name: string, data: Uint8Array, signal?: AbortSignal): Promise<boolean> {
    return this.run(async () => {
      const sender = new YmodemSender(name, data);
      const result = await this.transfer(
        sendFrame(name),
        OP.sendReply,
        sender,
        () => sender.start(),
        SEND_END_MS,
        signal,
        false,
      );
      return result.done && result.end !== null && transferAccepted(result.end);
    });
  }

  /**
   * Uma transferência inteira, com o canal na mão: o pedido no controle, o
   * YMODEM no canal de dados e a espera pela confirmação no controle. O
   * canal de dados e a espera pela confirmação abrem antes do pedido: a
   * cinta manda o `C` logo depois da resposta, às vezes antes de a escrita
   * confirmar.
   */
  private async transfer(
    request: Uint8Array,
    replyOpcode: number,
    machine: Machine,
    start: () => YmodemStep,
    endMs: number,
    signal?: AbortSignal,
    abortableAfterAccept = true,
  ): Promise<{ done: boolean; end: Uint8Array | null }> {
    if (signal?.aborted || this.isClosed) {
      return { done: false, end: null };
    }
    /** O sinal que ainda vale: no envio, some quando a cinta aceita o pedido. */
    let abort = signal;
    this.transferring = true;
    const inbox: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    const poke = () => {
      const current = wake;
      wake = null;
      current?.();
    };
    this.dataSink = (bytes) => {
      inbox.push(bytes);
      poke();
    };
    this.wakeTransfer = poke;
    signal?.addEventListener('abort', poke);

    let end: Uint8Array | null = null;
    let ended: (() => void) | null = null;
    const endWaiter: ControlWaiter = {
      onReply: (reply) => {
        if (end === null && (reply[0] === OP.statusReply || reply[0] === 0x15)) {
          end = reply;
          ended?.();
        }
      },
      onClose: () => ended?.(),
    };

    try {
      try {
        await this.exchange(request, replyOpcode);
      } catch {
        return { done: false, end: null };
      }
      if (!abortableAfterAccept) {
        signal?.removeEventListener('abort', poke);
        abort = undefined;
      }
      this.waiters.add(endWaiter);
      let step = start();
      for (;;) {
        if (step.send.length > 0) {
          if (step.delayMs) await this.pause(step.delayMs);
          for (const [index, item] of step.send.entries()) {
            if (index > 0) await this.pause(ITEM_GAP_MS);
            await this.write(XOSS.rx, item, this.rxMode, CHUNK_GAP_MS);
          }
        }
        if (step.error) {
          await this.settle();
          return { done: false, end: null };
        }
        if (step.done) {
          break;
        }
        if (abort?.aborted) {
          await this.cancel();
          return { done: false, end: null };
        }
        if (this.isClosed) {
          return { done: false, end: null };
        }
        if (inbox.length === 0) {
          const waitMs = step.waitMs ?? 0;
          const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve(true);
            }, waitMs);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          if (abort?.aborted) {
            await this.cancel();
            return { done: false, end: null };
          }
          if (this.isClosed) {
            return { done: false, end: null };
          }
          if (timedOut) {
            step = machine.timeout();
            continue;
          }
        }
        step = machine.push(concat(inbox.splice(0)));
      }
      if (end === null && !this.isClosed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, endMs);
          ended = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return { done: true, end };
    } catch {
      // Escrita que falhou ou cliente fechado no meio: a transferência acabou.
      return { done: false, end: null };
    } finally {
      this.waiters.delete(endWaiter);
      signal?.removeEventListener('abort', poke);
      this.dataSink = null;
      this.wakeTransfer = null;
      this.transferring = false;
    }
  }

  /** Cancela a transferência em curso na cinta (CAN) e deixa o resto dela passar. */
  private async cancel(): Promise<void> {
    try {
      await this.write(XOSS.rx, Uint8Array.of(CAN), this.rxMode);
    } catch {
      // Sem a escrita a cinta desiste sozinha pelo prazo dela.
    }
    await this.settle();
  }

  private settle(): Promise<void> {
    return this.pause(SETTLE_MS);
  }

  private pause(ms: number): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
