import type { TraceSink } from '@/treadmill/types';

/**
 * Contrato do gravador de registros: tudo o que a sessão e o roteiro escrevem
 * (`TraceLine`) vai para um arquivo de texto no celular, um por execução do
 * app. A interface só conhece este contrato.
 */

export interface LogFile {
  /** Nome do arquivo, por exemplo `gym-burn-2026-11-10_21-30-05.txt`. */
  name: string;
  sizeBytes: number;
  /** `Date.now()` da última modificação, quando o sistema informa. */
  modifiedAt: number | null;
  /** É o arquivo em que o app está gravando agora. */
  current: boolean;
}

/** Pasta do celular, escolhida pelo usuário, que recebe uma cópia dos registros. */
export interface MirrorFolder {
  /** URI devolvida pelo seletor de pastas do sistema. */
  uri: string;
  /** Nome para exibir, por exemplo `Documents/GymBurn`. */
  label: string;
}

export interface RecorderSnapshot {
  /** Arquivo desta execução do app; `null` se não foi possível criá-lo. */
  currentFileName: string | null;
  /** Arquivos guardados, do mais novo para o mais antigo. */
  files: LogFile[];
  /** Pasta de cópia, se o usuário escolheu uma. */
  mirror: MirrorFolder | null;
  /** Último problema ao gravar ou copiar, pronto para exibir; `null` se está tudo bem. */
  problem: string | null;
}

/** Nenhuma ação devolve resultado: o efeito aparece no snapshot (e falhas viram `problem`). */
export interface RecorderActions {
  /** Relê a lista de arquivos; os tamanhos mudam enquanto o app grava. */
  refresh(): void;
  /** Grava o que estiver pendente e abre a folha de compartilhamento do sistema com o arquivo. */
  share(fileName: string): void;
  remove(fileName: string): void;
  /** Apaga todos os arquivos, menos o atual. */
  removeOthers(): void;
  /** Abre o seletor de pastas do sistema; os registros passam a ser copiados para a pasta escolhida. */
  chooseMirrorFolder(): void;
  stopMirroring(): void;
}

export interface RecorderStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RecorderSnapshot;
  readonly actions: RecorderActions;
  /** Entrada do registro: a sessão e o roteiro escrevem por aqui. Nunca lança. */
  readonly write: TraceSink;
  /** Grava em disco o que ainda está na memória. */
  flush(): Promise<void>;
  /** Grava na hora, de forma síncrona, o que está na memória; para o erro fatal. Nunca lança. */
  flushSync(): void;
}
