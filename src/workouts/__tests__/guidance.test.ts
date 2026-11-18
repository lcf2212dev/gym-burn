import { advanceGuidance, pendingAction } from '../guidance';
import { dailyTarget, pulseWindow, revisedStage } from '../adaptive';
import { makePlan, currentCue } from '../model';
import type { TreadmillSample } from '@/treadmill/types';

const plan = makePlan('Resistência', 45, 5, 1.5);
const cue = currentCue(plan, 0)!;
const sample = (
  at: number,
  speedKmh = cue.stage.speed,
  inclinationPercent = cue.stage.incline,
  heartRateBpm: number | null = null,
): TreadmillSample => ({
  at,
  speedAt: at,
  inclineAt: at,
  speedKmh,
  inclinationPercent,
  heartRateBpm,
  energyKcal: null,
  distanceM: null,
});

it('fecha apenas após os dois alvos contemporâneos e não reabre o ajuste concluído', () => {
  const opened = advanceGuidance(null, cue, sample(20, 1, 2), 20);
  const partial = advanceGuidance(opened, cue, sample(21, cue.stage.speed, 2), 21);
  expect(pendingAction(partial)).toBe('adjust');
  const staleIncline = { ...sample(6200), inclineAt: 20 };
  expect(pendingAction(advanceGuidance(partial, cue, staleIncline, 6200))).toBe('adjust');
  const complete = advanceGuidance(partial, cue, sample(6300), 6300);
  expect(pendingAction(complete)).toBeNull();
  expect(pendingAction(advanceGuidance(complete, cue, sample(6400, 1, 2), 6400))).toBeNull();
});

it('BPM anterior, ausente e zero não confirmam o aviso; a primeira leitura válida nova confirma', () => {
  const pulseCue = { ...cue, measure: true };
  let progress = advanceGuidance(null, pulseCue, sample(500, undefined, undefined, 105), 500);
  for (const bpm of [null, 0, 255]) {
    progress = advanceGuidance(progress, pulseCue, sample(600, undefined, undefined, bpm), 600);
    expect(pendingAction(progress)).toBe('bpm');
  }
  expect(
    pendingAction(advanceGuidance(progress, pulseCue, sample(700, undefined, undefined, 110), 700)),
  ).toBeNull();
});

it('ajusta conforme objetivo e leituras reais, preservando duração e fases leves', () => {
  const target = dailyTarget(plan, { age: 41, weightKg: 123, heightCm: 188 });
  const stage = plan.stages[1];
  const last = sample(4, stage.speed, stage.incline, 150);
  const high = pulseWindow([last], 0);
  expect(revisedStage(stage, 'reduzir velocidade', target, high, last, false, true)).toEqual({
    ...stage,
    speed: 4.7,
  });
  const low = pulseWindow(
    [1, 2, 3].map((at) => sample(at, stage.speed, stage.incline, 95)),
    0,
  );
  expect(revisedStage(stage, 'aumentar inclinação', target, low, last, false, true).incline).toBe(
    2,
  );
  expect(revisedStage(stage, 'aumentar velocidade', target, low, last, true, true)).toBe(stage);
  expect(
    revisedStage(stage, 'aumentar velocidade', target, low.slice(0, 1), last, false, true),
  ).toBe(stage);
});
