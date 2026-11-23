import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  ScannedDevice,
} from '@/ble/transport';
import { sameUuid, utf8Decode } from '@/ftms';

import { BATTERY, HEART_RATE, parseHeartRateMeasurement } from './heart-rate';
import { XossBusyError, XossClient, XossClosedError } from './xoss/client';
import { decodeFit, type FitRecord } from './xoss/fit';
import { parseFileList, type XossSpace } from './xoss/frames';
import {
  patchStrapProfile,
  readStrapProfile,
  sameStrapProfile,
  utf8Encode,
  type StrapProfile,
} from './xoss/profile';

/** Uma leitura da cinta mais velha que isto não vale: os batimentos voltam a ser os da esteira. */
export const STRAP_FRESH_MS = 5000;

/** Quanto dura cada janela de busca pela cinta pareada. */
const SEARCH_WINDOW_MS = 20_000;
/** Pausa entre duas janelas: o Android limita os inícios de busca e a busca gasta bateria. */
const SEARCH_PAUSE_MS = 10_000;
/**
 * A cada janela sem ver a cinta a pausa cresce uma vez, até este múltiplo:
 * quem pareou uma cinta e treina sem ela não fica com o rádio buscando dois
 * terços do treino.
 */
const MAX_PAUSE_FACTOR = 6;
/**
 * Espera depois de conectar num aparelho que não mostrou o Heart Rate
 * Measurement. Quase sempre é a lista de serviços que o Android guardou
 * incompleta, e uma nova conexão resolve; se o aparelho não for mesmo uma
 * cinta, a insistência fica espaçada.
 */
const NOT_A_STRAP_RETRY_MS = 30_000;
/** Espera antes de tentar de novo depois de uma conexão que falhou. */
const RETRY_MS = 3_000;
/** A busca do pareamento para sozinha depois deste tempo. */
const PAIRING_TIMEOUT_MS = 30_000;
/**
 * Sem ninguém precisando da cinta, ela só é solta depois deste tempo: entre a
 * busca e a conexão da esteira a sessão fica livre por um instante, e largar a
 * cinta ali seria reconectar logo em seguida.
 */
const RELEASE_GRACE_MS = 15_000;
/** Quanto esperar pela leitura da bateria antes de seguir sem ela. */
const BATTERY_TIMEOUT_MS = 2000;
/** Prazo da assinatura das notificações de bateria, feita depois de conectar. */
const BATTERY_SUBSCRIBE_TIMEOUT_MS = 5000;
/** Os últimos RR guardados, numerados, para a sessão da esteira não perder nenhum entre dois pacotes. */
const BEAT_RING = 32;
/** A cadência mais velha que isto não vale: a amostra recebe `null`. */
export const CADENCE_FRESH_MS = 3000;
/** A consulta de passos: 1 Hz; depois de 3 prazos estourados seguidos, a cada 5 s. */
const STEPS_POLL_MS = 1000;
const STEPS_SLOW_MS = 5000;
const STEPS_MISSES = 3;
/** Memória livre mínima para o app começar uma gravação na cinta (o FIT de 45 min tem uns 35 kB). */
const MIN_FREE_KB = 60;
/** O arquivo da gravação casa com o treino pelo nome (UTC) até esta distância do início. */
const BACKFILL_MATCH_MS = 5000;
/**
 * Espera depois de encerrar uma gravação, antes de começar outra ou de ler a
 * lista de treinos: a cinta grava o arquivo (o cliente de referência espera 2 s).
 */
const RECORDING_GAP_MS = 2000;
/** Espera antes de reler o perfil enviado, como `tools/xoss/perfil.py`: a cinta reescreve o arquivo. */
const PROFILE_REREAD_MS = 1000;
/**
 * Uma reconciliação com passo falho tenta de novo depois destas esperas, uma a
 * uma, e depois a cada 60 s, enquanto a cinta segue anexada: uma cinta que
 * recusa um comando não inunda o canal com ele.
 */
const RECONCILE_RETRY_MS = [10_000, 30_000, 60_000];
/**
 * A marca da gravação vale sem limite enquanto o treino dono dela está ativo
 * no app (uma pausa longa não a vence). Sem ele (treino encerrado, app
 * reaberto depois de morto), vale por este tempo a partir do início; passado
 * isso, é descartada sem encerrar nada.
 */
const RECORDING_MARK_MAX_MS = 24 * 3_600_000;
/**
 * Sem ninguém precisando da cinta, uma tarefa ociosa em curso (FIT, perfil)
 * segura a conexão até acabar, no máximo por este tempo: o `rest()` 15 s depois
 * de a esteira soltar a cinta cortaria o download sempre no mesmo ponto.
 */
const IDLE_HOLD_MAX_MS = 120_000;
/** Downloads interrompidos ou falhos do mesmo arquivo antes de ele sair da fila nesta conexão. */
const MAX_DOWNLOAD_ATTEMPTS = 2;
/**
 * Fila nativa presa sem treino ativo: o app desconecta para soltá-la, mas no
 * máximo uma vez neste intervalo (uma cinta que trava sempre não fica num
 * laço de conectar e desconectar).
 */
const STALL_RELEASE_GAP_MS = 10 * 60_000;

export type StrapPhase =
  | 'idle' // sem cinta pareada, ou ninguém precisa dela agora
  | 'searching' // procurando a cinta pareada por perto
  | 'connecting'
  | 'connected'; // batimentos chegando

/** Um intervalo RR, numerado na ordem em que chegou (a numeração só cresce). */
export interface StrapBeat {
  seq: number;
  rrMs: number;
}

/** Cadência da XOSS X2 Pro, em passos por minuto, com o total de passos e a hora da consulta. */
export interface StrapCadence {
  spm: number;
  steps: number;
  at: number;
}

/** Uma leitura da cinta e o `Date.now()` em que ela chegou. */
export interface StrapReading {
  bpm: number;
  at: number;
  /**
   * Os últimos ~32 RR, crus (o filtro de artefatos, `acceptRr`, fica para
   * quem analisa), numerados. Ausente enquanto a cinta não mandou nenhum.
   */
  beats?: { seq: number; rrMs: number }[];
  /**
   * Ausente: a cinta não tem fonte de cadência (não é a X2 Pro, ou o protocolo
   * não anexou). `null`: tem, mas sem valor dos últimos 3 s.
   */
  cadence?: { spm: number; steps: number; at: number } | null;
}

/** Cada notificação de batimentos, como chegou: o caminho direto para medir repouso e HRV parado. */
export interface StrapBeatEvent {
  at: number;
  /** `null` quando a cinta diz que não tem leitura (0 ou sem contato). */
  bpm: number | null;
  /** Os RR do pacote, crus. */
  rrMs: number[];
}

export interface SavedStrap {
  id: string;
  name: string | null;
  /** A cinta já anexou o protocolo da XOSS X2 Pro. */
  xoss?: boolean;
  // As marcas de dono: o que o app ligou na cinta e ainda não desfez. Ficam no
  // aparelho para sobreviver ao app morto. Sem a marca, o app não toca no que
  // achar ligado: pode ser da pessoa, do app da XOSS ou de outro aparelho.
  /**
   * A gravação que o app começou e ainda não encerrou, e quando. Vale sem
   * limite com o treino dono ativo; sem ele, por 24 h a partir do início.
   */
  recording?: { workoutId: string; startedAt: number } | null;
  /**
   * O alerta: o valor que a pessoa tinha antes do app (`null` = desligado; o
   * primeiro, nunca sobrescrito por reprogramações) e todos os valores que o
   * app já programou e ainda não confirmou desfeitos. No fim, a cinta volta a
   * `previous` se mostra qualquer um deles.
   */
  alert?: { workoutId: string; previous: number | null; owned: number[] } | null;
  /** O app ligou a contagem de passos, que estava desligada: no fim, desliga. */
  steps?: { since: number } | null;
}

/**
 * O que o treino quer da cinta. A sessão da cinta reconcilia sempre que o
 * protocolo da XOSS anexa (inclusive depois de uma queda do link ou de o app
 * ter sido morto), em vez de receber comandos soltos.
 */
export interface StrapWishes {
  workout: null | {
    id: string;
    startedAt: number;
    guided: boolean;
    alertBpm: number | null;
  };
  profile: null | { weightG: number; heightMm: number; age: number; maxHr: number };
  /**
   * Treinos encerrados com gravação na cinta e lacunas na trilha, a preencher
   * pelo FIT, do mais novo ao mais antigo. Opcional: sem ele, nada é baixado.
   */
  backfill?: { workoutId: string; recordedAt: number }[];
}

/** O FIT de um treino, baixado da cinta. */
export interface BackfillJob {
  workoutId: string;
  /** O arquivo na cinta, `AAAAMMDDhhmmss.fit` em UTC. */
  file: string;
  records: FitRecord[];
}

/** O que a sessão de treino usa da cinta. */
export interface StrapLink {
  want(wishes: StrapWishes): void;
  onBackfill(listener: (job: BackfillJob) => void): () => void;
  /** O app começou uma gravação na cinta para este treino. */
  onRecorded(listener: (event: { workoutId: string; recordedAt: number }) => void): () => void;
}

/** O protocolo da XOSS X2 Pro anexado: o que a tela da cinta mostra no diagnóstico. */
export interface XossStatus {
  model: string;
  /** Última cadência lida; `null` sem consulta recente. */
  cadence: StrapCadence | null;
  /** A contagem de passos está ligada; `null` antes de saber. */
  stepsOn: boolean | null;
  space: XossSpace | null;
  /** Há gravação em curso; `null` antes de saber. */
  recording: boolean | null;
  /** A gravação em curso foi o app que começou. */
  ownRecording: boolean;
  /** O alerta de FC programado; `null` desligado, `undefined` ainda não lido. */
  alertBpm: number | null | undefined;
  /** Uma transferência de arquivo (FIT ou perfil) está em curso. */
  transferring: boolean;
  /** O último download (para medir no aparelho): arquivo, bytes, duração e se deu certo. */
  lastDownload: { file: string; bytes: number; ms: number; ok: boolean } | null;
  /** O perfil da cinta confere com o do app; `null` antes de conferir. */
  profileSynced: boolean | null;
}

export interface StrapSnapshot {
  /** A cinta pareada; `null` se nenhuma foi escolhida. */
  saved: SavedStrap | null;
  phase: StrapPhase;
  /** Última leitura válida da cinta; `null` sem leitura ou sem contato com a pele. */
  bpm: number | null;
  /** `Date.now()` da leitura em `bpm`. */
  bpmAt: number | null;
  /** Bateria da cinta, em %, lida ao conectar e atualizada pelas notificações dela. */
  battery: number | null;
  /** O protocolo da XOSS X2 Pro, quando anexado; `null` nas outras cintas. */
  xoss: XossStatus | null;
  /** A busca do pareamento está aberta. */
  pairing: boolean;
  /** Monitores de batimentos vistos na busca do pareamento, na ordem em que apareceram. */
  candidates: ScannedDevice[];
  /** Texto pronto para exibir; some na próxima tentativa que der certo. */
  error: string | null;
}

export interface StrapActions {
  startPairing(): void;
  stopPairing(): void;
  /** Pareia com um dos monitores da busca e conecta. */
  choose(deviceId: string): void;
  /** Desconecta e esquece a cinta pareada. */
  forget(): void;
  /** Volta a procurar a cinta pareada depois de uma tentativa que parou num erro. */
  retry(): void;
}

/** O que a interface precisa da cinta: estado observável, ações e o pedido de uso. */
export interface StrapStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): StrapSnapshot;
  readonly actions: StrapActions;
  /**
   * Pede a cinta: enquanto houver um pedido aberto, a sessão procura a cinta
   * pareada, conecta e reconecta se o link cair. Devolve a função que encerra
   * o pedido.
   */
  hold(): () => void;
  /**
   * Liga a contagem de passos da X2 Pro e a consulta a 1 Hz mesmo sem treino,
   * enquanto o pedido estiver aberto: é o que a tela da cinta usa para mostrar
   * a cadência ao vivo. Devolve a função que encerra o pedido.
   */
  watchCadence(): () => void;
}

export interface HeartStrapSessionOptions {
  ble: BleTransport;
  /** Onde a cinta pareada fica guardada entre uma abertura do app e outra. */
  storage: { read(): SavedStrap | null; write(strap: SavedStrap | null): void };
  now?: () => number;
  searchWindowMs?: number;
  searchPauseMs?: number;
  retryMs?: number;
  unfitRetryMs?: number;
  pairingTimeoutMs?: number;
  releaseGraceMs?: number;
}

/** O aparelho conectou, mas não mostrou o Heart Rate Measurement. */
class NotAStrapError extends Error {}

/** O que o app já sabe ou já fez na cinta nesta conexão; recomeça a cada anexação do protocolo. */
interface Known {
  /** O treino para o qual o relógio foi acertado. */
  clockFor: string | null;
  stepsOn: boolean | null;
  /** O alerta conferido na cinta; `undefined` antes de saber. */
  alertBpm: number | null | undefined;
  /** O treino para o qual a gravação já foi tentada. */
  recordingFor: string | null;
  /** A gravação já foi conferida sem treino. */
  recordingChecked: boolean;
  spaceRead: boolean;
  /** Uma tentativa de perfil por conexão. */
  profileTried: boolean;
  /** Os treinos cujo FIT já foi resolvido nesta conexão (entregue, fora da lista ou desistido). */
  backfillDone: Set<string>;
  /** Downloads interrompidos ou falhos por arquivo, nesta conexão. */
  downloadFailures: Map<string, number>;
}

const freshKnown = (): Known => ({
  clockFor: null,
  stepsOn: null,
  alertBpm: undefined,
  recordingFor: null,
  recordingChecked: false,
  spaceRead: false,
  profileTried: false,
  backfillDone: new Set(),
  downloadFailures: new Map(),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function noop(): void {}

/**
 * A cinta de batimentos (ou qualquer monitor que fale o Heart Rate Service,
 * 0x180D). A pessoa pareia uma vez; depois disso a sessão conecta sozinha
 * sempre que o app está procurando ou usando uma esteira, e reconecta quando o
 * link cai.
 *
 * Enquanto a cinta manda leituras, são elas que valem como batimentos do
 * treino (`reading`). Sem cinta, sem contato com a pele ou com a leitura
 * velha, `reading` devolve `null` e a sessão da esteira volta a usar o sensor
 * de mão do painel.
 *
 * Os batimentos nunca dependem de mais nada: qualquer cinta que fale o Heart
 * Rate Service funciona assim. Na XOSS X2 Pro (serviço 6e400001 e Model
 * Number "X2PRO"), depois de conectada, a sessão anexa também o protocolo
 * proprietário (`XossClient`), em segundo plano: passos e cadência, gravação
 * do treino na memória da cinta, alerta de FC e o perfil. É a única escrita
 * do app em Bluetooth; qualquer falha nela só desliga o protocolo, sem erro na
 * tela, e os batimentos seguem.
 */
export class HeartStrapSession implements StrapStore, StrapLink {
  readonly actions: StrapActions;

  private readonly ble: BleTransport;
  private readonly storage: HeartStrapSessionOptions['storage'];
  private readonly now: () => number;
  private readonly searchWindowMs: number;
  private readonly searchPauseMs: number;
  private readonly retryMs: number;
  private readonly unfitRetryMs: number;
  private readonly pairingTimeoutMs: number;
  private readonly releaseGraceMs: number;

  private readonly listeners = new Set<() => void>();
  private snapshot: StrapSnapshot;

  /** Pedidos de uso abertos (`hold`). */
  private holds = 0;
  /** A busca está suspensa (`setQuiet`). */
  private quiet = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Muda a cada tentativa e a cada desistência; callbacks de uma tentativa antiga são ignorados. */
  private epoch = 0;
  private searchScan: BleSubscription | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Janelas de busca seguidas que acabaram sem ver a cinta. */
  private emptyWindows = 0;
  private connection: BleConnection | null = null;
  private subscriptions: BleSubscription[] = [];

  /** Os últimos RR, numerados por `beatSeq`. */
  private beats: StrapBeat[] = [];
  private beatSeq = 0;
  private readonly beatListeners = new Set<(beat: StrapBeatEvent) => void>();

  /** O protocolo da XOSS anexado nesta conexão; `null` nas outras cintas ou depois de uma falha. */
  private xoss: XossClient | null = null;
  private known: Known = freshKnown();
  private wishes: StrapWishes = { workout: null, profile: null };
  private wishesKey = JSON.stringify(this.wishes);
  private reconciling = false;
  private dirty = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Voltas seguidas com passo falho: escolhem a espera da próxima. */
  private retries = 0;
  /** Cancela a transferência ociosa em curso (FIT ou perfil) quando um treino começa. */
  private idleAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private pollMisses = 0;
  private cadenceWatchers = 0;
  private lastStallRelease = -Infinity;
  /** A lona da esteira conectada está andando: o perfil não começa a sincronizar. */
  private beltMoving = false;
  /** Ninguém precisa da cinta, mas uma tarefa ociosa está em curso: o descanso espera ela. */
  private restPending = false;
  private restDeadline: ReturnType<typeof setTimeout> | null = null;
  /**
   * O `release` de uma conexão que está sendo solta: uma conexão nova à mesma
   * cinta espera ele acabar (antes, pegaria a mesma ligação, que o fim do
   * `release` derrubaria).
   */
  private releasing: Promise<void> | null = null;
  private readonly backfillListeners = new Set<(job: BackfillJob) => void>();
  private readonly recordedListeners = new Set<
    (event: { workoutId: string; recordedAt: number }) => void
  >();

  private pairingEpoch = 0;
  private pairingScan: BleSubscription | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Tudo o que a busca do pareamento viu. O anúncio e o scan response chegam
   * separados (um traz o nome, o outro os serviços), então quem ainda não
   * mostrou o Heart Rate Service também fica guardado.
   */
  private readonly seen = new Map<string, ScannedDevice>();

  constructor(options: HeartStrapSessionOptions) {
    this.ble = options.ble;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.searchWindowMs = options.searchWindowMs ?? SEARCH_WINDOW_MS;
    this.searchPauseMs = options.searchPauseMs ?? SEARCH_PAUSE_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.unfitRetryMs = options.unfitRetryMs ?? NOT_A_STRAP_RETRY_MS;
    this.pairingTimeoutMs = options.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS;
    this.releaseGraceMs = options.releaseGraceMs ?? RELEASE_GRACE_MS;

    let saved: SavedStrap | null = null;
    try {
      saved = this.storage.read();
    } catch {
      // Sem conseguir ler o banco, o app abre como se não houvesse cinta pareada.
    }
    this.snapshot = {
      saved,
      phase: 'idle',
      bpm: null,
      bpmAt: null,
      battery: null,
      xoss: null,
      pairing: false,
      candidates: [],
      error: null,
    };
    this.actions = {
      startPairing: () => void this.startPairing(),
      stopPairing: () => this.stopPairing(),
      choose: (deviceId) => this.choose(deviceId),
      forget: () => this.forget(),
      retry: () => this.pursue(),
    };
  }

  // Funções-flecha: `useSyncExternalStore` chama sem `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): StrapSnapshot => this.snapshot;

  private update(patch: Partial<StrapSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /**
   * A leitura da cinta que vale neste instante, com a hora em que chegou, ou
   * `null` se ela não tem uma leitura recente. É o que a sessão da esteira
   * consulta a cada pacote; a hora deixa ela contar cada leitura uma vez só.
   */
  reading = (now: number): StrapReading | null => {
    const { phase, bpm, bpmAt } = this.snapshot;
    if (phase !== 'connected' || bpm === null || bpmAt === null) {
      return null;
    }
    if (Math.abs(now - bpmAt) > STRAP_FRESH_MS) {
      return null;
    }
    const reading: StrapReading = { bpm, at: bpmAt };
    if (this.beats.length > 0) {
      reading.beats = this.beats;
    }
    if (this.xoss) {
      // A cadência é nível, não evento: vale enquanto a consulta é recente.
      const cadence = this.snapshot.xoss?.cadence ?? null;
      reading.cadence = cadence && Math.abs(now - cadence.at) <= CADENCE_FRESH_MS ? cadence : null;
    }
    return reading;
  };

  /** Cada notificação de batimentos da cinta, com os RR crus. Devolve a função que cancela. */
  onBeat = (listener: (beat: StrapBeatEvent) => void): (() => void) => {
    this.beatListeners.add(listener);
    return () => {
      this.beatListeners.delete(listener);
    };
  };

  onBackfill = (listener: (job: BackfillJob) => void): (() => void) => {
    this.backfillListeners.add(listener);
    return () => {
      this.backfillListeners.delete(listener);
    };
  };

  onRecorded = (
    listener: (event: { workoutId: string; recordedAt: number }) => void,
  ): (() => void) => {
    this.recordedListeners.add(listener);
    return () => {
      this.recordedListeners.delete(listener);
    };
  };

  /**
   * Declara o que o treino quer da cinta. Pedidos iguais ao anterior não
   * fazem nada; um treino que começa cancela a transferência ociosa em curso.
   */
  want = (wishes: StrapWishes): void => {
    const key = JSON.stringify(wishes);
    if (key === this.wishesKey) {
      return;
    }
    this.wishes = wishes;
    this.wishesKey = key;
    // Pedido novo, situação nova: a espera crescente das falhas antigas não vale para ele.
    this.retries = 0;
    if (wishes.workout) {
      this.idleAbort?.abort();
    }
    if (this.xoss) {
      void this.reconcile();
    }
  };

  /**
   * A lona da esteira conectada está andando. Com ela andando a sincronização
   * do perfil não começa: um treino pode começar a qualquer instante, e o
   * envio, que não se cancela no meio, atrasaria os passos e a gravação dele.
   */
  setBeltMoving(moving: boolean): void {
    if (this.beltMoving === moving) {
      return;
    }
    this.beltMoving = moving;
    if (!moving && this.xoss && !this.wishes.workout) {
      void this.reconcile();
    }
  }

  watchCadence = (): (() => void) => {
    this.cadenceWatchers += 1;
    if (this.xoss) void this.reconcile();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cadenceWatchers -= 1;
      if (this.xoss) void this.reconcile();
    };
  };

  hold = (): (() => void) => {
    this.holds += 1;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.clearPendingRest();
    this.pursue();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        this.releaseTimer = setTimeout(() => {
          this.releaseTimer = null;
          this.rest();
        }, this.releaseGraceMs);
      }
    };
  };

  /**
   * Suspende a busca e a conexão da cinta enquanto a esteira conecta: no
   * Android, uma busca aberta ou outra conexão em andamento atrapalham a
   * abertura de uma conexão, e a da esteira é a que não pode falhar. A cinta
   * já conectada não é afetada.
   */
  setQuiet(quiet: boolean): void {
    if (this.quiet === quiet) {
      return;
    }
    this.quiet = quiet;
    if (quiet && this.snapshot.phase === 'connecting') {
      // A cinta estava no meio da conexão: larga e volta a procurar depois.
      this.drop();
      this.update({ phase: 'searching' });
      return;
    }
    if (this.snapshot.phase !== 'searching') {
      return;
    }
    if (quiet) {
      this.closeSearch();
    } else if (!this.searchScan && !this.searchTimer) {
      void this.search();
    }
  }

  /** Com cinta pareada e alguém precisando dela, começa a procurar (se já não estiver a caminho). */
  private pursue(): void {
    if (this.snapshot.saved && this.holds > 0 && this.snapshot.phase === 'idle') {
      void this.search();
    }
  }

  /**
   * Ninguém precisa mais da cinta: para a busca e solta a conexão. Com uma
   * tarefa ociosa em curso (FIT, perfil), espera ela acabar, por até 120 s.
   */
  private rest(force = false): void {
    if (this.holds > 0 || this.snapshot.phase === 'idle') {
      return;
    }
    if (!force && this.idleAbort) {
      this.restPending = true;
      this.restDeadline ??= setTimeout(() => {
        this.restDeadline = null;
        this.restPending = false;
        this.rest(true);
      }, IDLE_HOLD_MAX_MS);
      return;
    }
    this.clearPendingRest();
    this.drop();
    this.update({ phase: 'idle', bpm: null, bpmAt: null, battery: null });
  }

  private clearPendingRest(): void {
    this.restPending = false;
    if (this.restDeadline) {
      clearTimeout(this.restDeadline);
      this.restDeadline = null;
    }
  }

  /** Abandona a tentativa ou a conexão em curso, sem mexer no estado visível (além do protocolo). */
  private drop(): void {
    this.epoch += 1;
    this.detachXoss();
    this.beats = [];
    this.closeSearch();
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      void connection.disconnect().catch(noop);
    }
  }

  // --- Busca pela cinta pareada ---------------------------------------------

  private closeSearch(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.searchScan) {
      this.searchScan.remove();
      this.searchScan = null;
    }
  }

  private async search(): Promise<void> {
    const saved = this.snapshot.saved;
    if (!saved) {
      return;
    }
    const epoch = ++this.epoch;
    this.closeSearch();
    this.emptyWindows = 0;
    this.update({ phase: 'searching' });
    try {
      await this.ble.prepare();
    } catch (error) {
      if (epoch === this.epoch) {
        // Sem rádio não adianta insistir sozinho: a próxima tentativa vem com
        // um novo pedido de uso ou com um toque na tela da cinta.
        this.update({ phase: 'idle', error: errorMessage(error) });
      }
      return;
    }
    if (epoch !== this.epoch) {
      return;
    }
    this.openWindow(saved.id, epoch);
  }

  /** Uma janela de busca: procura até ver a cinta ou o tempo acabar, e descansa antes da próxima. */
  private openWindow(id: string, epoch: number): void {
    if (this.quiet) {
      // Fica em "procurando", sem busca aberta, até `setQuiet(false)`.
      return;
    }
    const again = () => {
      this.closeSearch();
      this.emptyWindows += 1;
      const factor = Math.min(this.emptyWindows, MAX_PAUSE_FACTOR);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        if (epoch === this.epoch) {
          this.openWindow(id, epoch);
        }
      }, this.searchPauseMs * factor);
    };
    this.searchScan = this.ble.scan(
      (device) => {
        if (epoch === this.epoch && sameId(device.id, id)) {
          void this.connectTo(id);
        }
      },
      () => {
        if (epoch === this.epoch) {
          again();
        }
      },
    );
    this.searchTimer = setTimeout(again, this.searchWindowMs);
  }

  // --- Conexão ----------------------------------------------------------------

  private async connectTo(id: string): Promise<void> {
    const epoch = ++this.epoch;
    this.closeSearch();
    this.update({ phase: 'connecting' });
    const releasing = this.releasing;
    if (releasing) {
      await releasing;
      if (epoch !== this.epoch) return;
    }

    let connection: BleConnection | null = null;
    try {
      connection = await this.ble.connect(id);
      if (epoch !== this.epoch) {
        // Alguém desistiu enquanto conectava.
        await connection.disconnect().catch(noop);
        return;
      }
      this.connection = connection;
      this.subscriptions.push(connection.onDisconnect(() => this.handleLinkLost(epoch)));

      const characteristics = await connection.getCharacteristics(HEART_RATE.service);
      const measurement = characteristics.find((characteristic) =>
        sameUuid(characteristic.uuid, HEART_RATE.measurement),
      );
      if (!measurement?.canNotify) {
        throw new NotAStrapError();
      }
      const battery = await this.readBattery(connection);
      if (epoch !== this.epoch) return;

      const subscription = await connection.subscribe(
        HEART_RATE.service,
        HEART_RATE.measurement,
        (bytes) => this.handleMeasurement(bytes, epoch),
      );
      if (epoch !== this.epoch) {
        subscription.remove();
        return;
      }
      this.subscriptions.push(subscription);

      // O nome da busca pode faltar (anúncio sem nome); o da conexão completa o registro.
      const saved = this.snapshot.saved;
      const named =
        saved && sameId(saved.id, id) && !saved.name && connection.name
          ? { ...saved, name: connection.name }
          : saved;
      if (named !== saved && named) {
        this.persist(named);
      }
      this.update({ phase: 'connected', battery, saved: named, error: null });
      // Daqui em diante é tudo em segundo plano: os batimentos já estão chegando.
      void this.afterConnect(connection, epoch);
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.drop();
      const unfit = error instanceof NotAStrapError;
      const failed = unfit
        ? 'Este aparelho não mostrou os batimentos pelo perfil padrão de frequência cardíaca (Heart Rate Service).'
        : 'Não foi possível conectar à cinta. Confira se ela está no peito e por perto.';
      if (this.holds === 0) {
        this.update({ phase: 'idle', error: failed });
        return;
      }
      // A cinta pode ter saído do alcance entre o anúncio e a conexão: volta a procurar.
      this.update({ phase: 'searching', error: failed });
      const retry = this.epoch;
      this.searchTimer = setTimeout(
        () => {
          this.searchTimer = null;
          if (retry === this.epoch) {
            void this.search();
          }
        },
        unfit ? this.unfitRetryMs : this.retryMs,
      );
    }
  }

  /** Bateria em %, ou `null` se a cinta não informa (ou demora a responder). */
  private async readBattery(connection: BleConnection): Promise<number | null> {
    try {
      const characteristics = await connection.getCharacteristics(BATTERY.service);
      const level = characteristics.find((characteristic) =>
        sameUuid(characteristic.uuid, BATTERY.level),
      );
      if (!level?.canRead) {
        return null;
      }
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sem resposta')), BATTERY_TIMEOUT_MS);
        connection.read(BATTERY.service, BATTERY.level).then(
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
      return bytes.length > 0 && bytes[0] <= 100 ? bytes[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Depois de os batimentos chegarem: assina a bateria e, na X2 Pro, anexa o
   * protocolo da XOSS. Nada aqui pode derrubar a conexão.
   */
  private async afterConnect(connection: BleConnection, epoch: number): Promise<void> {
    await this.watchBattery(connection, epoch);
    if (epoch !== this.epoch) return;
    const xoss = await XossClient.attach(connection, { now: this.now }).catch(() => null);
    if (epoch !== this.epoch) {
      xoss?.close();
      return;
    }
    if (!xoss) {
      return;
    }
    this.xoss = xoss;
    this.known = freshKnown();
    this.pollMisses = 0;
    this.retries = 0;
    xoss.onDead(() => this.handleXossDead(xoss));
    const saved = this.snapshot.saved;
    if (saved && !saved.xoss) {
      const marked = { ...saved, xoss: true };
      this.persist(marked);
      this.update({ saved: marked });
    }
    this.update({
      xoss: {
        model: xoss.model,
        cadence: null,
        stepsOn: null,
        space: null,
        recording: null,
        ownRecording: false,
        alertBpm: undefined,
        transferring: false,
        lastDownload: null,
        profileSynced: null,
      },
    });
    void this.reconcile();
  }

  /** Assina as notificações do nível de bateria, se a cinta manda. Sem elas, vale a leitura da conexão. */
  private async watchBattery(connection: BleConnection, epoch: number): Promise<void> {
    let abandoned = false;
    try {
      const characteristics = await connection.getCharacteristics(BATTERY.service);
      const level = characteristics.find((characteristic) =>
        sameUuid(characteristic.uuid, BATTERY.level),
      );
      if (!level?.canNotify || epoch !== this.epoch) {
        return;
      }
      const pending = connection.subscribe(BATTERY.service, BATTERY.level, (bytes) =>
        this.handleBattery(bytes, epoch),
      );
      // Uma assinatura que voltar depois do prazo, ou de outra conexão, é desfeita.
      pending.then((subscription) => {
        if (abandoned || epoch !== this.epoch) subscription.remove();
      }, noop);
      const subscription = await new Promise<BleSubscription>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sem resposta')), BATTERY_SUBSCRIBE_TIMEOUT_MS);
        pending.then(
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
      if (epoch === this.epoch) {
        this.subscriptions.push(subscription);
      }
    } catch {
      abandoned = true;
    }
  }

  private handleBattery(bytes: Uint8Array, epoch: number): void {
    if (epoch === this.epoch && bytes.length > 0 && bytes[0] <= 100 && bytes[0] !== this.snapshot.battery) {
      this.update({ battery: bytes[0] });
    }
  }

  /** Solta o protocolo da XOSS desta conexão (a conexão em si fica com quem chamou). */
  private detachXoss(): void {
    const xoss = this.xoss;
    this.xoss = null;
    this.idleAbort?.abort();
    this.idleAbort = null;
    this.stopPolling();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    xoss?.close();
    if (this.snapshot.xoss) {
      this.update({ xoss: null });
    }
  }

  /**
   * A fila nativa travou numa escrita do protocolo. Ele se desliga de vez nesta
   * conexão, e os batimentos seguem (as notificações não passam pela fila). Só
   * sem treino ativo a cinta é desconectada para soltar a fila.
   */
  private handleXossDead(xoss: XossClient): void {
    if (this.xoss !== xoss) {
      return;
    }
    this.detachXoss();
    if (this.wishes.workout || this.now() - this.lastStallRelease < STALL_RELEASE_GAP_MS) {
      return;
    }
    this.lastStallRelease = this.now();
    this.handleLinkLost(this.epoch);
  }

  // --- Reconciliação com a cinta (XOSS X2 Pro) --------------------------------

  private patchXoss(patch: Partial<XossStatus>): void {
    const current = this.snapshot.xoss;
    if (current && this.xoss) {
      this.update({ xoss: { ...current, ...patch } });
    }
  }

  private wantsSteps(): boolean {
    return !!this.wishes.workout || this.cadenceWatchers > 0;
  }

  /**
   * Leva a cinta ao estado pedido. Roda uma de cada vez; um pedido novo no meio
   * faz outra volta no fim. Cada passo vai por conta própria; se algum falhou
   * (prazo, leitura de volta que não bate), uma nova volta vem com espera
   * crescente (10 s, 30 s, 60 s e depois a cada 60 s), e nela só o que falhou
   * refaz alguma coisa. Os batimentos não dependem disto.
   */
  private async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.dirty = true;
      return;
    }
    this.reconciling = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      do {
        this.dirty = false;
        const xoss = this.xoss;
        if (!xoss || xoss.closed) break;
        let ok = false;
        try {
          ok = this.wishes.workout
            ? await this.applyWorkout(xoss, this.wishes.workout)
            : await this.applyIdle(xoss);
        } catch {
          // Os passos já se protegem um a um; isto só garante que nada escape da volta.
        }
        if (ok) {
          this.retries = 0;
        } else if (this.xoss === xoss && !xoss.closed && !this.dirty) {
          const wait = RECONCILE_RETRY_MS[Math.min(this.retries, RECONCILE_RETRY_MS.length - 1)];
          this.retries += 1;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.reconcile();
          }, wait);
        }
      } while (this.dirty && this.xoss);
    } finally {
      this.reconciling = false;
    }
  }

  /** Grava as marcas de dono junto da cinta salva (sobrevivem ao app morto). */
  private setMarks(patch: Pick<SavedStrap, 'recording' | 'alert' | 'steps'>): void {
    const saved = this.snapshot.saved;
    if (!saved) return;
    const next = { ...saved, ...patch };
    this.persist(next);
    this.update({ saved: next });
  }

  /**
   * A marca da gravação, se ainda vale: sem limite com o treino dono ativo;
   * sem ele, por 24 h a partir do início. Vencida, é descartada sem encerrar
   * nada, e o treino dono é avisado do horário antes, para o FIT ainda poder
   * casar.
   *
   * Risco que sobra, conhecido: se alguém encerrar a gravação do app e outro
   * app começar uma nova dentro dessas 24 h, o app encerra a do outro. A lista
   * de arquivos não serve para separar os dois casos: não se mediu se a cinta
   * lista a gravação em curso, e se listar, conferir por ela deixaria a
   * gravação do próprio app rodando sem dono em todo fim de treino.
   */
  private recordingMark(): NonNullable<SavedStrap['recording']> | null {
    const mark = this.snapshot.saved?.recording ?? null;
    if (!mark) return null;
    if (this.ownerActive(mark) || this.now() - mark.startedAt <= RECORDING_MARK_MAX_MS) return mark;
    this.notifyRecorded(mark);
    this.setMarks({ recording: null });
    return null;
  }

  /** O treino dono da marca está em curso no app. */
  private ownerActive(mark: NonNullable<SavedStrap['recording']>): boolean {
    return this.wishes.workout?.id === mark.workoutId;
  }

  private notifyRecorded(mark: NonNullable<SavedStrap['recording']>): void {
    const event = { workoutId: mark.workoutId, recordedAt: mark.startedAt };
    this.recordedListeners.forEach((listener) => listener(event));
  }

  /**
   * Passos com treino (ou com a tela da cinta aberta): lê antes e, se a
   * contagem estava desligada, marca e liga; se já estava ligada, não é do app e
   * fica como está no fim. Sem pedido: desliga só o que o app ligou.
   */
  private async applySteps(xoss: XossClient): Promise<void> {
    if (this.wantsSteps()) {
      if (this.known.stepsOn !== true) {
        if (!this.snapshot.saved?.steps) {
          const state = await xoss.readSteps();
          if (!state.on) {
            // A marca vai antes do pedido: uma resposta perdida não deixa os passos sem dono.
            this.setMarks({ steps: { since: this.now() } });
            await xoss.setSteps(true);
          }
        } else {
          await xoss.setSteps(true);
        }
        this.known.stepsOn = true;
        this.patchXoss({ stepsOn: true });
      }
      this.startPolling();
      return;
    }
    this.stopPolling();
    if (this.snapshot.xoss?.cadence) {
      this.patchXoss({ cadence: null });
    }
    if (this.snapshot.saved?.steps) {
      await xoss.setSteps(false);
      this.known.stepsOn = false;
      this.setMarks({ steps: null });
      this.patchXoss({ stepsOn: false });
    }
  }

  /**
   * Com treino: relógio, passos, gravação (no guiado) e alerta, nesta ordem e
   * cada um por conta própria: o alerta que a cinta recusa, por exemplo, não
   * impede os passos nem a gravação. A única dependência é a da gravação no
   * relógio: o FIT sai com o nome no relógio da cinta, e com ele mais de 5 s
   * errado o arquivo nunca casaria com o treino. Sem o relógio acertado nesta
   * conexão, a gravação espera a nova tentativa dele. Devolve `false` se algum
   * passo falhou (ou ficou esperando).
   */
  private async applyWorkout(xoss: XossClient, workout: NonNullable<StrapWishes['workout']>): Promise<boolean> {
    const clock = await this.attempt(async () => {
      if (this.known.clockFor !== workout.id) {
        await xoss.setClock(Math.floor(this.now() / 1000));
        this.known.clockFor = workout.id;
      }
    });
    let ok = clock;
    ok = (await this.attempt(() => this.applySteps(xoss))) && ok;
    if (workout.guided && clock) {
      ok = (await this.attempt(() => this.ensureRecording(xoss, workout))) && ok;
    }
    ok = (await this.attempt(() => this.applyAlert(xoss, workout))) && ok;
    return ok;
  }

  /** A marca do alerta, aceitando o formato antigo (`bpm` no lugar de `owned`). */
  private alertMark(): NonNullable<SavedStrap['alert']> | null {
    const mark = this.snapshot.saved?.alert as
      | (NonNullable<SavedStrap['alert']> & { bpm?: number })
      | null
      | undefined;
    if (!mark) return null;
    return { workoutId: mark.workoutId, previous: mark.previous, owned: mark.owned ?? (mark.bpm ? [mark.bpm] : []) };
  }

  /**
   * O alerta do treino guiado. Na primeira vez guarda na marca o que a cinta
   * tinha (0 ou o que a pessoa configurou); a cada valor programado, soma o
   * valor à lista dos do app, antes do pedido (uma resposta perdida não deixa
   * o valor sem dono). Programa e confere por leitura; uma leitura que não bate
   * é falha como as outras, e a reconciliação tenta de novo. O treino livre não
   * mexe no alerta.
   */
  private async applyAlert(xoss: XossClient, workout: NonNullable<StrapWishes['workout']>) {
    const bpm = workout.alertBpm;
    if (!workout.guided || bpm === null) {
      return;
    }
    const mark = this.alertMark();
    if (this.known.alertBpm === bpm && mark?.workoutId === workout.id && mark.owned.includes(bpm)) {
      return;
    }
    let previous: number | null;
    if (mark) {
      previous = mark.previous;
    } else {
      previous = await xoss.alert();
      this.known.alertBpm = previous;
      this.patchXoss({ alertBpm: previous });
    }
    const owned = mark?.owned.includes(bpm) ? mark.owned : [...(mark?.owned ?? []), bpm];
    this.setMarks({ alert: { workoutId: workout.id, previous, owned } });
    const ok = await xoss.setAlert(bpm);
    this.known.alertBpm = ok ? bpm : undefined;
    this.patchXoss({ alertBpm: ok ? bpm : undefined });
    if (!ok) {
      throw new Error('O alerta lido de volta não é o programado.');
    }
  }

  /**
   * Sem treino, o alerta volta ao que a pessoa tinha, se a cinta mostra algum
   * dos valores que o app programou (se a pessoa mudou no meio, fica o dela).
   * Sem marca, não toca. Uma volta que não confere tenta de novo depois.
   */
  private async restoreAlert(xoss: XossClient): Promise<void> {
    const mark = this.alertMark();
    if (!mark) {
      if (this.known.alertBpm === undefined) {
        // Só para o diagnóstico: ler não muda nada.
        const current = await xoss.alert();
        this.known.alertBpm = current;
        this.patchXoss({ alertBpm: current });
      }
      return;
    }
    const current = await xoss.alert();
    if (current !== null && mark.owned.includes(current)) {
      if (!(await xoss.setAlert(mark.previous))) {
        // A marca fica; a falha agenda nova volta, como as outras.
        this.known.alertBpm = undefined;
        throw new Error('O alerta lido de volta não é o anterior.');
      }
      this.known.alertBpm = mark.previous;
    } else {
      this.known.alertBpm = current;
    }
    this.setMarks({ alert: null });
    this.patchXoss({ alertBpm: this.known.alertBpm });
  }

  /**
   * No treino guiado, grava o treino na memória da cinta: uma tentativa por
   * conexão e treino. Só começa com 60 kB livres, com a cinta no modo manual e
   * sem outra gravação em curso. Uma gravação achada em curso sem a marca do
   * app (ou com a marca vencida) não é tocada; a órfã de um treino anterior do
   * app é encerrada (vira o arquivo daquele treino) e a deste começa.
   */
  private async ensureRecording(xoss: XossClient, workout: NonNullable<StrapWishes['workout']>) {
    if (this.known.recordingFor === workout.id) {
      return;
    }
    await this.startRecording(xoss, workout);
    // Só um resultado definitivo encerra as tentativas desta conexão: um prazo
    // estourado no meio lança antes daqui, e a próxima volta tenta de novo.
    this.known.recordingFor = workout.id;
  }

  private async startRecording(xoss: XossClient, workout: NonNullable<StrapWishes['workout']>) {
    const own = this.recordingMark();
    const recording = await xoss.recording();
    if (recording === null) return;
    if (recording && own?.workoutId === workout.id) {
      // A gravação deste treino segue de antes da queda do link (ou do app
      // morto, ou de uma resposta perdida). O treino é avisado de novo: se a
      // resposta do `75 01` se perdeu, é aqui que ele fica sabendo do horário.
      this.patchXoss({ recording: true, ownRecording: true });
      this.notifyRecorded(own);
      return;
    }
    if (recording && !own) {
      this.patchXoss({ recording: true, ownRecording: false });
      return;
    }
    if (recording && own) {
      // A gravação órfã de um treino anterior do app: vira o arquivo daquele treino.
      await xoss.stopRecording();
      this.notifyRecorded(own);
      this.setMarks({ recording: null });
      await sleep(RECORDING_GAP_MS);
    } else if (own) {
      // A marca ficou de uma gravação que já acabou.
      this.notifyRecorded(own);
      this.setMarks({ recording: null });
    }
    const space = await xoss.space();
    this.known.spaceRead = true;
    this.patchXoss({ space, recording: false, ownRecording: false });
    if (!space || space.freeKb < MIN_FREE_KB) return;
    if ((await xoss.recordMode()) !== 'manual') return;
    // A marca vai antes do pedido: se a resposta do `75 01` se perder com a
    // gravação já começada, ela ainda é do app, e o fim do treino a encerra.
    // Se não começou, a conferência abaixo (ou a próxima volta sem treino) tira a marca.
    const mark = { workoutId: workout.id, startedAt: this.now() };
    this.setMarks({ recording: mark });
    await xoss.startRecording();
    if ((await xoss.recording()) !== true) {
      this.setMarks({ recording: null });
      return;
    }
    this.patchXoss({ recording: true, ownRecording: true });
    this.notifyRecorded(mark);
  }

  /**
   * Sem treino: desfaz o que o app ligou, nesta ordem e cada passo por conta
   * própria (a gravação do app é encerrada, o alerta volta ao que era, os
   * passos que ele ligou são desligados); depois as tarefas ociosas, também
   * nesta ordem: baixar os FIT pendentes e só então acertar o perfil (depois de
   * gravar um perfil novo a cinta já devolveu a lista de treinos vazia por
   * algumas conexões). A falha de um passo não impede os outros nem as tarefas
   * ociosas; devolve `false` se algum falhou, e só ele refaz algo na volta
   * seguinte (os outros já estão no estado pedido).
   */
  private async applyIdle(xoss: XossClient): Promise<boolean> {
    let ok = await this.attempt(() => this.endRecording(xoss));
    ok = (await this.attempt(() => this.restoreAlert(xoss))) && ok;
    ok = (await this.attempt(() => this.applySteps(xoss))) && ok;
    if (!this.known.spaceRead) {
      ok =
        (await this.attempt(async () => {
          const space = await xoss.space();
          this.known.spaceRead = true;
          this.patchXoss({ space });
        })) && ok;
    }
    ok = (await this.attempt(() => this.idleTasks(xoss))) && ok;
    return ok;
  }

  /**
   * Encerra a gravação do app, se ela está em curso e a marca vale (sem treino
   * ativo, por 24 h a partir do início). O treino dono é avisado do horário
   * antes de a marca sumir: se o aviso do começo se perdeu (o treino acabou
   * antes, o app morreu), é aqui que ele fica sabendo.
   */
  private async endRecording(xoss: XossClient): Promise<void> {
    const own = this.recordingMark();
    if (!own && this.known.recordingChecked) {
      return;
    }
    let recording = await xoss.recording();
    if (recording && own) {
      await xoss.stopRecording();
      // A cinta grava o arquivo: a lista de treinos lida logo em seguida ainda pode não tê-lo.
      await sleep(RECORDING_GAP_MS);
      recording = await xoss.recording();
    }
    if (own && recording === false) {
      this.notifyRecorded(own);
      this.setMarks({ recording: null });
    }
    this.known.recordingChecked = true;
    // Uma gravação que segue em curso aqui não é do app (a dele foi encerrada acima).
    this.patchXoss({ recording, ownRecording: false });
  }

  /** Um passo da reconciliação: `false` se falhou (a falha não passa para os outros passos). */
  private async attempt(step: () => Promise<void>): Promise<boolean> {
    try {
      await step();
      return true;
    } catch {
      return false;
    }
  }

  private async idleTasks(xoss: XossClient): Promise<void> {
    if (this.wishes.workout || this.idleAbort) {
      return;
    }
    const abort = new AbortController();
    this.idleAbort = abort;
    try {
      await this.backfill(xoss, abort.signal);
      if (abort.signal.aborted || this.wishes.workout || this.xoss !== xoss) return;
      const wanted = this.wishes.profile;
      // Com a lona andando, um treino pode começar a qualquer instante: o perfil
      // espera ela parar (`setBeltMoving(false)` faz outra volta).
      if (wanted && !this.known.profileTried && !this.beltMoving) {
        this.known.profileTried = true;
        this.patchXoss({ transferring: true });
        try {
          await this.syncProfile(xoss, wanted, abort.signal);
        } finally {
          this.patchXoss({ transferring: false });
        }
      }
    } finally {
      if (this.idleAbort === abort) this.idleAbort = null;
      if (this.restPending) {
        this.clearPendingRest();
        this.rest();
      }
    }
  }

  /** Um download, medido (arquivo, bytes e tempo vão para o diagnóstico da tela da cinta). */
  private async download(xoss: XossClient, name: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const started = this.now();
    const bytes = await xoss.fetch(name, signal);
    this.patchXoss({
      lastDownload: { file: name, bytes: bytes?.length ?? 0, ms: this.now() - started, ok: bytes !== null },
    });
    return bytes;
  }

  /**
   * Baixa da cinta o FIT dos treinos com lacunas. O arquivo casa pelo nome (o
   * início da gravação, em UTC) a até 5 s do horário guardado no treino. Lista
   * vazia é "nada por ora": a cinta às vezes devolve a lista vazia com o
   * arquivo na memória, e a próxima conexão tenta de novo. Um arquivo que falha
   * (ou é interrompido) duas vezes sai da fila nesta conexão, para o perfil não
   * ficar preso atrás dele. Nenhum arquivo é apagado da cinta.
   */
  private async backfill(xoss: XossClient, signal: AbortSignal): Promise<void> {
    const jobs = (this.wishes.backfill ?? []).filter((job) => !this.known.backfillDone.has(job.workoutId));
    if (jobs.length === 0) {
      return;
    }
    const failures = this.known.downloadFailures;
    const giveUp = (name: string) => (failures.get(name) ?? 0) >= MAX_DOWNLOAD_ATTEMPTS;
    const failed = (name: string) => failures.set(name, (failures.get(name) ?? 0) + 1);
    this.patchXoss({ transferring: true });
    try {
      let listing: Uint8Array | null = null;
      while (!giveUp('filelist.txt')) {
        listing = await this.download(xoss, 'filelist.txt', signal);
        if (listing) break;
        failed('filelist.txt');
        if (signal.aborted || this.xoss !== xoss) return;
      }
      const files = listing ? parseFileList(listing) : [];
      if (files.length === 0) {
        // Sem lista (ou lista vazia): nada por ora nesta conexão.
        jobs.forEach((job) => this.known.backfillDone.add(job.workoutId));
        return;
      }
      for (const job of jobs) {
        const file = files.find((found) => Math.abs(found.at - job.recordedAt) <= BACKFILL_MATCH_MS);
        while (file && !giveUp(file.name)) {
          const bytes = await this.download(xoss, file.name, signal);
          if (!bytes) {
            failed(file.name);
            if (signal.aborted || this.xoss !== xoss) return;
            continue;
          }
          let records: FitRecord[] | null = null;
          try {
            records = decodeFit(bytes).records;
          } catch {
            // Arquivo que não é FIT: não adianta baixar de novo.
          }
          if (records) {
            const event: BackfillJob = { workoutId: job.workoutId, file: file.name, records };
            this.backfillListeners.forEach((listener) => listener(event));
          }
          break;
        }
        this.known.backfillDone.add(job.workoutId);
      }
    } finally {
      this.patchXoss({ transferring: false });
    }
  }

  /**
   * Acerta o perfil da cinta pelo do app: baixa, compara peso, altura, idade e
   * FC máxima e, se algum difere, corrige o texto, envia, relê e confere pelos
   * valores (a cinta reescreve o arquivo: a leitura de volta não é idêntica byte
   * a byte). Nunca envia sem ter lido, nem com chave faltando. Gênero, LTHR e
   * fuso ficam como estão. O envio, depois de aceito pela cinta, vai até o fim
   * mesmo que um treino comece (ver `XossClient.send`).
   */
  private async syncProfile(xoss: XossClient, wanted: StrapProfile, signal: AbortSignal) {
    const before = await this.download(xoss, 'user_profile.json', signal);
    if (!before || signal.aborted) return;
    const text = utf8Decode(before);
    const current = readStrapProfile(text, this.now());
    if (!current) return;
    if (sameStrapProfile(current, wanted)) {
      this.patchXoss({ profileSynced: true });
      return;
    }
    const patched = patchStrapProfile(text, wanted, this.now());
    if (!patched || signal.aborted) return;
    if (!(await xoss.send('user_profile.json', utf8Encode(patched), signal))) return;
    await sleep(PROFILE_REREAD_MS);
    if (signal.aborted) return;
    const after = await this.download(xoss, 'user_profile.json', signal);
    const check = after ? readStrapProfile(utf8Decode(after), this.now()) : null;
    this.patchXoss({ profileSynced: !!check && sameStrapProfile(check, wanted) });
  }

  // --- Consulta de passos -------------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer || this.polling) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, 0);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Uma consulta de passos. A 1 Hz; com três prazos estourados seguidos, recua
   * para 5 s e a cadência vira `null`. Com o canal ocupado (uma transferência,
   * um comando) desiste na hora, sem entrar na fila. Os temporizadores param
   * com o app em segundo plano: ao voltar, a consulta retoma sozinha.
   */
  private async poll(): Promise<void> {
    const xoss = this.xoss;
    if (!xoss || !this.wantsSteps()) {
      return;
    }
    this.polling = true;
    const started = this.now();
    let next = this.pollMisses >= STEPS_MISSES ? STEPS_SLOW_MS : STEPS_POLL_MS;
    try {
      const steps = await xoss.steps();
      if (this.xoss !== xoss) return;
      this.pollMisses = 0;
      next = STEPS_POLL_MS;
      this.patchXoss({ cadence: { spm: steps.spm, steps: steps.steps, at: steps.at }, stepsOn: steps.on });
    } catch (error) {
      if (this.xoss !== xoss || error instanceof XossClosedError) return;
      // Ocupado não conta. Prazo estourado ou escrita recusada (no Android uma
      // escrita que falha derruba todas as pendentes) contam como falta, e a
      // consulta segue: nada além da reconexão a religaria.
      if (!(error instanceof XossBusyError)) {
        this.pollMisses += 1;
        if (this.pollMisses >= STEPS_MISSES) {
          next = STEPS_SLOW_MS;
          this.patchXoss({ cadence: null });
        }
      }
    } finally {
      this.polling = false;
    }
    if (this.xoss === xoss && this.wantsSteps() && !this.pollTimer) {
      const wait = Math.max(0, next - (this.now() - started));
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        void this.poll();
      }, wait);
    }
  }

  /** O link caiu sem que o app tenha pedido: volta a procurar, se ainda precisa da cinta. */
  private handleLinkLost(epoch: number): void {
    if (epoch !== this.epoch) {
      return;
    }
    this.drop();
    this.update({ phase: 'idle', bpm: null, bpmAt: null, battery: null });
    this.pursue();
  }

  private handleMeasurement(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.epoch) {
      return;
    }
    let measurement;
    try {
      measurement = parseHeartRateMeasurement(bytes);
    } catch {
      return;
    }
    const at = this.now();
    // 0 e "sem contato" são a cinta dizendo que não tem leitura: sem isso o
    // app seguraria o último valor em vez de voltar ao sensor da esteira.
    const valid = measurement.bpm > 0 && measurement.contact !== false;
    if (valid && measurement.rrMs.length > 0) {
      // Numerados: a sessão da esteira guarda o último que consumiu, e nenhum se
      // perde quando duas notificações caem entre dois pacotes dela.
      const added = measurement.rrMs.map((rrMs) => ({ seq: ++this.beatSeq, rrMs }));
      this.beats = [...this.beats, ...added].slice(-BEAT_RING);
    }
    if (valid) {
      this.update({ bpm: measurement.bpm, bpmAt: at });
    } else if (this.snapshot.bpm !== null) {
      this.update({ bpm: null, bpmAt: null });
    }
    const beat: StrapBeatEvent = { at, bpm: valid ? measurement.bpm : null, rrMs: measurement.rrMs };
    this.beatListeners.forEach((listener) => listener(beat));
  }

  // --- Pareamento -------------------------------------------------------------

  private async startPairing(): Promise<void> {
    if (this.snapshot.pairing) {
      return;
    }
    const epoch = ++this.pairingEpoch;
    this.seen.clear();
    this.update({ pairing: true, candidates: [], error: null });
    try {
      await this.ble.prepare();
    } catch (error) {
      if (epoch === this.pairingEpoch) {
        this.update({ pairing: false, error: errorMessage(error) });
      }
      return;
    }
    if (epoch !== this.pairingEpoch) {
      return;
    }
    this.pairingScan = this.ble.scan(
      (device) => {
        if (epoch === this.pairingEpoch) this.handlePairingResult(device);
      },
      () => {
        if (epoch !== this.pairingEpoch) return;
        this.stopPairing();
        this.update({ error: 'A busca por cintas falhou. Tente procurar de novo.' });
      },
    );
    this.pairingTimer = setTimeout(() => this.stopPairing(), this.pairingTimeoutMs);
  }

  private stopPairing(): void {
    this.pairingEpoch += 1;
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = null;
    }
    if (this.pairingScan) {
      this.pairingScan.remove();
      this.pairingScan = null;
    }
    if (this.snapshot.pairing) {
      this.update({ pairing: false });
    }
  }

  private handlePairingResult(found: ScannedDevice): void {
    const known = this.seen.get(found.id);
    const merged: ScannedDevice = {
      ...found,
      name: found.name ?? known?.name ?? null,
      rssi: found.rssi ?? known?.rssi ?? null,
      advertisesHeartRate: !!found.advertisesHeartRate || !!known?.advertisesHeartRate,
    };
    this.seen.set(found.id, merged);
    if (!merged.advertisesHeartRate) {
      return;
    }
    // O RSSI oscila a cada anúncio: a lista só muda quando entra um monitor ou chega o nome.
    const listed = this.snapshot.candidates.find((candidate) => candidate.id === found.id);
    if (listed && listed.name === merged.name) {
      return;
    }
    this.update({
      candidates: listed
        ? this.snapshot.candidates.map((candidate) => (candidate.id === found.id ? merged : candidate))
        : [...this.snapshot.candidates, merged],
    });
  }

  private choose(deviceId: string): void {
    const candidate = this.snapshot.candidates.find((found) => found.id === deviceId);
    if (!candidate) {
      return;
    }
    this.stopPairing();
    const previous = this.snapshot.saved;
    // A mesma cinta pareada de novo: as marcas ficam até o `release` confirmar cada passo.
    const same = !!previous && sameId(previous.id, candidate.id);
    this.releaseOwned(same);
    this.drop();
    const saved: SavedStrap = same
      ? { ...previous, id: candidate.id, name: candidate.name ?? previous.name }
      : { id: candidate.id, name: candidate.name };
    this.persist(saved);
    this.update({ saved, bpm: null, bpmAt: null, battery: null, error: null });
    if (this.quiet) {
      // A esteira está conectando e tem a vez: a cinta espera, como na busca,
      // e `setQuiet(false)` retoma a busca por ela.
      this.update({ phase: 'searching' });
      return;
    }
    // Acabou de ser vista na busca: conecta direto, sem outra janela. Com a mesma
    // cinta, `connectTo` espera antes a conexão velha cair (`releasing`).
    void this.connectTo(saved.id);
  }

  private forget(): void {
    this.releaseOwned();
    this.drop();
    this.persist(null);
    this.update({ saved: null, phase: 'idle', bpm: null, bpmAt: null, battery: null, error: null });
  }

  /**
   * Antes de soltar a cinta (esquecer, trocar ou parear de novo), desfaz tudo o
   * que o app ligou nela: encerra a gravação dele, devolve o alerta ao que era
   * e desliga os passos que ele ligou. Sem isso ficariam ligados para sempre, e
   * ninguém mais os desligaria (sem a marca, "não são do app"). Em segundo plano: o canal e a conexão saem da
   * sessão antes do `drop`, que os fecharia na hora; o `release` recusa o que
   * a reconciliação ainda tinha na fila, e a conexão só cai no fim. Com
   * `keepMarks` (a mesma cinta pareada de novo), as marcas só somem quando o
   * passo delas foi confirmado.
   */
  private releaseOwned(keepMarks = false): Promise<void> {
    const xoss = this.xoss;
    const connection = this.connection;
    const saved = this.snapshot.saved;
    if (!xoss || !connection || !saved) {
      return Promise.resolve();
    }
    const recording = saved.recording ? this.recordingMark() : null;
    const alert = this.alertMark();
    const steps = saved.steps ?? null;
    if (!recording && !alert && !steps) {
      return Promise.resolve();
    }
    if (recording) this.notifyRecorded(recording);
    this.xoss = null;
    this.connection = null;
    const strapId = saved.id;
    const releasing = xoss
      .release({
        recording: !!recording,
        alert: alert ? { owned: alert.owned, restore: alert.previous } : null,
        stepsOff: !!steps,
      })
      .then((done) => {
        const current = this.snapshot.saved;
        if (keepMarks && current && sameId(current.id, strapId)) {
          this.setMarks({
            recording: done.recording ? null : (current.recording ?? null),
            alert: done.alert ? null : (current.alert ?? null),
            steps: done.steps ? null : (current.steps ?? null),
          });
        }
        return connection.disconnect();
      })
      .catch(noop)
      .finally(() => {
        if (this.releasing === releasing) this.releasing = null;
      });
    this.releasing = releasing;
    return releasing;
  }

  private persist(strap: SavedStrap | null): void {
    try {
      this.storage.write(strap);
    } catch {
      // A cinta vale até o app fechar; na próxima abertura será preciso parear de novo.
    }
  }
}
