import { advanceGuidance, cueKey, pendingAction, PULSE_READINGS, type Guidance } from '../guidance';
import {
  changeLabel,
  correctedStage,
  correction,
  correctionBpm,
  livePulse,
  MAX_RAISE_METS,
  pulseFeatures,
  pulseWindow,
  raiseRoom,
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
const grip = (values: number[]) =>
  pulseFeatures(pulseWindow(pulses(0, [99, 99, ...values]), 0, (values.length + 1) * 1000), zone)!;
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

it('a chave do aviso muda a cada pedido de batimentos e a cada vez que os alvos passam a valer', () => {
  const g: Guidance = {
    index: 1,
    speedReached: false,
    inclineReached: false,
    adjusted: false,
    targetsSince: 300000,
    bpmSlot: 1,
    bpmRequestedAt: 240000,
    bpmCount: 0,
    bpmAt: null,
    bpmReceived: true,
  };
  const stage = work;
  const key = cueKey('w', g, stage);
  expect(key).toBe('w/1/adjust@300000/' + stage.speed + '/' + stage.incline);
  // O mesmo aviso, na amostra seguinte, tem a mesma chave: minimizado, fica minimizado.
  expect(cueKey('w', { ...g, speedReached: true }, stage)).toBe(key);
  // O app pede de novo a redução que não chegou ao painel: os alvos valem de agora, e a chave é outra.
  expect(cueKey('w', { ...g, targetsSince: 330000 }, stage)).not.toBe(key);
  // O pedido de batimentos usa o horário dele.
  expect(cueKey('w', { ...g, bpmReceived: false, bpmRequestedAt: 360000 }, stage)).toBe(
    'w/1/bpm@360000/' + stage.speed + '/' + stage.incline,
  );
  // Sem aviso em aberto, não há chave.
  expect(cueKey('w', { ...g, adjusted: true }, stage)).toBeNull();
  expect(cueKey('w', null, stage)).toBeNull();
});

it('o pedido da FC de repouso caduca quando a janela fecha sem leitura', () => {
  const asked = advanceGuidance(null, { ...cue, measure: true }, sample(100, 1, 0), 100);
  expect(pendingAction(asked)).toBe('bpm');
  const lapsed = advanceGuidance(asked, cue, sample(200, 1, 0), 200);
  expect(lapsed?.bpmRequestedAt).toBeNull();
  expect(pendingAction(lapsed)).toBe('adjust');
});

it('a janela do sensor de mão descarta as 2 primeiras de cada pegada e as de antes da etapa', () => {
  const samples = [
    ...pulses(0, [140, 130, 112, 113]),
    sample(4000),
    sample(5000),
    sample(6000),
    sample(7000),
    ...pulses(8000, [125, 120, 114, 115, 116]),
  ];
  expect(pulseWindow(samples, 0, 12000).map((r) => r.bpm)).toEqual([112, 113, 114, 115, 116]);
  // Só valem as leituras dos últimos 12 s, e menos de 4 não bastam para rever a carga.
  expect(pulseWindow(samples, 0, 16000).map((r) => r.bpm)).toEqual([]);
  expect(pulseWindow([...samples, ...pulses(13000, [117, 118])], 0, 16000).map((r) => r.bpm)).toEqual([
    114, 115, 116, 117, 118,
  ]);
  // Leituras de antes do início da etapa não contam nem para abrir a pegada.
  expect(pulseWindow([...samples, ...pulses(13000, [117, 118])], 9000, 14000).map((r) => r.bpm)).toEqual([
    115, 116, 117, 118,
  ]);
  // Depois de 12 s sem leitura não há o que rever, e com a lona parada nada conta.
  expect(pulseWindow(samples, 0, 25000)).toEqual([]);
  const still = [0, 1, 2, 3, 4, 5].map((i) => sample(i * 1000, 0, 0, 100));
  expect(pulseWindow(still, 0, 5000)).toEqual([]);
  // No máximo 10 leituras, as mais novas.
  const long = pulses(0, Array.from({ length: 12 }, (_, i) => 100 + i));
  expect(pulseWindow(long, 0, 11000).map((r) => r.bpm)).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
});

it('com a cinta a janela é o último minuto inteiro, e um pico de segundos não muda a mediana', () => {
  const strap = (start: number, values: number[]) =>
    values.map((bpm, i): TreadmillSample => ({
      ...sample(start + i * 1000, work.speed, work.incline, bpm),
      heartRateSource: 'strap',
    }));
  const flat = (seconds: number, bpm: number) => Array.from({ length: seconds }, () => bpm);
  // 90 s de cinta: valem os últimos 60 s (61 leituras, das duas pontas), sem descartar nenhuma.
  const samples = strap(0, [...flat(30, 100), ...flat(60, 115)]);
  const window = pulseWindow(samples, 0, 89000);
  expect(window).toHaveLength(61);
  expect(window[0]).toMatchObject({ at: 29000, bpm: 100 });
  expect(pulseFeatures(window, zone)).toMatchObject({ count: 61, spanSeconds: 60, median: 115, position: 'na faixa' });
  // 9 segundos em 119 dentro de um minuto em 116: a mediana continua na faixa.
  const blip = strap(0, [...flat(51, 116), ...flat(9, 119)]);
  expect(pulseFeatures(pulseWindow(blip, 0, 59000), zone)).toMatchObject({ median: 116, position: 'na faixa' });
  // Mais da metade do minuto acima do teto, aí sim.
  const over = strap(0, [...flat(25, 116), ...flat(35, 119)]);
  expect(pulseFeatures(pulseWindow(over, 0, 59000), zone)).toMatchObject({ median: 119, position: 'acima', margin: 2 });
  // A tendência compara as duas metades do minuto.
  const rising = strap(0, [...flat(30, 108), ...flat(30, 111)]);
  expect(pulseFeatures(pulseWindow(rising, 0, 59000), zone)).toMatchObject({ change: 3, trend: 'subindo' });
  // Menos de 40 s de leituras na etapa ainda não dizem o BPM da carga.
  expect(pulseWindow(strap(0, flat(39, 110)), 0, 38000)).toEqual([]);
  expect(pulseWindow(strap(0, flat(41, 110)), 0, 40000)).toHaveLength(41);
  expect(pulseWindow(samples, 60000, 89000)).toEqual([]);
  // A cinta caiu e a pessoa segurou o sensor: valem as regras do sensor de mão.
  const mixed = [...strap(0, flat(60, 110)), ...pulses(66000, [120, 119, 112, 113, 112, 113])];
  expect(pulseWindow(mixed, 0, 71000).map((r) => r.bpm)).toEqual([112, 113, 112, 113]);
});

it('a leitura do momento é a mediana dos 5 últimos segundos da cinta, com a subida em 30 s', () => {
  const strap = (start: number, values: (number | null)[], speed = work.speed): TreadmillSample[] =>
    values.map((bpm, i) => ({ ...sample(start + i * 1000, speed, work.incline, bpm), heartRateSource: 'strap' }));
  const flat = (seconds: number, bpm: number | null) => Array.from({ length: seconds }, () => bpm);
  // 40 s em 160 e depois 3 leituras em 172: nos últimos 5 s (160, 160, 172, 172, 172) a mediana já passou de 170.
  const climbing = strap(0, [...flat(40, 160), 172, 172, 172]);
  expect(livePulse(climbing, 42000)).toEqual({ bpm: 172, rise: 12 });
  // Com duas leituras novas a mediana ainda é a de antes.
  expect(livePulse(climbing.slice(0, 42), 41000)).toEqual({ bpm: 160, rise: 0 });
  // Sem 3 leituras entre 35 e 25 s atrás não há subida a medir: ela vale 0.
  expect(livePulse(strap(0, [160, 165, 170, 172, 174]), 4000)).toEqual({ bpm: 170, rise: 0 });
  // A cinta lê uma vez por segundo e as amostras entre duas leituras vêm sem número: contam só as leituras.
  const sparse = strap(0, [...flat(40, 160), 171, null, 171, null, 171]);
  expect(livePulse(sparse, 44000)).toEqual({ bpm: 171, rise: 11 });
  // Menos de 3 leituras nos últimos 5 s não bastam.
  expect(livePulse(strap(0, [...flat(40, 160), null, null, null, 171, 171]), 44000)).toBeNull();
  // Só com a cinta: a leitura mais recente do sensor de mão não vale, nem uma de mais de 5 s.
  const grip = pulses(0, [160, 161, 162, 163, 164, 165]);
  expect(livePulse(grip, 5000)).toBeNull();
  expect(livePulse([...climbing, ...pulses(43000, [150])], 43000)).toBeNull();
  expect(livePulse(climbing, 48000)).toBeNull();
  // Com a lona parada a leitura não conta.
  expect(livePulse(strap(0, [...flat(40, 160), 172, 172, 172], 0), 42000)).toBeNull();
});

it('com os RR da cinta, a leitura do momento é o batimento a batimento, filtrado e conferido com a cinta', () => {
  // 45 s com a cinta mandando 164 e os batimentos de verdade em `beat` bpm, com `junk` a cada RR bom.
  const series = (beat: (t: number) => number, junk: number[] = []) => {
    let phase = 0;
    return Array.from({ length: 45 }, (_, t): TreadmillSample => {
      const rr = Math.round(60000 / beat(t));
      const rrMs: number[] = [];
      for (phase += 1000; phase >= rr; phase -= rr) rrMs.push(rr, ...junk);
      return { ...sample(t * 1000, work.speed, work.incline, 164), heartRateSource: 'strap', rrMs };
    });
  };
  // Os RR dizem 168 (357 ms) e a cinta, suavizada, 164: vale o dos RR, e a subida em 30 s compara RR com RR.
  expect(livePulse(series(() => 168), 44000)).toEqual({ bpm: 168, rise: 0 });
  expect(livePulse(series((t) => (t < 20 ? 160 : 168)), 44000)).toEqual({ bpm: 168, rise: 8 });
  // Metade dos RR é artefato (280 ms, 214 bpm, fora da faixa de 300 a 2000 ms): o filtro os descarta.
  expect(livePulse(series(() => 168, [280]), 44000)).toEqual({ bpm: 168, rise: 0 });
  // Um RR em cada dois a 20% ou mais do anterior (500 ms, 120 bpm): também descartado.
  expect(livePulse(series(() => 168, [500]), 44000)).toEqual({ bpm: 168, rise: 0 });
  // Os RR mais de 10 bpm longe da cinta (182 contra 164): sobrou artefato, e vale a cinta.
  expect(livePulse(series(() => 182), 44000)).toEqual({ bpm: 164, rise: 0 });
  // Os RR existem para adiantar a subida, nunca para atrasar a trava: com a cinta em 178 e os RR em 169
  // (de acordo, a 9 bpm), vale o maior, 178, acima do teto de um VO₂máx de 161 a 170.
  const strapAt = (bpm: number) => series(() => 169).map((s) => ({ ...s, heartRateBpm: bpm }));
  expect(livePulse(strapAt(178), 44000)).toEqual({ bpm: 178, rise: 0 });
  // Menos de 5 batimentos nos últimos 5 s (a cinta parou de mandar RR): vale a cinta, como sem RR,
  // e a subida compara cinta com cinta, sem pôr nela a diferença entre as duas contas.
  const few = series(() => 168).map((s) => (s.at >= 40000 ? { ...s, rrMs: s.at === 44000 ? [357, 357] : [] } : s));
  expect(livePulse(few, 44000)).toEqual({ bpm: 164, rise: 0 });
});

it('resume as leituras em mediana, tendência e posição na faixa', () => {
  const features = grip;
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
const stageAt = (speed: number, incline: number): Stage => ({ ...work, speed, incline });

it('dentro da faixa a carga só ganha os bpm que cabem até o teto, e nada quando já está no alvo', () => {
  const [below, inside, top, above] = [steady(90), steady(110), steady(117), steady(130)];
  expect(inside).toMatchObject({ position: 'na faixa', belowTop: 7 });
  expect(above).toMatchObject({ position: 'acima', belowTop: -13 });
  // Carga estabilizada (4 min ou mais): cabe a distância até o teto, menos 1 bpm de folga.
  expect(raiseRoom(inside, load)).toBe(6);
  // Longe do teto a folga é um quinto da distância: de 18 bpm, ficam 4.
  expect(raiseRoom(steady(99), load)).toBe(14);
  expect(raiseRoom(steady(107), load)).toBe(8);
  expect(raiseRoom(steady(113), load)).toBe(3);
  // A 3 bpm do teto, ou menos, o alvo já foi atingido.
  expect(raiseRoom(steady(114), load)).toBe(0);
  expect(raiseRoom(top, load)).toBe(0);
  // Com menos de 4 minutos na carga a FC ainda sobe uns 3 bpm sozinha: eles ficam reservados.
  expect(raiseRoom(inside, { ...load, secondsAtLoad: 239 })).toBe(3);
  expect(raiseRoom(steady(111), { ...load, secondsAtLoad: 239 })).toBe(0);
  expect(raiseRoom(steady(111), { ...load, secondsAtLoad: 240 })).toBe(5);
  // Fora da faixa quem age é a correção, não o ajuste fino.
  expect(raiseRoom(below, load)).toBe(0);
  expect(raiseRoom(above, load)).toBe(0);
  // Com a FC ainda subindo ela chega mais perto do teto sozinha.
  const rising = grip([104, 105, 106, 108, 109, 110]);
  expect(rising).toMatchObject({ position: 'na faixa', trend: 'subindo' });
  expect(raiseRoom(rising, load)).toBe(0);
  // Com o minuto inteiro da cinta, 1 bpm entre as metades (2 bpm por minuto) já é subida.
  const minute = (first: number, second: number) =>
    pulseFeatures(
      Array.from({ length: 60 }, (_, i) => ({ bpm: i < 30 ? first : second, at: i * 1000, kmh: 5, incline: 1.5 })),
      zone,
    )!;
  expect(minute(110, 110)).toMatchObject({ count: 60, change: 0, trend: 'estável' });
  expect(raiseRoom(minute(110, 110), load)).toBe(6);
  expect(minute(109, 110)).toMatchObject({ change: 1, trend: 'estável' });
  expect(raiseRoom(minute(109, 110), load)).toBe(0);
  // Caindo, ou no sensor de mão (poucas leituras), 1 bpm é ruído.
  expect(raiseRoom(minute(111, 110), load)).toBeGreaterThan(0);
  expect(raiseRoom(grip([109, 109, 109, 110, 110, 110]), load)).toBeGreaterThan(0);
  // A carga só sobe em etapa principal que não seja um tiro, nos alvos, há 90 s ou mais.
  expect(raiseRoom(inside, { ...load, easy: true })).toBe(0);
  expect(raiseRoom(inside, { ...load, short: true })).toBe(0);
  expect(raiseRoom(inside, { ...load, reached: false })).toBe(0);
  expect(raiseRoom(inside, { ...load, secondsAtLoad: 89 })).toBe(0);
  expect(raiseRoom(inside, { ...load, secondsAtLoad: 90 })).toBe(3);
  // Nos 2 últimos minutos do último bloco o aumento não teria tempo de fazer efeito.
  expect(raiseRoom(inside, { ...load, closing: true })).toBe(0);
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
  // Num tiro (bloco de até 5 min) a FC ainda sobe até o fim: abaixo do piso a carga não sobe no meio.
  expect(correction(steady(90), { ...load, short: true })).toBeNull();
  // Acima do teto o tiro é aliviado como qualquer etapa.
  expect(correction(steady(130), { ...load, short: true })).toBe('aliviar');
  expect(correction(steady(90), { ...load, reached: false })).toBeNull();
  expect(correction(steady(90), { ...load, secondsAtLoad: 89 })).toBeNull();
  expect(correction(rising, load)).toBeNull();
});

it('nos 3 minutos depois de um alívio, outro só sai com excesso claro e a FC sem cair', () => {
  const fallingAbove = grip([130, 129, 128, 126, 124, 122]);
  // 1 ou 2 bpm acima do teto com um alívio recente: a FC ainda está respondendo a ele.
  expect(correction(steady(118), load, 60)).toBeNull();
  expect(correction(steady(119), load, 179)).toBeNull();
  // Passados os 3 minutos, o mesmo excesso alivia de novo.
  expect(correction(steady(118), load, 180)).toBe('aliviar');
  // 3 bpm ou mais acima do teto não esperam.
  expect(correction(steady(120), load, 60)).toBe('aliviar');
  expect(correction(steady(130), load, 61)).toBe('aliviar');
  // A não ser que a FC já esteja caindo: é o alívio anterior fazendo efeito.
  expect(correction(fallingAbove, load, 60)).toBeNull();
  expect(correction(fallingAbove, load, 180)).toBe('aliviar');
  // A espera não segura a subida abaixo do piso.
  expect(correction(steady(90), load, 60)).toBe('subir');
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
  expect(fix(stageAt(5.2, 3), 'aliviar', 149 - 132)).toEqual(stageAt(5.2, 0.5));
  expect(fix(stageAt(5.2, 3), 'aliviar', 138 - 132)).toEqual(stageAt(5.2, 2));
  // Subindo, uma correção não passa de 1 MET: 19 e 21 bpm pediriam 1,27 e 1,4.
  expect(fix(stageAt(5.2, 3), 'subir', 126 - 107)).toEqual(stageAt(5.2, 5));
  expect(fix(stageAt(5, 0), 'subir', 126 - 105)).toEqual(stageAt(5.2, 2));
  // Correndo só a velocidade muda: no limiar, 173 BPM a 8 km/h e 1% (faixa de 153 a 162).
  expect(fix(stageAt(8, 1), 'aliviar', 173 - 159)).toEqual(stageAt(7, 1));
  // 9 km/h tira 0,995 MET de um pedido de 1: dentro da folga de 0,03, como na caminhada.
  expect(fix(stageAt(10, 1), 'aliviar', 15)).toEqual(stageAt(9, 1));
  expect(fix(stageAt(10, 1), 'subir', 15)).toEqual(stageAt(11, 1));
  // Quanto mais longe da faixa, maior o degrau: abaixo de 4,9 km/h a caminhada é plana.
  expect([8, 13, 33].map((bpm) => fix(stageAt(5, 1), 'aliviar', bpm))).toEqual([
    stageAt(4.8, 0),
    stageAt(4.1, 0),
    stageAt(1.3, 0),
  ]);
  // O corte fica o mais perto possível do pedido: no máximo 0,03 MET aquém, e nunca um degrau além.
  for (const bpm of [8, 13, 33]) {
    const mets = bpm / 15;
    const after = fix(stageAt(5, 1), 'aliviar', bpm);
    const cut = metabolicCost(5, 1) - metabolicCost(after.speed, after.incline);
    expect(cut).toBeGreaterThanOrEqual(mets - 0.03);
    expect(cut).toBeLessThan(mets + 0.05);
  }
  // Subindo, o custo não passa do pedido, e o degrau seguinte passaria.
  const raised = fix(stageAt(5, 1), 'subir', 12);
  expect(raised).toEqual(stageAt(5.2, 2.5));
  expect(metabolicCost(5.2, 2.5) - metabolicCost(5, 1)).toBeLessThanOrEqual(12 / 15);
  expect(metabolicCost(5.2, 3) - metabolicCost(5, 1)).toBeGreaterThan(12 / 15);
  // A caminhada nunca passa de 5,2 km/h, e por maior que seja a distância a correção para em 1 MET.
  expect(MAX_RAISE_METS).toBe(1);
  expect(fix(stageAt(5, 0), 'subir', 75)).toEqual(stageAt(5.2, 2));
  expect(metabolicCost(5.2, 2) - metabolicCost(5, 0)).toBeLessThanOrEqual(1);
  expect(metabolicCost(5.2, 2.5) - metabolicCost(5, 0)).toBeGreaterThan(1);
  expect(fix(stageAt(10, 1), 'subir', 75)).toEqual(stageAt(11, 1));
  // Numa correção fora da faixa um pedido pequeno ainda vale um degrau.
  expect(fix(stageAt(5, 0), 'subir', 0.1)).toEqual(stageAt(5.1, 0));
  expect(fix(stageAt(5.2, 2), 'subir', 0.1)).toEqual(stageAt(5.2, 2.5));
  expect(fix(stageAt(10, 1), 'subir', 0.1)).toEqual(stageAt(10.1, 1));
  // No limite da esteira a etapa volta como estava.
  const steep = stageAt(5.2, 15);
  expect(fix(steep, 'subir', 15)).toBe(steep);
  const fastest = stageAt(22, 1);
  expect(fix(fastest, 'subir', 15)).toBe(fastest);
  const slowest = stageAt(1, 0);
  expect(fix(slowest, 'aliviar', 15)).toBe(slowest);
  // A pessoa já anda abaixo dos alvos: a redução parte do que a esteira mede, e nenhum alvo fica acima disso.
  const below = correctedStage(stageAt(5.2, 3), 'aliviar', 0.2, sample(0, 5.04, 1.2));
  expect(below).toEqual(stageAt(5, 0.5));
  expect(below.speed).toBeLessThanOrEqual(5.04);
  expect(below.incline).toBeLessThanOrEqual(1.2);
  // Dentro da tolerância do guia vale o alvo: a esteira informa 4,995% quando está em 5%.
  expect(correctedStage(stageAt(5.2, 5), 'aliviar', 0.2, sample(0, 5.19, 4.995))).toEqual(stageAt(5.2, 4.5));
  // Uma etapa leve não desce de 3 km/h, a linha mais leve da escada; abaixo disso ela fica como está.
  const easy = (speed: number): Stage => ({ ...stageAt(speed, 0), measure: true });
  expect(correctedStage(easy(4), 'aliviar', 0.3, sample(0, 4, 0))).toEqual(easy(3.4));
  expect(correctedStage(easy(4), 'aliviar', 1.2, sample(0, 4, 0))).toEqual(easy(3));
  const light = easy(2.4);
  expect(correctedStage(light, 'aliviar', 1.2, sample(0, 2.4, 0))).toBe(light);
  // Sem velocidade e inclinação medidas, ou com a lona quase parada, não há conta a fazer.
  const walk = stageAt(5.2, 3);
  expect(correctedStage(walk, 'aliviar', 1, sample(0, 0.5, 3))).toBe(walk);
  expect(correctedStage(walk, 'aliviar', 1, { ...sample(0), speedKmh: null })).toBe(walk);
  expect(correctedStage(walk, 'subir', 1, { ...sample(0), inclinationPercent: null })).toBe(walk);
  expect(correctedStage(walk, 'aliviar', 0, sample(0, 5.2, 3))).toBe(walk);
  expect(correctedStage(walk, 'subir', NaN, sample(0, 5.2, 3))).toBe(walk);
});

it('com rampa o ajuste fino é a velocidade, de 4,9 a 5,2 km/h: 0,1 km/h vale bem menos que meio ponto de rampa', () => {
  const at = (stage: Stage) => sample(0, stage.speed, stage.incline);
  const ease = (stage: Stage, mets: number) => correctedStage(stage, 'aliviar', mets, at(stage));
  const tune = (stage: Stage, mets: number) => correctedStage(stage, 'subir', mets, at(stage), true);
  // Meio ponto de rampa a 5,2 km/h custa 0,22 MET; 0,1 km/h a 2,5%, 0,07.
  expect(metabolicCost(5.2, 3) - metabolicCost(5.2, 2.5)).toBeCloseTo(0.223, 3);
  expect(metabolicCost(5.2, 2.5) - metabolicCost(5.1, 2.5)).toBeCloseTo(0.069, 3);
  // Aliviando, o corte é o que chega mais perto do pedido: a rampa quando ela basta, e a velocidade para o que falta.
  expect(ease(stageAt(5.2, 2.5), 0.2)).toEqual(stageAt(5.2, 2));
  expect(ease(stageAt(5.2, 2.5), 0.3)).toEqual(stageAt(5.1, 2));
  expect(ease(stageAt(5.2, 2.5), 0.4)).toEqual(stageAt(5.2, 1.5));
  // Meio ponto de rampa tira 0,22 MET: serve para um pedido de 0,25, sem mexer também na velocidade.
  expect(ease(stageAt(5.2, 2.5), 0.25)).toEqual(stageAt(5.2, 2));
  // Com rampa a velocidade não desce de 4,9 km/h: dali o corte é pela rampa. A 4,9 km/h meio
  // ponto tira 0,21 MET, e um pedido de 0,23 não vira dois degraus.
  expect(ease(stageAt(4.9, 2.5), 0.2)).toEqual(stageAt(4.9, 2));
  expect(ease(stageAt(4.9, 4), 0.23)).toEqual(stageAt(4.9, 3.5));
  // Sem rampa, só resta a velocidade.
  expect(ease(stageAt(5.2, 0), 0.2)).toEqual(stageAt(4.8, 0));
  // No ajuste fino a carga sobe o que cabe no pedido, e fica como está se nenhum degrau cabe.
  const top = stageAt(5.2, 2.5);
  expect(tune(top, 0.2)).toBe(top);
  expect(tune(top, 0.25)).toEqual(stageAt(5.2, 3));
  expect(tune(stageAt(5, 2.5), 0.05)).toEqual(stageAt(5, 2.5));
  expect(tune(stageAt(5, 2.5), 0.1)).toEqual(stageAt(5.1, 2.5));
  expect(tune(stageAt(5, 2.5), 0.15)).toEqual(stageAt(5.2, 2.5));
  expect(tune(stageAt(5, 2.5), 0.3)).toEqual(stageAt(5.1, 3));
  // Abaixo de 4,9 km/h a caminhada é plana: primeiro a velocidade, e a rampa só perto do teto.
  expect(tune(stageAt(4.5, 0), 0.2)).toEqual(stageAt(4.9, 0));
  expect(tune(stageAt(4.5, 0), 0.5)).toEqual(stageAt(5, 0.5));
  // Correndo, 0,1 km/h vale 0,1 MET.
  const run = stageAt(7, 1);
  expect(tune(run, 0.05)).toBe(run);
  expect(tune(run, 0.1)).toEqual(stageAt(7.1, 1));
  // Um aumento nunca desce um alvo, e um alívio nunca sobe.
  for (const speed of [4.5, 4.9, 5, 5.2])
    for (const incline of [0, 1, 2.5, 7.5])
      for (const mets of [0.05, 0.1, 0.2, 0.4, 0.8]) {
        const from = stageAt(speed, incline);
        const up = tune(from, mets);
        expect(up.speed).toBeGreaterThanOrEqual(speed);
        expect(up.incline).toBeGreaterThanOrEqual(incline);
        expect(up.speed).toBeLessThanOrEqual(5.2);
        expect(metabolicCost(up.speed, up.incline) - metabolicCost(speed, incline)).toBeLessThanOrEqual(mets + 1e-9);
        const down = ease(from, mets);
        expect(down.speed).toBeLessThanOrEqual(speed);
        expect(down.incline).toBeLessThanOrEqual(incline);
        expect(metabolicCost(speed, incline) - metabolicCost(down.speed, down.incline)).toBeGreaterThanOrEqual(mets - 0.03 - 1e-9);
      }
});

it('aliviar uma corrida nunca deixa o alvo entre 5,2 e 6 km/h, nem sobe a velocidade ou a rampa', () => {
  const at = (stage: Stage) => sample(0, stage.speed, stage.incline);
  const ease = (stage: Stage, mets: number) => correctedStage(stage, 'aliviar', mets, at(stage));
  // Enquanto a corrida dá conta, só a velocidade desce, até 6 km/h, com a mesma folga de 0,03 MET da caminhada.
  // 6,2 km/h tira 0,796 MET de um pedido de 0,8.
  expect(ease(stageAt(7, 1), 0.8)).toEqual(stageAt(6.2, 1));
  expect(ease(stageAt(7, 1), 0.99)).toEqual(stageAt(6, 1));
  // 6,1 km/h com um corte de 0,1 MET: 6 km/h fica 0,0005 MET aquém, dentro da folga, e a pessoa segue correndo.
  expect(ease(stageAt(6.1, 1), 0.1)).toEqual(stageAt(6, 1));
  // Passou disso, a pessoa passa a andar a 5,2 km/h com a mesma rampa, e o alívio para aí, por maior
  // que seja o pedido: pela equação 5,2 km/h com 7,5% custa menos que correr a 6, mas não para quem
  // corre devagar, e a queda real da troca é grande. O resto vem na revisão seguinte.
  for (const mets of [0.1, 0.3, 1, 3]) expect(ease(stageAt(6, 1), mets)).toEqual(stageAt(5.2, 1));
  expect(ease(stageAt(7, 1), 1.4)).toEqual(stageAt(5.2, 1));
  // Um alvo antigo de corrida com 3% de rampa: andando ela fica nos 3%; com a esteira medindo menos, na medida.
  expect(ease(stageAt(6.6, 3), 1)).toEqual(stageAt(5.2, 3));
  expect(correctedStage(stageAt(6.6, 3), 'aliviar', 1, sample(0, 6.6, 2))).toEqual(stageAt(5.2, 2));
  // Já andando, a revisão seguinte desce pela caminhada, como sempre.
  expect(ease(stageAt(5.2, 1), 0.3)).toEqual(stageAt(5.1, 0.5));
  // Quem já baixou a esteira para andar num bloco de corrida está caminhando: a conta parte da
  // carga medida, e o alívio não pede mais velocidade nem mais rampa do que a esteira tem.
  expect(correctedStage(stageAt(6, 1), 'aliviar', 0.3, sample(0, 5.5, 1))).toEqual(stageAt(5, 1));
  expect(correctedStage(stageAt(10, 1), 'aliviar', 1, sample(0, 5, 1))).toEqual(stageAt(3.8, 0));
  for (const speed of [6, 8, 10])
    for (const walking of [1.5, 3, 4.5, 5, 5.2, 5.5, 5.9])
      for (const mets of [0.1, 0.5, 1, 2]) {
        const eased = correctedStage(stageAt(speed, 1), 'aliviar', mets, sample(0, walking, 1));
        expect(eased.speed).toBeLessThanOrEqual(Math.min(walking, 5.2));
        expect(eased.incline).toBeLessThanOrEqual(1);
      }
  // Um alvo antigo de caminhada acima de 5,2 km/h volta ao teto ao ser aliviado, e também ao subir.
  expect(ease(stageAt(5.6, 2), 0.1)).toEqual(stageAt(5.2, 2));
  expect(ease(stageAt(5.6, 2), 0.5)).toEqual(stageAt(5.2, 1.5));
  expect(correctedStage(stageAt(5.6, 2), 'subir', 0.3, sample(0, 5.6, 2))).toEqual(stageAt(5.2, 3));
  for (const speed of [6, 6.2, 6.5, 7, 8, 10, 12])
    for (const incline of [0, 1, 3])
      for (let mets = 0.1; mets < 8; mets += 0.1) {
        const eased = ease(stageAt(speed, incline), mets);
        expect(eased.speed <= 5.2 || eased.speed >= 6).toBe(true);
        expect(eased.speed).toBeLessThan(speed + 0.01);
        expect(eased.incline).toBeLessThanOrEqual(incline);
      }
});

it('correndo, a rampa nunca passa de 2%', () => {
  const at = (stage: Stage) => sample(0, stage.speed, stage.incline);
  // A corrida só muda pela velocidade: a rampa fica onde está.
  expect(correctedStage(stageAt(8, 2), 'subir', 0.5, at(stageAt(8, 2)))).toEqual(stageAt(8.4, 2));
  expect(correctedStage(stageAt(8, 2), 'aliviar', 0.5, at(stageAt(8, 2)))).toEqual(stageAt(7.5, 2));
  // Um alvo antigo de corrida com mais rampa volta a 2% no primeiro ajuste, e a velocidade faz a conta fechar.
  const steep = stageAt(8, 3);
  expect(correctedStage(steep, 'aliviar', 0.5, at(steep))).toEqual(stageAt(7.8, 2));
  expect(correctedStage(steep, 'subir', 0.3, at(steep))).toEqual(stageAt(8.6, 2));
  expect(metabolicCost(8.6, 2) - metabolicCost(8, 3)).toBeLessThanOrEqual(0.3);
  for (const speed of [6, 7, 9, 12])
    for (const incline of [0, 1, 2, 3, 6])
      for (const mets of [0.1, 0.4, 1, 2])
        for (const kind of ['aliviar', 'subir'] as const) {
          const stage = stageAt(speed, incline);
          const after = correctedStage(stage, kind, mets, at(stage));
          if (after !== stage && after.speed >= 6) expect(after.incline).toBeLessThanOrEqual(2);
        }
});

it('o registro do treino diz qual alvo a correção mudou', () => {
  expect(changeLabel(stageAt(5, 1), stageAt(4.8, 0))).toBe('reduzir velocidade');
  expect(changeLabel(stageAt(5.2, 2.5), stageAt(5.2, 0))).toBe('reduzir inclinação');
  expect(changeLabel(stageAt(5, 0), stageAt(5.2, 0))).toBe('aumentar velocidade');
  expect(changeLabel(stageAt(5.2, 2.5), stageAt(5.2, 5))).toBe('aumentar inclinação');
  // Velocidade e rampa juntas: vale a rampa, o último degrau da escada.
  expect(changeLabel(stageAt(5, 0), stageAt(5.2, 2))).toBe('aumentar inclinação');
});
