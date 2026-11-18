import type { TreadmillSample } from '@/treadmill/types';
import { inRange, type Plan, type Profile, type Stage } from './model';

export const objectives = ['Recuperação leve', 'Base aeróbica', 'Resistência moderada'] as const;
export type Objective = (typeof objectives)[number];
export const decisions = [
  'manter',
  'reduzir velocidade',
  'reduzir inclinação',
  'aumentar velocidade',
  'aumentar inclinação',
] as const;
export type Decision = (typeof decisions)[number];

export function dailyTarget(plan: Plan, profile: Profile) {
  const objective =
    plan.objective ??
    (plan.goal === 'Recuperação ativa'
      ? objectives[0]
      : plan.goal === 'Resistência'
        ? objectives[2]
        : objectives[1]);
  const percentages = {
    'Recuperação leve': [50, 60],
    'Base aeróbica': [55, 65],
    'Resistência moderada': [60, 70],
  }[objective];
  const max = 220 - profile.age;
  return {
    objective,
    low: Math.round((max * percentages[0]) / 100),
    high: Math.round((max * percentages[1]) / 100),
  };
}

export function pulseWindow(samples: TreadmillSample[], since: number) {
  return samples
    .filter((s) => s.at >= since && (s.speedKmh ?? 0) > 0 && inRange(s.heartRateBpm, 25, 250))
    .slice(-10)
    .map((s) => ({
      bpm: s.heartRateBpm!,
      at: s.at,
      kmh: s.speedKmh,
      incline: s.inclinationPercent,
    }));
}

export function revisedStage(
  stage: Stage,
  choice: Decision,
  target: ReturnType<typeof dailyTarget>,
  readings: ReturnType<typeof pulseWindow>,
  measured: TreadmillSample,
  easy: boolean,
  reached: boolean,
): Stage {
  if (!readings.length || measured.speedKmh === null || measured.inclinationPercent === null)
    return stage;
  const pulses = readings.map((r) => r.bpm);
  const latest = pulses[pulses.length - 1];
  const canIncrease = !easy && reached && pulses.length >= 3 && pulses.every((b) => b < target.low);
  let speed = stage.speed;
  let incline = stage.incline;
  if (latest > target.high && choice.startsWith('reduzir')) {
    // Ao aliviar o esforço, nenhum dos dois alvos pode exigir um aumento no painel.
    if (measured.speedKmh < 1 || measured.inclinationPercent < 0) return stage;
    speed = Math.min(speed, Math.floor(measured.speedKmh * 10) / 10);
    incline = Math.min(incline, Math.floor(measured.inclinationPercent * 2) / 2);
    if (choice === 'reduzir velocidade' || incline < 0.5) speed -= 0.3;
    else incline -= 0.5;
  } else if (canIncrease && choice === 'aumentar velocidade') speed += 0.2;
  else if (canIncrease && choice === 'aumentar inclinação') incline += 0.5;
  else return stage;

  speed = Math.min(9, Math.max(1, Math.round(speed * 10) / 10));
  incline = Math.min(5, Math.max(0, Math.round(incline * 2) / 2));
  return speed === stage.speed && incline === stage.incline ? stage : { ...stage, speed, incline };
}
