import type { TreadmillSample } from '@/treadmill/types';
import {
  betweenBlocks,
  blockEnd,
  carryBpm,
  COOLDOWN_MIN_SECONDS,
  nextBlockLoad,
  paceRecovery,
  type BlockEnd,
  type NextBlockInput,
} from '../intervals';
import { emptyLog, metabolicCost, type Change, type Plan, type StageLog } from '../model';
import { sessionPlan, sessions } from '../week';

// O VO₂máx do plano semanal: 600 s aquecendo, 4 tiros de 240 s com 180 s leves e 420 s desaquecendo.
// Tiros nas etapas 1, 3, 5 e 7; recuperações entre tiros nas 2, 4 e 6; a 8 vem antes da volta à calma.
const vo2 = (pace: number, grade = 1) => sessionPlan(sessions.vo2Long, pace, grade);
// 41 anos e FC máxima de 179: faixa de 161 a 170.
const zone = { low: 161, high: 170 };
const withLoads = (plan: Plan, loads: Record<number, [number, number]>): Plan => ({
  ...plan,
  stages: plan.stages.map((s, i) => (loads[i] ? { ...s, speed: loads[i][0], incline: loads[i][1] } : s)),
});
const decide = (input: Partial<NextBlockInput> & Pick<NextBlockInput, 'plan' | 'index' | 'ends'>) =>
  nextBlockLoad({
    log: input.plan.stages.map(() => emptyLog()),
    changes: [],
    zone,
    rest: null,
    strapReadings: 20,
    offBelt: false,
    ...input,
  });
const end = (index: number, speed: number, bpm: number, incline = 1): BlockEnd => ({ index, speed, incline, bpm });

it('a recuperação entre dois blocos é a etapa leve logo depois de um, com outro mais adiante', () => {
  const plan = vo2(6.6);
  expect(plan.stages.map((_, i) => betweenBlocks(plan, i))).toEqual([
    false, false, true, false, true, false, true, false, false, false,
  ]);
});

it('o fim do bloco é a carga medida nos últimos 20 s, nos degraus do guia, e as leituras da cinta ali', () => {
  const stage = vo2(6.6).stages[1];
  const at = (t: number, speedKmh: number, bpm: number | null, strap = true): TreadmillSample => ({
    at: t * 1000,
    speedKmh,
    inclinationPercent: 0.995,
    heartRateBpm: bpm,
    heartRateSource: strap ? 'strap' : 'treadmill',
    energyKcal: null,
    distanceM: null,
  });
  // 30 s de bloco até 100 s: a lona a 6,1 nos últimos 20 s (a pessoa seguiu um corte), a cinta lendo 15 deles.
  const samples = Array.from({ length: 30 }, (_, k) => at(70 + k, k < 10 ? 6.6 : 6.1, k % 4 === 0 ? null : 170));
  expect(blockEnd(samples, 100000, stage)).toEqual({ speed: 6.1, incline: 1, strapReadings: 15 });
  // Junto do alvo vale o alvo; sem a cinta não há leitura dela.
  expect(blockEnd(samples.map((s) => ({ ...s, speedKmh: 6.62, heartRateSource: 'treadmill' })), 100000, stage)).toEqual({
    speed: 6.6,
    incline: 1,
    strapReadings: 0,
  });
  expect(blockEnd(samples, 50000, stage)).toBeNull();
});

it('o acúmulo é a média das diferenças de fim entre tiros seguidos, descontada a mudança de carga', () => {
  const plan = vo2(6.6);
  expect(carryBpm(plan, [end(1, 6.6, 165)], null)).toBe(2);
  // Mesma carga: 8 e 4 bpm de um tiro para o outro.
  expect(carryBpm(plan, [end(1, 6.6, 162), end(3, 6.6, 170), end(5, 6.6, 174)], null)).toBe(6);
  // O 2º tiro foi 0,4 km/h mais forte (0,4 MET, 6 bpm a 15 por MET): dos 10 bpm, 4 são acúmulo.
  expect(carryBpm(plan, [end(1, 6.6, 160), end(3, 7.0, 170)], null)).toBeCloseTo(10 - 15 * (metabolicCost(7, 1) - metabolicCost(6.6, 1)), 6);
  // Um tiro sem fim medido no meio: o par que pula um tiro não conta.
  expect(carryBpm(plan, [end(1, 6.6, 160), end(5, 6.6, 172)], null)).toBe(2);
  // Nunca negativo.
  expect(carryBpm(plan, [end(1, 6.6, 168), end(3, 6.6, 164)], null)).toBe(0);
  // Um par de caminhada com corrida (pela velocidade alvo) não entra: a diferença entre as duas equações
  // não é o esforço real, e daria aqui um acúmulo falso de 15 bpm.
  const walked = withLoads(plan, { 3: [5.2, 1] });
  expect(carryBpm(walked, [end(1, 6.6, 175), end(3, 5.2, 172)], null)).toBe(2);
  expect(carryBpm(walked, [end(1, 6.6, 175), end(3, 5.2, 172), end(5, 6.6, 174)], null)).toBe(2);
  // A modalidade sai da velocidade medida no fim: quem não seguiu um corte para a caminhada e continuou
  // correndo a 6,6 conta como correndo, e o par entra; quem andou num tiro de corrida, como andando.
  expect(carryBpm(walked, [end(1, 6.6, 165), end(3, 6.6, 170)], null)).toBe(5);
  expect(carryBpm(plan, [end(1, 6.6, 175), end(3, 5.2, 172)], null)).toBe(2);
  const both = withLoads(plan, { 1: [5.2, 1], 3: [5.2, 1] });
  expect(carryBpm(both, [end(1, 5.2, 150, 1), end(3, 5.2, 155, 1)], null)).toBe(5);
});

it('a sessão real de 22/11, encadeada: cada tiro na carga que a decisão anterior deu, com os mesmos fins', () => {
  // Os fins de 22/11 (161, 170 e 178) e o plano de partida a 6,0 km/h e 1%; cada decisão vai para o plano.
  let plan = vo2(6.0);
  const apply = (d: NonNullable<ReturnType<typeof decide>>) => {
    plan = { ...plan, stages: plan.stages.map((s, i) => (d.stages.includes(i) ? d.to : s)) };
  };
  // 1ª recuperação: o 1º tiro terminou em 161. Sem par ainda, acúmulo de 2 e previsão de 163 para o
  // próximo. Para subir vale o fim do último tiro: 161 + 2 × 3 = 167, que já não está 3 abaixo do teto.
  // A carga fica.
  const ends = [end(1, 6.0, 161)];
  const first = decide({ plan, index: 2, ends })!;
  expect(first).toMatchObject({ index: 3, predictedBpm: 163, carryBpm: 2, verdict: 'manter', stages: [] });
  apply(first);
  // 2ª: o 2º tiro, na mesma carga, terminou em 170: acúmulo de 9 e previsão de 179. O corte de 1 MET não
  // cabe na corrida; um tiro de corrida não herda caminhada, e os dois seguintes ficam no piso dela,
  // 6,0 km/h plano.
  ends.push(end(3, 6.0, 170));
  const second = decide({ plan, index: 4, ends })!;
  expect(second).toMatchObject({ index: 5, predictedBpm: 179, carryBpm: 9, verdict: 'reduzir', stages: [5, 7] });
  expect([second.to.speed, second.to.incline]).toEqual([6, 0]);
  apply(second);
  // 3ª: o 3º tiro, a 6,0 km/h plano, terminou em 178. A previsão segue acima do teto, mas o 4º já está
  // no piso da corrida: nada muda, e o que faltar fica para a trava, dentro dele.
  ends.push(end(5, 6.0, 178, 0));
  const third = decide({ plan, index: 6, ends })!;
  expect(third).toMatchObject({ index: 7, verdict: 'reduzir', stages: [] });
  expect(third.predictedBpm).toBeGreaterThanOrEqual(186);
  expect([third.to.speed, third.to.incline]).toEqual([6, 0]);
  expect(plan.stages.filter((s) => !s.measure).map((s) => [s.speed, s.incline])).toEqual([
    [6, 1], [6, 1], [6, 0], [6, 0],
  ]);
  // A última recuperação vem antes da volta à calma: não há bloco a decidir.
  expect(decide({ plan, index: 8, ends: [...ends, end(7, 6.0, 165, 0)] })).toBeNull();
});

it('depois de um corte da trava perto do fim, o tiro que termina 2 acima do teto reduz o seguinte sem empilhar', () => {
  // A trava cortou o 1º tiro de 7,5 para 6,9 km/h a 90 s do fim, e a redução passou aos três tiros seguintes.
  const plan = withLoads(vo2(7.5), { 3: [6.9, 1], 5: [6.9, 1], 7: [6.9, 1] });
  const cut: Change = { second: 600 + 150, stage: 1, decision: 'reduzir velocidade', bpm: 172, from: [7.5, 1], to: [6.9, 1], by: 'trava' };
  const ends = [end(1, 6.9, 172)];
  const settled = decide({ plan, index: 2, ends, changes: [cut] })!;
  // O fim do tiro ainda responde ao corte: sai só o excesso, 2 bpm, a partir de 6,9.
  expect(settled).toMatchObject({ verdict: 'reduzir', stages: [3, 5, 7] });
  expect([settled.to.speed, settled.to.incline]).toEqual([6.7, 1]);
  expect(metabolicCost(6.9, 1) - metabolicCost(6.7, 1)).toBeLessThanOrEqual(0.5);
  // Sem o corte, a previsão (172 + 2 de acúmulo = 174) pediria 7 bpm: bem mais.
  const fresh = decide({ plan, index: 2, ends })!;
  expect(fresh.to.speed).toBeLessThan(6.7);
  // O corte feito há mais de 3 min do fim não segura a previsão.
  const early = decide({ plan, index: 2, ends, changes: [{ ...cut, second: 600 + 50 }] })!;
  expect(early.to).toEqual(fresh.to);
  // Terminando no teto, depois do corte, nada muda, e a carga não sobe.
  expect(decide({ plan, index: 2, ends: [end(1, 6.9, 160)], changes: [cut] })).toMatchObject({ verdict: 'manter', stages: [] });
});

it('a carga só sobe sem leitura acima do teto, sem corte da trava na sessão e com a pessoa na lona', () => {
  const plan = vo2(6.6);
  const ends = [end(1, 6.6, 158)];
  // 158 no fim, previsão de 160 para o próximo. Para subir vale o fim do último tiro, 158 + 2 × 3 = 164:
  // cabem 5 bpm, 0,33 MET a 15 por MET. Sobe, mas só o próximo tiro.
  const raised = decide({ plan, index: 2, ends })!;
  expect(raised).toMatchObject({ verdict: 'aumentar', predictedBpm: 160, stages: [3] });
  expect(raised.to.speed).toBe(6.9);
  // Bem abaixo, o aumento para em 1 MET.
  const far = decide({ plan, index: 2, ends: [end(1, 6.6, 130)] })!;
  expect(metabolicCost(far.to.speed, far.to.incline) - metabolicCost(6.6, 1)).toBeLessThanOrEqual(1);
  expect(far.to.speed).toBe(7.6);
  // Uma leitura acima do teto no bloco, um corte da trava em qualquer tiro, ou a pessoa fora da lona: não sobe.
  const log: StageLog[] = plan.stages.map(() => emptyLog());
  const above = log.map((l, i) => (i === 1 ? { ...l, zone: [0, 100, 1] as StageLog['zone'] } : l));
  const off = log.map((l, i) => (i === 1 ? { ...l, offBeltMs: 12000 } : l));
  const trava: Change = { second: 400, stage: 1, decision: 'reduzir velocidade', bpm: 172, from: [6.6, 1], to: [6.6, 1], by: 'trava' };
  for (const input of [{ log: above }, { log: off }, { offBelt: true }, { changes: [trava] }])
    expect(decide({ plan, index: 2, ends, ...input })).toMatchObject({ verdict: 'manter', stages: [], to: plan.stages[3] });
  // Na faixa do alvo (previsão de 167 a 169) a carga do fim se repete: um próximo tiro mais pesado desce a ela.
  const heavier = withLoads(plan, { 3: [7.0, 1], 5: [7.0, 1], 7: [6.0, 1] });
  expect(decide({ plan: heavier, index: 2, ends: [end(1, 6.6, 166)] })).toMatchObject({
    verdict: 'manter',
    stages: [3, 5],
    to: expect.objectContaining({ speed: 6.6, incline: 1 }),
  });
  // Um mais leve recebe a carga em que o anterior terminou no alvo, só ele (como um aumento): sem isso o
  // aumento do bloco anterior, que deu certo, voltaria à carga do plano sem aviso.
  const lighter = withLoads(plan, { 3: [6.0, 1], 5: [6.0, 1] });
  expect(decide({ plan: lighter, index: 2, ends: [end(1, 6.6, 166)] })).toMatchObject({
    verdict: 'manter',
    stages: [3],
    to: expect.objectContaining({ speed: 6.6, incline: 1 }),
  });
  // Esse caminho tem as mesmas condições do aumento. Com uma leitura acima do teto, um corte da trava ou
  // tempo fora da lona nesse bloco, ele fica como está.
  for (const input of [{ log: above }, { log: off }, { changes: [trava] }])
    expect(decide({ plan: lighter, index: 2, ends: [end(1, 6.6, 166)], ...input })).toMatchObject({ verdict: 'manter', stages: [] });
  // Nem com o BPM do momento (o da trava, que pode vir dos RR) acima do teto no bloco, ou no começo da
  // recuperação, sem nenhuma leitura da cinta acima dele.
  const liveBlock = log.map((l, i) => (i === 1 ? { ...l, liveTop: 172 } : l));
  const liveLate = log.map((l, i) => (i === 2 ? { ...l, liveTop: 171 } : l));
  for (const input of [{ log: liveBlock }, { log: liveLate }])
    expect(decide({ plan: lighter, index: 2, ends: [end(1, 6.6, 166)], ...input })).toMatchObject({ verdict: 'manter', stages: [] });
  // Nem com um corte da trava em outro tiro da sessão: na 2ª recuperação, com o corte no 1º tiro.
  const twice = [end(1, 6.6, 167), end(3, 6.6, 167)];
  const second = withLoads(plan, { 5: [6.0, 1], 7: [6.0, 1] });
  expect(decide({ plan: second, index: 4, ends: twice })).toMatchObject({ verdict: 'manter', stages: [5] });
  expect(decide({ plan: second, index: 4, ends: twice, changes: [trava] })).toMatchObject({ verdict: 'manter', stages: [] });
  // A carga passada fica no máximo 1 MET acima da planejada: quem terminou a 7,6 km/h, num alvo de 6,0,
  // em 166, leva o próximo tiro a 7,0, e não a 7,6.
  const capped = decide({ plan: lighter, index: 2, ends: [end(1, 7.6, 166)] })!;
  expect(capped).toMatchObject({ verdict: 'manter', stages: [3] });
  expect([capped.to.speed, capped.to.incline]).toEqual([7, 1]);
  expect(metabolicCost(7, 1) - metabolicCost(6, 1)).toBeLessThanOrEqual(1);
  // O aumento tem o mesmo limite, a partir da carga planejada.
  const fast = decide({ plan: lighter, index: 2, ends: [end(1, 7.6, 140)] })!;
  expect(fast).toMatchObject({ verdict: 'aumentar', stages: [3] });
  expect(metabolicCost(fast.to.speed, fast.to.incline) - metabolicCost(6, 1)).toBeLessThanOrEqual(1);
  // A pessoa terminou o tiro a 7,6 km/h, acima do alvo de 6,6, com previsão de 171: o corte a partir
  // dali ainda passaria do alvo do próximo, e um corte nunca sobe a carga dele.
  expect(decide({ plan, index: 2, ends: [end(1, 7.6, 169)] })).toMatchObject({ verdict: 'reduzir', stages: [], to: plan.stages[3] });
  // Uma leitura acima do teto nos primeiros segundos da recuperação (a FC ainda subindo): também não sobe.
  const late = log.map((l, i) => (i === 2 ? { ...l, zone: [0, 10, 2] as StageLog['zone'] } : l));
  expect(decide({ plan, index: 2, ends, log: late })).toMatchObject({ verdict: 'manter', stages: [] });
});

it('um tiro de corrida não herda caminhada da decisão, e depois de um tiro que terminou andando pela troca ela não reduz de novo', () => {
  // O fim a 6,6 km/h em 182: previsão de 184 e corte de 1 MET, que não cabe nem a 6,0 km/h plano. Os
  // tiros seguintes ficam no piso da corrida, 6,0 km/h plano; o que faltar fica para a trava.
  const deep = decide({ plan: vo2(6.6), index: 2, ends: [end(1, 6.6, 182)] })!;
  expect(deep).toMatchObject({ verdict: 'reduzir', stages: [3, 5, 7] });
  expect([deep.to.speed, deep.to.incline]).toEqual([6, 0]);
  // A trava tirou o 1º tiro da corrida (6,0 km/h com 1% para 5,2 km/h com 1%) a 2 min do fim, e os tiros
  // seguintes já começam no piso da corrida: a decisão mostra o veredito e a previsão, mas não reduz de
  // novo a partir da caminhada.
  const plan = vo2(6.0);
  const walkOff: Change = { second: 700, stage: 1, decision: 'reduzir velocidade', bpm: 171, from: [6, 1], to: [5.2, 1], by: 'trava' };
  const after = decide({ plan, index: 2, ends: [end(1, 5.2, 172)], changes: [walkOff] })!;
  expect(after).toMatchObject({ verdict: 'reduzir', predictedBpm: 174, stages: [], to: plan.stages[3] });
  // Com a troca mais cedo (o fim já não responde a ela), também não.
  expect(decide({ plan, index: 2, ends: [end(1, 5.2, 172)], changes: [{ ...walkOff, second: 610 }] })).toMatchObject({ stages: [] });
});

it('um tiro que terminou abaixo de 3 km/h não passa essa carga aos seguintes', () => {
  // A pessoa baixou a esteira a 2,5 km/h no fim do 1º tiro. Antes o corte (175 BPM) e até o "manter"
  // (160) levavam os tiros seguintes a 2,5 km/h; agora eles ficam no alvo planejado, e a trava cuida
  // do que vier dentro deles. O veredito e a previsão continuam no painel.
  const plan = vo2(6.6);
  for (const bpm of [175, 160]) {
    const slow = decide({ plan, index: 2, ends: [end(1, 2.5, bpm, 0)] })!;
    expect(slow).toMatchObject({ stages: [], to: plan.stages[3] });
  }
  expect(decide({ plan, index: 2, ends: [end(1, 2.5, 175, 0)] })).toMatchObject({ verdict: 'reduzir' });
});

it('sem a cinta, sem o fim medido ou com ele fora das cargas do guia, não há decisão', () => {
  const plan = vo2(6.6);
  expect(decide({ plan, index: 2, ends: [end(1, 6.6, 160)], strapReadings: 9 })).toBeNull();
  expect(decide({ plan, index: 2, ends: [] })).toBeNull();
  // O fim medido é do bloco anterior a outro: não serve para esta recuperação.
  expect(decide({ plan, index: 4, ends: [end(1, 6.6, 160)] })).toBeNull();
  // 5,6 km/h não é carga do guia (nem caminhada, nem corrida).
  expect(decide({ plan, index: 2, ends: [end(1, 5.6, 160)] })).toBeNull();
  // Uma etapa de esforço não é recuperação.
  expect(decide({ plan, index: 3, ends: [end(1, 6.6, 160)] })).toBeNull();
  // Um tiro de menos de 1 min: nos últimos 20 s dele a lona ainda pode estar acelerando.
  const sprint = { ...plan, stages: plan.stages.map((s, i) => (i === 1 ? { ...s, seconds: 59 } : s)) };
  expect(decide({ plan: sprint, index: 2, ends: [end(1, 6.6, 150)] })).toBeNull();
  expect(decide({ plan: { ...sprint, stages: sprint.stages.map((s, i) => (i === 1 ? { ...s, seconds: 60 } : s)) }, index: 2, ends: [end(1, 6.6, 150)] })).not.toBeNull();
});

describe('blocos longos: a carga acertada dentro do bloco passa ao seguinte', () => {
  // O limiar do plano: 600 s aquecendo, 3 blocos de 480 s com 120 s leves. Blocos nas etapas 1, 3 e 5.
  // 41 anos, FC máxima de 179: faixa de 152 a 161. O plano saiu a 5,2 km/h e 4%.
  const limiar = { low: 152, high: 161 };
  const planned = sessionPlan(sessions.threshold, 5.2, 4);
  const decideLong = (input: Partial<NextBlockInput> & Pick<NextBlockInput, 'plan' | 'index' | 'ends'>) =>
    decide({ zone: limiar, rest: 61, ...input });
  const logs = (plan: Plan, over: Record<number, Partial<StageLog>>) =>
    plan.stages.map((_, i) => ({ ...emptyLog(), ...over[i] }));
  // Em 27/11 a IA subiu o 1º bloco de 4% a 6% e a 8%, e a trava o baixou a 7% a 1 min do fim.
  const raises: Change[] = [
    { second: 740, stage: 1, decision: 'aumentar inclinação', bpm: 133, from: [5.2, 4], to: [5.2, 6], by: 'ia' },
    { second: 861, stage: 1, decision: 'aumentar inclinação', bpm: 142, from: [5.2, 6], to: [5.2, 8], by: 'ia' },
  ];
  const trava: Change = { second: 1019, stage: 1, decision: 'reduzir inclinação', bpm: 163, from: [5.2, 8], to: [5.2, 7], by: 'trava' };

  it('o treino de 27/11: o 2º bloco parte da carga em que o 1º terminou no teto, e não dos 4% do plano', () => {
    const plan = withLoads(planned, { 1: [5.2, 7] });
    const first = decideLong({
      plan,
      index: 2,
      ends: [end(1, 5.2, 161, 7)],
      changes: [...raises, trava],
      log: logs(plan, { 1: { zone: [354, 69, 57], liveTop: 164 } }),
    })!;
    // O corte da trava foi a 1 min do fim: o fim ainda responde a ele, e sai só o excesso sobre o teto
    // (nenhum). A carga é 1,3 MET mais pesada que a do plano, e passa inteira: foi o app que a pediu.
    expect(first).toMatchObject({ index: 3, verdict: 'manter', carried: true, stages: [3] });
    expect([first.to.speed, first.to.incline]).toEqual([5.2, 7]);
    expect(metabolicCost(5.2, 7) - metabolicCost(5.2, 4)).toBeGreaterThan(1);
    // Só o próximo bloco muda, como num aumento.
    expect(first.from).toEqual(plan.stages[3]);
  });

  it('o 3º bloco de 27/11 parte dos 7,5% em que o 2º terminou na faixa', () => {
    // A pessoa manteve 7,5% e o app adotou essa carga; a trava tinha cortado a 2 min do fim.
    const plan = withLoads(planned, { 1: [5.2, 7], 3: [5.2, 7.5] });
    const late: Change = { second: 1547, stage: 3, decision: 'reduzir velocidade', bpm: 162, from: [5.2, 7.5], to: [5.1, 7], by: 'trava' };
    const adopted: Change = { second: 1673, stage: 3, decision: 'adotar carga', bpm: 159, from: [5.1, 7], to: [5.2, 7.5], by: 'pessoa' };
    const third = decideLong({
      plan,
      index: 4,
      ends: [end(1, 5.2, 161, 7), end(3, 5.2, 159, 7.5)],
      changes: [...raises, trava, late, adopted],
      log: logs(plan, { 3: { zone: [184, 296, 0], liveTop: 162 } }),
    })!;
    expect(third).toMatchObject({ index: 5, verdict: 'manter', carried: true, stages: [5] });
    expect([third.to.speed, third.to.incline]).toEqual([5.2, 7.5]);
  });

  it('com o bloco encostando no teto, o acúmulo não fica abaixo do padrão, e a carga passa já aliviada', () => {
    // O 2º bloco terminou em 159 a 7,5%, com o BPM do momento em 162 no meio dele e sem corte da trava.
    // O par medido dá acúmulo 0 (o 1º bloco terminou mais alto); com os 2 bpm do padrão a previsão é 161,
    // acima de teto − 1: saem 3 bpm, e o 3º bloco parte de 7%, ainda bem acima dos 4% do plano.
    const plan = withLoads(planned, { 1: [5.2, 7], 3: [5.2, 7.5] });
    const ends = [end(1, 5.2, 161, 7), end(3, 5.2, 159, 7.5)];
    const touched = decideLong({ plan, index: 4, ends, changes: raises, log: logs(plan, { 3: { liveTop: 162 } }) })!;
    expect(touched).toMatchObject({ verdict: 'reduzir', carryBpm: 2, predictedBpm: 161, carried: true, stages: [5] });
    expect([touched.to.speed, touched.to.incline]).toEqual([5.2, 7]);
    // Sem nada acima do teto vale o acúmulo medido, e a carga do fim passa como está.
    const clean = decideLong({ plan, index: 4, ends, changes: raises })!;
    expect(clean).toMatchObject({ verdict: 'manter', carryBpm: 0, carried: true, stages: [5] });
    expect([clean.to.speed, clean.to.incline]).toEqual([5.2, 7.5]);
  });

  it('um corte pedido pela previsão desce a partir da carga do fim, e não volta à do plano', () => {
    // O 1º bloco, levado a 7% pela IA, terminou em 161 sem passar do teto: previsão de 163, corte de 5 bpm.
    const plan = withLoads(planned, { 1: [5.2, 7] });
    const cut = decideLong({ plan, index: 2, ends: [end(1, 5.2, 161, 7)], changes: raises })!;
    expect(cut).toMatchObject({ verdict: 'reduzir', predictedBpm: 163, carried: true, stages: [3] });
    // Meio MET a menos que os 7% do fim, no máximo, e ainda bem acima dos 4% do plano.
    const cost = metabolicCost(cut.to.speed, cut.to.incline);
    expect(cost).toBeLessThan(metabolicCost(5.2, 7));
    expect(cost).toBeGreaterThan(metabolicCost(5.2, 7) - 0.5);
    expect(cost).toBeGreaterThan(metabolicCost(5.2, 4) + 0.5);
  });

  it('a carga que a pessoa manteve acima do alvo, sem o app adotar, não passa ao bloco seguinte', () => {
    // O alvo do 1º bloco ficou em 6%, e ela terminou a 8%: acima do teto no bloco, não há como subir.
    const plan = withLoads(planned, { 1: [5.2, 6] });
    const own = decideLong({
      plan,
      index: 2,
      ends: [end(1, 5.2, 158, 8)],
      log: logs(plan, { 1: { liveTop: 163 } }),
    })!;
    expect(own).toMatchObject({ carried: false, stages: [], to: plan.stages[3] });
    // Com a pessoa fora da lona no bloco, a carga do fim também não passa: o BPM dele não vale.
    const off = decideLong({
      plan: withLoads(planned, { 1: [5.2, 7] }),
      index: 2,
      ends: [end(1, 5.2, 150, 7)],
      changes: [trava],
      log: logs(planned, { 1: { offBeltMs: 20000 } }),
    })!;
    expect(off).toMatchObject({ carried: false, stages: [] });
  });

  it('com um aumento a menos de 4 min do fim, o BPM do fim ainda subia: a carga passa como está, sem subir mais', () => {
    // O 1º bloco vai de 600 a 1080 s. A IA o levou a 6% aos 740 s e a 7% aos 900 s, 3 min antes do
    // fim, e ele terminou em 150, bem abaixo do alvo. Pelo BPM a carga subiria; o 2º parte dos 7%.
    const plan = withLoads(planned, { 1: [5.2, 7] });
    const late: Change = { second: 900, stage: 1, decision: 'aumentar inclinação', bpm: 140, from: [5.2, 6], to: [5.2, 7], by: 'ia' };
    const kept = decideLong({ plan, index: 2, ends: [end(1, 5.2, 150, 7)], changes: [raises[0], late] })!;
    expect(kept).toMatchObject({ verdict: 'manter', carried: true, stages: [3] });
    expect([kept.to.speed, kept.to.incline]).toEqual([5.2, 7]);
    // Com o último aumento a mais de 4 min do fim (aos 800 s), o BPM do fim já é o da carga: a decisão
    // sobe a partir dos 7%, sem o limite de 1 MET acima dos 4% do plano.
    const early = decideLong({ plan, index: 2, ends: [end(1, 5.2, 150, 7)], changes: [raises[0], { ...late, second: 800 }] })!;
    expect(early).toMatchObject({ verdict: 'aumentar', carried: false, stages: [3] });
    expect(metabolicCost(early.to.speed, early.to.incline)).toBeGreaterThan(metabolicCost(5.2, 7));
    expect(metabolicCost(early.to.speed, early.to.incline) - metabolicCost(5.2, 7)).toBeLessThanOrEqual(1);
    // A carga que a pessoa manteve e o app adotou não conta como aumento recente.
    const adopted: Change = { second: 1000, stage: 1, decision: 'adotar carga', bpm: 148, from: [5.2, 6], to: [5.2, 7], by: 'pessoa' };
    expect(decideLong({ plan, index: 2, ends: [end(1, 5.2, 150, 7)], changes: [raises[0], adopted] })).toMatchObject({ verdict: 'aumentar' });
  });

  it('num tiro nada muda: com leitura acima do teto ou corte da trava, a carga mais pesada não passa', () => {
    const plan = withLoads(vo2(6.6), { 3: [6.0, 1], 5: [6.0, 1] });
    const log = plan.stages.map((_, i) => (i === 1 ? { ...emptyLog(), liveTop: 172 } : emptyLog()));
    expect(decide({ plan, index: 2, ends: [end(1, 6.6, 166)], log })).toMatchObject({ verdict: 'manter', carried: false, stages: [] });
  });
});

describe('a recuperação pelo coração', () => {
  // Máxima de 179: a recuperação termina com o BPM do momento em 116 (65%).
  const pace = (plan: Plan, index: number, into: number, bpm: number | null, planned = 180) =>
    paceRecovery({ plan, index, into, planned, bpm, maxBpm: 179 });
  const total = (plan: Plan) => plan.stages.reduce((n, s) => n + s.seconds, 0);
  const apply = (plan: Plan, stages: Plan['stages']) => ({ ...plan, stages });

  it('termina com o BPM a 65% da máxima, não antes de 2 min, e a volta à calma fica com o tempo', () => {
    const plan = vo2(6.6);
    expect(total(plan)).toBe(2700);
    expect(pace(plan, 2, 100, 110)).toBeNull();
    const early = pace(plan, 2, 119, 116)!;
    expect(early).toMatchObject({ seconds: 120, reason: 'cedo' });
    expect(early.stages[2].seconds).toBe(120);
    expect(early.stages[9].seconds).toBe(480);
    expect(total(apply(plan, early.stages))).toBe(2700);
    // 117 ainda não é 65%; sem leitura, ou na última recuperação (antes da volta à calma), nada muda.
    expect(pace(plan, 2, 130, 117)).toBeNull();
    expect(pace(plan, 2, 130, null)).toBeNull();
    expect(pace(plan, 8, 130, 100)).toBeNull();
  });

  it('com o BPM ainda alto ela é alongada, até 5 min, com o tempo da volta à calma dividido entre as que faltam', () => {
    let plan = vo2(6.6);
    // Faltam 3 recuperações e a volta à calma pode emprestar 4 min: 80 s para esta.
    const first = pace(plan, 2, 174, 140)!;
    expect(pace(plan, 2, 170, 140)).toBeNull();
    expect(first).toMatchObject({ seconds: 260, reason: 'alongada' });
    plan = apply(plan, first.stages);
    expect([plan.stages[2].seconds, plan.stages[9].seconds, total(plan)]).toEqual([260, 340, 2700]);
    // No tempo a mais o BPM cai: ela termina ali, e a volta à calma recebe o que sobrou.
    const done = pace(plan, 2, 200, 115)!;
    expect(done).toMatchObject({ seconds: 201, reason: 'alongada' });
    expect([done.stages[9].seconds, total(apply(plan, done.stages))]).toEqual([399, 2700]);
    // A leitura some no tempo a mais: vale o tempo do plano, ou agora, se ele já passou.
    expect(pace(plan, 2, 150, null)).toMatchObject({ seconds: 180, reason: 'plano' });
    expect(pace(plan, 2, 200, null)).toMatchObject({ seconds: 201, reason: 'plano' });
    // As três recuperações alongadas até o fim: a volta à calma termina em 3 min, nunca menos.
    plan = vo2(6.6);
    for (const index of [2, 4, 6]) plan = apply(plan, pace(plan, index, 176, 150)!.stages);
    expect(plan.stages.map((s) => s.seconds)).toEqual([600, 240, 260, 240, 260, 240, 260, 240, 180, COOLDOWN_MIN_SECONDS]);
    expect(total(plan)).toBe(2700);
    // Com uma volta à calma longa, o teto é de 5 min.
    const long = { ...vo2(6.6), stages: vo2(6.6).stages.map((s, i) => (i === 9 ? { ...s, seconds: 1800 } : s)) };
    expect(pace(long, 2, 176, 150)).toMatchObject({ seconds: 300 });
    // Sem volta à calma que pague o tempo (3 min ou menos), ela não é alongada.
    const short = { ...vo2(6.6), stages: vo2(6.6).stages.map((s, i) => (i === 9 ? { ...s, seconds: 180 } : s)) };
    expect(pace(short, 2, 176, 150)).toBeNull();
  });
});

describe('VO₂máx de tiros curtos: 8 × 2 min com 1 min leve', () => {
  // 600 s aquecendo, 8 tiros de 120 s (etapas 1, 3, … 15) com 60 s leves e 660 s desaquecendo.
  const short = (pace = 6.0) => sessionPlan(sessions.vo2, pace, 1);

  it('tem os mesmos 16 minutos de esforço e 45 de treino', () => {
    const plan = short();
    expect(plan.stages.filter((s) => !s.measure).map((s) => s.seconds)).toEqual(Array(8).fill(120));
    expect(plan.stages.reduce((n, s) => n + s.seconds, 0)).toBe(45 * 60);
    expect(plan.stages[2]).toMatchObject({ name: 'Recuperação', seconds: 60, measure: true });
  });

  it('a pausa de 1 minuto fica no tempo do plano: a recuperação guiada pelo coração não a alonga nem encurta', () => {
    const plan = short();
    // BPM ainda bem acima de 65% da máxima no fim da pausa: com 2 min ou mais ela seria alongada.
    expect(paceRecovery({ plan, index: 2, into: 58, planned: 60, bpm: 150, maxBpm: 179 })).toBeNull();
    // E já abaixo dos 65% logo no começo: também não encurta.
    expect(paceRecovery({ plan, index: 2, into: 20, planned: 60, bpm: 100, maxBpm: 179 })).toBeNull();
    // A mesma leitura numa recuperação de 3 min alonga.
    expect(paceRecovery({ plan: vo2(6.6), index: 2, into: 178, planned: 180, bpm: 150, maxBpm: 179 })).not.toBeNull();
  });

  it('sem par medido, o acúmulo esperado com a pausa curta é de 5 bpm por tiro', () => {
    const first = decide({ plan: short(), index: 2, ends: [end(1, 6.0, 148)] })!;
    expect(first).toMatchObject({ carryBpm: 5, predictedBpm: 153, verdict: 'manter', stages: [] });
    // Com 3 min de pausa o padrão continua 2.
    expect(decide({ plan: vo2(6.0), index: 2, ends: [end(1, 6.0, 148)] })!.carryBpm).toBe(2);
  });

  it('a série chega à faixa sem aumento no começo e recebe o corte quando a previsão passa do teto', () => {
    // Fins subindo de tiro em tiro, como numa série com pausa curta.
    let plan = short();
    const ends: BlockEnd[] = [];
    const verdicts: string[] = [];
    [148, 156, 162, 166].forEach((bpm, k) => {
      const block = 1 + 2 * k;
      ends.push(end(block, plan.stages[block].speed, bpm, plan.stages[block].incline));
      const d = decide({ plan, index: block + 1, ends })!;
      verdicts.push(d.verdict);
      plan = { ...plan, stages: plan.stages.map((s, i) => (d.stages.includes(i) ? d.to : s)) };
    });
    // Nos três primeiros o fim do último tiro, pela reta, já estaria no teto: a carga não sobe.
    // No 4º, 166 + 5 de acúmulo passa de 169: os tiros seguintes descem ao piso da corrida.
    expect(verdicts).toEqual(['manter', 'manter', 'manter', 'reduzir']);
    expect(plan.stages.filter((s) => !s.measure).map((s) => [s.speed, s.incline])).toEqual([
      [6, 1], [6, 1], [6, 1], [6, 1], [6, 0], [6, 0], [6, 0], [6, 0],
    ]);
  });

  it('o acúmulo usa os dois pares mais recentes: os saltos do começo não pesam nos últimos tiros', () => {
    const plan = short();
    const ends = [end(1, 6.0, 140), end(3, 6.0, 152), end(5, 6.0, 158), end(7, 6.0, 160)];
    // Diferenças de 12, 6 e 2: valem as duas últimas.
    expect(carryBpm(plan, ends, null)).toBe(4);
  });
});
