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
export type Profile = { age: number; weightKg: number; heightCm: number };
export type Stage = {
  name: string;
  speed: number;
  incline: number;
  seconds: number;
  measure: boolean;
};
export type Plan = { objective?: Objective; goal: Goal; minutes: number; stages: Stage[] };
export type Estimate = { level: string; summary: string };
export type Totals = {
  movingMs: number;
  distanceM: number;
  inclineMs: number;
  inclineDurationMs: number;
  bpmCount: number;
  bpmSum: number;
  peakBpm: number;
};
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
};
export const levels = [
  'Dados insuficientes',
  'Em adaptação',
  'Base em formação',
  'Base consistente',
] as const;
export const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

export function validProfile(p: Profile) {
  return (
    Number.isInteger(p.age) &&
    inRange(p.age, 1, 120) &&
    inRange(p.weightKg, 10, 500) &&
    inRange(p.heightCm, 50, 250)
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

export function currentCue(plan: Plan, elapsed: number) {
  let start = 0;
  for (const [index, stage] of plan.stages.entries()) {
    const end = start + stage.seconds;
    if (elapsed < end) {
      const measure =
        requestsPulse(stage) && elapsed - start >= Math.min(30, Math.floor(stage.seconds / 2));
      return {
        index,
        stage,
        left: end - elapsed,
        measure,
        key: index + (measure ? '-bpm' : '-ajuste'),
      };
    }
    start = end;
  }
  return null;
}

export function newWorkout(profile: Profile, source: SessionMode, plan: Plan | null): Workout {
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
  };
}

export function accumulate(t: Totals, sample: TreadmillSample, previous: TreadmillSample | null) {
  const speed = sample.speedKmh;
  if (!speed || speed <= 0) return t;
  const gap = previous && previous.speedKmh && previous.speedKmh > 0 ? sample.at - previous.at : 0;
  const dt = gap > 0 && gap <= 5000 ? gap : 0;
  const bpm = inRange(sample.heartRateBpm, 25, 250) ? sample.heartRateBpm : null;
  return {
    movingMs: t.movingMs + dt,
    distanceM: t.distanceM + (speed * dt) / 3600,
    inclineMs: t.inclineMs + (sample.inclinationPercent ?? 0) * dt,
    inclineDurationMs: t.inclineDurationMs + (sample.inclinationPercent === null ? 0 : dt),
    bpmCount: t.bpmCount + (bpm === null ? 0 : 1),
    bpmSum: t.bpmSum + (bpm ?? 0),
    peakBpm: Math.max(t.peakBpm, bpm ?? 0),
  };
}

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
