import { advanceGuidance, pendingAction, PULSE_READINGS } from '../guidance';
import { allowedDecisions, pulseFeatures, pulseWindow, revisedStage } from '../adaptive';
import { makePlan, currentCue } from '../model';
import type { TreadmillSample } from '@/treadmill/types';

const plan = makePlan('Resistência', 45, 5, 1.5);
// A primeira etapa pede a FC de repouso logo de início; os testes de ajuste usam a etapa sem esse pedido.
const cue = { ...currentCue(plan, 0)!, measure: false };
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
const zone = { low: 99, high: 117 };
const work = plan.stages[1];
const pulses = (start: number, values: number[]) =>
  values.map((bpm, i) => sample(start + i * 1000, work.speed, work.incline, bpm));

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

it('o aviso de batimentos só fecha depois das leituras válidas novas que a revisão exige', () => {
  const pulseCue = { ...cue, measure: true };
  let progress = advanceGuidance(null, pulseCue, sample(500, undefined, undefined, 105), 500);
  for (const bpm of [null, 0, 255]) {
    progress = advanceGuidance(progress, pulseCue, sample(600, undefined, undefined, bpm), 600);
    expect(progress).toMatchObject({ bpmCount: 0, bpmReceived: false });
  }
  for (let i = 1; i <= PULSE_READINGS; i++) {
    const at = 600 + i * 1000;
    progress = advanceGuidance(progress, pulseCue, sample(at, undefined, undefined, 110), at);
    // A mesma amostra entregue de novo não conta outra vez.
    progress = advanceGuidance(progress, pulseCue, sample(at, undefined, undefined, 110), at);
    expect(progress?.bpmCount).toBe(i);
    expect(pendingAction(progress) === 'bpm').toBe(i < PULSE_READINGS);
  }
});

it('o pedido da FC de repouso caduca quando a janela fecha sem leitura', () => {
  const asked = advanceGuidance(null, { ...cue, measure: true }, sample(100, 1, 0), 100);
  expect(pendingAction(asked)).toBe('bpm');
  const lapsed = advanceGuidance(asked, cue, sample(200, 1, 0), 200);
  expect(lapsed?.bpmRequestedAt).toBeNull();
  expect(pendingAction(lapsed)).toBe('adjust');
});

it('a janela de leituras descarta as 2 primeiras de cada pegada e as de antes da etapa', () => {
  const samples = [
    ...pulses(0, [140, 130, 112, 113]),
    sample(4000),
    sample(5000),
    sample(6000),
    sample(7000),
    ...pulses(8000, [125, 120, 114, 115, 116]),
  ];
  expect(pulseWindow(samples, 0, 0).map((r) => r.bpm)).toEqual([112, 113, 114, 115, 116]);
  expect(pulseWindow(samples, 0, 8000).map((r) => r.bpm)).toEqual([114, 115, 116]);
  // Leituras de antes do início da etapa não contam nem para abrir a pegada.
  expect(pulseWindow(samples, 9000, 0).map((r) => r.bpm)).toEqual([115, 116]);
  expect(pulseWindow([sample(0, 0, 0, 100), sample(1000, 0, 0, 100), sample(2000, 0, 0, 100)], 0, 0)).toEqual([]);
});

it('resume as leituras em mediana, tendência e posição na faixa', () => {
  const features = (values: number[]) =>
    pulseFeatures(pulseWindow(pulses(0, [99, 99, ...values]), 0, 0), zone);
  // Uma leitura solta (150) não tira a mediana da faixa.
  expect(features([110, 111, 150, 110, 112])).toMatchObject({
    count: 5,
    median: 111,
    latest: 112,
    position: 'na faixa',
    margin: 0,
  });
  expect(features([120, 121, 122, 123, 124])).toMatchObject({
    median: 122,
    position: 'acima',
    margin: 5,
    change: 3,
    trend: 'subindo',
  });
  expect(features([128, 126, 124, 122, 120, 119])).toMatchObject({ change: -6, trend: 'caindo' });
  // A oscilação de 1 bpm do sensor não é tendência.
  expect(features([88, 89, 88, 89, 88, 89])).toMatchObject({
    position: 'abaixo',
    margin: 10,
    change: 1,
    trend: 'estável',
  });
  expect(features([131, 131, 132, 131, 132, 132])).toMatchObject({ trend: 'estável' });
  expect(pulseFeatures([], zone)).toBeNull();
});

it('só oferece à IA as decisões que cabem na etapa', () => {
  const features = (bpm: number) =>
    pulseFeatures(pulseWindow(pulses(0, [bpm, bpm, bpm, bpm, bpm, bpm]), 0, 0), zone)!;
  const load = { stage: work, easy: false, reached: true, secondsAtLoad: 300 };
  expect(allowedDecisions(features(110), load)).toEqual(['manter']);
  expect(allowedDecisions(features(130), load)).toEqual(['manter', 'reduzir velocidade', 'reduzir inclinação']);
  expect(allowedDecisions(features(130), { ...load, stage: { ...work, incline: 0 } })).toEqual([
    'manter',
    'reduzir velocidade',
  ]);
  expect(allowedDecisions(features(90), load)).toEqual(['manter', 'aumentar velocidade', 'aumentar inclinação']);
  // Abaixo da faixa a carga só sobe em etapa principal, nos alvos, com a FC já estabilizada.
  expect(allowedDecisions(features(90), { ...load, easy: true })).toEqual(['manter']);
  expect(allowedDecisions(features(90), { ...load, reached: false })).toEqual(['manter']);
  expect(allowedDecisions(features(90), { ...load, secondsAtLoad: 60 })).toEqual(['manter']);
  // Aliviar é possível em qualquer etapa.
  expect(allowedDecisions(features(130), { ...load, easy: true, secondsAtLoad: 0 })).toContain('reduzir velocidade');
});

it('aplica a decisão em passos pequenos sem pedir aumento no painel ao aliviar', () => {
  const at = sample(4, work.speed, work.incline);
  expect(revisedStage(work, 'manter', at)).toBe(work);
  expect(revisedStage(work, 'reduzir velocidade', at)).toEqual({ ...work, speed: 4.7 });
  expect(revisedStage(work, 'reduzir inclinação', at)).toEqual({ ...work, incline: 1 });
  expect(revisedStage(work, 'aumentar velocidade', at)).toEqual({ ...work, speed: 5.2 });
  expect(revisedStage(work, 'aumentar inclinação', at)).toEqual({ ...work, incline: 2 });
  // A pessoa já anda abaixo do alvo: a redução parte do que a esteira mede.
  expect(revisedStage(work, 'reduzir velocidade', sample(4, 4.5, 1)).speed).toBe(4.2);
  // Sem inclinação para tirar, a redução vai para a velocidade.
  expect(revisedStage({ ...work, incline: 0 }, 'reduzir inclinação', sample(4, work.speed, 0)).speed).toBe(4.7);
});
