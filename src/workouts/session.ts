import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { ConsoleEvent, TreadmillSample } from '@/treadmill/types';
import {
  allowedDecisions,
  changeLabel,
  correctedStage,
  correction,
  correctionBpm,
  pulseFeatures,
  pulseWindow,
  REVIEW_READINGS,
  revisedStage,
  STEADY_SECONDS,
  type Correction,
  type Decision,
  type Features,
  type Load,
  type Reading,
} from './adaptive';
import { assess, reviewIntensity } from './ai';
import { advanceGuidance, type Cue, type Guidance } from './guidance';
import {
  accumulate,
  currentCue,
  emptyLog,
  insufficient,
  levels,
  logBeats,
  logStage,
  metabolicCost,
  newWorkout,
  REST_WINDOW_SECONDS,
  validBpm,
  type Plan,
  type Profile,
  type Stage,
  type Workout,
  type Zone,
} from './model';
import {
  bpmPerMet,
  dailyTarget,
  energyKcal,
  heartProfile,
  restingBpm,
  type Pulse,
} from './physiology';
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
/** Intervalo entre revisões com o sensor seguro o tempo todo. */
const CONTINUOUS_REVIEW_GAP = 90_000;
/**
 * Depois de um ajuste, a pessoa leva um tempo para mexer no painel e a FC para
 * começar a responder. O intervalo é menor que o dos pedidos de leitura: a
 * medida seguinte, 3 minutos depois, já pode corrigir de novo.
 */
const CHANGE_COOLDOWN = 60_000;
/** Idade máxima da velocidade e da inclinação medidas para valerem num ajuste. */
const TELEMETRY_MAX_AGE = 5000;
/** Uma revisão em espera há mais que isto é trocada por outra com leituras novas. */
const SUPERSEDE_AFTER = 30_000;
/** Idade máxima das leituras que confirmam uma decisão na hora de aplicá-la. */
const FRESH_WINDOW = 30_000;

export class WorkoutSession {
  private listeners = new Set<() => void>();
  private previous: TreadmillSample | null = null;
  private lastEvent: ConsoleEvent | undefined;
  private reviewToken = 0;
  private reviewAbort: AbortController | null = null;
  private reviewing = false;
  private reviewStarted = 0;
  /** Horário da última leitura já avaliada, pela IA ou pelas regras locais. */
  private lastReview = -Infinity;
  private lastChange = -Infinity;
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
        this.update({
          error: 'Falha ao gravar o treino no aparelho. Confira o espaço disponível.',
        });
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
      next = { ...next, beats: logBeats(next.beats, sample, this.previous, elapsed) };
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
      if (cue && previous?.index !== cue.index) this.stageSince = sample.at;
      const guidance = advanceGuidance(previous, cue, sample, sample.at);
      this.update({ active: next, guidance });
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

  private load(plan: Plan, index: number, g: Guidance, now: number): Load {
    const stage = plan.stages[index];
    const reached = g.speedReached && g.inclineReached;
    return {
      stage,
      easy: stage.measure || plan.objective === 'Recuperação',
      reached,
      secondsAtLoad: reached && this.reachedSince !== null ? (now - this.reachedSince) / 1000 : 0,
    };
  }

  /**
   * Decide o que as leituras recentes pedem. Fora da faixa o app corrige a
   * carga na hora, já na primeira medida e sem consultar a IA: acima do teto
   * em qualquer etapa, abaixo do piso nos blocos de esforço com a esteira nos
   * alvos. Dentro da faixa e abaixo do teto, num bloco de esforço, a leitura
   * vai à IA, que decide se a carga sobe um degrau. O resto fica como está.
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
    this.reachedSince = g.speedReached && g.inclineReached ? (this.reachedSince ?? sample.at) : null;
    const sinceReview = sample.at - this.lastReview;
    const newContact = this.contactStart > this.lastReview && sinceReview >= CONTACT_REVIEW_GAP;
    if (sample.at - this.lastChange < CHANGE_COOLDOWN) return;
    if (!newContact && sinceReview < CONTINUOUS_REVIEW_GAP) return;
    const readings = pulseWindow(samples, this.stageSince, sample.at - 12000);
    if (readings.length < REVIEW_READINGS) return;
    const zone = dailyTarget(w.plan, w.profile, w.hr);
    const features = pulseFeatures(readings, zone);
    if (!features) return;
    const load = this.load(w.plan, cue.index, g, sample.at);
    const latest = readings[readings.length - 1].at;
    const fix = correction(features, load);
    if (fix) {
      // Sem velocidade e inclinação recentes a conta do ajuste fica para a próxima amostra.
      const recent = (at: number | null | undefined) =>
        at != null && sample.at - at <= TELEMETRY_MAX_AGE;
      if (!recent(sample.speedAt) || !recent(sample.inclineAt)) return;
      this.lastReview = latest;
      this.correct(w, cue.index, fix, features, zone, load, sample);
      return;
    }
    if (this.reviewing && sample.at - this.reviewStarted < SUPERSEDE_AFTER) return;
    const allowed = allowedDecisions(features, load);
    this.lastReview = latest;
    if (allowed.length > 1) void this.review(w, cue, readings, features, allowed, load);
    else if (!this.reviewing) this.update({ coach: localVerdict(features, load) });
  }

  /**
   * Corrige a carga de uma leitura fora da faixa. O tamanho do ajuste sai da
   * distância do BPM até o alvo e da reta entre carga e frequência cardíaca da
   * pessoa: quanto mais longe da faixa, maior o degrau.
   */
  private correct(
    w: Workout,
    index: number,
    kind: Correction,
    features: Features,
    zone: Zone,
    load: Load,
    sample: TreadmillSample,
  ) {
    const { stage } = load;
    const bpm = features.median + ' BPM';
    const side = kind === 'aliviar' ? 'Acima da faixa · ' : 'Abaixo da faixa · ';
    const cost = metabolicCost(sample.speedKmh ?? stage.speed, sample.inclinationPercent ?? stage.incline);
    const slope = bpmPerMet(features.median, cost, w.hr?.rest ?? null);
    const revised = correctedStage(stage, kind, correctionBpm(kind, features, zone) / slope, sample);
    if (revised === stage) {
      const limit = kind === 'aliviar' ? ' · carga já no mínimo' : ' · carga já no máximo';
      this.update({ coach: side + bpm + limit });
      return;
    }
    // Uma resposta da IA que ainda não chegou foi pedida para a carga antiga.
    this.reviewAbort?.abort();
    this.reviewAbort = null;
    this.reviewToken++;
    this.reviewing = false;
    if (!this.commit(index, revised, changeLabel(stage, revised), features.median, sample, sample.at))
      return;
    this.update({ coach: side + bpm + (kind === 'aliviar' ? ' · carga reduzida' : ' · carga aumentada') });
  }

  private resetReview() {
    this.reviewAbort?.abort();
    this.reviewAbort = null;
    this.reviewToken++;
    this.reviewing = false;
    this.lastReview = -Infinity;
    this.lastChange = -Infinity;
    this.lastPulse = -Infinity;
    this.contactStart = 0;
    this.reachedSince = null;
    this.early = [];
    this.restDone = false;
  }

  private async review(
    w: Workout,
    cue: Cue,
    readings: Reading[],
    features: Features,
    allowed: Decision[],
    load: Load,
  ) {
    // Leituras novas valem mais que uma resposta que ainda não chegou.
    this.reviewAbort?.abort();
    const token = ++this.reviewToken;
    const abort = new AbortController();
    this.reviewAbort = abort;
    this.reviewing = true;
    this.reviewStarted = this.lastReview;
    this.update({ coach: 'IA analisando ' + features.median + ' BPM…' });
    try {
      const { decision, reason } = await reviewIntensity(
        {
          workout: w,
          index: cue.index,
          left: cue.left,
          load,
          readings,
          features,
          allowed,
          now: this.lastReview,
        },
        { signal: abort.signal },
      );
      if (this.reviewToken !== token) return;
      this.update({ coach: this.apply(cue.index, load.stage, decision, reason) });
    } catch {
      if (this.reviewToken === token)
        this.update({ coach: 'IA indisponível · seguindo o plano salvo' });
    } finally {
      if (this.reviewToken === token) {
        this.reviewing = false;
        this.reviewAbort = null;
      }
    }
  }

  /**
   * Aplica a decisão da IA, se ela ainda couber. A resposta pode chegar bem
   * depois das leituras enviadas: só vale com a mesma etapa, a mesma carga e
   * leituras recentes que ainda admitam a mesma decisão. Devolve o texto do
   * painel.
   */
  private apply(index: number, sent: Stage, decision: Decision, reason: string) {
    const waiting = 'Aguardando nova leitura';
    const active = this.state.active;
    const plan = active?.plan;
    const g = this.state.guidance;
    const samples = this.treadmill.getSnapshot().samples;
    const last = samples.at(-1);
    const now = Date.now();
    const stage = plan?.stages[index];
    if (
      !active ||
      !plan ||
      !g ||
      !stage ||
      g.index !== index ||
      stage.speed !== sent.speed ||
      stage.incline !== sent.incline ||
      !last ||
      !last.speedKmh ||
      now - (last.speedAt ?? 0) > 5000 ||
      now - (last.inclineAt ?? 0) > 5000
    )
      return waiting;
    const fresh = pulseWindow(samples, this.stageSince, now - FRESH_WINDOW);
    const features =
      fresh.length >= REVIEW_READINGS
        ? pulseFeatures(fresh, dailyTarget(plan, active.profile, active.hr))
        : null;
    if (!features || !allowedDecisions(features, this.load(plan, index, g, now)).includes(decision))
      return waiting;
    const note = reason ? ' · ' + reason : '';
    const revised = revisedStage(stage, decision);
    if (revised === stage) return 'IA · manter' + note;
    if (!this.commit(index, revised, decision, features.median, last, now)) return waiting;
    return 'IA · ' + decision + note;
  }

  /**
   * Grava os alvos novos da etapa e reabre o aviso de ajuste. Devolve `false`
   * se o treino já saiu dessa etapa.
   */
  private commit(
    index: number,
    revised: Stage,
    decision: Decision,
    bpm: number,
    last: TreadmillSample,
    now: number,
  ) {
    const active = this.state.active;
    const plan = active?.plan;
    const g = this.state.guidance;
    const stage = plan?.stages[index];
    if (!active || !plan || !g || !stage) return false;
    // O mesmo arredondamento de `receive`: o pedido de batimentos em vigor sai deste número.
    const elapsed = Math.floor(active.totals.movingMs / 1000);
    // O ajuste de um bloco de esforço vale também para os blocos iguais que
    // ainda virão: sem isso o próximo voltaria à carga que acabou de ser corrigida.
    const stages = plan.stages.map((s, i) =>
      i === index ||
      (i > index &&
        !stage.measure &&
        !s.measure &&
        s.speed === stage.speed &&
        s.incline === stage.incline)
        ? { ...s, speed: revised.speed, incline: revised.incline }
        : s,
    );
    const next = {
      ...active,
      plan: { ...plan, stages },
      changes: [...(active.changes ?? []), { second: elapsed, stage: index, decision, bpm }],
    };
    const cue = currentCue(next.plan, elapsed);
    if (!cue || cue.index !== index) return false;
    saveWorkout(next);
    this.lastChange = now;
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

/** O que o painel mostra quando as regras locais resolvem sem consultar a IA. */
function localVerdict(f: Features, load: Load) {
  const bpm = f.median + ' BPM';
  // Nos trechos leves e nas sessões de recuperação ninguém busca o teto da faixa.
  if (load.easy) {
    if (f.position === 'na faixa') return 'Na faixa · ' + bpm;
    return load.stage.measure ? 'Etapa leve · ' + bpm : 'Abaixo do teto · ' + bpm;
  }
  if (f.belowTop <= 0) return 'No teto da faixa · ' + bpm;
  const gap = f.belowTop + ' bpm abaixo do teto · ' + bpm;
  if (!load.reached) return gap + ' · ajuste a esteira aos alvos';
  if (load.secondsAtLoad < STEADY_SECONDS) return gap + ' · menos de ' + STEADY_SECONDS + ' s nesta carga';
  if (f.position === 'abaixo' && f.trend === 'subindo') return gap + ' · BPM ainda subindo';
  return gap + ' · carga já no máximo';
}
