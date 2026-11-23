import type { TreadmillSample } from '@/treadmill/types';
import {
  accumulate,
  emptyLog,
  energyCost,
  metabolicCost,
  newWorkout,
  validLoad,
  type Plan,
  type Workout,
} from '../model';
import {
  ageMax,
  aimBand,
  bpmPerMet,
  dailyTarget,
  DEFAULT_BPM_PER_MET,
  energyKcal,
  forcedReductions,
  heartProfile,
  loadLadder,
  maxBounds,
  maxFloor,
  mets,
  observedPeak,
  restingBpm,
  restOf,
} from '../physiology';
import { sessionPlan, week } from '../week';

const profile = { age: 40, weightKg: 78, heightCm: 175 };
const plan = sessionPlan(week[1].session!, 5, 1);
const pulses = (start: number, values: number[]) =>
  values.map((bpm, i) => ({ at: start + i * 1000, bpm }));
const session = (restBpm: number | null, maxBpm: number | null): Workout => ({
  ...newWorkout(profile, 'ble', null),
  restBpm,
  estimate: maxBpm ? { level: 'Base em formação', summary: '', maxBpm } : null,
});

it('lê a FC de repouso das primeiras leituras, sem as 2 iniciais de cada pegada', () => {
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88, 87]), false)).toBe(88);
  // Com a janela aberta ainda espera a quinta leitura; fechada, aceita quatro.
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88]), false)).toBeNull();
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88]), true)).toBe(89);
  // Duas pegadas curtas não somam leituras aproveitáveis.
  expect(restingBpm([...pulses(0, [90, 91, 92]), ...pulses(10000, [93, 94, 95])], true)).toBeNull();
});

it('usa a menor leitura de repouso recente, com desconto, e a mediana das previsões de máxima', () => {
  expect(heartProfile(profile, [])).toEqual({ rest: null, max: 180, maxSource: 'idade' });
  const history = [
    session(92, 184),
    session(88, 181),
    session(null, null),
    session(95, 190),
    session(90, null),
    session(86, null),
    session(60, 150), // sexta leitura e quarta previsão: já ficam de fora
  ];
  // Registros sem origem do repouso são do primeiro minuto andando: perdem os 15 bpm.
  expect(heartProfile(profile, history)).toEqual({ rest: 71, restSource: 'andando', max: 184, maxSource: 'IA' });
});

it('desconta os 15 bpm só das medidas andando: a feita parado vale como está', () => {
  const at = (restBpm: number, restSource?: Workout['restSource']) => ({ ...session(restBpm, null), restSource });
  // Parado 68 contra andando 80 (65): vale o 65 do andando.
  expect(heartProfile(profile, [at(68, 'parado'), at(80, 'andando')])).toMatchObject({
    rest: 65,
    restSource: 'andando',
  });
  // Parado 62 contra um registro antigo de 80 (65): vale o 62 parado, sem desconto.
  expect(heartProfile(profile, [at(62, 'parado'), at(80)])).toMatchObject({ rest: 62, restSource: 'parado' });
  // Só duas medidas paradas: a menor delas, como está.
  expect(heartProfile(profile, [at(64, 'parado'), at(61, 'parado')])).toMatchObject({ rest: 61, restSource: 'parado' });
  expect(restOf(at(70, 'parado'))).toBe(70);
  expect(restOf(at(70, 'andando'))).toBe(55);
  expect(restOf(at(70))).toBe(55);
  expect(restOf({ restBpm: null })).toBeNull();
});

it('com 3 ou mais medidas parado entre as 5 últimas, o repouso em uso é a mediana delas', () => {
  const at = (restBpm: number, restSource?: Workout['restSource']) => ({ ...session(restBpm, null), restSource });
  // Uma leitura falsa de 40 (cinta mal assentada) não manda no perfil pelos próximos 5 treinos.
  expect(heartProfile(profile, [at(40, 'parado'), at(64, 'parado'), at(62, 'parado')])).toMatchObject({
    rest: 62,
    restSource: 'parado',
  });
  // As andando ficam de fora da mediana, mesmo com o desconto as deixando mais baixas.
  const mixed = [at(63, 'parado'), at(70, 'andando'), at(61, 'parado'), at(72), at(65, 'parado')];
  expect(heartProfile(profile, mixed)).toMatchObject({ rest: 63, restSource: 'parado' });
  // Só contam as 5 últimas: a terceira medida parado, sexta da lista, fica de fora.
  const old = [at(63, 'parado'), at(70, 'andando'), at(61, 'parado'), at(72), at(80), at(65, 'parado')];
  expect(heartProfile(profile, old)).toMatchObject({ rest: 55, restSource: 'andando' });
});

it('a faixa de cada sessão são os percentuais do plano semanal sobre a FC máxima', () => {
  const zone = (day: number) => dailyTarget(sessionPlan(week[day].session!, 5, 1), profile);
  expect(zone(1)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  expect(zone(2)).toEqual({ objective: 'VO₂máx', low: 162, high: 171 });
  expect(zone(3)).toEqual({ objective: 'Recuperação', low: 90, high: 108 });
  expect(zone(5)).toEqual({ objective: 'Limiar', low: 153, high: 162 });
  expect(zone(6)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  // Treino livre: vale a base aeróbica.
  expect(dailyTarget(null, profile)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  // A máxima prevista move a faixa; o repouso medido, não.
  expect(dailyTarget(plan, profile, { rest: 50, max: 190, maxSource: 'IA' })).toMatchObject({ low: 124, high: 143 });
});

it('planos gravados antes do plano semanal continuam com as faixas da época', () => {
  const old = (goal: string, objective?: string) =>
    dailyTarget({ goal, objective, minutes: 45, stages: [] } as unknown as Plan, profile);
  expect(old('Caminhada inclinada', 'Base aeróbica')).toEqual({ objective: 'Base aeróbica', low: 99, high: 117 });
  expect(old('Resistência', 'Resistência moderada')).toMatchObject({ low: 108, high: 126 });
  expect(old('Recuperação ativa')).toEqual({ objective: 'Recuperação leve', low: 90, high: 108 });
  expect(old('Queima de gordura')).toMatchObject({ objective: 'Base aeróbica', low: 99, high: 117 });
});

it('calcula o custo metabólico da carga e monta a escada de cargas', () => {
  // Caminhada abaixo de 6 km/h, corrida a partir daí.
  expect([mets(3.5, 2), mets(5, 0), mets(5.2, 0), mets(5.2, 7.5), mets(6, 1), mets(10, 1)]).toEqual([
    3.3, 3.4, 3.5, 6.8, 7, 11,
  ]);
  const ladder = loadLadder();
  // Caminhada plana até 5 km/h de 0,5 em 0,5, depois 5,2 km/h, a velocidade mais alta da caminhada.
  expect(ladder.slice(0, 6).map((r) => [r.pace, r.grade])).toEqual([
    [3, 0], [3.5, 0], [4, 0], [4.5, 0], [5, 0], [5.2, 0],
  ]);
  // A rampa sobe a 5,2 km/h, de 0 a 7,5%: dali a corrida a 6 km/h já custa mais.
  expect(ladder.filter((r) => r.pace === 5.2).map((r) => r.grade)).toEqual(
    Array.from({ length: 16 }, (_, i) => i / 2),
  );
  // Nenhuma linha entre o teto da caminhada e o começo da corrida: de 5,3 a 5,9 km/h não há alvo.
  expect(ladder.filter((r) => r.pace > 5.2 && r.pace < 6)).toEqual([]);
  expect(ladder.some((r) => r.pace === 5.6)).toBe(false);
  // Corrida a 1% de 6 km/h até o máximo da esteira.
  const running = ladder.filter((r) => r.pace >= 6);
  expect(running[0]).toEqual({ pace: 6, grade: 1, mets: 7 });
  expect(running.every((r) => r.grade === 1)).toBe(true);
  expect(ladder[ladder.length - 1]).toMatchObject({ pace: 22, grade: 1 });
  // Toda linha é uma carga que o guia pode pedir: caminhada até 5,2 km/h, ou corrida com até 2% de rampa.
  expect(ladder.every((r) => validLoad(r.pace, r.grade))).toBe(true);
  expect([validLoad(5.2, 15), validLoad(6, 2), validLoad(12, 0)]).toEqual([true, true, true]);
  expect([validLoad(5.3, 0), validLoad(5.9, 1), validLoad(6, 2.5), validLoad(8, 3)]).toEqual([false, false, false, false]);
  // Cada linha custa mais que a anterior: nenhum custo aparece duas vezes.
  ladder.forEach((row, i) => expect(row.mets).toBeGreaterThan(ladder[i - 1]?.mets ?? 0));
});

it('a reta de FC por MET sai da leitura e do repouso, e vale 15 fora de 8 a 25 ou sem repouso', () => {
  // (150 − 70) ÷ (5 − 1) = 20 bpm por MET.
  expect(bpmPerMet(150, 5, 70)).toBe(20);
  // As bordas valem: 8 e 25.
  expect(bpmPerMet(112, 5, 80)).toBe(8);
  expect(bpmPerMet(180, 5, 80)).toBe(25);
  // Logo fora delas, e sem FC de repouso, vale a conta do plano.
  expect(DEFAULT_BPM_PER_MET).toBe(15);
  expect(bpmPerMet(111, 5, 80)).toBe(15);
  expect(bpmPerMet(181, 5, 80)).toBe(15);
  expect(bpmPerMet(150, 5, null)).toBe(15);
  // Leitura abaixo do repouso ou carga de 1 MET não traçam reta nenhuma.
  expect(bpmPerMet(60, 5, 70)).toBe(15);
  expect(bpmPerMet(150, 1, 70)).toBe(15);
});

it('limita a FC máxima prevista às estimativas pela idade, com o pico observado como piso', () => {
  expect(maxBounds(40, null)).toEqual({ low: 170, high: 190 });
  expect(maxBounds(60, null)).toEqual({ low: 150, high: 176 });
  expect(maxBounds(40, 178)).toEqual({ low: 178, high: 190 });
  expect(maxBounds(40, 195)).toEqual({ low: 195, high: 195 });
  const peak = (top: number) => ({ ...session(null, null), log: [{ ...emptyLog(), top }] });
  expect(observedPeak([peak(150), peak(171), session(null, null)])).toBe(171);
  expect(observedPeak([session(null, null)])).toBeNull();
});

it('o piso da FC máxima soma 5 bpm ao pico de sessão levada até o fim sem redução', () => {
  expect([ageMax(40), ageMax(50)]).toEqual([180, 172]);
  // Com plano, o pico fica no bloco de esforço (a etapa 1); no treino livre, no registro único.
  const peak = (top: number, seconds: number, extra: Partial<Workout> = {}): Workout => {
    const w = session(null, null);
    const log = extra.plan ? [emptyLog(), { ...emptyLog(), top }] : [{ ...emptyLog(), top }];
    return { ...w, totals: { ...w.totals, movingMs: seconds * 1000 }, log, ...extra };
  };
  const change = (decision: string) => [{ second: 600, stage: 1, decision, bpm: 176 }];
  // Treino livre conta como levado até o fim com 20 min; guiado, com 90% dos 45 min do plano.
  expect(maxFloor([peak(176, 1200)])).toBe(181);
  expect(maxFloor([peak(176, 1199)])).toBe(176);
  expect(maxFloor([peak(176, 2430, { plan })])).toBe(181);
  expect(maxFloor([peak(176, 2429, { plan })])).toBe(176);
  // Quem precisou aliviar a carga pode ter chegado perto do máximo: o pico vale sem folga.
  expect(maxFloor([peak(176, 2700, { plan, changes: change('reduzir velocidade') })])).toBe(176);
  expect(maxFloor([peak(176, 2700, { plan, changes: change('aumentar velocidade') })])).toBe(181);
  // Só conta a redução feita com o BPM 5 ou mais acima do teto: o alívio pequeno é rotina de quem treina junto dele.
  const eased = (over: number) => {
    const w = peak(176, 2700, { plan });
    const bpm = dailyTarget(plan, w.profile, w.hr).high + over;
    return { ...w, changes: [{ second: 600, stage: 1, decision: 'reduzir inclinação', bpm }] };
  };
  expect([1, 4, 5, 12].map((over) => forcedReductions(eased(over)))).toEqual([0, 0, 1, 1]);
  expect(maxFloor([eased(4)])).toBe(181);
  expect(maxFloor([eased(5)])).toBe(176);
  // Vale o maior piso entre todas as sessões.
  expect(maxFloor([peak(180, 600), peak(170, 1800)])).toBe(180);
  expect(maxFloor([peak(178, 600), peak(176, 1800)])).toBe(181);
  expect(maxFloor([session(null, null)])).toBeNull();
});

it('um pico seguido de outro bloco concluído, ou de 4 min no mesmo bloco sem alívio, sobe o piso mesmo com redução forçada', () => {
  // O VO₂máx de 22/11: 41 anos, faixa de 161 a 170. A trava cortou o 3º tiro com 178 (redução forçada).
  const age41 = { ...profile, age: 41 };
  const vo2 = sessionPlan(week[2].session!, 6.6, 1);
  const stage = (top: number, topAtSeconds: number, seconds: number) => ({
    ...emptyLog(),
    ms: seconds * 1000,
    top,
    topAtMs: topAtSeconds * 1000,
  });
  const shots = (fourth: number): Workout => {
    const log = vo2.stages.map(() => emptyLog());
    log[5] = stage(179, 235, 240);
    log[7] = stage(176, 230, fourth);
    return {
      ...newWorkout(age41, 'ble', vo2),
      totals: { ...newWorkout(age41, 'ble', vo2).totals, movingMs: 2700000 },
      log,
      changes: [{ second: 1940, stage: 5, decision: 'reduzir velocidade', bpm: 178, by: 'trava' }],
    };
  };
  expect(forcedReductions(shots(240))).toBe(1);
  // Chegou a 179 e ainda fez o 4º tiro inteiro: não estava no máximo, piso de 184.
  expect(maxFloor([shots(240)])).toBe(184);
  // Com 90% do 4º tiro feito ainda vale; com menos, o 179 é só o maior pico.
  expect(maxFloor([shots(216)])).toBe(184);
  expect(maxFloor([shots(215)])).toBe(179);
  // Um bloco contínuo: pico de 150 aos 10 min e mais 25 min no bloco, com uma redução forçada no meio.
  const base = sessionPlan(week[1].session!, 5, 1);
  const { high } = dailyTarget(base, profile);
  const steady = (reliefAfter: number): Workout => {
    const log = [emptyLog(), stage(150, 600, 2100), emptyLog()];
    const second = 300 + 600 + reliefAfter;
    return {
      ...newWorkout(profile, 'ble', base),
      log,
      changes: [{ second, stage: 1, decision: 'reduzir inclinação', bpm: high + 6, from: [5, 1], to: [5, 0.5], by: 'trava' }],
    };
  };
  // Sem alívio no minuto seguinte ao pico, os 25 min depois dele bastam: piso de 155.
  expect(maxFloor([steady(90)])).toBe(155);
  // Com o alívio 30 s depois do pico e nenhum bloco depois, o pico vale sem folga.
  expect(maxFloor([steady(30)])).toBe(150);
  // O tempo fora da lona não conta como seguir: com 22 dos 25 min depois do pico ao lado dela, não sobe.
  const aside = steady(90);
  expect(maxFloor([{ ...aside, log: [emptyLog(), { ...aside.log![1], offBeltMs: 1_320_000 }, emptyLog()] }])).toBe(150);
  // Nem um tiro seguinte feito fora da lona conta como concluído.
  const offShot = shots(240);
  offShot.log![7] = { ...offShot.log![7], offBeltMs: 60_000 };
  expect(maxFloor([offShot])).toBe(179);
  // Num registro mais antigo, sem o horário do pico, os 4 min no mesmo bloco não têm como ser medidos.
  const old = steady(90);
  expect(maxFloor([{ ...old, log: [emptyLog(), { ...old.log![1], topAtMs: undefined }, emptyLog()] }])).toBe(150);
  // Mas outro bloco concluído depois do pico basta a ordem das etapas: o 22/11 sem horário também dá 184.
  const undated = shots(240);
  undated.log = undated.log!.map((l) => ({ ...l, topAtMs: undefined }));
  expect(maxFloor([undated])).toBe(184);
  // O pico de uma recuperação nunca leva folga, mesmo com tiros concluídos depois dele.
  const recovering = shots(240);
  recovering.log![5] = { ...recovering.log![5], top: 170 };
  recovering.log![6] = { ...emptyLog(), ms: 180000, top: 182, topAtMs: 5000 };
  expect(maxFloor([recovering])).toBe(182);
  // Nem numa sessão levada até o fim sem redução forçada: o pico do aquecimento vale sem folga.
  const warm = { ...shots(240), changes: [] };
  warm.log![0] = { ...emptyLog(), ms: 600000, top: 183, topAtMs: 590000 };
  expect(maxFloor([warm])).toBe(184);
  warm.log![5] = { ...warm.log![5], top: 170 };
  warm.log![7] = { ...warm.log![7], top: 170 };
  expect(maxFloor([warm])).toBe(183);
  // A folga não passa da maior estimativa pela idade + 10 (189 aos 41 anos); o pico observado, sim.
  const capped = shots(240);
  capped.log![5] = { ...capped.log![5], top: 186 };
  expect(maxFloor([capped])).toBe(189);
  capped.log![5] = { ...capped.log![5], top: 192 };
  expect(maxFloor([capped])).toBe(192);
  // Até 10 bpm além desse limite (199 aos 41 anos) o pico vale; acima disso é artefato e fica de fora,
  // senão viraria piso da FC máxima para sempre.
  capped.log![5] = { ...capped.log![5], top: 199 };
  expect(maxFloor([capped])).toBe(199);
  // Com o 205 de fora, sobra o 176 do 4º tiro, sem tiro depois dele: sem folga.
  capped.log![5] = { ...capped.log![5], top: 205 };
  expect(maxFloor([capped])).toBe(176);
  expect(maxFloor([{ ...capped, log: [emptyLog(), { ...emptyLog(), top: 205 }] }])).toBeNull();
});

it('o alvo dos blocos de esforço é o alto da faixa; em recuperação, a faixa inteira', () => {
  expect(aimBand({ low: 116, high: 134 }, 'Base aeróbica')).toEqual({ bpm: 134, low: 131, high: 134 });
  expect(aimBand({ low: 162, high: 171 }, 'VO₂máx')).toEqual({ bpm: 171, low: 168, high: 171 });
  expect(aimBand({ low: 90, high: 108 }, 'Recuperação')).toEqual({ bpm: 96, low: 90, high: 108 });
});

it('estima as kcal pela carga de cada segundo e pelo peso do perfil', () => {
  const moving = (kmh: number, incline: number, seconds: number, weightKg = 78) => {
    let w = newWorkout({ ...profile, weightKg }, 'ble', null);
    let previous: TreadmillSample | null = null;
    for (let t = 0; t <= seconds; t++) {
      const sample: TreadmillSample = {
        at: t * 1000,
        speedKmh: kmh,
        inclinationPercent: incline,
        heartRateBpm: null,
        energyKcal: null,
        distanceM: null,
      };
      w = { ...w, totals: accumulate(w.totals, sample, previous) };
      previous = sample;
    }
    return w;
  };
  // 5,2 km/h a 2% custa 4,368 METs: 45 min × 4,368 × 0,0175 kcal por kg × 78 kg.
  const walk = moving(5.2, 2, 2700);
  expect(walk.totals.metMs).toBeCloseTo(4.368 * 2700000, -4);
  expect(energyKcal(walk)).toBe(268);
  // O gasto acompanha o peso; a frequência cardíaca não entra na conta.
  expect(energyKcal(moving(5.2, 2, 2700, 100))).toBe(344);
  // Correndo vale a equação de corrida: 10 km/h a 1% são 10,95 METs.
  expect(energyKcal(moving(10, 1, 600, 80))).toBe(153);
  expect(energyKcal(newWorkout(profile, 'ble', null))).toBeNull();
  // Entre 5,2 e 6 km/h o custo vai da equação de caminhada à de corrida sem salto.
  expect([5.2, 5.4, 5.6, 5.8, 6].map((kmh) => Math.round(energyCost(kmh, 0) * 100) / 100)).toEqual([
    3.48, 4.29, 5.1, 5.9, 6.71,
  ]);
  // Até 5,2 km/h vale a equação de caminhada pura.
  expect(energyCost(5.2, 2)).toBe(metabolicCost(5.2, 2));
  // 5,6 km/h a 2% já está no trecho interpolado: 5,798 METs, 356 kcal em 45 min.
  expect(energyCost(5.6, 2)).toBeCloseTo(5.798, 3);
  expect(energyKcal(moving(5.6, 2, 2700))).toBe(356);
  // O custo que o plano compara continua sendo o da caminhada.
  expect(mets(5.9, 0)).toBe(3.8);
  // Registro antigo, sem a soma segundo a segundo: a conta sai da carga média de cada etapa.
  const stage = (kmh: number, incline: number, seconds: number) => ({
    ...emptyLog(),
    ms: seconds * 1000,
    distanceM: (kmh * seconds) / 3.6,
    inclineMs: incline * seconds * 1000,
    inclineDurationMs: seconds * 1000,
  });
  const old: Workout = {
    ...walk,
    totals: { ...walk.totals, metMs: undefined },
    log: [stage(4, 0, 300), stage(5.2, 2, 2100), stage(4, 0, 300)],
  };
  // 10 min a 2,9 METs e 35 min a 4,368 METs.
  expect(energyKcal(old)).toBe(248);
  // Sem etapas, vale a média da sessão inteira.
  expect(energyKcal({ ...old, log: undefined })).toBe(268);
});
