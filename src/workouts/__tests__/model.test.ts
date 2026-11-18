import {
  accumulate,
  currentCue,
  evidence,
  goals,
  makePlan,
  newWorkout,
  validProfile,
} from '../model';
import type { TreadmillSample } from '@/treadmill/types';

const profile = { age: 35, heightCm: 175, weightKg: 75 };
const sample = (at: number, speedKmh: number, heartRateBpm: number | null): TreadmillSample => ({
  at,
  speedKmh,
  heartRateBpm,
  distanceM: null,
  energyKcal: null,
  inclinationPercent: 2,
});

it.each(goals)('mantém a duração e avisa quando medir BPM em %s', (goal) => {
  for (const minutes of [5, 45, 180]) {
    const plan = makePlan(goal, minutes, 5, 1);
    expect(plan.stages.reduce((n, s) => n + s.seconds, 0)).toBe(minutes * 60);
    expect(currentCue(plan, 0)?.stage.name).toBe('Aquecimento');
    expect(currentCue(plan, 0)?.measure).toBe(false);
    expect(currentCue(plan, Math.min(30, Math.floor(plan.stages[0].seconds / 2)))?.measure).toBe(
      true,
    );
    expect(currentCue(plan, plan.stages[0].seconds)?.index).toBe(1);
    expect(currentCue(plan, minutes * 60)).toBeNull();
  }
});

it('ignora pausa e lacuna BLE e calcula apenas o esforço observado', () => {
  const w = newWorkout(profile, 'ble', makePlan('Intervalado', 45, 8, 4));
  const samples = [
    sample(0, 3.6, 110),
    sample(1000, 3.6, null),
    sample(12000, 3.6, 130),
    sample(13000, 0, 88),
    sample(14000, 4, null),
  ];
  samples.forEach((s, i) => {
    w.totals = accumulate(w.totals, s, samples[i - 1] ?? null);
  });
  expect(evidence(w)).toMatchObject({
    movingSeconds: 1,
    distanceMeters: 1,
    averageKmh: 3.6,
    averageIncline: 2,
    bpmReadings: 2,
    averageBpm: 120,
    peakBpm: 130,
  });
});

it('rejeita alvos inválidos e perfil incompleto', () => {
  expect(validProfile({ ...profile, heightCm: 0 })).toBe(false);
  expect(() => makePlan('Resistência', 45, 40, 1)).toThrow();
  expect(() => makePlan('Resistência', 45, 4, NaN)).toThrow();
});
