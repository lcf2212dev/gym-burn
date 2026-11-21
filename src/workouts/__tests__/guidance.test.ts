import { advanceGuidance, pendingAction, PULSE_READINGS, type Guidance } from '../guidance';
import {
  allowedDecisions,
  changeLabel,
  correctedStage,
  correction,
  correctionBpm,
  MAX_RAISE_METS,
  pulseFeatures,
  pulseWindow,
  revisedStage,
} from '../adaptive';
import { currentCue, metabolicCost, PULSE_INTERVAL_SECONDS, type Stage } from '../model';
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
/** O resumo de uma pegada: as 2 primeiras leituras caem e as demais são `values`. */
const grip = (values: number[]) => pulseFeatures(pulseWindow(pulses(0, [99, 99, ...values]), 0, 0), zone)!;
const steady = (bpm: number) => grip([bpm, bpm, bpm, bpm, bpm, bpm]);

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

it('com a cinta no peito o pedido de batimentos já nasce atendido e o aviso não abre', () => {
  const pulseCue = { ...cue, measure: true };
  const strap = (at: number, bpm: number | null): TreadmillSample => ({
    ...sample(at, undefined, undefined, bpm),
    heartRateSource: 'strap',
  });
  // Esteira já nos alvos: sem pedido de batimentos não resta aviso nenhum.
  const opened = advanceGuidance(null, pulseCue, strap(500, 105), 500);
  expect(opened).toMatchObject({ bpmRequestedAt: 500, bpmReceived: true });
  expect(pendingAction(opened)).toBeNull();

  // O pedido seguinte, 3 minutos depois, também não abre.
  const next = advanceGuidance(opened, { ...pulseCue, pulse: 1 }, strap(180_000, 110), 180_000);
  expect(next).toMatchObject({ bpmSlot: 1, bpmReceived: true });
  expect(pendingAction(next)).toBeNull();
});

it('se a cinta cai, o pedido seguinte volta a pedir as mãos no sensor da esteira', () => {
  const pulseCue = { ...cue, measure: true };
  const strap: TreadmillSample = { ...sample(500, undefined, undefined, 105), heartRateSource: 'strap' };
  const opened = advanceGuidance(null, pulseCue, strap, 500);

  // Sem cinta e sem as mãos no sensor: a amostra vem sem batimentos.
  const next = advanceGuidance(opened, { ...pulseCue, pulse: 1 }, sample(180_000), 180_000);
  expect(next).toMatchObject({ bpmSlot: 1, bpmReceived: false });
  expect(pendingAction(next)).toBe('bpm');

  // A leitura do sensor de mão conta uma a uma, como sempre.
  const grip: TreadmillSample = {
    ...sample(181_000, undefined, undefined, 110),
    heartRateSource: 'treadmill',
  };
  expect(advanceGuidance(next, { ...pulseCue, pulse: 1 }, grip, 181_000)).toMatchObject({
    bpmCount: 1,
    bpmReceived: false,
  });

  // E a cinta que volta fecha o pedido que estava aberto.
  const back: TreadmillSample = { ...sample(182_000, undefined, undefined, 111), heartRateSource: 'strap' };
  const closed = advanceGuidance(next, { ...pulseCue, pulse: 1 }, back, 182_000);
  expect(closed).toMatchObject({ bpmReceived: true });
  expect(pendingAction(closed)).toBeNull();
});

it('a amostra entre duas leituras da cinta também atende o pedido', () => {
  // A esteira manda mais de um pacote por segundo e cada leitura da cinta entra
  // numa amostra só: o pedido que abre numa amostra sem número não pode piscar o aviso.
  const pulseCue = { ...cue, measure: true };
  const between: TreadmillSample = { ...sample(500), heartRateSource: 'strap' };
  const opened = advanceGuidance(null, pulseCue, between, 500);
  expect(opened).toMatchObject({ bpmReceived: true, bpmCount: 0 });
  expect(pendingAction(opened)).toBeNull();
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

// Passa a etapa do plano pelo guia segundo a segundo, como a sessão faz.
function clock() {
  let g = null as Guidance | null;
  const tick = (elapsed: number, bpm: number | null = null, onTarget = true) => {
    const at = currentCue(plan, elapsed)!;
    const speed = onTarget ? at.stage.speed : 1;
    g = advanceGuidance(g, at, sample(elapsed * 1000, speed, at.stage.incline, bpm), elapsed * 1000);
  };
  const run = (from: number, to: number, bpm: number | null = null, onTarget = true) => {
    for (let s = from; s <= to; s++) tick(s, bpm, onTarget);
  };
  return { tick, run, state: () => g };
}

it('pede os batimentos a cada 3 minutos de treino, num relógio que a troca de etapa não zera', () => {
  const { tick, run, state } = clock();
  // A FC de repouso vem antes de acelerar, mesmo com a esteira fora dos alvos.
  run(0, 9, null, false);
  expect(state()).toMatchObject({ bpmSlot: 0, bpmRequestedAt: 0, adjusted: false });
  expect(pendingAction(state())).toBe('bpm');
  run(10, 15, 110, false);
  expect(state()).toMatchObject({ bpmCount: PULSE_READINGS, bpmReceived: true });
  expect(pendingAction(state())).toBe('adjust');
  // Leituras que continuam chegando não reabrem nem adiam o próximo pedido.
  run(16, 60, 110);
  run(61, 179);
  expect(pendingAction(state())).toBeNull();
  tick(PULSE_INTERVAL_SECONDS);
  expect(state()).toMatchObject({ bpmSlot: 1, bpmRequestedAt: 180000, bpmCount: 0, bpmReceived: false });
  expect(pendingAction(state())).toBe('bpm');
  run(181, 186, 110);
  expect(state()).toMatchObject({ bpmRequestedAt: 180000, bpmReceived: true });
  expect(pendingAction(state())).toBeNull();
  // Aos 300 s começa o bloco de esforço: o pedido atendido continua atendido, e o aviso é o de ajuste.
  run(187, 299, 110);
  tick(300, null, false);
  expect(state()).toMatchObject({
    index: 1,
    targetsSince: 300000,
    bpmSlot: 1,
    bpmRequestedAt: 180000,
    bpmReceived: true,
  });
  expect(pendingAction(state())).toBe('adjust');
  run(301, 359);
  expect(pendingAction(state())).toBeNull();
  // O pedido seguinte abre aos 6:00 do treino, e não 3 minutos depois do começo da etapa.
  tick(360);
  expect(state()).toMatchObject({ index: 1, bpmSlot: 2, bpmRequestedAt: 360000, bpmCount: 0, bpmReceived: false });
  expect(pendingAction(state())).toBe('bpm');
});

it('um pedido sem resposta atravessa a troca de etapa e dá lugar ao seguinte, do zero', () => {
  const { tick, run, state } = clock();
  // Sem leitura, a FC de repouso caduca aos 90 s, e o pedido seguinte abre aos 3:00.
  run(0, 89);
  expect(state()?.bpmRequestedAt).toBe(0);
  tick(90);
  expect(state()?.bpmRequestedAt).toBeNull();
  run(91, 179);
  expect(state()?.bpmRequestedAt).toBeNull();
  tick(180);
  expect(state()).toMatchObject({ bpmSlot: 1, bpmRequestedAt: 180000 });
  // A pessoa segura o sensor por 5 leituras, uma a menos que o pedido exige.
  run(181, 294);
  run(295, 299, 110);
  expect(state()).toMatchObject({ bpmCount: 5, bpmReceived: false });
  // Na etapa nova o pedido continua o mesmo, mas o ajuste da esteira, mais recente, vem antes.
  tick(300, null, false);
  expect(state()).toMatchObject({ index: 1, bpmSlot: 1, bpmRequestedAt: 180000, bpmCount: 5 });
  expect(pendingAction(state())).toBe('adjust');
  tick(301);
  expect(pendingAction(state())).toBe('bpm');
  // Aos 6:00 o pedido antigo é trocado por um novo, sem as leituras que ele já tinha.
  run(302, 359);
  tick(360);
  expect(state()).toMatchObject({ bpmSlot: 2, bpmRequestedAt: 360000, bpmCount: 0, bpmReceived: false });
  // Sem resposta, o pedido continua aberto até o próximo, aos 9:00.
  run(361, 539);
  expect(state()).toMatchObject({ bpmSlot: 2, bpmRequestedAt: 360000, bpmReceived: false });
  tick(540);
  expect(state()).toMatchObject({ bpmSlot: 3, bpmRequestedAt: 540000 });
});

it('com batimentos e ajuste em aberto, o aviso é o do pedido mais recente', () => {
  const open: Guidance = {
    index: 1,
    speedReached: false,
    inclineReached: false,
    adjusted: false,
    targetsSince: 300000,
    bpmSlot: 1,
    bpmRequestedAt: 360000,
    bpmCount: 0,
    bpmAt: null,
    bpmReceived: false,
  };
  expect(pendingAction(null)).toBeNull();
  // O pedido de batimentos abriu depois dos alvos em vigor: vem primeiro.
  expect(pendingAction(open)).toBe('bpm');
  // Os alvos mudaram depois do pedido: a etapa ou o ajuste novo vem primeiro.
  expect(pendingAction({ ...open, bpmRequestedAt: 240000 })).toBe('adjust');
  // No empate de horário vale o ajuste.
  expect(pendingAction({ ...open, bpmRequestedAt: 300000 })).toBe('adjust');
  // O primeiro pedido do treino, a FC de repouso, vem sempre antes.
  expect(pendingAction({ ...open, bpmSlot: 0, bpmRequestedAt: 0, targetsSince: 0 })).toBe('bpm');
  expect(pendingAction({ ...open, bpmSlot: 0, bpmRequestedAt: 0, targetsSince: 5000 })).toBe('bpm');
  // Com a esteira já ajustada, só resta o pedido de batimentos.
  expect(pendingAction({ ...open, adjusted: true, bpmRequestedAt: 240000 })).toBe('bpm');
  // Atendido o pedido, ou sem pedido, resta o ajuste, se houver.
  expect(pendingAction({ ...open, bpmReceived: true })).toBe('adjust');
  expect(pendingAction({ ...open, bpmRequestedAt: null })).toBe('adjust');
  expect(pendingAction({ ...open, bpmReceived: true, adjusted: true })).toBeNull();
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

const load = { stage: work, easy: false, reached: true, secondsAtLoad: 300 };
const at = (speed: number, incline: number) => ({ ...load, stage: { ...work, speed, incline } });
const stageAt = (speed: number, incline: number): Stage => ({ ...work, speed, incline });

it('só oferece à IA um aumento dentro da faixa e abaixo do teto, já escolhendo entre velocidade e inclinação', () => {
  const [below, inside, top, above] = [steady(90), steady(110), steady(117), steady(130)];
  // O alvo é o teto da faixa: dentro dela, mas abaixo dele, a carga ainda pode subir.
  expect(inside).toMatchObject({ position: 'na faixa', belowTop: 7 });
  expect(above).toMatchObject({ position: 'acima', belowTop: -13 });
  expect(allowedDecisions(inside, load)).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(steady(99), load)).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(top, load)).toEqual(['manter']);
  // Fora da faixa quem corrige é o app: nada vai à IA, e redução nunca é oferecida.
  expect(allowedDecisions(below, load)).toEqual(['manter']);
  expect(allowedDecisions(above, load)).toEqual(['manter']);
  expect(allowedDecisions(above, { ...load, easy: true, secondsAtLoad: 0 })).toEqual(['manter']);
  // Abaixo de 5,6 km/h a caminhada sobe pela velocidade.
  expect(allowedDecisions(inside, at(5.5, 3))).toEqual(['manter', 'aumentar velocidade']);
  // De 5,6 km/h até a corrida a carga sobe pela rampa, até o máximo da esteira.
  expect(allowedDecisions(inside, at(5.6, 0))).toEqual(['manter', 'aumentar inclinação']);
  expect(allowedDecisions(inside, at(5.6, 8))).toEqual(['manter', 'aumentar inclinação']);
  expect(allowedDecisions(inside, at(5.6, 14.5))).toEqual(['manter', 'aumentar inclinação']);
  expect(allowedDecisions(inside, at(5.6, 15))).toEqual(['manter']);
  // Um alvo antigo entre 5,6 e 7 km/h também sobe pela rampa, nunca pela velocidade.
  expect(allowedDecisions(inside, at(6, 2))).toEqual(['manter', 'aumentar inclinação']);
  expect(allowedDecisions(inside, at(6.9, 1))).toEqual(['manter', 'aumentar inclinação']);
  // Correndo, tudo é pela velocidade, sem o teto antigo de 9 km/h.
  expect(allowedDecisions(inside, at(7, 1))).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(inside, at(12, 1))).toEqual(['manter', 'aumentar velocidade']);
  expect(allowedDecisions(inside, at(22, 1))).toEqual(['manter']);
  // A carga só sobe em etapa principal, nos alvos, há 90 s ou mais.
  expect(allowedDecisions(inside, { ...load, easy: true })).toEqual(['manter']);
  expect(allowedDecisions(inside, { ...load, reached: false })).toEqual(['manter']);
  expect(allowedDecisions(inside, { ...load, secondsAtLoad: 89 })).toEqual(['manter']);
  expect(allowedDecisions(inside, { ...load, secondsAtLoad: 90 })).toEqual(['manter', 'aumentar velocidade']);
});

it('fora da faixa o app corrige sozinho: alivia acima do teto sempre e sobe abaixo do piso só com a carga estável', () => {
  const rising = grip([84, 85, 86, 88, 89, 90]);
  const falling = grip([94, 92, 90, 88, 86, 85]);
  const fallingAbove = grip([130, 129, 128, 126, 124, 122]);
  expect(rising).toMatchObject({ position: 'abaixo', trend: 'subindo' });
  expect(falling).toMatchObject({ position: 'abaixo', trend: 'caindo' });
  expect(fallingAbove).toMatchObject({ position: 'acima', trend: 'caindo' });
  // Acima do teto alivia em qualquer etapa, sem esperar tempo na carga nem os alvos.
  expect(correction(steady(130), load)).toBe('aliviar');
  expect(correction(steady(130), { ...load, easy: true, reached: false, secondsAtLoad: 0 })).toBe('aliviar');
  // Sem tolerância de poucos bpm, e com a FC já caindo também.
  expect(correction(steady(118), { ...load, secondsAtLoad: 5 })).toBe('aliviar');
  expect(correction(fallingAbove, load)).toBe('aliviar');
  // Dentro da faixa, do piso ao teto, o app não corrige nada.
  for (const bpm of [99, 110, 117]) expect(correction(steady(bpm), load)).toBeNull();
  // Abaixo do piso sobe a carga num bloco de esforço, nos alvos há 90 s, com a FC sem subir.
  expect(correction(steady(90), load)).toBe('subir');
  expect(correction(falling, load)).toBe('subir');
  expect(correction(steady(90), { ...load, secondsAtLoad: 90 })).toBe('subir');
  expect(correction(steady(90), { ...load, easy: true })).toBeNull();
  expect(correction(steady(90), { ...load, reached: false })).toBeNull();
  expect(correction(steady(90), { ...load, secondsAtLoad: 89 })).toBeNull();
  expect(correction(rising, load)).toBeNull();
});

it('o tamanho da correção sai da distância do BPM até o alvo', () => {
  // Aliviando, o BPM volta para 3 abaixo do teto: 130 − (117 − 3).
  expect(correctionBpm('aliviar', steady(130), zone)).toBe(16);
  expect(correctionBpm('aliviar', steady(118), zone)).toBe(4);
  // Subindo, vai só até o meio da faixa: 108 − 90.
  expect(correctionBpm('subir', steady(90), zone)).toBe(18);
  expect(correctionBpm('subir', steady(80), zone)).toBe(28);
  // 110,5 arredonda para 111.
  expect(correctionBpm('subir', steady(90), { low: 101, high: 120 })).toBe(21);
});

it('a correção anda pela escada de cargas, proporcional à distância, sem exigir aumento no painel ao aliviar', () => {
  // Os exemplos dos cenários: 40 anos, faixa de 117 a 135 e 15 bpm por MET.
  const fix = (stage: Stage, kind: 'aliviar' | 'subir', bpm: number) =>
    correctedStage(stage, kind, bpm / 15, sample(0, stage.speed, stage.incline));
  expect(fix(stageAt(5.6, 2.5), 'aliviar', 149 - 132)).toEqual(stageAt(5.6, 0));
  expect(fix(stageAt(5.6, 2.5), 'aliviar', 138 - 132)).toEqual(stageAt(5.6, 1.5));
  // Subindo, uma correção não passa de 1 MET: 19 e 21 bpm pediriam 1,27 e 1,4.
  expect(fix(stageAt(5.6, 2.5), 'subir', 126 - 107)).toEqual(stageAt(5.6, 4.5));
  expect(fix(stageAt(5, 0), 'subir', 126 - 105)).toEqual(stageAt(5.6, 1));
  // Correndo só a velocidade muda: no limiar, 173 BPM a 8 km/h e 1% (faixa de 153 a 162).
  expect(fix(stageAt(8, 1), 'aliviar', 173 - 159)).toEqual(stageAt(7, 1));
  expect(fix(stageAt(10, 1), 'aliviar', 15)).toEqual(stageAt(8.9, 1));
  expect(fix(stageAt(10, 1), 'subir', 15)).toEqual(stageAt(11, 1));
  // Quanto mais longe da faixa, maior o degrau: a caminhada perde a rampa e depois a velocidade.
  expect([8, 13, 33].map((bpm) => fix(stageAt(5, 1), 'aliviar', bpm))).toEqual([
    stageAt(4.7, 0),
    stageAt(4, 0),
    stageAt(1.2, 0),
  ]);
  // O custo cai ao menos o pedido, e um décimo de km/h a menos de redução já não bastaria.
  for (const bpm of [8, 13, 33]) {
    const mets = bpm / 15;
    const after = fix(stageAt(5, 1), 'aliviar', bpm);
    const before = metabolicCost(5, 1);
    expect(before - metabolicCost(after.speed, after.incline)).toBeGreaterThanOrEqual(mets);
    expect(before - metabolicCost(Math.round((after.speed + 0.1) * 10) / 10, 0)).toBeLessThan(mets);
  }
  // Subindo, o custo não passa do pedido, e o degrau seguinte passaria.
  const raised = fix(stageAt(5, 1), 'subir', 12);
  expect(raised).toEqual(stageAt(5.6, 1.5));
  expect(metabolicCost(5.6, 1.5) - metabolicCost(5, 1)).toBeLessThanOrEqual(12 / 15);
  expect(metabolicCost(5.6, 2) - metabolicCost(5, 1)).toBeGreaterThan(12 / 15);
  // A caminhada nunca passa de 5,6 km/h, e por maior que seja a distância a correção para em 1 MET.
  expect(MAX_RAISE_METS).toBe(1);
  expect(fix(stageAt(5, 0), 'subir', 75)).toEqual(stageAt(5.6, 1));
  expect(metabolicCost(5.6, 1) - metabolicCost(5, 0)).toBeLessThanOrEqual(1);
  expect(metabolicCost(5.6, 1.5) - metabolicCost(5, 0)).toBeGreaterThan(1);
  expect(fix(stageAt(10, 1), 'subir', 75)).toEqual(stageAt(11, 1));
  // Um pedido pequeno ainda vale um degrau.
  expect(fix(stageAt(5, 0), 'subir', 0.1)).toEqual(stageAt(5.1, 0));
  expect(fix(stageAt(5.6, 2), 'subir', 0.1)).toEqual(stageAt(5.6, 2.5));
  expect(fix(stageAt(10, 1), 'subir', 0.1)).toEqual(stageAt(10.1, 1));
  // No limite da esteira a etapa volta como estava.
  const steep = stageAt(5.6, 15);
  expect(fix(steep, 'subir', 15)).toBe(steep);
  const fastest = stageAt(22, 1);
  expect(fix(fastest, 'subir', 15)).toBe(fastest);
  const slowest = stageAt(1, 0);
  expect(fix(slowest, 'aliviar', 15)).toBe(slowest);
  // A pessoa já anda abaixo dos alvos: a redução parte do que a esteira mede, e nenhum alvo fica acima disso.
  const below = correctedStage(stageAt(5.6, 2.5), 'aliviar', 0.2, sample(0, 5.04, 1.2));
  expect(below).toEqual(stageAt(5, 0.5));
  expect(below.speed).toBeLessThanOrEqual(5.04);
  expect(below.incline).toBeLessThanOrEqual(1.2);
  // Dentro da tolerância do guia vale o alvo: a esteira informa 4,995% quando está em 5%.
  expect(correctedStage(stageAt(5.6, 5), 'aliviar', 0.2, sample(0, 5.59, 4.995))).toEqual(stageAt(5.6, 4.5));
  // Uma etapa leve não desce de 3 km/h, a linha mais leve da escada; abaixo disso ela fica como está.
  const easy = (speed: number): Stage => ({ ...stageAt(speed, 0), measure: true });
  expect(correctedStage(easy(4), 'aliviar', 0.3, sample(0, 4, 0))).toEqual(easy(3.3));
  expect(correctedStage(easy(4), 'aliviar', 1.2, sample(0, 4, 0))).toEqual(easy(3));
  const light = easy(2.4);
  expect(correctedStage(light, 'aliviar', 1.2, sample(0, 2.4, 0))).toBe(light);
  // Sem velocidade e inclinação medidas, ou com a lona quase parada, não há conta a fazer.
  const walk = stageAt(5.6, 2.5);
  expect(correctedStage(walk, 'aliviar', 1, sample(0, 0.5, 2.5))).toBe(walk);
  expect(correctedStage(walk, 'aliviar', 1, { ...sample(0), speedKmh: null })).toBe(walk);
  expect(correctedStage(walk, 'subir', 1, { ...sample(0), inclinationPercent: null })).toBe(walk);
  expect(correctedStage(walk, 'aliviar', 0, sample(0, 5.6, 2.5))).toBe(walk);
  expect(correctedStage(walk, 'subir', NaN, sample(0, 5.6, 2.5))).toBe(walk);
});

it('aliviar uma corrida nunca deixa o alvo entre 5,6 e 7 km/h', () => {
  const at = (stage: Stage) => sample(0, stage.speed, stage.incline);
  const ease = (stage: Stage, mets: number) => correctedStage(stage, 'aliviar', mets, at(stage));
  // Enquanto a corrida dá conta, só a velocidade desce, até 7 km/h.
  expect(ease(stageAt(8, 1), 0.8)).toEqual(stageAt(7.1, 1));
  expect(ease(stageAt(8, 1), 0.99)).toEqual(stageAt(7, 1));
  // Passou disso, a carga desce para a linha de baixo da escada: 5,6 km/h com a rampa que couber.
  expect(ease(stageAt(7, 1), 0.3)).toEqual(stageAt(5.6, 8));
  expect(ease(stageAt(7, 1), 1)).toEqual(stageAt(5.6, 6.5));
  expect(ease(stageAt(8, 1), 1.4)).toEqual(stageAt(5.6, 8));
  expect(ease(stageAt(7, 1), 3)).toEqual(stageAt(5.6, 2.5));
  // Quem já baixou a esteira para andar num bloco de corrida está caminhando: a conta parte da
  // carga medida, e o alívio não pede mais velocidade nem mais rampa do que a esteira tem.
  expect(correctedStage(stageAt(7, 1), 'aliviar', 0.3, sample(0, 6.5, 1))).toEqual(stageAt(5.6, 1));
  expect(correctedStage(stageAt(10, 1), 'aliviar', 1, sample(0, 5, 1))).toEqual(stageAt(3.8, 0));
  for (const speed of [7, 8, 10])
    for (const walking of [1.5, 3, 4.5, 5, 5.5, 5.6, 6, 6.9])
      for (const mets of [0.1, 0.5, 1, 2]) {
        const eased = correctedStage(stageAt(speed, 1), 'aliviar', mets, sample(0, walking, 1));
        expect(eased.speed).toBeLessThanOrEqual(Math.min(walking, 5.6));
        expect(eased.incline).toBeLessThanOrEqual(1);
      }
  // Um alvo antigo de caminhada acima de 5,6 km/h volta ao teto ao ser aliviado.
  expect(ease(stageAt(6, 2), 0.1)).toEqual(stageAt(5.6, 2));
  expect(ease(stageAt(6, 2), 0.5)).toEqual(stageAt(5.6, 1));
  for (const speed of [7, 7.2, 7.5, 8, 9, 10, 12])
    for (const incline of [0, 1, 3])
      for (let mets = 0.1; mets < 8; mets += 0.1) {
        const eased = ease(stageAt(speed, incline), mets);
        expect(eased.speed <= 5.6 || eased.speed >= 7).toBe(true);
        expect(eased.speed).toBeLessThan(speed + 0.01);
      }
});

it('o registro do treino diz qual alvo a correção mudou', () => {
  expect(changeLabel(stageAt(5, 1), stageAt(4.7, 0))).toBe('reduzir velocidade');
  expect(changeLabel(stageAt(5.6, 2.5), stageAt(5.6, 0))).toBe('reduzir inclinação');
  expect(changeLabel(stageAt(5, 0), stageAt(5.6, 0))).toBe('aumentar velocidade');
  expect(changeLabel(stageAt(5.6, 2.5), stageAt(5.6, 5))).toBe('aumentar inclinação');
  // Velocidade e rampa juntas: vale a rampa, o último degrau da escada.
  expect(changeLabel(stageAt(5, 0), stageAt(5.6, 2))).toBe('aumentar inclinação');
});

it('aplica o aumento da IA em passos pequenos, sem passar de 5,6 km/h numa caminhada', () => {
  expect(revisedStage(work, 'manter')).toBe(work);
  expect(revisedStage(work, 'aumentar velocidade')).toEqual({ ...work, speed: 5.2 });
  expect(revisedStage(work, 'aumentar inclinação')).toEqual({ ...work, incline: 2 });
  // Reduções não passam por aqui: quem alivia é a correção do app.
  expect(revisedStage(work, 'reduzir velocidade')).toBe(work);
  expect(revisedStage(work, 'reduzir inclinação')).toBe(work);
  // A caminhada para no teto de 5,6 km/h.
  expect(revisedStage(stageAt(5.3, 1), 'aumentar velocidade').speed).toBe(5.5);
  expect(revisedStage(stageAt(5.5, 1), 'aumentar velocidade').speed).toBe(5.6);
  const walkTop = stageAt(5.6, 1);
  expect(revisedStage(walkTop, 'aumentar velocidade')).toBe(walkTop);
  // Um alvo antigo acima do teto da caminhada não sobe mais pela velocidade.
  const old = stageAt(6, 2);
  expect(revisedStage(old, 'aumentar velocidade')).toBe(old);
  // Correndo, os alvos vão até o que a esteira alcança, e param ali.
  expect(revisedStage(stageAt(12, 14.5), 'aumentar velocidade').speed).toBe(12.2);
  expect(revisedStage(stageAt(21.9, 1), 'aumentar velocidade').speed).toBe(22);
  expect(revisedStage(stageAt(12, 14.5), 'aumentar inclinação').incline).toBe(15);
  const top = stageAt(22, 15);
  expect(revisedStage(top, 'aumentar velocidade')).toBe(top);
  expect(revisedStage(top, 'aumentar inclinação')).toBe(top);
});
