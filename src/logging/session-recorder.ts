import type { TraceLine, TraceSink } from '@/treadmill/types';

import {
  formatHeader,
  formatTraceLine,
  isLogFileName,
  logFileName,
  type HeaderInfo,
} from './format';
import type { LogFile, MirrorFolder, RecorderActions, RecorderSnapshot, RecorderStore } from './types';

// Este arquivo não importa nada do Expo nem do React Native: o armazenamento e o
// relógio entram por injeção, para a lógica poder ser testada em memória.

/** Espera, desde a primeira linha pendente, antes de gravar. */
export const FLUSH_DELAY_MS = 2000;
/** Com tantas linhas pendentes, grava sem esperar o prazo. */
export const FLUSH_LINES = 100;
/** Teto de linhas na memória enquanto a gravação falha; passou disso, as mais antigas se perdem. */
export const MAX_PENDING_LINES = 5000;
/** Retenção: arquivos guardados no total, contando o da execução atual. */
export const MAX_FILES = 30;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export interface StoredFile {
  name: string;
  sizeBytes: number;
  modifiedAt: number | null;
}

/** O que o gravador precisa do sistema de arquivos. Toda falha deve virar uma rejeição. */
export interface RecorderStorage {
  /** Os arquivos da pasta interna de registros (qualquer nome; quem chama filtra). */
  list(): Promise<StoredFile[]>;
  /** Anexa `text` ao arquivo, criando-o se não existir. */
  append(name: string, text: string): Promise<void>;
  /**
   * Como `append`, mas síncrono: quando a função volta, o texto já está no arquivo. Existe para o
   * erro fatal, que encerra o app logo em seguida. Opcional: sem ele, `flushSync` cai na descarga normal.
   */
  appendSync?(name: string, text: string): void;
  read(name: string): Promise<string>;
  remove(name: string): Promise<void>;
  /** Abre a folha de compartilhamento do sistema; resolve quando ela fecha. */
  share(name: string): Promise<void>;

  /** A pasta de cópia salva numa execução anterior. */
  loadMirror(): Promise<MirrorFolder | null>;
  /** Persiste a escolha (`null` apaga). */
  saveMirror(mirror: MirrorFolder | null): Promise<void>;
  /** Abre o seletor de pastas; `null` se o usuário cancelou. */
  pickMirrorFolder(): Promise<MirrorFolder | null>;
  /**
   * Escreve na cópia: `append` anexa (criando o arquivo se preciso); sem `append`,
   * substitui o conteúdo inteiro.
   */
  mirrorWrite(
    folder: MirrorFolder,
    name: string,
    text: string,
    options: { append: boolean },
  ): Promise<void>;
  /** `appendSync` para a cópia: anexa, criando o arquivo se preciso. */
  mirrorWriteSync?(folder: MirrorFolder, name: string, text: string): void;
}

export interface RecorderClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: RecorderClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SessionRecorderOptions {
  storage: RecorderStorage;
  clock?: RecorderClock;
  /** Dados do app e do aparelho, para o cabeçalho do arquivo. */
  headerInfo: HeaderInfo;
}

const NO_FILES: LogFile[] = [];

/** O que sai de `pending` numa gravação: já formatado, com o que é preciso para desfazer se falhar. */
interface Block {
  text: string;
  lines: string[];
  dropped: { count: number; at: number } | null;
  /** Este bloco leva o cabeçalho. */
  withHeader: boolean;
  /** Este bloco leva o aviso de uma gravação anterior que falhou. */
  withFailureNotice: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function sameFiles(a: readonly LogFile[], b: readonly LogFile[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (file, index) =>
        file.name === b[index].name &&
        file.sizeBytes === b[index].sizeBytes &&
        file.modifiedAt === b[index].modifiedAt &&
        file.current === b[index].current,
    )
  );
}

/**
 * Grava as linhas do registro num arquivo de texto, uma execução por arquivo.
 *
 * `write` só põe a linha numa fila na memória; a gravação acontece em segundo plano, sempre
 * uma por vez (tudo que mexe no armazenamento passa pela mesma fila), e uma falha nunca
 * chega a quem escreve: vira `problem` no snapshot, e as linhas esperam a próxima tentativa.
 * O snapshot é imutável, como o da sessão: objeto novo a cada mudança, partes iguais
 * mantêm a referência.
 */
export class SessionRecorder implements RecorderStore {
  private readonly storage: RecorderStorage;
  private readonly clock: RecorderClock;
  private readonly headerInfo: HeaderInfo;
  private readonly fileName: string;
  private readonly startedAt: number;
  private readonly listeners = new Set<() => void>();

  private snapshot: RecorderSnapshot;

  /** Linhas já formatadas que ainda não chegaram ao arquivo, da mais antiga para a mais nova. */
  private pending: string[] = [];
  /** Linhas descartadas pelo teto, a registrar no arquivo antes das que sobraram. */
  private dropped: { count: number; at: number } | null = null;
  private timer: unknown = null;
  /** Uma descarga já na fila e ainda não iniciada: pedidos novos se juntam a ela. */
  private queuedDrain: Promise<void> | null = null;
  /** Depois de uma falha, só o prazo (e não o tamanho ou os erros) provoca nova tentativa. */
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();

  private headerWritten = false;
  /** Uma gravação em andamento leva o cabeçalho: outra não deve repeti-lo. Desfeito se ela falhar. */
  private headerReserved = false;
  /** Motivo da primeira falha de uma sequência; o próximo bloco gravado a avisa e zera. */
  private writeFailure: string | null = null;
  /** O arquivo desta execução já foi gravado ao menos uma vez. */
  private created = false;
  private createFailed = false;
  private mirrorActive = false;
  private disposed = false;

  private writeProblem: string | null = null;
  private mirrorProblem: string | null = null;
  private filesProblem: string | null = null;

  constructor(options: SessionRecorderOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? systemClock;
    this.headerInfo = options.headerInfo;
    this.startedAt = this.clock.now();
    this.fileName = logFileName(new Date(this.startedAt));
    this.snapshot = {
      currentFileName: this.fileName,
      files: NO_FILES,
      mirror: null,
      problem: null,
    };
    void this.enqueue(() => this.start());
  }

  // --- RecorderStore ---------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RecorderSnapshot => this.snapshot;

  readonly write: TraceSink = (line) => {
    try {
      this.accept(line);
    } catch {
      // O registro é acessório: nada que aconteça aqui pode afetar quem escreve.
    }
  };

  /** Grava o que está na memória. Nunca rejeita: a falha aparece em `problem`. */
  async flush(): Promise<void> {
    await this.scheduleDrain();
  }

  /**
   * Grava agora, de forma síncrona, tudo o que está em `pending`; para o erro fatal, que mata o
   * app logo depois (a escrita assíncrona não teria tempo). Nunca lança.
   *
   * Uma descarga assíncrona em andamento já tirou as suas linhas de `pending`: elas não são
   * repetidas, e o cabeçalho, se é essa descarga que o leva, também não. Por isso, no arquivo, o
   * bloco síncrono pode ficar antes do bloco em andamento (as linhas têm hora). Se o armazenamento
   * não tem `appendSync` ou ele falha, as linhas voltam para `pending` e a descarga normal é pedida.
   * Se o app continuar vivo, o gravador segue normalmente. (Se a descarga que levava o cabeçalho
   * falhar depois disso, o cabeçalho acabará no meio do arquivo, no próximo bloco gravado.)
   */
  flushSync(): void {
    try {
      this.flushSyncNow();
    } catch {
      // Chamado de dentro do tratamento de um erro fatal: nada pode escapar daqui.
    }
  }

  readonly actions: RecorderActions = {
    refresh: () => {
      this.clearFilesProblem();
      void this.enqueue(() => this.refreshFiles());
    },
    share: (fileName) => {
      if (isLogFileName(fileName)) {
        void this.shareFile(fileName);
      }
    },
    remove: (fileName) => {
      // O arquivo em que o app está gravando não pode ser apagado.
      if (isLogFileName(fileName) && fileName !== this.fileName) {
        this.clearFilesProblem();
        void this.enqueue(() => this.removeFiles([fileName]));
      }
    },
    removeOthers: () => {
      this.clearFilesProblem();
      void this.enqueue(() => this.removeOthers());
    },
    chooseMirrorFolder: () => {
      void this.chooseMirror();
    },
    stopMirroring: () => {
      void this.enqueue(() => this.stopMirror());
    },
  };

  /** Encerra os temporizadores e tenta gravar o que sobrou. Depois disso, `write` não faz nada. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    void this.scheduleDrain();
    this.listeners.clear();
  }

  // --- Entrada de linhas -----------------------------------------------------

  private accept(line: TraceLine): void {
    if (this.disposed) {
      return;
    }
    this.pending.push(formatTraceLine(line));
    this.enforceCap();
    if (line.kind === 'error' || this.pending.length >= FLUSH_LINES) {
      if (this.clock.now() < this.blockedUntil) {
        this.armTimer();
      } else {
        void this.scheduleDrain();
      }
    } else {
      this.armTimer();
    }
  }

  private enforceCap(): void {
    const excess = this.pending.length - MAX_PENDING_LINES;
    if (excess > 0) {
      this.pending.splice(0, excess);
      this.dropped = {
        count: (this.dropped?.count ?? 0) + excess,
        at: this.dropped?.at ?? this.clock.now(),
      };
    }
  }

  /** Devolve à conta as perdas de uma descarga que falhou, somando as que ocorreram nesse meio-tempo. */
  private restoreDropped(previous: { count: number; at: number } | null): void {
    if (previous) {
      this.dropped = { count: previous.count + (this.dropped?.count ?? 0), at: previous.at };
    }
  }

  private armTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.scheduleDrain();
    }, FLUSH_DELAY_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- Fila e gravação -------------------------------------------------------

  /** Tudo que usa o armazenamento passa por aqui, uma tarefa por vez e na ordem do pedido. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private scheduleDrain(): Promise<void> {
    if (this.queuedDrain) {
      return this.queuedDrain;
    }
    this.clearTimer();
    const drain = this.enqueue(async () => {
      this.queuedDrain = null;
      await this.drain();
    });
    this.queuedDrain = drain;
    return drain;
  }

  /** Tira de `pending` tudo o que há, com o cabeçalho, o aviso de falha e o de perdas, se for o caso. */
  private takeBlock(): Block | null {
    if (this.pending.length === 0) {
      return null;
    }
    const lines = this.pending;
    const dropped = this.dropped;
    const withHeader = !this.headerWritten && !this.headerReserved;
    const withFailureNotice = this.writeFailure !== null;

    const parts: string[] = [];
    if (withHeader) {
      parts.push(formatHeader(this.headerInfo, this.startedAt));
    }
    if (this.writeFailure !== null) {
      // Não dá para saber quanto da gravação que falhou chegou ao arquivo.
      parts.push(
        formatTraceLine({
          at: this.clock.now(),
          kind: 'error',
          text: `A gravação anterior falhou (${this.writeFailure}); se parte dela chegou ao arquivo, as linhas a seguir a repetem`,
          hex: null,
        }),
      );
    }
    if (dropped) {
      const noun = dropped.count === 1 ? 'linha foi descartada' : 'linhas foram descartadas';
      parts.push(
        formatTraceLine({
          at: dropped.at,
          kind: 'error',
          text: `${dropped.count} ${noun} da memória porque o arquivo não pôde ser gravado`,
          hex: null,
        }),
      );
    }
    parts.push(...lines);

    // Só depois de tudo formatado: se algo acima lançasse, `pending` continuaria intacto.
    this.pending = [];
    this.dropped = null;
    if (withHeader) {
      this.headerReserved = true;
    }
    return { text: `${parts.join('\n')}\n`, lines, dropped, withHeader, withFailureNotice };
  }

  /** Devolve as linhas do bloco para a frente da fila e desfaz a reserva do cabeçalho. */
  private restoreBlock(block: Block): void {
    this.pending = block.lines.concat(this.pending);
    this.restoreDropped(block.dropped);
    this.enforceCap();
    if (block.withHeader) {
      this.headerReserved = false;
    }
  }

  /** A gravação do bloco falhou, e não dá para saber quanto dele chegou ao arquivo. */
  private blockFailed(block: Block, error: unknown): void {
    this.restoreBlock(block);
    this.writeFailure ??= errorMessage(error);
    if (!this.created) {
      this.createFailed = true;
    }
    this.writeProblem = `Não foi possível gravar o registro: ${errorMessage(error)}`;
    this.syncProblems();
  }

  /** O bloco chegou ao arquivo. Devolve se foi a primeira gravação do arquivo. */
  private blockWritten(block: Block): boolean {
    if (block.withHeader) {
      this.headerWritten = true;
      this.headerReserved = false;
    }
    if (block.withFailureNotice) {
      this.writeFailure = null;
      this.writeProblem = null;
    }
    const firstWrite = !this.created;
    this.created = true;
    this.createFailed = false;
    return firstWrite;
  }

  private mirrorFailed(error: unknown): void {
    // A cópia nunca afeta o arquivo interno: fica suspensa até o fim da execução.
    this.mirrorActive = false;
    this.mirrorProblem = `A cópia para ${this.snapshot.mirror?.label} falhou e foi suspensa até o app ser reaberto: ${errorMessage(error)}`;
  }

  /** Anexa ao arquivo tudo que está pendente (e, se for o caso, o cabeçalho e os avisos). */
  private async drain(): Promise<void> {
    const block = this.takeBlock();
    if (!block) {
      return;
    }

    try {
      await this.storage.append(this.fileName, block.text);
    } catch (error) {
      this.blockFailed(block, error);
      this.blockedUntil = this.clock.now() + FLUSH_DELAY_MS;
      if (!this.disposed) {
        this.armTimer();
      }
      return;
    }

    const firstWrite = this.blockWritten(block);

    if (this.snapshot.mirror && this.mirrorActive) {
      try {
        await this.storage.mirrorWrite(this.snapshot.mirror, this.fileName, block.text, { append: true });
      } catch (error) {
        this.mirrorFailed(error);
      }
    }

    this.syncProblems();
    if (firstWrite) {
      await this.refreshFiles();
    }
    if (this.pending.length > 0 && !this.disposed) {
      this.armTimer();
    }
  }

  private flushSyncNow(): void {
    const block = this.takeBlock();
    if (!block) {
      return;
    }
    this.clearTimer();

    const { appendSync, mirrorWriteSync } = this.storage;
    if (!appendSync) {
      // Nada foi tentado: não é uma falha de gravação, só segue pela descarga normal.
      this.restoreBlock(block);
      void this.scheduleDrain();
      return;
    }
    try {
      appendSync.call(this.storage, this.fileName, block.text);
    } catch (error) {
      this.blockFailed(block, error);
      void this.scheduleDrain();
      return;
    }

    const firstWrite = this.blockWritten(block);
    if (this.snapshot.mirror && this.mirrorActive && mirrorWriteSync) {
      try {
        mirrorWriteSync.call(this.storage, this.snapshot.mirror, this.fileName, block.text);
      } catch (error) {
        this.mirrorFailed(error);
      }
    }
    this.syncProblems();
    if (firstWrite) {
      void this.enqueue(() => this.refreshFiles());
    }
  }

  // --- Início, lista e retenção ----------------------------------------------

  private async start(): Promise<void> {
    try {
      const mirror = await this.storage.loadMirror();
      if (mirror) {
        this.mirrorActive = true;
        this.update({ mirror });
      }
    } catch (error) {
      this.mirrorProblem = `Não foi possível ler a pasta de cópia salva: ${errorMessage(error)}`;
    }
    await this.prune();
    await this.refreshFiles();
  }

  private async listLogFiles(): Promise<StoredFile[]> {
    const stored = await this.storage.list();
    // Os nomes começam pela data, então a ordem alfabética é a cronológica (mais novo primeiro).
    return stored.filter((file) => isLogFileName(file.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  /** Apaga os mais antigos além do limite de arquivos ou de bytes; nunca o atual. */
  private async prune(): Promise<void> {
    try {
      const files = await this.listLogFiles();
      // O arquivo desta execução ainda será criado: ele ocupa uma das vagas.
      let count = 1;
      let bytes = 0;
      let over = false;
      for (const file of files) {
        if (file.name === this.fileName) {
          continue;
        }
        if (!over && (count + 1 > MAX_FILES || bytes + file.sizeBytes > MAX_TOTAL_BYTES)) {
          over = true;
        }
        if (over) {
          try {
            await this.storage.remove(file.name);
          } catch {
            // Fica para a próxima execução.
          }
        } else {
          count += 1;
          bytes += file.sizeBytes;
        }
      }
    } catch (error) {
      this.filesProblem = `Não foi possível limpar os registros antigos: ${errorMessage(error)}`;
      this.syncProblems();
    }
  }

  private async refreshFiles(): Promise<void> {
    try {
      const stored = await this.listLogFiles();
      const files: LogFile[] = stored.map((file) => ({
        name: file.name,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        current: file.name === this.fileName,
      }));
      if (!sameFiles(files, this.snapshot.files)) {
        this.update({ files });
      }
    } catch (error) {
      this.filesProblem = `Não foi possível listar os registros: ${errorMessage(error)}`;
      this.syncProblems();
    }
  }

  // --- Ações -----------------------------------------------------------------

  private clearFilesProblem(): void {
    if (this.filesProblem !== null) {
      this.filesProblem = null;
      this.syncProblems();
    }
  }

  private async shareFile(fileName: string): Promise<void> {
    this.clearFilesProblem();
    await this.flush();
    try {
      // Fora da fila: a folha de compartilhamento pode ficar aberta por muito tempo.
      await this.storage.share(fileName);
    } catch (error) {
      this.filesProblem = `Não foi possível compartilhar o registro: ${errorMessage(error)}`;
      this.syncProblems();
    }
  }

  private async removeFiles(names: string[]): Promise<void> {
    let failure: string | null = null;
    for (const name of names) {
      try {
        await this.storage.remove(name);
      } catch (error) {
        failure = errorMessage(error);
      }
    }
    if (failure !== null) {
      this.filesProblem = `Não foi possível apagar o registro: ${failure}`;
      this.syncProblems();
    }
    await this.refreshFiles();
  }

  private async removeOthers(): Promise<void> {
    try {
      const files = await this.listLogFiles();
      await this.removeFiles(files.filter((file) => file.name !== this.fileName).map((file) => file.name));
    } catch (error) {
      this.filesProblem = `Não foi possível listar os registros: ${errorMessage(error)}`;
      this.syncProblems();
    }
  }

  private async chooseMirror(): Promise<void> {
    let folder: MirrorFolder | null;
    try {
      // Fora da fila: o seletor do sistema pode ficar aberto, e a gravação continua.
      folder = await this.storage.pickMirrorFolder();
    } catch (error) {
      this.filesProblem = `Não foi possível abrir o seletor de pastas: ${errorMessage(error)}`;
      this.syncProblems();
      return;
    }
    if (folder) {
      const chosen = folder;
      await this.enqueue(() => this.startMirror(chosen));
    }
  }

  /** Roda na fila: nenhuma gravação acontece entre a leitura do arquivo e o início da cópia. */
  private async startMirror(folder: MirrorFolder): Promise<void> {
    this.mirrorActive = false;
    this.mirrorProblem = null;
    this.update({ mirror: folder });
    try {
      await this.storage.saveMirror(folder);
    } catch (error) {
      this.mirrorProblem = `A pasta de cópia não pôde ser salva e será esquecida ao fechar o app: ${errorMessage(error)}`;
    }
    try {
      if (this.created) {
        const content = await this.storage.read(this.fileName);
        await this.storage.mirrorWrite(folder, this.fileName, content, { append: false });
      }
      this.mirrorActive = true;
    } catch (error) {
      this.mirrorProblem = `Não foi possível copiar o registro para ${folder.label}: ${errorMessage(error)}`;
    }
    this.syncProblems();
  }

  private async stopMirror(): Promise<void> {
    this.mirrorActive = false;
    this.mirrorProblem = null;
    this.update({ mirror: null });
    try {
      await this.storage.saveMirror(null);
    } catch (error) {
      this.filesProblem = `Não foi possível esquecer a pasta de cópia: ${errorMessage(error)}`;
    }
    this.syncProblems();
  }

  // --- Estado ----------------------------------------------------------------

  /** Recalcula os campos derivados dos problemas e do estado do arquivo atual. */
  private syncProblems(): void {
    this.update({
      currentFileName: this.createFailed ? null : this.fileName,
      problem: this.writeProblem ?? this.mirrorProblem ?? this.filesProblem,
    });
  }

  private update(patch: Partial<RecorderSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof RecorderSnapshot)[]) {
      if (patch[key] !== this.snapshot[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Um ouvinte com defeito não pode interromper a gravação.
      }
    }
  }
}
