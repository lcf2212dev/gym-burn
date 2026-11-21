import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  ScannedDevice,
} from '@/ble/transport';
import { sameUuid } from '@/ftms';

import { BATTERY, HEART_RATE, parseHeartRateMeasurement } from './heart-rate';

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

export type StrapPhase =
  | 'idle' // sem cinta pareada, ou ninguém precisa dela agora
  | 'searching' // procurando a cinta pareada por perto
  | 'connecting'
  | 'connected'; // batimentos chegando

/** Uma leitura da cinta e o `Date.now()` em que ela chegou. */
export interface StrapReading {
  bpm: number;
  at: number;
}

export interface SavedStrap {
  id: string;
  name: string | null;
}

export interface StrapSnapshot {
  /** A cinta pareada; `null` se nenhuma foi escolhida. */
  saved: SavedStrap | null;
  phase: StrapPhase;
  /** Última leitura válida da cinta; `null` sem leitura ou sem contato com a pele. */
  bpm: number | null;
  /** `Date.now()` da leitura em `bpm`. */
  bpmAt: number | null;
  /** Bateria da cinta, em %, lida ao conectar. */
  battery: number | null;
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
 * Como a sessão da esteira, só lê: nunca escreve uma característica.
 */
export class HeartStrapSession implements StrapStore {
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
    return Math.abs(now - bpmAt) <= STRAP_FRESH_MS ? { bpm, at: bpmAt } : null;
  };

  hold = (): (() => void) => {
    this.holds += 1;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
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

  /** Ninguém precisa mais da cinta: para a busca e solta a conexão. */
  private rest(): void {
    if (this.holds > 0 || this.snapshot.phase === 'idle') {
      return;
    }
    this.drop();
    this.update({ phase: 'idle', bpm: null, bpmAt: null, battery: null });
  }

  /** Abandona a tentativa ou a conexão em curso, sem mexer no estado visível. */
  private drop(): void {
    this.epoch += 1;
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
    // 0 e "sem contato" são a cinta dizendo que não tem leitura: sem isso o
    // app seguraria o último valor em vez de voltar ao sensor da esteira.
    if (measurement.bpm > 0 && measurement.contact !== false) {
      this.update({ bpm: measurement.bpm, bpmAt: this.now() });
    } else if (this.snapshot.bpm !== null) {
      this.update({ bpm: null, bpmAt: null });
    }
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
    this.drop();
    const saved = { id: candidate.id, name: candidate.name };
    this.persist(saved);
    this.update({ saved, bpm: null, bpmAt: null, battery: null, error: null });
    // Acabou de ser vista na busca: conecta direto, sem outra janela.
    void this.connectTo(saved.id);
  }

  private forget(): void {
    this.drop();
    this.persist(null);
    this.update({ saved: null, phase: 'idle', bpm: null, bpmAt: null, battery: null, error: null });
  }

  private persist(strap: SavedStrap | null): void {
    try {
      this.storage.write(strap);
    } catch {
      // A cinta vale até o app fechar; na próxima abertura será preciso parear de novo.
    }
  }
}
