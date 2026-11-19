import { advanceGuidance, pendingAction, PULSE_READINGS, type Guidance } from '../guidance';
import { allowedDecisions, pulseFeatures, pulseWindow, revisedStage } from '../adaptive';
import { currentCue, PULSE_INTERVAL_SECONDS } from '../model';
import { sessionPlan, week } from '../week';
import type { TreadmillSample } from '@/treadmill/types';

// Base aeróbica a 5 km/h e 1,5%: aquecimento a 4 km/h e o bloco de esforço na etapa 1.
const plan = sessionPlan(week[1].session!, 5, 1.5);
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

it('atendido o pedido, volta a pedir os batimentos 3 minutos depois, enquanto couber na etapa', () => {
  // Etapa de 700 s com um segundo por amostra: o relógio anda junto com `into`.
  let g: Guidance | null = null;
  const tick = (into: number, bpm: number | null = null) => {
    const at = { ...cue, index: 1, into, left: 700 - into, measure: into >= 120 };
    g = advanceGuidance(g, at, sample(into * 1000, undefined, undefined, bpm), into * 1000);
  };
  const hold = (from: number) => {
    for (let s = from + 1; s <= from + PULSE_READINGS; s++) tick(s, 110);
  };
  for (let s = 0; s <= 120; s++) tick(s);
  expect(g).toMatchObject({ bpmRequestedAt: 120000, bpmReceived: false });
  hold(120);
  expect(g).toMatchObject({ bpmCount: PULSE_READINGS, bpmReceived: true });
  // Leituras que continuam chegando não reabrem nem adiam o próximo pedido.
  for (let s = 127; s < 126 + PULSE_INTERVAL_SECONDS; s++) tick(s, s < 140 ? 110 : null);
  expect(pendingAction(g)).toBeNull();
  tick(126 + PULSE_INTERVAL_SECONDS);
  expect(pendingAction(g)).toBe('bpm');
  expect(g).toMatchObject({ bpmRequestedAt: 306000, bpmCount: 0, bpmReceived: false });
  // Sem resposta, o pedido continua o mesmo: não abre outro por cima.
  for (let s = 307; s <= 500; s++) tick(s);
  expect(g).toMatchObject({ bpmRequestedAt: 306000, bpmReceived: false });
  hold(500);
  expect(pendingAction(g)).toBeNull();
  // O seguinte cairia aos 686 s, com 14 s de etapa: não dá tempo de ler, então não abre.
  for (let s = 507; s < 700; s++) tick(s);
  expect(g).toMatchObject({ bpmRequestedAt: 306000, bpmReceived: true });
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

it('só oferece à IA as decisões que cabem na etapa, já escolhendo entre velocidade e inclinação', () => {
  const features = (bpm: number) =>
    pulseFeatures(pulseWindow(pulses(0, [bpm, bpm, bpm, bpm, bpm, bpm]), 0, 0), zone)!;
  const load = { stage: work, easy: false, reached: true, secondsAtLoad: 300 };
  const at = (speed: number, incline: number) => ({ ...load, stage: { ...work, speed, incline } });
  const [below, inside, top, above] = [features(90), features(110), features(117), features(130)];
  // O alvo é o teto da faixa: dentro dela, mas abaixo dele, a carga ainda pode subir.
  expect(inside).toMatchObject({ position: 'na faixa', belowTop: 7 });
  expect(above).toMatchObject({ position: 'acima', belowTop: -13 });
  expect(allowedDecisions(inside, load)).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(top, load)).toEqual(['manter']);
  // Caminhada abaixo de 6 km/h: sobe pela velocidade e alivia primeiro a rampa.
  expect(allowedDecisions(below, load)).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(above, load)).toEqual(['manter', 'reduzir inclinação']);
  expect(allowedDecisions(above, at(5, 0))).toEqual(['manter', 'reduzir velocidade']);
  // De 6 km/h até a corrida a carga sobe pela rampa, até 8%.
  expect(allowedDecisions(below, at(6, 2))).toEqual(['manter', 'aumentar inclinação']);
  expect(allowedDecisions(below, at(6, 8))).toEqual(['manter', 'aumentar velocidade']);
  // Correndo, tudo é pela velocidade, sem o teto antigo de 9 km/h.
  expect(allowedDecisions(below, at(12, 1))).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(above, at(12, 1))).toEqual(['manter', 'reduzir velocidade']);
  expect(allowedDecisions(below, at(22, 1))).toEqual(['manter']);
  // Abaixo do teto a carga só sobe em etapa principal, nos alvos, com a FC já estabilizada.
  expect(allowedDecisions(below, { ...load, easy: true })).toEqual(['manter']);
  expect(allowedDecisions(inside, { ...load, easy: true })).toEqual(['manter']);
  expect(allowedDecisions(below, { ...load, reached: false })).toEqual(['manter']);
  expect(allowedDecisions(inside, { ...load, secondsAtLoad: 60 })).toEqual(['manter']);
  // Aliviar é possível em qualquer etapa.
  expect(allowedDecisions(above, { ...load, easy: true, secondsAtLoad: 0 })).toContain('reduzir inclinação');
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
  // Os alvos vão até o que a esteira alcança, e param ali.
  const fast = { ...work, speed: 12, incline: 14.5 };
  expect(revisedStage(fast, 'aumentar velocidade', sample(4, 12, 14.5)).speed).toBe(12.2);
  expect(revisedStage(fast, 'aumentar inclinação', sample(4, 12, 14.5)).incline).toBe(15);
  const top = { ...work, speed: 22, incline: 15 };
  expect(revisedStage(top, 'aumentar velocidade', sample(4, 22, 15))).toBe(top);
});
