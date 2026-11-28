import type { BackfillJob, StrapBeatEvent, StrapLink, StrapWishes } from '@/heart/strap-session';
import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { ConsoleEvent, TreadmillSample } from '@/treadmill/types';
import { formatDecimal, formatDuration } from '@/utils/format';
import {
  adoptedLoad,
  changeLabel,
  correctedStage,
  EASY_FLOOR_KMH,
  correction,
  correctionBpm,
  livePulse,
  MAX_REDUCE_BPM,
  pulseFeatures,
  pulseWindow,
  raiseRoom,
  runFloor,
  RELIEF_SETTLE_SECONDS,
  SHORT_BLOCK_SECONDS,
  STEADY_SECONDS,
  STRAP_WINDOW_MS,
  URGENT_EXCESS_BPM,
  type Correction,
  type Features,
  type Live,
  type Load,
} from './adaptive';
import { assess, reviewLoad } from './ai';
import {
  cadenceChange,
  FATIGUE_TIP,
  smoothCadence,
  stepGait,
  strideM,
  trackBelt,
  trackCadence,
  type Belt,
  type CadenceTrend,
} from './gait';
import { advanceGuidance, type Cue, type Guidance } from './guidance';
import {
  betweenBlocks,
  blockEnd,
  NEXT_BLOCK_AT_SECONDS,
  nextBlockLoad,
  paceRecovery,
  type BlockEnd,
  type NextBlock,
  type Pace,
} from './intervals';
import {
  accumulate,
  currentCue,
  emptyLog,
  insufficient,
  levels,
  logBeats,
  logLoads,
  logStage,
  median,
  metabolicCost,
  newWorkout,
  RUN_FROM_KMH,
  REST_WINDOW_SECONDS,
  validBpm,
  type Change,
  type Plan,
  type Profile,
  type Stage,
  type Workout,
  type Zone,
} from './model';
import {
  AIM_SPAN_BPM,
  bpmPerMet,
  dailyTarget,
  energyKcal,
  foxMax,
  heartProfile,
  restingBpm,
  type Pulse,
} from './physiology';
import type { ReviewDecision, ReviewReply } from './prompts';
import {
  addStillBeat,
  dayKey,
  efforts,
  readinessLock,
  STILL_GAP_MS,
  stillHistory,
  stillHrv,
  stillRest,
  stillSeconds,
  stillWait,
  type HrvCheck,
  type ReadinessRecord,
  type StillBeat,
} from './rest';
import {
  clearData,
  clearSource,
  deleteWorkout,
  pruneTracks,
  readProfile,
  readReadiness,
  readWorkouts,
  saveProfile,
  saveReadiness,
  saveWorkout,
} from './storage';
import { fillTrackFromFit, readTrack, TRACK_FLAGS, TrackRecorder, trackGaps } from './track';

/**
 * O passo da pessoa agora, para o painel: a cadência suavizada (mediana de 10
 * s, passos/min), a passada (m), se ela está correndo pela cadência (`null`
 * sem cadência), se está fora da lona e quanto a cadência média dos últimos 30
 * s mudou desde o primeiro minuto do bloco na mesma velocidade (fração; `null`
 * sem comparação).
 */
export type GaitView = {
  cadenceSpm: number | null;
  strideM: number | null;
  running: boolean | null;
  offBelt: boolean;
  cadenceChange: number | null;
};

/**
 * A carga decidida na recuperação para o próximo bloco de esforço (`index`):
 * os alvos dele, o BPM previsto para o fim dele na carga em que o anterior
 * terminou, o que a previsão pediu, se a carga mudou e se ela é a do fim do
 * bloco anterior, mais pesada que a do plano (`carried`; veja `NextBlock`).
 */
export type NextBlockView = {
  index: number;
  speed: number;
  incline: number;
  predictedBpm: number;
  verdict: NextBlock['verdict'];
  changed: boolean;
  carried: boolean;
};

/**
 * A última recuperação que o coração encurtou ou alongou: a etapa, a duração
 * do plano, a nova e o porquê (veja `Pace`).
 */
export type RecoveryView = { index: number; planned: number; seconds: number; reason: Pace['reason'] };

/** Intervalo mínimo entre revisões quando a pessoa volta a segurar o sensor. */
const CONTACT_REVIEW_GAP = 20_000;
/**
 * Intervalo entre revisões com leitura contínua (a cinta no peito, ou o sensor
 * seguro o tempo todo): a IA olha o treino a cada 30 s. A mediana das regras
 * locais continua sendo a do último minuto. A resposta tem até 28 s (`ai.ts`)
 * e chega antes da revisão seguinte; se não chegar, a seguinte espera por ela
 * (`reviewing`).
 */
const CONTINUOUS_REVIEW_GAP = 30_000;
/**
 * Depois de um ajuste, a pessoa leva um tempo para mexer no painel e a FC para
 * começar a responder: a revisão seguinte espera 1 minuto. A trava não espera.
 */
const CHANGE_COOLDOWN = 60_000;
/** Idade máxima da velocidade e da inclinação medidas para valerem num ajuste. */
const TELEMETRY_MAX_AGE = 5000;
/**
 * Depois de um alívio a trava espera 30 s para reabrir o aviso de um corte que
 * não chegou ao painel (para cortar de novo, 1 minuto: `RELIEF_RESPONSE_WAIT`):
 * a pessoa ainda está mexendo no painel, e a FC sobe mais um pouco antes de
 * responder. É também por quanto
 * ela segura o aviso de carga já no mínimo, em vez de refazer a conta a cada
 * segundo, e o intervalo entre dois avisos de um corte que não chegou ao painel.
 */
const GUARD_WAIT = 30_000;
/**
 * Depois de um alívio feito com o BPM acima do teto, a trava só corta de novo
 * passado 1 minuto: a FC segue subindo uns 25 s depois do corte (o atraso
 * normal do coração), e dois cortes em 30 s derrubavam a carga muito abaixo do
 * alvo. A regra local tem a mesma espera (`CHANGE_COOLDOWN`), e as duas não se
 * somam: as duas contam do último ajuste. O aviso de um corte que não chegou
 * ao painel continua a cada 30 s.
 */
const RELIEF_RESPONSE_WAIT = 60_000;
/** O nome, no registro, da carga do fim de um bloco passada ao seguinte num "manter". */
const KEEP_LOAD = 'manter carga';
/** O nome, no registro, da carga que a pessoa manteve acima do alvo e o app adotou (veja `holding`). */
const ADOPT_LOAD = 'adotar carga';
/**
 * Quanto tempo seguido a esteira fica numa carga mais pesada que o alvo, com o
 * BPM sem passar do teto, até essa carga virar o alvo da etapa: 2 minutos, duas
 * constantes de tempo da FC (veja `HR_TAU_SECONDS`, em prompts.ts), em que ela
 * já fez a maior parte da subida que essa carga dá.
 */
const ADOPT_HOLD_MS = 120_000;
/**
 * No começo de um bloco a lona ainda está acelerando e o BPM é o da etapa
 * anterior: até a esteira chegar aos alvos, a trava espera os primeiros 30 s.
 */
const BLOCK_START_GRACE = 30_000;
/** Uma queda de 2 bpm em 30 s ou mais é o alívio anterior fazendo efeito. */
const FALLING_RISE_BPM = -2;
/** A mesma tolerância com que o guia dá um alvo por atingido. */
const SPEED_TOLERANCE_KMH = 0.051;
const INCLINE_TOLERANCE_PERCENT = 0.251;
/** Quanto da subida dos últimos 30 s a trava tira a mais, no máximo. */
const GUARD_RISE_CAP_BPM = 10;
/**
 * A folga da trava junto do teto, num bloco longo (mais de 5 min): 1 ou 2 bpm
 * de excesso só a acionam depois de 15 s seguidos com o BPM do momento acima
 * do teto; com 3 bpm ou mais (`URGENT_EXCESS_BPM`) ela age na hora. O alvo da
 * sessão é o próprio teto, e a FC de quem está nele oscila 1 ou 2 bpm sem a
 * carga mudar: em 27/11, num limiar com teto de 161, o BPM do momento foi a
 * 162 por 5 s em dois blocos e voltou sozinho a 158; a trava cortou a carga
 * nas duas vezes, e a pessoa (com razão) não seguiu nenhum dos cortes. Na base
 * de 24/11, com 30 min junto do teto, foram 35 passagens assim, e só 8 delas
 * passam desta folga. Num tiro (até 5 min) não há folga: a FC sobe até o fim
 * dele, e toda passagem pelo teto é subida de verdade.
 */
const GUARD_HOLD_MS = 15_000;
/** O começo do texto do painel quando a IA não respondeu e o app seguiu com a própria conta. */
const OFFLINE = 'Sem IA · ';
const SAVE_ERROR = 'Falha ao gravar o treino no aparelho. Confira o espaço disponível.';
/** O alerta de FC da cinta, no treino guiado: tantos bpm acima do teto da faixa do dia. */
const STRAP_ALERT_ABOVE_BPM = 5;
/** Um treino só é preenchido pelo FIT da cinta até tantos dias depois. */
const BACKFILL_DAYS = 7;
/** Quantos treinos a cinta procura no FIT de uma vez. */
const BACKFILL_MAX = 5;
/**
 * Quantas amostras seguidas sem leitura do momento, com a lona andando, até a
 * recuperação guiada pelo coração voltar ao tempo do plano.
 */
const LIVE_MISSING_SAMPLES = 5;
/** Os encerramentos que deixam a trilha incompleta, com a cinta ainda gravando. */
const BROKEN_ENDINGS = ['App interrompido', 'Esteira desconectada'];

export class WorkoutSession {
  private listeners = new Set<() => void>();
  private previous: TreadmillSample | null = null;
  private lastEvent: ConsoleEvent | undefined;
  private reviewToken = 0;
  private reviewAbort: AbortController | null = null;
  /** Uma revisão da IA ainda sem resposta: outra não começa enquanto ela corre. */
  private reviewing = false;
  /** Horário da última leitura já avaliada. */
  private lastReview = -Infinity;
  private lastChange = -Infinity;
  /**
   * Horário do último alívio feito com o BPM acima do teto: a FC leva minutos
   * para responder a ele. Uma redução antecipada da IA não conta.
   */
  private lastRelief = -Infinity;
  /** A etapa em que foi feito esse alívio; -1 sem nenhum, ou depois de um aumento. */
  private reliefIndex = -1;
  /** Horário em que a trava achou a carga já no mínimo, ou o alvo já mais leve que o corte. */
  private lastFloor = -Infinity;
  /** Horário do último aviso de que a esteira está acima dos alvos com o BPM acima do teto. */
  private lastRealert = -Infinity;
  /**
   * Desde quando o BPM do momento está acima do teto, sem voltar a ele, no
   * bloco de esforço em curso; `null` com ele no teto ou abaixo, ou sem
   * leitura do momento. Veja `GUARD_HOLD_MS`.
   */
  private overSince: number | null = null;
  /** A esteira já chegou aos alvos desta etapa ao menos uma vez. */
  private stageReached = false;
  /**
   * A carga mais pesada que o alvo em que a esteira está, já como alvo (veja
   * `adoptedLoad`), desde quando e a última amostra que a confirmou, com o BPM
   * sem passar do teto: `null` fora disso. Veja `holding`.
   */
  private held: { since: number; last: number; speed: number; incline: number } | null = null;
  private stageSince = 0;
  /** Desde quando a esteira está nos alvos da etapa. */
  private reachedSince: number | null = null;
  private contactStart = 0;
  private lastPulse = -Infinity;
  /** Leituras do início do treino, de onde sai a FC de repouso do dia. */
  private early: Pulse[] = [];
  private restDone = false;
  /**
   * Os batimentos da cinta com a esteira conectada e a lona parada, antes do
   * treino: de onde saem o repouso e a prontidão do dia quando a lona começa
   * a andar (veja `rest.ts`). Não é zerada com a revisão: o treino livre
   * começa na mesma amostra em que a janela é lida.
   */
  private still: StillBeat[] = [];
  private checkpoint = 0;
  private waitForStop = false;
  /** A trilha por segundo do treino em curso, fora do estado React. */
  private track: TrackRecorder | null = null;
  /** Se a trilha de um treino encerrado tem lacunas, lida uma vez só. */
  private readonly gaps = new Map<string, boolean>();
  /** Andando ou correndo pela cadência, com histerese (`stepGait`); `null` sem cadência. */
  private running: boolean | null = null;
  /** O "fora da lona" da etapa em curso. */
  private belt: Belt | null = null;
  /** A cadência do bloco de esforço em curso, para o aviso de cadência caindo. */
  private cadence: CadenceTrend | null = null;
  /**
   * Horário da última amostra fora da lona. A revisão olha o último minuto de
   * leituras, que ainda tem o BPM baixo de quem estava parado ao lado da lona:
   * a carga só volta a poder subir um minuto depois de ela voltar.
   */
  private offBeltAt = -Infinity;
  /** Os fins dos blocos de esforço deste treino, medidos na recuperação seguinte. */
  private ends: BlockEnd[] = [];
  /** A última recuperação em que a carga do próximo bloco já foi decidida. */
  private decidedAt = -1;
  /** A duração de cada recuperação no plano, antes de o coração mudá-la. */
  private planned = new Map<number, number>();
  /** A última leitura do momento na recuperação `liveIndex` e há quantas amostras ela falta. */
  private liveIndex = -1;
  private lastLive: number | null = null;
  private missingLive = 0;
  private state = {
    profile: readProfile(),
    coach: '',
    /**
     * Uma dica para a pessoa, à parte de `coach` (que cada revisão troca): o
     * aviso de cadência caindo, uma vez por bloco. Some na troca de etapa.
     */
    tip: '',
    /** O passo da pessoa, com a cadência da X2 Pro; `null` sem cadência nem treino. */
    gait: null as GaitView | null,
    /** A carga do próximo bloco, decidida na recuperação; some quando a etapa muda. */
    nextBlock: null as NextBlockView | null,
    /** A última recuperação encurtada ou alongada pelo coração neste treino. */
    recovery: null as RecoveryView | null,
    /**
     * Os segundos de leitura da cinta com a lona parada, na medida em curso
     * (veja `still`); `null` sem medida em curso.
     */
    stillSeconds: null as number | null,
    /** A janela parado em curso já dá o repouso do dia (60 s, com um trecho de 30 s coerente). */
    stillReady: false,
    /** O estado da HRV na janela parado em curso (veja `HrvCheck`); `null` sem medida em curso. */
    stillHrv: null as 'pronta' | NonNullable<HrvCheck['reason']> | null,
    /**
     * Por que a última tentativa de prontidão não foi gravada: a leitura da
     * cinta instável ou sem RR. Vale para o dia dela; some com uma medida gravada.
     */
    readinessIssue: null as { day: string; reason: 'instavel' | 'sem-rr' } | null,
    /** As medidas de prontidão dos últimos dias, da mais nova à mais antiga. */
    readiness: loadReadiness(),
    guidance: null as Guidance | null,
    minimizedCue: null as string | null,
    active: null as Workout | null,
    history: [] as Workout[],
    assessing: [] as string[],
    error: '',
  };

  /**
   * `strap` é a cinta de batimentos: a sessão declara a ela o que quer (passos,
   * gravação, alerta, perfil, FIT a baixar) e recebe a gravação começada e o
   * FIT baixado. Sem ela (testes, prévia) o treino funciona igual.
   */
  constructor(
    private treadmill: TreadmillStore,
    private strap?: StrapLink,
  ) {
    // As sessões da esteira simulada valem só enquanto o app está aberto: não
    // aparecem em tela nenhuma, então não há por que guardá-las.
    clearSource('demo');
    this.state.history = readWorkouts().map((w) => {
      if (w.ended) return w;
      const recovered = { ...w, ended: w.started + w.totals.movingMs, reason: 'App interrompido' };
      saveWorkout(recovered);
      return recovered;
    });
    try {
      pruneTracks();
    } catch {
      // Trilhas antigas a mais não atrapalham: a limpeza fica para a próxima abertura.
    }
    this.wish();
  }

  /**
   * O que o treino quer da cinta. No treino guiado: gravação na memória dela e
   * alerta de FC no teto da faixa do dia + 5 bpm. Num treino livre (ou na
   * esteira simulada) só os passos. Sem treino: o perfil acertado e o FIT dos
   * treinos com lacunas baixado.
   */
  private wish() {
    if (!this.strap) return;
    const { active, profile } = this.state;
    const guided = !!active?.plan && active.source === 'ble';
    const workout: StrapWishes['workout'] = active
      ? {
          id: active.id,
          startedAt: active.started,
          guided,
          alertBpm: guided
            ? dailyTarget(active.plan, active.profile, active.hr).high + STRAP_ALERT_ABOVE_BPM
            : null,
        }
      : null;
    const strapProfile: StrapWishes['profile'] = profile
      ? {
          weightG: Math.round(profile.weightKg * 1000),
          heightMm: Math.round(profile.heightCm * 10),
          age: profile.age,
          // A FC máxima em uso, a mesma que monta a faixa do próximo treino.
          maxHr: heartProfile(profile, this.sameSource('ble')).max,
        }
      : null;
    this.strap.want({ workout, profile: strapProfile, backfill: this.backfillJobs() });
  }

  /**
   * Os treinos que o FIT da cinta pode completar: com gravação começada pelo
   * app, ainda sem arquivo, dos últimos 7 dias, e com lacunas na trilha (ou
   * encerrados com o app morto ou a esteira caída).
   */
  private backfillJobs() {
    const since = Date.now() - BACKFILL_DAYS * 86_400_000;
    const jobs: { workoutId: string; recordedAt: number }[] = [];
    for (const w of this.state.history) {
      const recordedAt = w.strap?.recordedAt;
      if (jobs.length >= BACKFILL_MAX) break;
      if (w.source !== 'ble' || !recordedAt || w.strap?.file || !w.ended || w.started < since) continue;
      if (BROKEN_ENDINGS.includes(w.reason) || this.hasGaps(w)) jobs.push({ workoutId: w.id, recordedAt });
    }
    return jobs;
  }

  private hasGaps(w: Workout) {
    let gaps = this.gaps.get(w.id);
    if (gaps === undefined) {
      try {
        const track = readTrack(w.id);
        gaps = trackGaps(track, trackSpan(w, track.at(-1)?.second ?? -1)) > 0;
      } catch {
        gaps = false;
      }
      this.gaps.set(w.id, gaps);
    }
    return gaps;
  }

  /**
   * A cinta começou a gravar este treino: o horário fica no registro, para
   * casar o FIT depois. O primeiro horário vale: se a gravação recomeçar (a
   * cinta pode encerrá-la sozinha numa queda do link, o que não foi medido), o
   * primeiro arquivo é o que tem a maior parte do treino.
   */
  private recorded(workoutId: string, recordedAt: number) {
    try {
      const active = this.state.active;
      if (active?.id === workoutId) {
        if (active.strap?.recordedAt) return;
        const next = { ...active, strap: { ...active.strap, recordedAt } };
        saveWorkout(next);
        this.update({ active: next });
        return;
      }
      const done = this.state.history.find((w) => w.id === workoutId);
      if (!done || done.strap?.recordedAt) return;
      const next = { ...done, strap: { ...done.strap, recordedAt } };
      saveWorkout(next);
      this.update({ history: this.state.history.map((w) => (w.id === workoutId ? next : w)) });
    } catch {
      this.update({ error: SAVE_ERROR });
    }
  }

  /**
   * Chegou o FIT de um treino encerrado: só a trilha é preenchida (BPM e
   * cadência, marcados como vindos do FIT). Os agregados do treino não mudam:
   * o FIT não traz velocidade nem inclinação.
   */
  private backfilled(job: BackfillJob) {
    const w = this.state.history.find((h) => h.id === job.workoutId);
    if (!w || !w.ended) return;
    try {
      const last = readTrack(w.id).at(-1)?.second ?? -1;
      const filled = fillTrackFromFit(w.id, w.started, trackSpan(w, last), job.records);
      const next = { ...w, strap: { ...w.strap, file: job.file, backfilledSeconds: filled } };
      saveWorkout(next);
      this.gaps.delete(w.id);
      this.update({ history: this.state.history.map((h) => (h.id === w.id ? next : h)) });
    } catch {
      this.update({ error: SAVE_ERROR });
      return;
    }
    this.wish();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Passa a ouvir a esteira e a cinta (a gravação começada e o FIT baixado).
   * Devolve a função que solta tudo, chamada quando a sessão é descartada.
   */
  connect = () => {
    const offTreadmill = this.treadmill.subscribe(() => {
      try {
        this.receive();
      } catch {
        this.update({ error: SAVE_ERROR });
      }
    });
    const offRecorded = this.strap?.onRecorded(({ workoutId, recordedAt }) =>
      this.recorded(workoutId, recordedAt),
    );
    const offBackfill = this.strap?.onBackfill((job) => this.backfilled(job));
    const offBeat = this.strap?.onBeat((beat) => this.beat(beat));
    return () => {
      offTreadmill();
      offRecorded?.();
      offBackfill?.();
      offBeat?.();
    };
  };

  /**
   * Uma notificação da cinta. Com a esteira conectada, a lona parada (ou ainda
   * sem leitura de velocidade) e o repouso de hoje ainda por medir, ela entra
   * na janela parado; fora disso a janela recomeça. Quem já vinha andando num
   * registro livre não está mais em repouso, e nos 10 minutos depois de um
   * treino de 1 minuto ou mais a FC e a HRV ainda são as do esforço.
   */
  private beat(beat: StrapBeatEvent) {
    const machine = this.treadmill.getSnapshot();
    const active = this.state.active;
    const resting =
      machine.phase === 'connected' &&
      !((machine.samples.at(-1)?.speedKmh ?? 0) > 0) &&
      !this.restDone &&
      !(active && active.totals.movingMs > 0) &&
      // Os esforços saem do histórico: valem também com o app reaberto logo depois do treino.
      stillWait(efforts(this.state.history), beat.at) === 0;
    if (!resting) {
      this.dropStill();
      return;
    }
    // Sem contato com a pele não há leitura: a lacuna não conta como tempo medido.
    if (beat.bpm === null) return;
    this.still = addStillBeat(this.still, { at: beat.at, bpm: beat.bpm, rrMs: beat.rrMs });
    const seconds = stillSeconds(this.still);
    const ready = stillRest(this.still, this.stillPrevious(machine.mode)) !== null;
    const check = stillHrv(this.still);
    const hrv = check.hrv ? 'pronta' : check.reason;
    const s = this.state;
    if (seconds !== s.stillSeconds || ready !== s.stillReady || hrv !== s.stillHrv)
      this.update({ stillSeconds: seconds, stillReady: ready, stillHrv: hrv });
  }

  /** Esvazia a janela parado. */
  private dropStill() {
    this.still = [];
    if (this.state.stillSeconds !== null) this.update({ stillSeconds: null, stillReady: false, stillHrv: null });
  }

  /** As medidas parado anteriores da mesma origem: a referência do piso de plausibilidade do repouso. */
  private stillPrevious(source: Workout['source']) {
    return stillHistory(this.sameSource(source));
  }

  minimizeCue(key: string | null) {
    this.update({ minimizedCue: key });
  }

  setProfile(profile: Profile) {
    saveProfile(profile);
    this.update({ profile });
    this.wish();
  }

  /**
   * Apaga perfil, treinos e diário do aparelho e volta à primeira abertura. O
   * registro em curso é descartado. A chave da DeepSeek não é tocada.
   */
  reset() {
    this.resetReview();
    clearData();
    this.track = null;
    this.gaps.clear();
    this.previous = null;
    this.still = [];
    // Com a lona andando, um registro novo só começa depois de uma parada.
    this.waitForStop = true;
    this.update({
      profile: null,
      coach: '',
      tip: '',
      gait: null,
      nextBlock: null,
      recovery: null,
      stillSeconds: null,
      stillReady: false,
      stillHrv: null,
      readinessIssue: null,
      readiness: [],
      guidance: null,
      minimizedCue: null,
      active: null,
      history: [],
      assessing: [],
      error: '',
    });
    this.wish();
  }

  /** Apaga um registro encerrado do histórico. O treino em curso não está nele. */
  remove(id: string) {
    deleteWorkout(id);
    this.gaps.delete(id);
    this.update({ history: this.state.history.filter((w) => w.id !== id) });
    this.wish();
  }

  private sameSource(source: Workout['source']) {
    return this.state.history.filter((h) => h.source === source);
  }

  start(plan: Plan | null) {
    const { profile, active } = this.state;
    const machine = this.treadmill.getSnapshot();
    if (!profile || machine.phase !== 'connected' || machine.status.stoppedBySafetyKey) {
      throw new Error('Conecte a esteira e confira a chave de segurança.');
    }
    // Quem já vinha andando num registro livre não está mais em repouso: vale
    // a leitura que aquele registro fez, se fez, com a origem dela.
    const walking = !!active && active.totals.movingMs > 0;
    // Sem declarar "sem treino" à cinta no meio: o pedido do treino novo vem logo abaixo.
    if (active) this.finish('Início do treino guiado', false);
    const workout: Workout = {
      ...newWorkout(profile, machine.mode, plan, heartProfile(profile, this.sameSource(machine.mode))),
      restBpm: walking ? (active.restBpm ?? null) : null,
      ...(walking && active.restSource && { restSource: active.restSource }),
    };
    saveWorkout(workout);
    this.track = new TrackRecorder(workout.id, workout.started);
    this.resetReview();
    this.restDone = walking;
    this.stageSince = workout.started;
    this.checkpoint = workout.started;
    this.waitForStop = false;
    this.previous = null;
    const guidance = advanceGuidance(
      null,
      plan && currentCue(plan, 0),
      machine.samples.at(-1) ?? null,
      workout.started,
    );
    this.update({
      active: workout,
      guidance,
      minimizedCue: null,
      coach: '',
      tip: '',
      gait: null,
      nextBlock: null,
      recovery: null,
      error: '',
    });
    this.wish();
  }

  private receive() {
    const s = this.treadmill.getSnapshot();
    if (s.phase !== 'connected') {
      this.finish('Esteira desconectada');
      this.previous = null;
      this.waitForStop = false;
      this.lastEvent = undefined;
      return;
    }
    const event = s.status.consoleEvents[0];
    if (event && this.lastEvent !== event) {
      this.lastEvent = event;
      const e = event.event;
      if (
        e.type === 'reset' ||
        e.type === 'stoppedBySafetyKey' ||
        (e.type === 'stoppedOrPausedByUser' && e.action === 'stop')
      ) {
        this.finish(
          e.type === 'stoppedBySafetyKey' ? 'Parada de segurança' : 'Encerrado pelo painel',
        );
        this.waitForStop = true;
        this.previous = null;
        return;
      }
      if (e.type === 'startedOrResumedByUser') this.waitForStop = false;
    }
    const sample = s.samples.at(-1);
    if (s.status.stoppedBySafetyKey || !sample || sample === this.previous) return;
    const moving = (sample.speedKmh ?? 0) > 0;
    if (!moving) this.waitForStop = false;
    // Com a lona parada ou em pausa a carga mantida acima do alvo deixa de
    // contar: os 120 s têm de ser seguidos, na lona.
    if (!moving) this.held = null;
    if (!this.state.active && moving && !this.waitForStop && this.state.profile) this.start(null);
    const w = this.state.active;
    if (w) {
      // A trilha anda no relógio, com a lona parada ou andando.
      if (this.track?.workoutId !== w.id) this.track = new TrackRecorder(w.id, w.started);
      this.track.add(sample);
      // Andando ou correndo pela cadência: só para as kcal e o painel.
      const cadence = smoothCadence(s.samples, sample.at);
      this.running = stepGait(this.running, cadence);
      // O tempo andado não depende do passo: a etapa sai dele, e o "fora da lona" da etapa.
      const moved = accumulate(w.totals, sample, this.previous, { running: this.running });
      const elapsed = Math.floor(moved.movingMs / 1000);
      const cue = w.plan && currentCue(w.plan, elapsed);
      const gaitInput = {
        stage: cue?.index ?? -1,
        effort: !!cue && !cue.stage.measure,
        at: sample.at,
        kmh: sample.speedKmh,
        spm: sample.cadenceSpm,
      };
      this.belt = trackBelt(this.belt, gaitInput);
      const offBelt = this.belt.off;
      if (offBelt) {
        this.offBeltAt = sample.at;
        // O mesmo segundo de relógio de `TrackRecorder.add`.
        this.track.mark(Math.floor((sample.at - w.started) / 1000), TRACK_FLAGS.offBelt);
      }
      // Fora da lona o BPM não entra nos totais, e o gasto é o de repouso.
      const totals = offBelt
        ? accumulate(w.totals, sample, this.previous, { running: this.running, offBelt })
        : moved;
      let next = this.measureRest({ ...w, totals }, sample, moving);
      next = {
        ...next,
        // Fora da lona o BPM baixo não entra nos minutos, de onde saem os patamares do próximo plano.
        beats: logBeats(next.beats, sample, this.previous, elapsed, offBelt),
        loads: logLoads(next.loads, sample, this.previous, elapsed),
      };
      // O treino livre tem um registro só. No guiado, o que passa do fim do
      // plano não pertence a etapa nenhuma.
      const index = cue ? cue.index : w.plan ? -1 : 0;
      if (index >= 0) {
        const zone = dailyTarget(next.plan, next.profile, next.hr);
        const log = Array.from(
          { length: Math.max(index + 1, next.log?.length ?? 0) },
          (_, i) => next.log?.[i] ?? emptyLog(),
        );
        log[index] = logStage(log[index], sample, this.previous, zone, cue ? cue.into : elapsed, offBelt);
        // O BPM do momento mais alto da etapa: com os RR ele passa do teto antes
        // das leituras da cinta, e a decisão do bloco seguinte precisa saber disso.
        const live = w.plan && moving && !offBelt ? livePulse(s.samples, sample.at) : null;
        if (live && live.bpm > (log[index].liveTop ?? 0)) log[index] = { ...log[index], liveTop: live.bpm };
        next = { ...next, log };
      }
      const drop = trackCadence(this.cadence, gaitInput);
      this.cadence = drop.trend;
      const gait: GaitView | null =
        cadence === null && !offBelt
          ? null
          : {
              cadenceSpm: cadence,
              strideM: strideM(sample.speedKmh, cadence),
              running: this.running,
              offBelt,
              cadenceChange: cadenceChange(this.cadence, sample.at),
            };
      if (sample.at - this.checkpoint >= 10000) {
        saveWorkout(next);
        this.checkpoint = sample.at;
        try {
          this.track.flush();
        } catch {
          // A trilha é à parte: uma falha nela não pode parar o treino. Os
          // minutos não gravados ficam na memória para o próximo checkpoint.
          this.update({ error: SAVE_ERROR });
        }
      }
      const previous = this.state.guidance;
      let coach = this.state.coach;
      let tip = drop.warn ? FATIGUE_TIP : this.state.tip;
      if (cue && previous?.index !== cue.index) {
        this.stageSince = sample.at;
        // O tempo na carga conta de novo em cada etapa, mesmo que a esteira já esteja nos alvos dela.
        this.reachedSince = null;
        // Uma resposta da IA pedida na etapa anterior não vale para esta: o painel deixa de esperá-la.
        if (this.reviewing) coach = '';
        this.cancelReview();
        this.lastFloor = -Infinity;
        this.lastRealert = -Infinity;
        this.overSince = null;
        this.stageReached = false;
        this.held = null;
        // O aviso de cadência caindo era do bloco que acabou.
        tip = '';
      }
      const changedStage = !!cue && previous?.index !== cue.index;
      const guidance = advanceGuidance(previous, cue, sample, sample.at);
      this.update({
        active: next,
        guidance,
        coach,
        tip,
        gait,
        ...(changedStage && { nextBlock: null }),
      });
      // A amostra já está somada: uma falha ao gravar uma decisão daqui em diante
      // não pode fazer o mesmo intervalo entrar de novo na próxima amostra.
      this.previous = sample;
      if (w.plan && totals.movingMs >= w.plan.minutes * 60000) this.finish('Duração concluída');
      else if (cue && guidance && moving) {
        // Na recuperação entre dois blocos: a carga do próximo e a duração desta.
        this.planAhead(cue, sample, s.samples);
        const paced = this.pace(cue, sample, s.samples);
        this.consider(this.state.active ?? next, paced ?? cue, guidance, sample, s.samples);
      }
    }
    this.previous = sample;
  }

  /**
   * Aos 15 s de uma recuperação entre dois blocos de esforço, decide a carga
   * do próximo pelo fim do que acabou (veja `nextBlockLoad`). Uma vez por
   * recuperação. O fim do bloco (a carga dos últimos 20 s e o BPM do fim) fica
   * guardado para medir o acúmulo nas recuperações seguintes. Só com a cinta.
   */
  private planAhead(cue: Cue, sample: TreadmillSample, samples: TreadmillSample[]) {
    const active = this.state.active;
    const plan = active?.plan;
    if (!active || !plan || cue.into < NEXT_BLOCK_AT_SECONDS || this.decidedAt === cue.index) return;
    if (!betweenBlocks(plan, cue.index)) return;
    this.decidedAt = cue.index;
    const block = cue.index - 1;
    // O começo desta etapa é o fim do bloco: as amostras de antes dele são as do bloco.
    const end = blockEnd(samples, this.stageSince, plan.stages[block]);
    const tail = active.log?.[block]?.tail ?? [];
    if (end && tail.length >= 3 && !this.ends.some((e) => e.index === block))
      this.ends = [...this.ends, { index: block, speed: end.speed, incline: end.incline, bpm: median(tail) }];
    const zone = dailyTarget(plan, active.profile, active.hr);
    const decision = nextBlockLoad({
      plan,
      index: cue.index,
      log: active.log ?? [],
      changes: active.changes ?? [],
      zone,
      rest: active.hr?.rest ?? null,
      ends: this.ends,
      strapReadings: end?.strapReadings ?? 0,
      offBelt: this.offBeltRecently(sample.at),
    });
    if (!decision) return;
    const changed = decision.stages.length > 0;
    const nextBlock: NextBlockView = {
      index: decision.index,
      speed: decision.to.speed,
      incline: decision.to.incline,
      predictedBpm: decision.predictedBpm,
      verdict: decision.verdict,
      changed,
      carried: decision.carried,
    };
    if (!changed) {
      this.update({ nextBlock });
      return;
    }
    // `commit` não serve: ele exige a etapa em curso e reabre o aviso de ajuste,
    // e aqui a carga é de um bloco que ainda vai começar.
    const elapsed = Math.floor(active.totals.movingMs / 1000);
    const { from, to } = decision;
    // A carga do fim do bloco anterior levada ao próximo (como estava, ou já
    // com o corte que a previsão pediu) tem nome próprio: não é aumento nem
    // redução, e não conta como nenhum dos dois na avaliação.
    const change: Change = {
      second: elapsed,
      stage: decision.index,
      decision: decision.carried ? KEEP_LOAD : changeLabel(from, to),
      bpm: this.ends[this.ends.length - 1].bpm,
      from: [from.speed, from.incline],
      to: [to.speed, to.incline],
      by: 'bloco',
    };
    const stages = plan.stages.map((s, i) =>
      decision.stages.includes(i) ? { ...s, speed: to.speed, incline: to.incline } : s,
    );
    const next = { ...active, plan: { ...plan, stages }, changes: [...(active.changes ?? []), change] };
    saveWorkout(next);
    const name = to.seconds <= SHORT_BLOCK_SECONDS ? 'Próximo tiro: ' : 'Próximo bloco: ';
    const incline = to.incline !== from.incline ? ' e ' + formatDecimal(to.incline, Number.isInteger(to.incline) ? 0 : 1) + '%' : '';
    this.update({ active: next, nextBlock, coach: name + formatDecimal(to.speed, 1) + ' km/h' + incline });
  }

  /**
   * Numa recuperação entre dois blocos, com leitura recente da cinta, a
   * duração dela segue o coração (veja `paceRecovery`): termina quando o BPM do
   * momento cai a 65% da FC máxima, de 2 a 5 min, e a volta à calma paga a
   * diferença. Devolve o pedido do guia refeito quando a etapa mudou.
   */
  private pace(cue: Cue, sample: TreadmillSample, samples: TreadmillSample[]): Cue | null {
    const active = this.state.active;
    const plan = active?.plan;
    if (!active || !plan || !betweenBlocks(plan, cue.index)) return null;
    const planned = this.planned.get(cue.index) ?? plan.stages[cue.index].seconds;
    this.planned.set(cue.index, planned);
    // Uma lacuna curta da cinta (o rádio, ou a lona voltando a andar depois de
    // uma pausa) não é "sem leitura": a última leitura vale por 5 amostras com
    // a lona andando. Sem isso uma recuperação alongada terminaria na hora.
    if (this.liveIndex !== cue.index) [this.liveIndex, this.lastLive, this.missingLive] = [cue.index, null, 0];
    const fresh = livePulse(samples, sample.at);
    if (fresh) [this.lastLive, this.missingLive] = [fresh.bpm, 0];
    else this.missingLive += 1;
    const bpm = fresh?.bpm ?? (this.missingLive < LIVE_MISSING_SAMPLES ? this.lastLive : null);
    const live = bpm === null ? null : { bpm };
    const pace = paceRecovery({
      plan,
      index: cue.index,
      into: cue.into,
      planned,
      bpm,
      maxBpm: active.hr?.max ?? foxMax(active.profile.age),
    });
    if (!pace) return null;
    const next = { ...active, plan: { ...plan, stages: pace.stages } };
    const elapsed = Math.floor(active.totals.movingMs / 1000);
    const redone = currentCue(next.plan, elapsed);
    if (!redone || redone.index !== cue.index) return null;
    saveWorkout(next);
    const time = formatDuration(pace.seconds);
    const coach =
      pace.reason === 'plano'
        ? 'Sem leitura · recuperação no tempo do plano'
        : pace.reason === 'cedo'
          ? 'Recuperação encerrada aos ' + time + ' · ' + live?.bpm + ' BPM'
          : pace.seconds > planned && pace.seconds > cue.into + 1
            ? 'Recuperação alongada até ' + time + ' · ' + live?.bpm + ' BPM'
            : 'Recuperação encerrada aos ' + time + ' · ' + live?.bpm + ' BPM';
    this.update({
      active: next,
      recovery: { index: cue.index, planned, seconds: pace.seconds, reason: pace.reason },
      coach,
    });
    return redone;
  }

  /**
   * Guarda a FC de repouso do dia. Quando a lona começa a andar, com 60 s ou
   * mais de leitura da cinta parado, ela sai da janela parado (`'parado'`);
   * senão, das primeiras leituras do treino, já andando (`'andando'`).
   */
  private measureRest(w: Workout, sample: TreadmillSample, moving: boolean): Workout {
    if (this.restDone) return w;
    const still = moving ? this.settleStill(w, sample.at) : null;
    if (still) return still;
    const closed = w.totals.movingMs > REST_WINDOW_SECONDS * 1000;
    if (!closed && moving && validBpm(sample.heartRateBpm))
      this.early.push({ at: sample.at, bpm: sample.heartRateBpm });
    const rest = restingBpm(this.early, closed);
    if (rest === null && !closed) return w;
    this.restDone = true;
    if (rest === null) return w;
    return this.rested(w, rest, 'andando');
  }

  /**
   * A lona começou a andar: o repouso do dia sai da janela parado, se ela tem
   * 60 s ou mais de leitura e chega até agora (uma janela que parou de receber
   * leituras, com a cinta sem contato ou desligada, é de outro momento), e a
   * prontidão do dia é gravada se os RR servirem. A janela é lida uma vez só.
   * Devolve o registro com o repouso, ou `null` quando vale o caminho andando.
   */
  private settleStill(w: Workout, now: number): Workout | null {
    if (!this.still.length) return null;
    const beats = this.still;
    this.dropStill();
    if (now - beats[beats.length - 1].at > STILL_GAP_MS) return null;
    const rest = stillRest(beats, this.stillPrevious(w.source));
    // A esteira simulada não diz se a pessoa estava parada: a medida dela não entra na base.
    if (w.source === 'ble') this.keepReadiness(beats, rest, now);
    if (rest === null) return null;
    this.restDone = true;
    return this.rested(w, rest, 'parado');
  }

  /** O registro com o repouso de hoje e a faixa do dia refeita com ele. */
  private rested(w: Workout, rest: number, restSource: Workout['restSource']): Workout {
    const measured = { ...w, restBpm: rest, restSource };
    return { ...measured, hr: heartProfile(w.profile, [measured, ...this.sameSource(w.source)]) };
  }

  /**
   * Grava a medida de prontidão do dia, se a HRV da janela vale (veja
   * `stillHrv`), com 2 minutos ou mais parado. Uma linha por dia: a mais
   * recente vale. Não grava nada com um treino terminado há menos de 3 horas
   * (a HRV ainda está deprimida) nem por cima da medida de hoje feita antes de
   * um treino de hoje (veja `readinessLock`); o repouso parado segue valendo
   * para o treino. Uma janela sem repouso coerente, com 2 minutos ou mais, é
   * leitura instável. O motivo de uma recusa fica em `readinessIssue`, para a
   * tela. Uma falha ao gravar não para o treino: a prontidão é só uma sugestão.
   */
  private keepReadiness(beats: StillBeat[], rest: number | null, now: number) {
    // Menos de 2 minutos parado: não foi uma tentativa de prontidão.
    const tried = stillHrv(beats);
    if (tried.reason === 'curta') return;
    if (readinessLock(efforts(this.state.history), this.state.readiness, now)) return;
    const day = dayKey(now);
    const check: HrvCheck = rest === null ? { hrv: null, reason: 'instavel' } : tried;
    if (!check.hrv) {
      if (check.reason !== 'curta') this.update({ readinessIssue: { day, reason: check.reason } });
      return;
    }
    const record: ReadinessRecord = { ...check.hrv, day, at: now, restBpm: rest };
    try {
      saveReadiness(record);
    } catch {
      return;
    }
    this.update({
      readiness: [record, ...this.state.readiness.filter((r) => r.day !== record.day)],
      readinessIssue: null,
    });
  }

  private load(plan: Plan, cue: Cue, g: Guidance, now: number): Load {
    const stage = plan.stages[cue.index];
    const reached = g.speedReached && g.inclineReached;
    const later = plan.stages.slice(cue.index + 1).some((s) => !s.measure);
    return {
      stage,
      easy: stage.measure || plan.objective === 'Recuperação',
      reached,
      secondsAtLoad: reached && this.reachedSince !== null ? (now - this.reachedSince) / 1000 : 0,
      closing: cue.left <= 120 && !later,
      short: !stage.measure && stage.seconds <= SHORT_BLOCK_SECONDS,
      offBelt: this.offBeltRecently(now),
    };
  }

  /**
   * A pessoa está fora da lona, ou voltou há menos de um minuto (a janela da
   * revisão com a cinta): a carga não sobe, nem pela regra local, nem pela IA,
   * nem pela decisão do bloco seguinte. A trava e as reduções seguem valendo.
   */
  private offBeltRecently(now: number) {
    return now - this.offBeltAt < STRAP_WINDOW_MS;
  }

  /** A velocidade e a inclinação desta amostra foram medidas há pouco. */
  private fresh(sample: TreadmillSample, now = sample.at) {
    const recent = (at: number | null | undefined) => at != null && now - at <= TELEMETRY_MAX_AGE;
    return recent(sample.speedAt) && recent(sample.inclineAt);
  }

  /**
   * Há quantos ms foi o alívio de excesso desta etapa: feito com o BPM acima do
   * teto, e sem um aumento depois dele. `Infinity` sem nenhum. É por ele que a
   * trava, a regra local e a IA esperam o alívio fazer efeito; um alívio de
   * outra etapa ou uma redução antecipada da IA não seguram nenhuma delas.
   */
  private sinceRelief(index: number, now: number) {
    return this.reliefIndex === index ? now - this.lastRelief : Infinity;
  }

  /** O BPM do momento passou do teto: com ele acima, a carga não sobe. */
  private overTop(zone: Zone, now: number) {
    const live = livePulse(this.treadmill.getSnapshot().samples, now);
    return !!live && live.bpm > zone.high;
  }

  /**
   * Com o BPM acima do teto e a esteira acima dos alvos, um corte já pedido não
   * chegou ao painel: outro por cima dele somaria os dois sem a FC ter
   * respondido a nenhum. O app reabre o aviso de ajuste, com bipes, e diz
   * no painel até onde reduzir, sem gravar ajuste novo. Devolve `true` quando a
   * esteira está acima dos alvos, avisando agora ou não.
   */
  private realert(index: number, g: Guidance, sample: TreadmillSample, head: string) {
    const cue = this.cueAt(index);
    if (!cue || (g.speedReached && g.inclineReached)) return false;
    const { stage } = cue;
    const measured = metabolicCost(sample.speedKmh ?? 0, sample.inclinationPercent ?? 0);
    if (measured <= metabolicCost(stage.speed, stage.incline)) return false;
    if (sample.at - this.lastRealert < GUARD_WAIT) return true;
    // Cada alvo que difere do que a esteira mede, para cima ou para baixo: o
    // painel não pode esconder a rampa quando ela também precisa mudar.
    const parts: string[] = [];
    if (Math.abs((sample.speedKmh ?? 0) - stage.speed) > SPEED_TOLERANCE_KMH)
      parts.push(formatDecimal(stage.speed, 1) + ' km/h');
    // A rampa anda de meio em meio ponto: 7,5% ou 2%, sem o ",0".
    if (Math.abs((sample.inclinationPercent ?? 0) - stage.incline) > INCLINE_TOLERANCE_PERCENT)
      parts.push(formatDecimal(stage.incline, Number.isInteger(stage.incline) ? 0 : 1) + '%');
    const target = parts.length ? parts.join(' e ') : formatDecimal(stage.speed, 1) + ' km/h';
    // "Reduza" só quando os dois descem; se um deles sobe (a rampa de 0 para 1%,
    // por exemplo), o painel diz "ajuste".
    const up =
      stage.speed > (sample.speedKmh ?? 0) + SPEED_TOLERANCE_KMH ||
      stage.incline > (sample.inclinationPercent ?? 0) + INCLINE_TOLERANCE_PERCENT;
    // O aviso reabre como num ajuste novo: os alvos em vigor passam a valer de agora.
    const guidance = advanceGuidance({ ...g, adjusted: false, targetsSince: sample.at }, cue, sample, sample.at);
    this.lastRealert = sample.at;
    this.update({ guidance, minimizedCue: null, coach: head + (up ? ' · ajuste para ' : ' · reduza para ') + target });
    return true;
  }

  /** O pedido do guia neste segundo de treino, se ele ainda está na etapa `index`. */
  private cueAt(index: number) {
    const active = this.state.active;
    if (!active?.plan) return null;
    const cue = currentCue(active.plan, Math.floor(active.totals.movingMs / 1000));
    return cue?.index === index ? cue : null;
  }

  /**
   * Decide o que as leituras pedem. Primeiro a trava (`guard`), a cada amostra,
   * e a carga que a pessoa mantém acima do alvo (`holding`), que vira o alvo da
   * etapa. Depois, a cada 30 s com leitura contínua ou a cada pegada no sensor, a
   * revisão: acima da faixa o app alivia na hora, em qualquer etapa e sem
   * consultar ninguém; no resto a IA decide entre manter, reduzir e, quando a
   * regra local deixaria, aumentar. Sem resposta dela vale a regra local:
   * abaixo do piso, num bloco de esforço com a esteira nos alvos, a carga sobe;
   * dentro da faixa e longe do teto, sobe o que couber sem passar dele; o resto
   * fica como está.
   */
  private consider(
    w: Workout,
    cue: Cue,
    g: Guidance,
    sample: TreadmillSample,
    samples: TreadmillSample[],
  ) {
    if (!w.plan) return;
    if (validBpm(sample.heartRateBpm)) {
      if (sample.at - this.lastPulse > 10000) this.contactStart = sample.at;
      this.lastPulse = sample.at;
    }
    const reached = g.speedReached && g.inclineReached;
    this.reachedSince = reached ? (this.reachedSince ?? sample.at) : null;
    if (reached) this.stageReached = true;
    const zone = dailyTarget(w.plan, w.profile, w.hr);
    // A conta da carga mantida anda antes da trava: um segundo acima do teto a
    // recomeça, mesmo quando é a trava que age nele.
    const kept = this.holding(w.plan, cue, g, sample, samples, zone);
    if (this.guard(w, cue.index, g, sample, samples, zone)) return;
    if (kept && this.adopt(cue.index, kept, sample)) return;
    const sinceReview = sample.at - this.lastReview;
    const newContact = this.contactStart > this.lastReview && sinceReview >= CONTACT_REVIEW_GAP;
    if (sample.at - this.lastChange < CHANGE_COOLDOWN) return;
    if (!newContact && sinceReview < CONTINUOUS_REVIEW_GAP) return;
    const readings = pulseWindow(samples, this.stageSince, sample.at);
    const features = pulseFeatures(readings, zone);
    if (!features) return;
    const load = this.load(w.plan, cue, g, sample.at);
    const latest = readings[readings.length - 1].at;
    const fix = correction(features, load, this.sinceRelief(cue.index, sample.at) / 1000);
    // Acima da faixa o alívio sai na hora, sem esperar a IA: é o que protege as
    // etapas leves e quem usa o sensor de mão, onde a trava não age.
    if (fix === 'aliviar') {
      // Sem velocidade e inclinação recentes a conta do ajuste fica para a próxima amostra.
      if (!this.fresh(sample)) return;
      this.lastReview = latest;
      // Um corte que ainda não chegou ao painel não leva outro por cima: o aviso reabre.
      if (this.realert(cue.index, g, sample, 'Acima da faixa · ' + features.median + ' BPM')) return;
      this.adjust(w, cue.index, fix, 0, features, zone, load, sample, 'app');
      return;
    }
    if (this.reviewing) return;
    this.lastReview = latest;
    const room = fix ? 0 : raiseRoom(features, load);
    void this.review(w, cue, load, features, zone, fix, room, sample, samples);
  }

  /**
   * A trava: com a cinta, num bloco de esforço, alivia a carga quando o BPM
   * do momento passa do teto, sem esperar a mediana do minuto nem a IA. A
   * mediana demora: no tiro de 4 minutos de 22/11 ela só acusou o excesso a
   * 25 s do fim, depois de 89 s acima do teto. Num tiro ela age no primeiro
   * segundo acima do teto. Num bloco longo, com 3 bpm ou mais de excesso ela
   * age na hora; com 1 ou 2, só depois de 15 s seguidos acima do teto (veja
   * `GUARD_HOLD_MS`): é a oscilação de quem está no alvo, que é o próprio teto.
   * Acionada, ela nunca fica sem reação: um corte novo ou, com um corte que ainda não
   * chegou ao painel, o aviso reaberto. Nas etapas leves a trava não age: nelas
   * o BPM vem caindo sozinho do bloco anterior. No começo do bloco ela espera a
   * esteira chegar aos alvos, por até 30 s. Depois de um alívio de excesso
   * nesta etapa, de quem for, ela espera 30 s para reabrir o aviso de um corte
   * que não chegou ao painel e 1 minuto para cortar de novo, e até 3 minutos
   * depois dele só corta com 3 bpm ou mais de excesso e o BPM sem cair. O corte parte
   * da carga medida (veja `correctedStage`), leva o BPM a 3 abaixo do teto e
   * tira também a subida dos últimos 30 s (até 10 bpm), que ainda vai chegar.
   * Com a esteira acima dos alvos em custo ela não corta: reabre o aviso
   * (`realert`). Devolve `true` quando agiu.
   */
  private guard(
    w: Workout,
    index: number,
    g: Guidance,
    sample: TreadmillSample,
    samples: TreadmillSample[],
    zone: Zone,
  ) {
    const stage = w.plan?.stages[index];
    if (!stage || stage.measure) return false;
    const live = livePulse(samples, sample.at);
    const excess = live ? live.bpm - zone.high : 0;
    // A conta dos segundos seguidos acima do teto anda em toda amostra do bloco.
    this.overSince = excess > 0 ? (this.overSince ?? sample.at) : null;
    if (!live || !this.fresh(sample)) return false;
    const tripped =
      stage.seconds <= SHORT_BLOCK_SECONDS ||
      excess >= URGENT_EXCESS_BPM ||
      (this.overSince !== null && sample.at - this.overSince >= GUARD_HOLD_MS);
    if (excess <= 0 || !tripped || sample.at - this.lastFloor < GUARD_WAIT) return false;
    // No começo do bloco a lona ainda acelera desde a etapa leve, e o BPM é o do
    // bloco anterior: um corte feito dali iria para todos os blocos seguintes.
    if (!this.stageReached && sample.at - this.stageSince < BLOCK_START_GRACE) return false;
    const sinceRelief = this.sinceRelief(index, sample.at);
    if (sinceRelief < GUARD_WAIT) return false;
    const text = 'Acima do teto · ' + live.bpm + ' BPM';
    if (this.realert(index, g, sample, text)) return true;
    // Com o corte no painel, o coração ainda sobe uns 25 s antes de responder:
    // um corte novo antes de 1 minuto somaria os dois sem a FC ter respondido ao
    // primeiro.
    if (sinceRelief < RELIEF_RESPONSE_WAIT) return false;
    const settling =
      sinceRelief < RELIEF_SETTLE_SECONDS * 1000 &&
      (live.bpm - zone.high < URGENT_EXCESS_BPM || live.rise <= FALLING_RISE_BPM);
    if (settling) return false;
    const cost = metabolicCost(sample.speedKmh ?? stage.speed, sample.inclinationPercent ?? stage.incline);
    const slope = bpmPerMet(live.bpm, cost, w.hr?.rest ?? null);
    const want =
      live.bpm - (zone.high - AIM_SPAN_BPM) + Math.min(GUARD_RISE_CAP_BPM, Math.max(0, live.rise));
    const revised = correctedStage(stage, 'aliviar', want / slope, sample);
    if (revised === stage) {
      this.lastFloor = sample.at;
      this.update({ coach: text + ' · ' + unchangedRelief(sample, stage) });
      return true;
    }
    if (!this.commit(index, revised, 'aliviar', live.bpm, sample, sample.at, 'trava')) return false;
    // A revisão recomeça a contar daqui; a resposta da IA que ainda não voltou era para a carga antiga.
    this.lastReview = sample.at;
    this.update({ coach: text + ' · carga reduzida' });
    return true;
  }

  /**
   * A carga que a pessoa mantém acima do alvo. Num bloco de esforço que não
   * seja um tiro, com ela na lona, a carga medida em que a esteira fica 2
   * minutos seguidos, estável e mais pesada que o alvo (veja `adoptedLoad`),
   * sem o BPM do momento nem a mediana do último minuto passarem do teto, é
   * uma carga que ela aguenta: devolve essa carga, com o BPM de agora, para
   * virar o alvo.
   * Sem isso, quem não segue um corte fica com a esteira fora dos alvos até o
   * fim da etapa, e a carga não sobe mais (em 24/11, o alvo ficou em 1 km/h
   * com a pessoa no alvo da FC a 5,2 km/h e 4%). Uma leitura acima do teto,
   * outra carga, a esteira nos alvos ou a velocidade e a inclinação sem leitura
   * recente recomeçam a conta, e também a lona parada ou em pausa (`receive`)
   * e uma falta de amostras por mais de 5 s. Sem leitura de BPM (a cinta sem
   * mandar nada por mais de 12 s; o sensor de mão entre as pegadas) também: sem
   * saber se o BPM passou do teto, uma carga mais pesada não é adotada. Na
   * prática a adoção é só com a cinta.
   */
  private holding(
    plan: Plan,
    cue: Cue,
    g: Guidance,
    sample: TreadmillSample,
    samples: TreadmillSample[],
    zone: Zone,
  ) {
    const load = this.load(plan, cue, g, sample.at);
    const eligible = !load.easy && !load.short && !load.offBelt && this.fresh(sample);
    const target = eligible ? adoptedLoad(load.stage, sample) : null;
    const live = target && livePulse(samples, sample.at);
    const features = target && pulseFeatures(pulseWindow(samples, this.stageSince, sample.at), zone);
    const bpm = live?.bpm ?? features?.median;
    const over = (live?.bpm ?? 0) > zone.high || (features?.median ?? 0) > zone.high;
    if (!target || bpm === undefined || over) {
      this.held = null;
      return null;
    }
    const same =
      !!this.held &&
      this.held.speed === target.speed &&
      this.held.incline === target.incline &&
      sample.at - this.held.last <= TELEMETRY_MAX_AGE;
    this.held = same ? { ...this.held!, last: sample.at } : { since: sample.at, last: sample.at, ...target };
    return sample.at - this.held.since < ADOPT_HOLD_MS ? null : { ...target, bpm };
  }

  /**
   * Passa o alvo da etapa para a carga que a pessoa manteve acima dele (veja
   * `holding`), no registro como ajuste dela (`by: 'pessoa'`). A carga foi
   * escolha dela: o aviso de ajuste não abre nem toca, e o tempo na carga conta
   * de quando ela chegou a ela, para as regras de sempre (inclusive o aumento)
   * voltarem a valer. Quando a carga medida não é um alvo válido (5,6 km/h, que
   * vira 5,2; correndo com 3% de rampa, que vira 2%), a esteira fica fora do
   * alvo novo, e os aumentos esperam a pessoa ir até ele; o painel diz isso sem
   * bipe. Como um aumento, vale só para a etapa em curso e acaba com a espera
   * pelo efeito de um alívio. Devolve `false` se o treino já saiu da etapa.
   */
  private adopt(index: number, to: { speed: number; incline: number; bpm: number }, sample: TreadmillSample) {
    const active = this.state.active;
    const plan = active?.plan;
    const g = this.state.guidance;
    const stage = plan?.stages[index];
    if (!active || !plan || !g || !stage || !this.held) return false;
    const elapsed = Math.floor(active.totals.movingMs / 1000);
    const change: Change = {
      second: elapsed,
      stage: index,
      decision: ADOPT_LOAD,
      bpm: to.bpm,
      from: [stage.speed, stage.incline],
      to: [to.speed, to.incline],
      by: 'pessoa',
    };
    const stages = plan.stages.map((s, i) => (i === index ? { ...s, speed: to.speed, incline: to.incline } : s));
    const next = { ...active, plan: { ...plan, stages }, changes: [...(active.changes ?? []), change] };
    const cue = currentCue(next.plan, elapsed);
    if (!cue || cue.index !== index) return false;
    saveWorkout(next);
    // A resposta da IA que ainda não voltou era para o alvo antigo.
    this.cancelReview();
    this.reliefIndex = -1;
    this.reachedSince = this.held.since;
    this.held = null;
    const incline = formatDecimal(to.incline, Number.isInteger(to.incline) ? 0 : 1) + '%';
    const guidance = advanceGuidance(g, cue, sample, sample.at);
    this.update({
      active: next,
      // O ajuste já está feito: sem isso, o alvo novo mudaria a chave do aviso
      // (`cueKey`), e um aviso aberto ou minimizado voltaria a tocar.
      guidance: guidance && { ...guidance, adjusted: true },
      coach: 'Alvo ajustado à esteira · ' + formatDecimal(to.speed, 1) + ' km/h e ' + incline + ' · ' + to.bpm + ' BPM',
    });
    return true;
  }

  /**
   * Muda a carga da etapa pela regra local. O tamanho do ajuste sai dos bpm
   * que ele busca e da reta entre carga e frequência cardíaca da pessoa. Numa
   * correção fora da faixa (`fix`), quanto mais longe dela, maior o degrau. No
   * ajuste fino dentro da faixa, `room` são os bpm que cabem até o teto: se
   * nenhum degrau cabe neles, a carga fica como está. `prefix` abre o texto do
   * painel.
   */
  private adjust(
    w: Workout,
    index: number,
    fix: Correction | null,
    room: number,
    features: Features,
    zone: Zone,
    load: Load,
    sample: TreadmillSample,
    by: NonNullable<Change['by']>,
    prefix = '',
  ) {
    const { stage } = load;
    const bpm = features.median + ' BPM';
    const side =
      prefix +
      (!fix
        ? features.belowTop + ' bpm abaixo do teto · '
        : fix === 'aliviar'
          ? 'Acima da faixa · '
          : 'Abaixo da faixa · ');
    const cost = metabolicCost(sample.speedKmh ?? stage.speed, sample.inclinationPercent ?? stage.incline);
    const slope = bpmPerMet(features.median, cost, w.hr?.rest ?? null);
    const want = fix ? correctionBpm(fix, features, zone) : room;
    const revised = correctedStage(stage, fix ?? 'subir', want / slope, sample, !fix);
    if (revised === stage) {
      const limit = !fix
        ? ' · o próximo degrau passaria do teto'
        : fix === 'aliviar'
          ? ' · ' + unchangedRelief(sample, stage)
          : ' · carga já no máximo';
      this.update({ coach: side + bpm + limit });
      return;
    }
    if (!this.commit(index, revised, fix ?? 'subir', features.median, sample, sample.at, by)) return;
    this.update({ coach: side + bpm + (fix === 'aliviar' ? ' · carga reduzida' : ' · carga aumentada') });
  }

  /**
   * Pede à IA a revisão da carga e aplica a resposta, se ela ainda valer. A IA
   * escolhe entre o que o app aceita agora: manter sempre; reduzir com o BPM do
   * momento (o `now` do prompt) na faixa ou acima dela; aumentar só quando a
   * regra local deixaria subir, e até onde ela subiria. Quando só "manter" é
   * aceito (etapa leve ou bloco com o BPM abaixo da faixa e a carga sem poder
   * subir) não há o que ela decidir: a chamada não é feita, e o painel mostra
   * o veredito do app. Em 27/11 foram 59 das 71 consultas do treino, todas de
   * volta com "manter". Sem resposta (erro, sem
   * chave, mais de 28 s ou resposta fora do formato, como uma decisão fora das
   * aceitas) vale a regra local, `fix` e `room`, que abaixo da faixa nunca
   * corta a carga.
   */
  private async review(
    w: Workout,
    cue: Cue,
    load: Load,
    features: Features,
    zone: Zone,
    fix: Correction | null,
    room: number,
    sample: TreadmillSample,
    samples: TreadmillSample[],
  ) {
    const live = livePulse(samples, sample.at);
    const seen = live?.bpm ?? features.median;
    const maxRaiseBpm = fix === 'subir' ? correctionBpm(fix, features, zone) : room;
    // Abaixo da faixa não há o que reduzir: em 24/11 a projeção pela reta pedia
    // 15 bpm a menos com o BPM 11 abaixo do piso.
    const allowed: ReviewDecision[] = ['manter'];
    if (seen >= zone.low) allowed.push('reduzir');
    if (maxRaiseBpm > 0) allowed.push('aumentar');
    // Só "manter": não há decisão a pedir, e o veredito do app diz o porquê.
    if (allowed.length === 1) {
      this.update({ coach: localVerdict(features, load) });
      return;
    }
    const token = ++this.reviewToken;
    const abort = new AbortController();
    this.reviewAbort = abort;
    this.reviewing = true;
    const since = this.sinceRelief(cue.index, sample.at);
    const sinceRelief = Number.isFinite(since) ? since / 1000 : null;
    this.update({ coach: 'IA analisando ' + seen + ' BPM…' });
    let reply: ReviewReply | null = null;
    try {
      reply = await reviewLoad(
        {
          workout: w,
          index: cue.index,
          left: cue.left,
          load,
          features,
          live,
          samples,
          now: sample.at,
          allowed,
          maxRaiseBpm,
          sinceRelief,
          gait: this.state.gait,
        },
        { signal: abort.signal },
      );
    } catch {
      // Sem resposta a revisão segue com a conta do app, logo abaixo.
    }
    // A trava, a troca de etapa, um ajuste, o fim do treino e "Apagar dados" cancelam a revisão.
    if (token !== this.reviewToken) return;
    this.reviewAbort = null;
    this.reviewing = false;
    try {
      const last = this.current(w.id, cue.index, load.stage);
      // Um aumento só sai com a esteira ainda nos alvos, e com a pessoa na lona:
      // a resposta pode chegar 28 s depois do pedido.
      const g = this.state.guidance;
      const now = {
        ...load,
        reached: !!g?.speedReached && !!g.inclineReached,
        offBelt: !!load.offBelt || (!!last && this.offBeltRecently(last.at)),
      };
      if (!last) this.update({ coach: 'Aguardando nova leitura' });
      // A pessoa mexeu na esteira enquanto a IA pensava: a resposta (e a regra
      // local) era para a carga de antes, e um corte feito a partir da nova
      // somaria o dela ao da IA.
      else if (!sameMeasuredLoad(last, sample))
        this.update({ coach: 'A esteira mudou durante a análise · a próxima revisão decide' });
      else if (reply) this.apply(w, cue.index, reply, features, zone, now, maxRaiseBpm, live, last);
      else if (!(fix || room) || !now.reached || !this.fresh(last, Date.now()))
        this.update({ coach: OFFLINE + localVerdict(features, now) });
      // A trava vence também a regra local: com o BPM do momento acima do teto, a carga não sobe.
      else if (this.overTop(zone, last.at))
        this.update({ coach: OFFLINE + 'Acima do teto · carga mantida' });
      // A regra local que chega aqui sempre sobe a carga: fora da lona, não.
      else if (now.offBelt) this.update({ coach: OFFLINE + 'Fora da lona · carga mantida' });
      else this.adjust(w, cue.index, fix, room, features, zone, load, last, 'app', OFFLINE);
    } catch {
      this.update({ error: SAVE_ERROR });
    }
  }

  /**
   * A amostra mais recente, se uma resposta pedida para esta etapa e esta carga
   * ainda vale: mesmo treino, mesma etapa, os mesmos alvos e a lona andando.
   * Senão, `null`. A velocidade e a inclinação recentes só são exigidas para
   * mudar a carga: sem elas o painel ainda mostra o veredito. A carga medida
   * do pedido é conferida à parte (`sameMeasuredLoad`).
   */
  private current(id: string, index: number, sent: Stage) {
    const active = this.state.active;
    const stage = active?.plan?.stages[index];
    const last = this.treadmill.getSnapshot().samples.at(-1);
    const same =
      active?.id === id &&
      this.state.guidance?.index === index &&
      stage?.speed === sent.speed &&
      stage.incline === sent.incline;
    return same && last && (last.speedKmh ?? 0) > 0 ? last : null;
  }

  /**
   * Aplica a decisão da IA. Os bpm pedidos ficam presos aos limites: de 1 a 15
   * ao reduzir, e ao aumentar até o que a regra local subiria. A conversão para
   * a carga é a mesma da regra local. A trava vence a IA: com o BPM do momento
   * acima do teto, a carga não sobe.
   */
  private apply(
    w: Workout,
    index: number,
    reply: ReviewReply,
    features: Features,
    zone: Zone,
    load: Load,
    maxRaiseBpm: number,
    live: Live | null,
    sample: TreadmillSample,
  ) {
    const { stage } = load;
    const note = reply.reason ? ' · ' + reply.reason : '';
    if (reply.decision === 'manter') {
      this.update({ coach: 'IA' + (note || ' · manter') });
      return;
    }
    const raise = reply.decision === 'aumentar';
    if (raise && this.overTop(zone, sample.at)) {
      this.update({ coach: 'IA · acima do teto, carga mantida' + note });
      return;
    }
    if (raise && load.offBelt) {
      this.update({ coach: 'IA · fora da lona, carga mantida' + note });
      return;
    }
    if (raise && !load.reached) {
      this.update({ coach: 'IA · ajuste a esteira aos alvos' + note });
      return;
    }
    if (!this.fresh(sample, Date.now())) {
      this.update({ coach: 'IA · aguardando a leitura da esteira' + note });
      return;
    }
    const bpm = Math.min(raise ? maxRaiseBpm : MAX_REDUCE_BPM, Math.max(1, reply.bpm));
    const cost = metabolicCost(sample.speedKmh ?? stage.speed, sample.inclinationPercent ?? stage.incline);
    const slope = bpmPerMet(features.median, cost, w.hr?.rest ?? null);
    const exact = raise && features.position === 'na faixa';
    const revised = correctedStage(stage, raise ? 'subir' : 'aliviar', bpm / slope, sample, exact);
    if (revised === stage) {
      const limit = !raise
        ? unchangedRelief(sample, stage)
        : exact
          ? 'o próximo degrau passaria do teto'
          : 'carga já no máximo';
      this.update({ coach: 'IA · ' + limit + note });
      return;
    }
    const seen = live?.bpm ?? features.median;
    if (!this.commit(index, revised, raise ? 'subir' : 'aliviar', seen, sample, sample.at, 'ia')) return;
    this.update({ coach: 'IA · ' + (raise ? 'carga aumentada' : 'carga reduzida') + note });
  }

  /** Cancela a revisão da IA em curso: a resposta dela não é mais aplicada. */
  private cancelReview() {
    this.reviewAbort?.abort();
    this.reviewAbort = null;
    this.reviewToken++;
    this.reviewing = false;
  }

  private resetReview() {
    this.cancelReview();
    this.lastReview = -Infinity;
    this.lastChange = -Infinity;
    this.lastRelief = -Infinity;
    this.reliefIndex = -1;
    this.lastFloor = -Infinity;
    this.lastRealert = -Infinity;
    this.overSince = null;
    this.stageReached = false;
    this.held = null;
    this.lastPulse = -Infinity;
    this.contactStart = 0;
    this.reachedSince = null;
    this.early = [];
    this.restDone = false;
    this.running = null;
    this.belt = null;
    this.cadence = null;
    this.offBeltAt = -Infinity;
    this.ends = [];
    this.decidedAt = -1;
    this.planned = new Map();
    this.liveIndex = -1;
    this.lastLive = null;
    this.missingLive = 0;
  }

  /**
   * Grava os alvos novos da etapa, com quem decidiu (`by`), e reabre o aviso de
   * ajuste. Cancela a revisão da IA em curso, pedida para a carga antiga, e
   * recomeça a conta da carga mantida acima do alvo (`holding`).
   * Devolve `false` se o treino já saiu dessa etapa. `kind` diz se o ajuste é
   * um alívio: o nome no registro não basta, porque o aumento de uma corrida
   * com rampa antiga acima de 2% baixa a rampa.
   */
  private commit(
    index: number,
    revised: Stage,
    kind: Correction,
    bpm: number,
    last: TreadmillSample,
    now: number,
    by: NonNullable<Change['by']>,
  ) {
    const active = this.state.active;
    const plan = active?.plan;
    const g = this.state.guidance;
    const stage = plan?.stages[index];
    if (!active || !plan || !g || !stage) return false;
    const zone = dailyTarget(plan, active.profile, active.hr);
    // O mesmo arredondamento de `receive`: o pedido de batimentos em vigor sai deste número.
    const elapsed = Math.floor(active.totals.movingMs / 1000);
    // Só a redução de um bloco de esforço passa para os blocos seguintes: todo
    // bloco de esforço que ainda vem e custa mais que a carga nova fica com ela.
    // Sem isso o próximo voltaria à carga que acabou de passar do teto. Um
    // aumento vale só para a etapa em curso: ele sai do BPM deste bloco, e num
    // treino de tiros a FC parte de mais alto a cada tiro.
    const relief = kind === 'aliviar';
    // Um alívio que tirou a pessoa da corrida vale só para este bloco: os
    // seguintes herdam no máximo o piso da corrida, 6 km/h com a menor rampa de
    // corrida que este bloco já teve. Sem isso um corte a 6 km/h derrubava o
    // resto do treino de tiros para a caminhada, e nada a trazia de volta.
    // Valem as cargas que o app decidiu para o bloco (a de antes do primeiro
    // ajuste e a de depois de cada um), e não as que a pessoa escolheu e o app
    // adotou (`by: 'pessoa'`): a escolha dela não vira piso de ninguém.
    const own = (active.changes ?? []).filter((c) => c.stage === index && c.by !== 'bloco');
    const planned = own[0]?.from;
    const decided = [
      planned ? { speed: planned[0], incline: planned[1] } : stage,
      ...own.filter((c) => c.by !== 'pessoa').flatMap((c) => (c.to ? [{ speed: c.to[0], incline: c.to[1] }] : [])),
    ];
    const floor = relief && revised.speed < RUN_FROM_KMH ? runFloor(decided) : null;
    const heir = floor ?? revised;
    const cost = metabolicCost(heir.speed, heir.incline);
    // Um alvo abaixo de 3 km/h, o piso, vale só para este bloco: sai de quem já
    // baixou a esteira até ali, e não diz nada da carga dos seguintes.
    const spread = relief && !stage.measure && heir.speed >= EASY_FLOOR_KMH;
    const stages = plan.stages.map((s, i) =>
      i === index
        ? { ...s, speed: revised.speed, incline: revised.incline }
        : spread && i > index && !s.measure && metabolicCost(s.speed, s.incline) > cost
          ? { ...s, speed: heir.speed, incline: heir.incline }
          : s,
    );
    const change: Change = {
      second: elapsed,
      stage: index,
      decision: changeLabel(stage, revised),
      bpm,
      from: [stage.speed, stage.incline],
      to: [revised.speed, revised.incline],
      by,
    };
    const next = {
      ...active,
      plan: { ...plan, stages },
      changes: [...(active.changes ?? []), change],
    };
    const cue = currentCue(next.plan, elapsed);
    if (!cue || cue.index !== index) return false;
    saveWorkout(next);
    this.cancelReview();
    this.lastChange = now;
    this.held = null;
    // A espera pelo efeito de um alívio só vale para o feito com o BPM acima do
    // teto; um aumento acaba com ela.
    if (relief && bpm > zone.high) {
      this.lastRelief = now;
      this.reliefIndex = index;
    } else if (!relief) this.reliefIndex = -1;
    this.reachedSince = null;
    const guidance = advanceGuidance({ ...g, adjusted: false, targetsSince: now }, cue, last, now);
    this.update({ active: next, guidance, minimizedCue: null });
    return true;
  }

  /** Encerra o treino em curso. `wish` falso só quando outro começa em seguida. */
  finish(reason: string, wish = true) {
    if (!this.state.active) return;
    const done = { ...this.state.active, ended: Date.now(), reason };
    saveWorkout(done);
    try {
      this.track?.flush();
    } catch {
      // O registro já está salvo; a trilha perde só os últimos segundos.
    }
    this.track = null;
    this.resetReview();
    this.waitForStop = true;
    const kcal = energyKcal(done);
    this.update({
      active: null,
      guidance: null,
      minimizedCue: null,
      // O gasto estimado fica no painel até o próximo treino começar.
      coach: kcal ? 'Treino encerrado · cerca de ' + kcal + ' kcal' : '',
      tip: '',
      gait: null,
      nextBlock: null,
      recovery: null,
      history: [done, ...this.state.history],
    });
    if (wish) this.wish();
    void this.evaluate(done);
  }

  async evaluate(w: Workout) {
    if (this.state.assessing.includes(w.id) || w.estimate) return;
    this.update({ assessing: [...this.state.assessing, w.id], error: '' });
    try {
      const history = this.state.history.filter(
        (h) => h.source === w.source && h.started < w.started,
      );
      // Sessão curta ou sem leituras não vai à IA: não há o que ela avaliar.
      const estimate = insufficient(w)
        ? {
            level: levels[0],
            summary:
              'Foram ' +
              Math.floor(w.totals.movingMs / 60000) +
              ' min em movimento e ' +
              w.totals.bpmCount +
              ' leituras de BPM. A avaliação precisa de pelo menos 3 minutos e 10 leituras.',
          }
        : await assess(w, history);
      // Os dados podem ter sido apagados enquanto a IA respondia. E o registro
      // pode ter mudado nesse meio-tempo (o horário da gravação na cinta, o FIT
      // baixado): a avaliação entra no que está no histórico agora.
      const current = this.state.history.find((h) => h.id === w.id);
      if (!current) return;
      const done = { ...current, estimate };
      saveWorkout(done);
      this.update({ history: this.state.history.map((h) => (h.id === done.id ? done : h)) });
      // A previsão nova pode mudar a FC máxima em uso, que vai para a cinta.
      this.wish();
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : 'Avaliação pendente.' });
    } finally {
      this.update({ assessing: this.state.assessing.filter((id) => id !== w.id) });
    }
  }
}

/** As medidas de prontidão guardadas; sem conseguir ler o banco, nenhuma. */
function loadReadiness(): ReadinessRecord[] {
  try {
    return readReadiness() ?? [];
  } catch {
    return [];
  }
}

/**
 * Até onde vai a trilha de um treino encerrado, em segundos de relógio desde o
 * início. Com o app morto, o fim guardado é o início mais o tempo em
 * movimento (não se sabe a hora real), então vale o maior entre ele, o último
 * segundo gravado e a duração do plano com 15 min de folga para as pausas.
 */
function trackSpan(w: Workout, lastSecond: number) {
  const wall = ((w.ended ?? w.started) - w.started) / 1000;
  if (w.reason !== 'App interrompido') return Math.max(wall, lastSecond + 1);
  return Math.max(wall, lastSecond + 1, w.plan ? w.plan.minutes * 60 + 900 : 0);
}

/** As duas amostras têm a mesma carga medida, dentro da tolerância com que o guia dá um alvo por atingido. */
function sameMeasuredLoad(a: TreadmillSample, b: TreadmillSample) {
  const near = (x: number | null, y: number | null, tolerance: number) =>
    x === null || y === null ? x === y : Math.abs(x - y) < tolerance;
  return (
    near(a.speedKmh, b.speedKmh, SPEED_TOLERANCE_KMH) &&
    near(a.inclinationPercent, b.inclinationPercent, INCLINE_TOLERANCE_PERCENT)
  );
}

/**
 * O que o painel diz de um alívio que não mudou nada. Com a esteira acima de
 * algum alvo, o corte pedido a partir da carga medida não chega abaixo do alvo
 * em vigor: a pessoa ainda não fez o corte anterior, e a carga não está no
 * mínimo. Com ela plana e abaixo de 3 km/h, a carga está além do piso.
 */
function unchangedRelief(sample: TreadmillSample, stage: Stage) {
  const speed = sample.speedKmh ?? 0;
  const above =
    speed > stage.speed + SPEED_TOLERANCE_KMH ||
    (sample.inclinationPercent ?? 0) > stage.incline + INCLINE_TOLERANCE_PERCENT;
  if (above) return 'ajuste a esteira aos alvos';
  // Plana e abaixo de 3 km/h, mais leve que o alvo: a pessoa já foi além do piso.
  if (speed < EASY_FLOOR_KMH && speed < stage.speed - SPEED_TOLERANCE_KMH)
    return 'carga já abaixo do piso de ' + formatDecimal(EASY_FLOOR_KMH, 0) + ' km/h';
  return 'carga já no mínimo';
}

/** O que o painel mostra quando a revisão não muda a carga. */
function localVerdict(f: Features, load: Load) {
  const bpm = f.median + ' BPM';
  // Acima do teto sem alívio: o anterior ainda está fazendo efeito.
  if (f.position === 'acima') return 'Acima da faixa · ' + bpm + ' · aguardando o efeito da redução';
  // Nos trechos leves e nas sessões de recuperação ninguém busca o teto da faixa.
  if (load.easy) {
    if (f.position === 'na faixa') return 'Na faixa · ' + bpm;
    return load.stage.measure ? 'Etapa leve · ' + bpm : 'Abaixo do teto · ' + bpm;
  }
  if (f.belowTop <= 0) return 'No teto da faixa · ' + bpm;
  if (f.position === 'na faixa' && f.belowTop <= AIM_SPAN_BPM) return 'No alvo · ' + bpm;
  const gap = f.belowTop + ' bpm abaixo do teto · ' + bpm;
  if (!load.reached) return gap + ' · ajuste a esteira aos alvos';
  // Parada ao lado da lona a FC cai: esse BPM não pede mais carga.
  if (load.offBelt) return gap + ' · fora da lona: a carga não sobe';
  // Num tiro a FC ainda sobe até o fim: a carga não sobe no meio dele.
  if (load.short) return gap + ' · tiro curto: a carga não sobe no meio';
  if (load.secondsAtLoad < STEADY_SECONDS) return gap + ' · menos de ' + STEADY_SECONDS + ' s nesta carga';
  if (f.trend === 'subindo') return gap + ' · BPM ainda subindo';
  if (load.closing) return gap + ' · fim do bloco';
  // O que sobra é a carga nova, em que a FC ainda sobe sozinha alguns bpm.
  return gap + ' · BPM ainda se ajustando à carga';
}
