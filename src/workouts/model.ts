import type { Objective } from './adaptive';
import type { SessionMode, TreadmillSample } from '@/treadmill/types';

export const goals = [
  'Intervalado',
  'Recuperação ativa',
  'Queima de gordura',
  'Resistência',
  'Caminhada inclinada',
] as const;
export type Goal = (typeof goals)[number];
export const activities = ['Sedentário', 'Ativo', 'Treinado'] as const;
export type Activity = (typeof activities)[number];
export type Profile = { age: number; weightKg: number; heightCm: number; activity?: Activity };
export type Stage = {
  name: string;
  speed: number;
  incline: number;
  seconds: number;
  measure: boolean;
};
export type Plan = {
  objective?: Objective;
  goal: Goal;
  minutes: number;
  stages: Stage[];
  /** Justificativa curta da IA para os alvos escolhidos. */
  why?: string;
};
export type Estimate = { level: string; summary: string; maxBpm?: number | null };
export type Totals = {
  movingMs: number;
  distanceM: number;
  inclineMs: number;
  inclineDurationMs: number;
  bpmCount: number;
  bpmSum: number;
  peakBpm: number;
};
/** FC de repouso e máxima usadas para calcular a faixa do treino. */
export type HeartProfile = { rest: number | null; max: number; maxSource: 'idade' | 'IA' };
export type Zone = { low: number; high: number };
/** O que foi medido em uma etapa do plano (ou no treino livre inteiro). */
export type StageLog = {
  ms: number;
  distanceM: number;
  inclineMs: number;
  inclineDurationMs: number;
  bpmCount: number;
  bpmSum: number;
  /** Leituras abaixo, dentro e acima da faixa do dia. */
  zone: [number, number, number];
  /** Últimas leituras da etapa: o BPM de fim de bloco sai da mediana delas. */
  tail: number[];
  /** Leituras entre 45 e 90 s da etapa: medem a queda na recuperação. */
  early: number[];
  /** Maior mediana de 3 leituras seguidas: um pico que não depende de uma leitura solta. */
  top: number;
};
/** Ajuste de carga aplicado durante o treino. */
export type Change = { second: number; stage: number; decision: string; bpm: number };
export type Workout = {
  id: string;
  started: number;
  source: SessionMode;
  profile: Profile;
  plan: Plan | null;
  totals: Totals;
  ended: number | null;
  reason: string;
  estimate: Estimate | null;
  // Os campos abaixo não existem nos registros anteriores à versão 2.1.
  /** FC lida no primeiro minuto e meio de lona em movimento. */
  restBpm?: number | null;
  hr?: HeartProfile;
  log?: StageLog[];
  changes?: Change[];
};
export const levels = [
  'Dados insuficientes',
  'Em adaptação',
  'Base em formação',
  'Base consistente',
] as const;
export const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export const validBpm = (n: unknown): n is number => inRange(n, 25, 250);

export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function validProfile(p: Profile) {
  return (
    Number.isInteger(p.age) &&
    inRange(p.age, 1, 120) &&
    inRange(p.weightKg, 10, 500) &&
    inRange(p.heightCm, 50, 250) &&
    (p.activity === undefined || activities.includes(p.activity))
  );
}

// A IA seleciona objetivo e alvos. O app distribui os blocos para garantir a
// duração solicitada e reservar transições de entrada e saída em todos os modos.
export function makePlan(
  goal: Goal,
  minutes: number,
  pace: number,
  grade: number,
  workMinutes = 5,
  recoveryMinutes = 2,
): Plan {
  if (
    !goals.includes(goal) ||
    !Number.isInteger(minutes) ||
    !inRange(minutes, 5, 180) ||
    !inRange(workMinutes, 1, 20) ||
    !inRange(recoveryMinutes, 1, 10) ||
    !inRange(pace, 1, 9) ||
    !inRange(grade, 0, 5)
  )
    throw new Error('A IA retornou alvos fora da faixa do guia.');
  const recovery = goal === 'Recuperação ativa';
  const speed = Math.round(Math.min(pace, recovery ? 4.5 : 9) * 10) / 10;
  const incline = Math.round(Math.min(grade, recovery ? 1 : 5) * 2) / 2;
  const easy = Math.min(speed, 4, Math.round(speed * 0.8 * 10) / 10);
  const steps: Omit<Stage, 'seconds'>[] = [];
  const add = (name: string, target: number, slope: number, measure = false) =>
    steps.push({ name, speed: Math.max(1, target), incline: slope, measure });
  add('Aquecimento', easy, 0, true);
  const warmup = Math.min(5, minutes / 5);
  const mainMinutes = minutes - warmup * 2;
  const rounds = Math.max(
    1,
    Math.min(30, Math.round(mainMinutes / (workMinutes + recoveryMinutes))),
  );
  for (let i = 0; i < rounds; i++) {
    add(goal === 'Intervalado' ? 'Intervalo de esforço' : goal, speed, incline);
    if (goal === 'Intervalado' || i < rounds - 1) {
      add('Recuperação', easy, 0, true);
    }
  }
  add('Volta à calma', easy, 0, true);
  const mainWeights = steps.slice(1, -1).map((s) => (s.measure ? recoveryMinutes : workMinutes));
  const mainTotal = mainWeights.reduce((a, b) => a + b, 0);
  const weights = [warmup, ...mainWeights.map((w) => (w * mainMinutes) / mainTotal), warmup];
  const sum = weights.reduce((a, b) => a + b, 0);
  let accumulated = 0;
  let prev = 0;
  const stages = steps.map((step, i) => {
    accumulated += weights[i];
    const end = Math.round((minutes * 60 * accumulated) / sum);
    const seconds = end - prev;
    prev = end;
    return { ...step, seconds };
  });
  return { goal, minutes, stages };
}

// Em blocos de caminhada também cabe uma leitura durante o esforço principal.
export function requestsPulse(stage: Stage) {
  return stage.measure || stage.speed <= 5;
}

/** Por quanto tempo, no início do treino, uma leitura ainda conta como FC de repouso. */
export const REST_WINDOW_SECONDS = 90;

// A frequência cardíaca leva de 2 a 3 minutos para acompanhar uma mudança de
// carga. O pedido de leitura espera 60 s nas etapas leves e 120 s nas
// principais. A primeira etapa pede logo no início: é a FC de repouso do dia,
// e o pedido vale só enquanto essa janela estiver aberta.
function pulseDue(index: number, stage: Stage, into: number) {
  if (!requestsPulse(stage)) return false;
  if (index === 0) return into < REST_WINDOW_SECONDS;
  return into >= Math.min(stage.measure ? 60 : 120, Math.floor(stage.seconds / 2));
}

export function currentCue(plan: Plan, elapsed: number) {
  let start = 0;
  for (const [index, stage] of plan.stages.entries()) {
    const end = start + stage.seconds;
    if (elapsed < end) {
      const into = elapsed - start;
      const measure = pulseDue(index, stage, into);
      return {
        index,
        stage,
        /** Segundos já feitos na etapa. */
        into,
        left: end - elapsed,
        measure,
        key: index + (measure ? '-bpm' : '-ajuste'),
      };
    }
    start = end;
  }
  return null;
}

export function newWorkout(
  profile: Profile,
  source: SessionMode,
  plan: Plan | null,
  hr?: HeartProfile,
): Workout {
  const started = Date.now();
  return {
    id: String(started) + '-' + Math.random().toString(36).slice(2, 9),
    started,
    source,
    profile,
    plan,
    totals: {
      movingMs: 0,
      distanceM: 0,
      inclineMs: 0,
      inclineDurationMs: 0,
      bpmCount: 0,
      bpmSum: 0,
      peakBpm: 0,
    },
    ended: null,
    reason: '',
    estimate: null,
    restBpm: null,
    hr,
    log: [],
    changes: [],
  };
}

// Só conta o intervalo entre duas amostras seguidas com a lona andando; uma
// lacuna do rádio maior que 5 s não vira tempo de treino.
function step(sample: TreadmillSample, previous: TreadmillSample | null) {
  const speed = sample.speedKmh;
  if (!speed || speed <= 0) return null;
  const gap = previous && previous.speedKmh && previous.speedKmh > 0 ? sample.at - previous.at : 0;
  return {
    speed,
    dt: gap > 0 && gap <= 5000 ? gap : 0,
    bpm: validBpm(sample.heartRateBpm) ? sample.heartRateBpm : null,
  };
}

export function accumulate(t: Totals, sample: TreadmillSample, previous: TreadmillSample | null) {
  const s = step(sample, previous);
  if (!s) return t;
  return {
    movingMs: t.movingMs + s.dt,
    distanceM: t.distanceM + (s.speed * s.dt) / 3600,
    inclineMs: t.inclineMs + (sample.inclinationPercent ?? 0) * s.dt,
    inclineDurationMs: t.inclineDurationMs + (sample.inclinationPercent === null ? 0 : s.dt),
    bpmCount: t.bpmCount + (s.bpm === null ? 0 : 1),
    bpmSum: t.bpmSum + (s.bpm ?? 0),
    peakBpm: Math.max(t.peakBpm, s.bpm ?? 0),
  };
}

export const emptyLog = (): StageLog => ({
  ms: 0,
  distanceM: 0,
  inclineMs: 0,
  inclineDurationMs: 0,
  bpmCount: 0,
  bpmSum: 0,
  zone: [0, 0, 0],
  tail: [],
  early: [],
  top: 0,
});

/** Acumula a amostra na etapa em curso. `into` são os segundos já feitos na etapa. */
export function logStage(
  log: StageLog | undefined,
  sample: TreadmillSample,
  previous: TreadmillSample | null,
  zone: Zone,
  into: number,
): StageLog {
  const l = log ?? emptyLog();
  const s = step(sample, previous);
  if (!s) return l;
  const next = {
    ...l,
    ms: l.ms + s.dt,
    distanceM: l.distanceM + (s.speed * s.dt) / 3600,
    inclineMs: l.inclineMs + (sample.inclinationPercent ?? 0) * s.dt,
    inclineDurationMs: l.inclineDurationMs + (sample.inclinationPercent === null ? 0 : s.dt),
  };
  if (s.bpm === null) return next;
  const tail = [...l.tail, s.bpm].slice(-10);
  const zoneCounts: StageLog['zone'] = [...l.zone];
  zoneCounts[s.bpm < zone.low ? 0 : s.bpm > zone.high ? 2 : 1]++;
  return {
    ...next,
    bpmCount: l.bpmCount + 1,
    bpmSum: l.bpmSum + s.bpm,
    zone: zoneCounts,
    tail,
    early: into >= 45 && into <= 90 && l.early.length < 10 ? [...l.early, s.bpm] : l.early,
    top: tail.length >= 3 ? Math.max(l.top, median(tail.slice(-3))) : l.top,
  };
}

/** Sessão longa o bastante para entrar no histórico enviado à IA. */
export const validSession = (w: Workout) => w.totals.movingMs >= 180000;
/** Sem 3 minutos de movimento ou 10 leituras não há o que avaliar. */
export const insufficient = (w: Workout) => !validSession(w) || w.totals.bpmCount < 10;

export function evidence(w: Workout) {
  const t = w.totals;
  return {
    date: new Date(w.started).toISOString(),
    goal: w.plan?.goal ?? 'Livre',
    plannedMinutes: w.plan?.minutes ?? null,
    movingSeconds: Math.round(t.movingMs / 1000),
    distanceMeters: Math.round(t.distanceM),
    averageKmh: t.movingMs ? Math.round((t.distanceM * 36000) / t.movingMs) / 10 : null,
    averageIncline: t.inclineDurationMs
      ? Math.round((10 * t.inclineMs) / t.inclineDurationMs) / 10
      : null,
    bpmReadings: t.bpmCount,
    averageBpm: t.bpmCount ? Math.round(t.bpmSum / t.bpmCount) : null,
    peakBpm: t.peakBpm || null,
    endedBy: w.reason,
  };
}
