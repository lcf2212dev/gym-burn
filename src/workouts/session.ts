import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { ConsoleEvent, TreadmillSample } from '@/treadmill/types';
import { dailyTarget, pulseWindow, revisedStage } from './adaptive';
import { assess, reviewIntensity } from './ai';
import { advanceGuidance, type Guidance } from './guidance';
import { accumulate, currentCue, newWorkout, type Plan, type Profile, type Workout } from './model';
import { readProfile, readWorkouts, saveProfile, saveWorkout } from './storage';

export class WorkoutSession {
  private listeners = new Set<() => void>();
  private previous: TreadmillSample | null = null;
  private lastEvent: ConsoleEvent | undefined;
  private reviewToken = 0;
  private reviewing = false;
  private lastReview = -Infinity;
  private stageSince = 0;
  private contactStart = 0;
  private lastPulse = -Infinity;
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

  start(plan: Plan | null) {
    const { profile, active } = this.state;
    const machine = this.treadmill.getSnapshot();
    if (!profile || machine.phase !== 'connected' || machine.status.stoppedBySafetyKey) {
      throw new Error('Conecte a esteira e confira a chave de segurança.');
    }
    if (active) this.finish('Início do treino guiado');
    const workout = newWorkout(profile, machine.mode, plan);
    saveWorkout(workout);
    this.resetReview();
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
      const next = { ...w, totals };
      if (sample.at - this.checkpoint >= 10000) {
        saveWorkout(next);
        this.checkpoint = sample.at;
      }
      const cue = w.plan && currentCue(w.plan, Math.floor(totals.movingMs / 1000));
      const previous = this.state.guidance;
      if (cue && previous?.index !== cue.index) this.stageSince = sample.at;
      const guidance = advanceGuidance(previous, cue, sample, sample.at);
      this.update({ active: next, guidance });
      if (w.plan && totals.movingMs >= w.plan.minutes * 60000) this.finish('Duração concluída');
      else if (cue && guidance && moving && !this.reviewing) {
        const justMeasured = guidance.bpmReceived && !previous?.bpmReceived;
        if (sample.heartRateBpm) {
          if (sample.at - this.lastPulse > 10000) this.contactStart = sample.at;
          this.lastPulse = sample.at;
        }
        const newContact =
          this.contactStart > this.lastReview && sample.at - this.lastReview >= 20000;
        if (justMeasured || newContact || sample.at - this.lastReview >= 90000) {
          const since = Math.max(this.stageSince, sample.at - 12000);
          const readings = pulseWindow(s.samples, since);
          const briefContactEnded = !sample.heartRateBpm && this.lastPulse > this.lastReview;
          if (readings.length && (readings.length >= 3 || justMeasured || briefContactEnded)) {
            void this.review(next, cue, readings);
          }
        }
      }
    }
    this.previous = sample;
  }

  private resetReview() {
    this.reviewToken++;
    this.reviewing = false;
    this.lastReview = -Infinity;
    this.lastPulse = -Infinity;
    this.contactStart = 0;
  }

  private async review(
    w: Workout,
    cue: NonNullable<ReturnType<typeof currentCue>>,
    readings: ReturnType<typeof pulseWindow>,
  ) {
    if (!w.plan) return;
    const token = ++this.reviewToken;
    this.reviewing = true;
    this.lastReview = readings[readings.length - 1].at;
    this.update({ coach: 'IA analisando os BPM…' });
    try {
      const choice = await reviewIntensity(w, w.plan, cue, readings);
      if (this.reviewToken !== token) return;
      const active = this.state.active;
      const plan = active?.plan;
      const g = this.state.guidance;
      const samples = this.treadmill.getSnapshot().samples;
      const last = samples.at(-1);
      const now = Date.now();
      if (
        !active ||
        !plan ||
        !g ||
        g.index !== cue.index ||
        !last ||
        !last.speedKmh ||
        now - this.lastReview > 20000 ||
        now - (last.speedAt ?? 0) > 5000 ||
        now - (last.inclineAt ?? 0) > 5000
      ) {
        this.update({ coach: 'Aguardando nova leitura' });
        return;
      }
      const recent = pulseWindow(samples, Math.max(this.stageSince, now - 20000));
      const stage = plan.stages[cue.index];
      const target = dailyTarget(plan, w.profile);
      const easy = stage.measure || plan.goal === 'Recuperação ativa';
      const nextStage = revisedStage(
        stage,
        choice,
        target,
        recent,
        last,
        easy,
        g.speedReached && g.inclineReached,
      );
      const bpm = recent.at(-1)?.bpm;
      if (!bpm || nextStage === stage) {
        this.update({
          coach: bpm ? 'IA · alvos mantidos após ' + bpm + ' BPM' : 'Aguardando nova leitura',
        });
        return;
      }
      const stages = plan.stages.map((s, index) => (index === cue.index ? nextStage : s));
      const next = { ...active, plan: { ...plan, stages } };
      saveWorkout(next);
      const guidance = advanceGuidance(
        { ...g, adjusted: false },
        { ...cue, stage: nextStage, measure: g.bpmRequestedAt !== null },
        last,
        now,
      );
      this.update({
        active: next,
        guidance,
        minimizedCue: null,
        coach: 'IA · ajuste após ' + bpm + ' BPM',
      });
    } catch {
      if (this.reviewToken === token)
        this.update({ coach: 'IA indisponível · seguindo o plano salvo' });
    } finally {
      if (this.reviewToken === token) this.reviewing = false;
    }
  }

  finish(reason: string) {
    if (!this.state.active) return;
    const done = { ...this.state.active, ended: Date.now(), reason };
    saveWorkout(done);
    this.resetReview();
    this.waitForStop = true;
    this.update({
      active: null,
      guidance: null,
      minimizedCue: null,
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
      const done = { ...w, estimate: await assess(w, history) };
      saveWorkout(done);
      this.update({ history: this.state.history.map((h) => (h.id === done.id ? done : h)) });
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : 'Avaliação pendente.' });
    } finally {
      this.update({ assessing: this.state.assessing.filter((id) => id !== w.id) });
    }
  }
}
