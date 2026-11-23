import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { ConsoleEvent, TreadmillSample } from '@/treadmill/types';
import { formatDecimal } from '@/utils/format';
import {
  changeLabel,
  correctedStage,
  correction,
  correctionBpm,
  livePulse,
  MAX_REDUCE_BPM,
  pulseFeatures,
  pulseWindow,
  raiseRoom,
  RELIEF_SETTLE_SECONDS,
  SHORT_BLOCK_SECONDS,
  STEADY_SECONDS,
  URGENT_EXCESS_BPM,
  type Correction,
  type Features,
  type Live,
  type Load,
} from './adaptive';
import { assess, reviewLoad } from './ai';
import { advanceGuidance, type Cue, type Guidance } from './guidance';
import {
  accumulate,
  currentCue,
  emptyLog,
  insufficient,
  levels,
  logBeats,
  logLoads,
  logStage,
  metabolicCost,
  newWorkout,
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
  heartProfile,
  restingBpm,
  type Pulse,
} from './physiology';
import type { ReviewDecision, ReviewReply } from './prompts';
import {
  clearData,
  clearSource,
  deleteWorkout,
  readProfile,
  readWorkouts,
  saveProfile,
  saveWorkout,
} from './storage';

/** Intervalo mínimo entre revisões quando a pessoa volta a segurar o sensor. */
const CONTACT_REVIEW_GAP = 20_000;
/**
 * Intervalo entre revisões com leitura contínua (a cinta no peito, ou o sensor
 * seguro o tempo todo): a IA olha o treino a cada 30 s. A mediana das regras
 * locais continua sendo a do último minuto.
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
 * Depois de um alívio a trava espera 30 s: a pessoa ainda está mexendo no
 * painel, e a FC sobe mais um pouco antes de responder. É também por quanto
 * ela segura o aviso de carga já no mínimo, em vez de refazer a conta a cada
 * segundo, e o intervalo entre dois avisos de um corte que não chegou ao painel.
 */
const GUARD_WAIT = 30_000;
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
/** O começo do texto do painel quando a IA não respondeu e o app seguiu com a própria conta. */
const OFFLINE = 'Sem IA · ';
const SAVE_ERROR = 'Falha ao gravar o treino no aparelho. Confira o espaço disponível.';

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
  /** Horário em que a trava achou a carga já no mínimo. */
  private lastFloor = -Infinity;
  /** Horário do último aviso de que a esteira está acima dos alvos com o BPM acima do teto. */
  private lastRealert = -Infinity;
  /** A esteira já chegou aos alvos desta etapa ao menos uma vez. */
  private stageReached = false;
  private stageSince = 0;
  /** Desde quando a esteira está nos alvos da etapa. */
  private reachedSince: number | null = null;
  private contactStart = 0;
  private lastPulse = -Infinity;
  /** Leituras do início do treino, de onde sai a FC de repouso do dia. */
  private early: Pulse[] = [];
  private restDone = false;
  private checkpoint = 0;
  private waitForStop = false;
  private state = {
    profile: readProfile(),
    coach: '',
    guidance: null as Guidance | null,
    minimizedCue: null as string | null,
    active: null as Workout | null,
    history: [] as Workout[],
    assessing: [] as string[],
    error: '',
  };

  constructor(private treadmill: TreadmillStore) {
    // As sessões da esteira simulada valem só enquanto o app está aberto: não
    // aparecem em tela nenhuma, então não há por que guardá-las.
    clearSource('demo');
    this.state.history = readWorkouts().map((w) => {
      if (w.ended) return w;
      const recovered = { ...w, ended: w.started + w.totals.movingMs, reason: 'App interrompido' };
      saveWorkout(recovered);
      return recovered;
    });
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

  connect = () =>
    this.treadmill.subscribe(() => {
      try {
        this.receive();
      } catch {
        this.update({ error: SAVE_ERROR });
      }
    });

  minimizeCue(key: string | null) {
    this.update({ minimizedCue: key });
  }

  setProfile(profile: Profile) {
    saveProfile(profile);
    this.update({ profile });
  }

  /**
   * Apaga perfil, treinos e diário do aparelho e volta à primeira abertura. O
   * registro em curso é descartado. A chave da DeepSeek não é tocada.
   */
  reset() {
    this.resetReview();
    clearData();
    this.previous = null;
    // Com a lona andando, um registro novo só começa depois de uma parada.
    this.waitForStop = true;
    this.update({
      profile: null,
      coach: '',
      guidance: null,
      minimizedCue: null,
      active: null,
      history: [],
      assessing: [],
      error: '',
    });
  }

  /** Apaga um registro encerrado do histórico. O treino em curso não está nele. */
  remove(id: string) {
    deleteWorkout(id);
    this.update({ history: this.state.history.filter((w) => w.id !== id) });
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
    // a leitura que aquele registro fez, se fez.
    const walking = !!active && active.totals.movingMs > 0;
    if (active) this.finish('Início do treino guiado');
    const workout = {
      ...newWorkout(profile, machine.mode, plan, heartProfile(profile, this.sameSource(machine.mode))),
      restBpm: walking ? (active.restBpm ?? null) : null,
    };
    saveWorkout(workout);
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
    this.update({ active: workout, guidance, minimizedCue: null, coach: '', error: '' });
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
    if (!this.state.active && moving && !this.waitForStop && this.state.profile) this.start(null);
    const w = this.state.active;
    if (w) {
      const totals = accumulate(w.totals, sample, this.previous);
      const elapsed = Math.floor(totals.movingMs / 1000);
      const cue = w.plan && currentCue(w.plan, elapsed);
      let next = this.measureRest({ ...w, totals }, sample, moving);
      next = {
        ...next,
        beats: logBeats(next.beats, sample, this.previous, elapsed),
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
        log[index] = logStage(log[index], sample, this.previous, zone, cue ? cue.into : elapsed);
        next = { ...next, log };
      }
      if (sample.at - this.checkpoint >= 10000) {
        saveWorkout(next);
        this.checkpoint = sample.at;
      }
      const previous = this.state.guidance;
      let coach = this.state.coach;
      if (cue && previous?.index !== cue.index) {
        this.stageSince = sample.at;
        // O tempo na carga conta de novo em cada etapa, mesmo que a esteira já esteja nos alvos dela.
        this.reachedSince = null;
        // Uma resposta da IA pedida na etapa anterior não vale para esta: o painel deixa de esperá-la.
        if (this.reviewing) coach = '';
        this.cancelReview();
        this.lastFloor = -Infinity;
        this.lastRealert = -Infinity;
        this.stageReached = false;
      }
      const guidance = advanceGuidance(previous, cue, sample, sample.at);
      this.update({ active: next, guidance, coach });
      if (w.plan && totals.movingMs >= w.plan.minutes * 60000) this.finish('Duração concluída');
      else if (cue && guidance && moving) this.consider(next, cue, guidance, sample, s.samples);
    }
    this.previous = sample;
  }

  /** Guarda a FC de repouso do dia assim que as primeiras leituras do treino bastarem. */
  private measureRest(w: Workout, sample: TreadmillSample, moving: boolean): Workout {
    if (this.restDone) return w;
    const closed = w.totals.movingMs > REST_WINDOW_SECONDS * 1000;
    if (!closed && moving && validBpm(sample.heartRateBpm))
      this.early.push({ at: sample.at, bpm: sample.heartRateBpm });
    const rest = restingBpm(this.early, closed);
    if (rest === null && !closed) return w;
    this.restDone = true;
    if (rest === null) return w;
    const measured = { ...w, restBpm: rest };
    // A faixa do dia é refeita com a medição de hoje.
    return { ...measured, hr: heartProfile(w.profile, [measured, ...this.sameSource(w.source)]) };
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
    };
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
   * chegou ao painel: outro, feito a partir do alvo, somaria os dois sem a FC
   * ter respondido a nenhum. O app reabre o aviso de ajuste, com bipes, e diz
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
    const parts: string[] = [];
    if ((sample.speedKmh ?? 0) > stage.speed + SPEED_TOLERANCE_KMH)
      parts.push(formatDecimal(stage.speed, 1) + ' km/h');
    // A rampa anda de meio em meio ponto: 7,5% ou 2%, sem o ",0".
    if ((sample.inclinationPercent ?? 0) > stage.incline + INCLINE_TOLERANCE_PERCENT)
      parts.push(formatDecimal(stage.incline, Number.isInteger(stage.incline) ? 0 : 1) + '%');
    const target = parts.length ? parts.join(' e ') : formatDecimal(stage.speed, 1) + ' km/h';
    // O aviso reabre como num ajuste novo: os alvos em vigor passam a valer de agora.
    const guidance = advanceGuidance({ ...g, adjusted: false, targetsSince: sample.at }, cue, sample, sample.at);
    this.lastRealert = sample.at;
    this.update({ guidance, minimizedCue: null, coach: head + ' · reduza para ' + target });
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
   * Decide o que as leituras pedem. Primeiro a trava (`guard`), a cada amostra.
   * Depois, a cada 30 s com leitura contínua ou a cada pegada no sensor, a
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
    if (this.guard(w, cue.index, g, sample, samples, zone)) return;
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
   * A trava: com a cinta, num bloco de esforço, alivia a carga assim que o BPM
   * do momento passa do teto, sem esperar a mediana do minuto nem a IA. A
   * mediana demora: no tiro de 4 minutos de 22/11 ela só acusou o excesso a
   * 25 s do fim, depois de 89 s acima do teto. BPM acima do teto num bloco de
   * esforço nunca fica sem reação: um corte novo ou, com um corte que ainda não
   * chegou ao painel, o aviso reaberto. Nas etapas leves a trava não age: nelas
   * o BPM vem caindo sozinho do bloco anterior. No começo do bloco ela espera a
   * esteira chegar aos alvos, por até 30 s. Depois de um alívio de excesso
   * nesta etapa, de quem for, ela espera 30 s, e até 3 minutos depois dele só
   * corta de novo com 3 bpm ou mais de excesso e o BPM sem cair. O corte parte
   * da carga medida, quando ela está abaixo do alvo, leva o BPM a 3 abaixo do
   * teto e tira também a subida dos últimos 30 s (até 10 bpm), que ainda vai
   * chegar. Devolve `true` quando agiu.
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
    if (!stage || stage.measure || !this.fresh(sample)) return false;
    const live = livePulse(samples, sample.at);
    if (!live || live.bpm <= zone.high || sample.at - this.lastFloor < GUARD_WAIT) return false;
    // No começo do bloco a lona ainda acelera desde a etapa leve, e o BPM é o do
    // bloco anterior: um corte feito dali iria para todos os blocos seguintes.
    if (!this.stageReached && sample.at - this.stageSince < BLOCK_START_GRACE) return false;
    const sinceRelief = this.sinceRelief(index, sample.at);
    if (sinceRelief < GUARD_WAIT) return false;
    const text = 'Acima do teto · ' + live.bpm + ' BPM';
    if (this.realert(index, g, sample, text)) return true;
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
      this.update({ coach: text + ' · carga já no mínimo' });
      return true;
    }
    if (!this.commit(index, revised, 'aliviar', live.bpm, sample, sample.at, 'trava')) return false;
    // A revisão recomeça a contar daqui; a resposta da IA que ainda não voltou era para a carga antiga.
    this.lastReview = sample.at;
    this.update({ coach: text + ' · carga reduzida' });
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
          ? ' · carga já no mínimo'
          : ' · carga já no máximo';
      this.update({ coach: side + bpm + limit });
      return;
    }
    if (!this.commit(index, revised, fix ?? 'subir', features.median, sample, sample.at, by)) return;
    this.update({ coach: side + bpm + (fix === 'aliviar' ? ' · carga reduzida' : ' · carga aumentada') });
  }

  /**
   * Pede à IA a revisão da carga e aplica a resposta, se ela ainda valer. A IA
   * escolhe entre o que o app aceita agora: manter e reduzir sempre; aumentar
   * só quando a regra local deixaria subir, e até onde ela subiria. Sem
   * resposta (erro, sem chave, mais de 12 s ou resposta fora do formato) vale
   * a regra local, `fix` e `room`.
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
    const token = ++this.reviewToken;
    const abort = new AbortController();
    this.reviewAbort = abort;
    this.reviewing = true;
    const live = livePulse(samples, sample.at);
    const maxRaiseBpm = fix === 'subir' ? correctionBpm(fix, features, zone) : room;
    const since = this.sinceRelief(cue.index, sample.at);
    const sinceRelief = Number.isFinite(since) ? since / 1000 : null;
    const allowed: ReviewDecision[] =
      maxRaiseBpm > 0 ? ['manter', 'reduzir', 'aumentar'] : ['manter', 'reduzir'];
    this.update({ coach: 'IA analisando ' + (live?.bpm ?? features.median) + ' BPM…' });
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
      // Um aumento só sai com a esteira ainda nos alvos: a resposta pode chegar 12 s depois do pedido.
      const g = this.state.guidance;
      const now = { ...load, reached: !!g?.speedReached && !!g.inclineReached };
      if (!last) this.update({ coach: 'Aguardando nova leitura' });
      else if (reply) this.apply(w, cue.index, reply, features, zone, now, maxRaiseBpm, live, last);
      else if (!(fix || room) || !now.reached || !this.fresh(last, Date.now()))
        this.update({ coach: OFFLINE + localVerdict(features, now) });
      // A trava vence também a regra local: com o BPM do momento acima do teto, a carga não sobe.
      else if (this.overTop(zone, last.at))
        this.update({ coach: OFFLINE + 'Acima do teto · carga mantida' });
      else this.adjust(w, cue.index, fix, room, features, zone, load, last, 'app', OFFLINE);
    } catch {
      this.update({ error: SAVE_ERROR });
    }
  }

  /**
   * A amostra mais recente, se uma resposta pedida para esta etapa e esta carga
   * ainda vale: mesmo treino, mesma etapa, os mesmos alvos e a lona andando.
   * Senão, `null`. A velocidade e a inclinação recentes só são exigidas para
   * mudar a carga: sem elas o painel ainda mostra o veredito.
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
        ? 'carga já no mínimo'
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
    this.stageReached = false;
    this.lastPulse = -Infinity;
    this.contactStart = 0;
    this.reachedSince = null;
    this.early = [];
    this.restDone = false;
  }

  /**
   * Grava os alvos novos da etapa, com quem decidiu (`by`), e reabre o aviso de
   * ajuste. Cancela a revisão da IA em curso, pedida para a carga antiga.
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
    const cost = metabolicCost(revised.speed, revised.incline);
    const stages = plan.stages.map((s, i) =>
      i === index ||
      (relief && i > index && !stage.measure && !s.measure && metabolicCost(s.speed, s.incline) > cost)
        ? { ...s, speed: revised.speed, incline: revised.incline }
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

  finish(reason: string) {
    if (!this.state.active) return;
    const done = { ...this.state.active, ended: Date.now(), reason };
    saveWorkout(done);
    this.resetReview();
    this.waitForStop = true;
    const kcal = energyKcal(done);
    this.update({
      active: null,
      guidance: null,
      minimizedCue: null,
      // O gasto estimado fica no painel até o próximo treino começar.
      coach: kcal ? 'Treino encerrado · cerca de ' + kcal + ' kcal' : '',
      history: [done, ...this.state.history],
    });
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
      // Os dados podem ter sido apagados enquanto a IA respondia.
      if (!this.state.history.some((h) => h.id === w.id)) return;
      const done = { ...w, estimate };
      saveWorkout(done);
      this.update({ history: this.state.history.map((h) => (h.id === done.id ? done : h)) });
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : 'Avaliação pendente.' });
    } finally {
      this.update({ assessing: this.state.assessing.filter((id) => id !== w.id) });
    }
  }
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
  // Num tiro a FC ainda sobe até o fim: a carga não sobe no meio dele.
  if (load.short) return gap + ' · tiro curto: a carga não sobe no meio';
  if (load.secondsAtLoad < STEADY_SECONDS) return gap + ' · menos de ' + STEADY_SECONDS + ' s nesta carga';
  if (f.trend === 'subindo') return gap + ' · BPM ainda subindo';
  if (load.closing) return gap + ' · fim do bloco';
  // O que sobra é a carga nova, em que a FC ainda sobe sozinha alguns bpm.
  return gap + ' · BPM ainda se ajustando à carga';
}
