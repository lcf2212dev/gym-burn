import type { TreadmillSample } from '@/treadmill/types';
import { livePulse, pulseFeatures, pulseWindow } from '../adaptive';
import {
  accumulate,
  currentCue,
  levels,
  logStage,
  makePlan,
  median,
  newWorkout,
  type Change,
  type MinuteBeats,
  type MinuteLoad,
  type Plan,
  type Profile,
  type Stage,
  type StageLog,
  type Workout,
} from '../model';
import { dailyTarget } from '../physiology';
import {
  assessBounds,
  assessPrompt,
  historyItem,
  parseAssess,
  parsePlan,
  parseReview,
  planProcedure,
  planPrompt,
  plateaus,
  PROMPT_VERSION,
  reviewDecisions,
  reviewPrompt,
  summarize,
  type ReviewDecision,
} from '../prompts';
import { sessionPlan, sessions, zones, type Session } from '../week';

// 40 anos: FC máxima estimada de 180. Base aeróbica de 117 a 135 BPM, VO₂máx de 162 a 171.
const profile: Profile = { age: 40, weightKg: 78, heightCm: 175 };
const DAY = 86400000;
const NOW = 1_800_000_000_000;
const base = sessions.base;
const vo2 = sessions.vo2Long;

// Passa um plano inteiro pelas mesmas funções que a sessão usa, um segundo por amostra.
function simulate(
  plan: Plan | null,
  bpmAt: (stage: Stage | null, index: number, into: number) => number | null,
  seconds: number,
  started = NOW,
): Workout {
  let w = newWorkout(profile, 'ble', plan, { rest: null, max: 180, maxSource: 'idade' });
  const zone = dailyTarget(plan, profile, w.hr);
  const log: StageLog[] = [];
  let previous: TreadmillSample | null = null;
  for (let t = 0; t <= seconds; t++) {
    const elapsed = Math.floor(w.totals.movingMs / 1000);
    const cue = plan && currentCue(plan, elapsed);
    if (plan && !cue) break;
    const sample: TreadmillSample = {
      at: t * 1000,
      speedAt: t * 1000,
      inclineAt: t * 1000,
      speedKmh: cue ? cue.stage.speed : 5,
      inclinationPercent: cue ? cue.stage.incline : 1,
      heartRateBpm: bpmAt(cue?.stage ?? null, cue?.index ?? 0, cue?.into ?? elapsed),
      energyKcal: null,
      distanceM: null,
    };
    w = { ...w, totals: accumulate(w.totals, sample, previous) };
    const index = cue?.index ?? 0;
    log[index] = logStage(log[index], sample, previous, zone, cue?.into ?? elapsed);
    previous = sample;
  }
  return { ...w, started, log, ended: started + w.totals.movingMs, reason: 'Duração concluída' };
}

// 32 min de base aeróbica: aquecimento de 300 s, dois blocos de esforço de 540 s,
// cada um com 120 s de recuperação, e volta à calma de 300 s.
const planAt = (pace: number, grade: number): Plan => ({
  ...makePlan('Base aeróbica', { warmup: 5, reps: 2, work: 9, recovery: 2, cooldown: 5 }, pace, grade),
  objective: 'Base aeróbica',
  zone: zones['Base aeróbica'],
});
const plan = planAt(5.2, 3);
// A pessoa segura o sensor nos últimos 30 s de cada bloco de esforço e por volta de 1 min de recuperação.
const grip = (work: number, recovery: number) => (stage: Stage | null, _: number, into: number) =>
  !stage
    ? work
    : !stage.measure
      ? into >= stage.seconds - 30
        ? work
        : null
      : stage.name === 'Recuperação' && into >= 50 && into <= 70
        ? recovery
        : null;
const done = (daysAgo: number, work = 126, recovery = 110, at = plan) =>
  simulate(at, grip(work, recovery), 2000, NOW - daysAgo * DAY);

it('resume a sessão por tipo de bloco, com custo da carga, fim de bloco, recuperação e posição na faixa', () => {
  const s = summarize(done(0));
  expect(s).toMatchObject({
    goal: 'Base aeróbica',
    objective: 'Base aeróbica',
    completionPercent: 100,
    zone: { low: 117, high: 135 },
    recoveryDrops: [16, 16],
    reductions: 0,
    validatedPeakBpm: 126,
    bpmSource: 'sensor de mão',
  });
  expect(s.work).toMatchObject({
    kmh: 5.2,
    inclinePercent: 3,
    mets: 4.8,
    targetKmh: 5.2,
    targetInclinePercent: 3,
    bpmEnd: 126,
  });
  expect(s.easy).toMatchObject({ kmh: 4, inclinePercent: 0 });
  // A faixa é a dos blocos de esforço: as leituras da recuperação, abaixo dela, não entram.
  expect(s.zoneSharePercent).toEqual({ below: 0, inside: 100, above: 0 });
  expect(summarize(done(0, 140)).zoneSharePercent).toEqual({ below: 0, inside: 0, above: 100 });
  expect(historyItem(done(3), NOW)).toMatchObject({
    daysAgo: 3,
    goal: 'Base aeróbica',
    work: { kmh: 5.2, inclinePercent: 3, mets: 4.8, targetKmh: 5.2, targetInclinePercent: 3, bpmEnd: 126 },
    zone: { low: 117, high: 135 },
    position: 'na faixa',
    recoveryDrops: [16, 16],
  });
});

it('trata registro antigo sem dados por etapa como aproximado e treino livre como um bloco só', () => {
  const old = { ...done(5), log: undefined, changes: undefined, hr: undefined, restBpm: undefined };
  expect(historyItem(old, NOW)).toMatchObject({
    approximate: true,
    work: {
      bpmEnd: old.totals.bpmCount ? Math.round(old.totals.bpmSum / old.totals.bpmCount) : null,
      targetKmh: null,
    },
  });
  const free = summarize(simulate(null, () => 108, 600));
  expect(free).toMatchObject({ goal: 'Livre', completionPercent: null, easy: null });
  expect(free.work).toMatchObject({ kmh: 5, mets: 3.8, bpmEnd: 108, targetKmh: null });
});

const data = (session: Session, history: Workout[]) =>
  planPrompt({ profile, session, history, now: NOW }).user;

it('o plano recebe a sessão do dia, a faixa, as sessões válidas e a escada de cargas', () => {
  const fragment = simulate(null, () => 100, 40, NOW - DAY);
  const { system, user } = planPrompt({ profile, session: base, history: [fragment, done(2), done(4)], now: NOW });
  expect(user.recent.map((r) => r.daysAgo)).toEqual([2, 4]);
  expect(user.session).toEqual({
    goal: 'Base aeróbica',
    structure: 'Contínuo: 5 min aquecendo, 35 min na faixa, 5 min desaquecendo',
    minutes: 45,
    zone: { objective: 'Base aeróbica', low: 117, high: 135 },
    // O alvo é o teto da faixa, e de 3 bpm abaixo dele até ele a carga já acertou.
    aim: { bpm: 135, low: 132, high: 135 },
  });
  expect(data(vo2, []).session).toMatchObject({
    structure: '10 min aquecendo, 4 × 4 min com 3 min leves, 7 min desaquecendo',
    zone: { objective: 'VO₂máx', low: 162, high: 171 },
    aim: { bpm: 171, low: 168, high: 171 },
  });
  // Em recuperação a faixa é um teto: a conta busca o terço de baixo, e a faixa inteira serve.
  expect(data(sessions.recovery, []).session).toMatchObject({
    zone: { objective: 'Recuperação', low: 90, high: 108 },
    aim: { bpm: 96, low: 90, high: 108 },
  });
  expect(user.hr).toEqual({ restBpm: null, restSource: null, maxBpm: 180, maxSource: 'idade' });
  expect(user.loads[0]).toEqual({ pace: 3, grade: 0, mets: 2.4 });
  // A escada não tem carga entre o teto da caminhada e o começo da corrida, e o prompt diz isso.
  expect(user.loads.filter((r) => r.pace > 5.2 && r.pace < 6)).toEqual([]);
  expect(system).toContain('A pessoa caminha até 5,2 km/h e só corre a partir de 6 km/h');
  expect(system).toContain('Nenhuma linha fica acima de 5,2 e abaixo de 6 km/h, e as de corrida têm rampa de 1%.');
  // Correndo, a rampa não passa de 2%: a escada só tem corrida a 1%, e o prompt diz o limite.
  expect(user.loads.filter((r) => r.pace >= 6).every((r) => r.grade === 1)).toBe(true);
  expect(system).toContain('Correndo, a rampa não passa de 2%.');
  expect(system).toContain(
    'work.targetKmh é de até 5,2 (caminhada, com qualquer rampa), ou quando work.targetKmh é de 6 em diante e work.targetInclinePercent é de até 2 (corrida)',
  );
  expect(system).toContain(
    'Com work.targetKmh acima de 5,2 e abaixo de 6, ou de 6 em diante com work.targetInclinePercent acima de 2, a carga da referência não pode ser repetida',
  );
  // O prompt já não fala em leitura só de 3 em 3 minutos: com a cinta ela é contínua.
  expect(system).toContain('o tempo todo com a cinta no peito');
  expect(PROMPT_VERSION).toBe('10');
  // Vão até 6 sessões válidas, e não mais 5.
  const seven = [1, 2, 3, 4, 5, 6, 7].map((days) => done(days));
  expect(data(base, seven).recent.map((r) => r.daysAgo)).toEqual([1, 2, 3, 4, 5, 6]);
  // Do perfil só vai a idade.
  expect(user.profile).toEqual({ age: 40 });
  expect(JSON.stringify(user)).not.toMatch(/weightKg|heightCm|activity/);
  expect(system).toContain('json');
});

it('a conta do plano repete a carga que ficou junto do teto da faixa e recalcula pela reta de FC por MET', () => {
  // Sem nenhuma sessão: 1 + (135 − 70) ÷ 15 = 5,3 METs, e 5,2 km/h a 4% custa 5,3.
  expect(planProcedure(data(base, []))).toEqual({ pace: 5.2, grade: 4, repeat: false });
  // Mesma sessão com 133 BPM, a 2 do teto de 135: repete os alvos em que ela terminou.
  expect(planProcedure(data(base, [done(2, 133)]))).toEqual({ pace: 5.2, grade: 3, repeat: true });
  // 126 BPM está na faixa, mas 9 abaixo do teto: a 15 bpm por MET, o alvo sobe de 4,8 para 5,4 METs.
  expect(planProcedure(data(base, [done(2)]))).toEqual({ pace: 5.2, grade: 4, repeat: false });
  // 106 BPM a 4,8 METs, sem repouso: 15 bpm por MET, alvo de 6,7 METs.
  expect(planProcedure(data(base, [done(2, 106, 95)]))).toEqual({ pace: 5.2, grade: 7, repeat: false });
  // Com repouso de 70 a reta é da própria pessoa: 9,5 bpm por MET, alvo de 7,9 METs. A rampa a
  // 5,2 km/h para em 6,8 METs e não há carga até a corrida: a escolha é correr a 6,5 km/h.
  const rested = (restBpm: number) => [{ ...done(2, 106, 95), restBpm }];
  expect(planProcedure(data(base, rested(85)))).toEqual({ pace: 6.5, grade: 1, repeat: false });
  // Uma reta fora de 8 a 25 bpm por MET é leitura ruim: vale 15.
  expect(planProcedure(data(base, rested(115)))).toMatchObject({ pace: 5.2, grade: 7 });
  // Acima da faixa (151 BPM): alvo de 3,7 METs, e a carga recua para 5,2 km/h a 0,5%.
  expect(planProcedure(data(base, [done(2, 151, 130)]))).toMatchObject({ pace: 5.2, grade: 0.5 });
  // Primeiro VO₂máx, com pontos de 4,8 METs (126) e 3,1 METs (100): 15 bpm por MET, alvo de 7,7 METs.
  const two = [done(1), done(2, 100, 92, planAt(4.5, 0))];
  expect(planProcedure(data(vo2, two))).toEqual({ pace: 6.5, grade: 1, repeat: false });
  // Registro antigo só conta quando não há outro.
  const old = { ...done(1, 150, 130), log: undefined, changes: undefined, hr: undefined };
  expect(planProcedure(data(base, [old, done(2, 133)]))).toEqual({ pace: 5.2, grade: 3, repeat: true });
  // Em recuperação a faixa inteira serve: 100 BPM, dentro de 90–108, repete a carga.
  const easy = done(2, 100, 92, { ...planAt(4.5, 0), goal: 'Recuperação ativa', objective: 'Recuperação', zone: zones['Recuperação'] });
  expect(planProcedure(data(sessions.recovery, [easy]))).toEqual({ pace: 4.5, grade: 0, repeat: true });
});

it('uma referência que terminou entre 5,2 e 6 km/h não é repetida: a carga sai da reta', () => {
  // Sessão antiga a 5,6 km/h e 2% (4,6 METs) com 133 BPM, dentro do alvo de 132 a 135.
  // Repetir pediria 5,6 km/h, que a escada já não tem: 4,6 + 2 ÷ 15 = 4,7 METs, 5,2 km/h a 2,5%.
  const old = done(2, 133, 110, planAt(5.6, 2));
  expect(historyItem(old, NOW).work).toMatchObject({ targetKmh: 5.6, targetInclinePercent: 2, mets: 4.6, bpmEnd: 133 });
  expect(planProcedure(data(base, [old]))).toEqual({ pace: 5.2, grade: 2.5, repeat: false });
  // A 5,6 km/h e 2,5% (4,9 METs) com 134 BPM: alvo de 5,0 METs, 5,2 km/h a 3%.
  expect(planProcedure(data(base, [done(2, 134, 110, planAt(5.6, 2.5))]))).toEqual({
    pace: 5.2,
    grade: 3,
    repeat: false,
  });
  // Nas duas pontas do vão a repetição continua: 5,2 km/h e 6 km/h.
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.2, 3))]))).toEqual({
    pace: 5.2,
    grade: 3,
    repeat: true,
  });
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(6, 1))]))).toEqual({ pace: 6, grade: 1, repeat: true });
  // Correndo, a rampa não passa de 2%: uma corrida a 2% se repete, e uma a 2,5% é recalculada
  // (7,4 METs + 2 ÷ 15 = 7,5 METs: corrida a 6,5 km/h e 1%).
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(6, 2))]))).toEqual({ pace: 6, grade: 2, repeat: true });
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(6, 2.5))]))).toEqual({ pace: 6.5, grade: 1, repeat: false });
  expect(() => parsePlan(data(base, [done(2, 133, 110, planAt(6, 2.5))]))({ pace: 6, grade: 2.5 })).toThrow();
  // Caminhando, a rampa continua livre.
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.2, 9))]))).toEqual({ pace: 5.2, grade: 9, repeat: true });
  // Logo acima de 5,2 e logo abaixo de 6 também recalculam.
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.3, 2))]))).toMatchObject({ repeat: false });
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.9, 1))]))).toMatchObject({ repeat: false });
  // Uma caminhada antiga com alvo de 5,7 km/h e a lona a 6 continua contando como caminhada
  // (4,4 METs), e não como corrida a 6 km/h (7,0 METs): o custo errado entortaria a reta.
  const brisk = simulate(planAt(5.7, 1), grip(139, 110), 2000, NOW - 2 * DAY);
  const fast = {
    ...brisk,
    log: brisk.log!.map((l, i) => (planAt(5.7, 1).stages[i].measure ? l : { ...l, distanceM: (6 * l.ms) / 3600 })),
  };
  expect(historyItem(fast, NOW).work).toMatchObject({ kmh: 6, targetKmh: 5.7, mets: 4.4 });
  // Planejada e feita a 6 km/h, é corrida.
  expect(historyItem(done(2, 150, 120, planAt(6, 1)), NOW).work).toMatchObject({ kmh: 6, mets: 7 });
  // Sem repetição exata, a resposta da IA pode cair na linha vizinha; a carga antiga é recusada.
  const parse = parsePlan(data(base, [old]));
  expect(parse({ pace: 5.2, grade: 2.5 })).toMatchObject({ pace: 5.2, grade: 2.5 });
  expect(parse({ pace: 5.2, grade: 3 })).toMatchObject({ grade: 3 });
  expect(() => parse({ pace: 5.6, grade: 2 })).toThrow();
});

it('confere a resposta do plano com a conta do app, aceitando número em texto', () => {
  // A conta dá 5,2 km/h a 7%.
  const parse = parsePlan(data(base, [done(2, 106, 95)]));
  expect(parse({ why: ' 106 BPM a 4,8 METs. ', pace: '5,2', grade: '7' })).toEqual({
    why: '106 BPM a 4,8 METs.',
    pace: 5.2,
    grade: 7,
  });
  // A linha vizinha da escada passa: é um arredondamento no meio da conta.
  expect(parse({ pace: 5.2, grade: 6.5 }).grade).toBe(6.5);
  expect(parse({ pace: 5.2, grade: 7.5 }).grade).toBe(7.5);
  // Mais longe que isso é erro de conta: a chamada é repetida.
  expect(() => parse({ pace: 5.2, grade: 6 })).toThrow();
  // Uma carga entre o teto da caminhada e a corrida não está na escada.
  expect(() => parse({ pace: 5.6, grade: 7 })).toThrow();
  expect(() => parse({ pace: 9, grade: 1 })).toThrow();
  expect(() => parse({ pace: 40, grade: 1 })).toThrow();
  expect(() => parse({ pace: 5.2 })).toThrow();
  expect(() => parse(null)).toThrow();
  // A repetição da sessão anterior tem de ser exata.
  const repeat = parsePlan(data(base, [done(2, 133)]));
  expect(repeat({ pace: 5.2, grade: 3 })).toMatchObject({ pace: 5.2, grade: 3 });
  expect(() => repeat({ pace: 5.2, grade: 3.5 })).toThrow();
});

// Uma sessão contínua de 45 min (5 de aquecimento, 35 de esforço, 5 de volta à calma) gravada
// minuto a minuto. `ramp` diz como a carga andou no bloco: [minutos, rampa, BPM] de cada trecho.
function recorded(ramp: [number, number, number][], daysAgo = 2, endBpm = 131): Workout {
  const continuous: Plan = sessionPlan(base, 5.2, ramp[ramp.length - 1][1]);
  const w = simulate(continuous, grip(endBpm, 110), 2800, NOW - daysAgo * DAY);
  const loads: MinuteLoad[] = [];
  const beats: MinuteBeats[] = [];
  const minute = (kmh: number, grade: number, bpm: number) => {
    loads.push([kmh * 60000, grade * 60000, 60000]);
    beats.push([bpm * 60, 60]);
  };
  for (let m = 0; m < 5; m++) minute(4, 0, 95);
  for (const [minutes, grade, bpm] of ramp) for (let m = 0; m < minutes; m++) minute(5.2, grade, bpm);
  for (let m = 0; m < 5; m++) minute(4, 0, 110);
  return { ...w, loads, beats };
}

it('os patamares saem da carga e dos batimentos minuto a minuto', () => {
  const w = recorded([[4, 2, 126], [8, 3, 133], [10, 2.5, 134], [13, 2, 133]]);
  expect(plateaus(w)).toEqual([
    { fromMinute: 0, minutes: 4, kmh: 5.2, inclinePercent: 2, mets: 4.4, bpm: 126 },
    { fromMinute: 4, minutes: 8, kmh: 5.2, inclinePercent: 3, mets: 4.8, bpm: 133 },
    { fromMinute: 12, minutes: 10, kmh: 5.2, inclinePercent: 2.5, mets: 4.6, bpm: 134 },
    { fromMinute: 22, minutes: 13, kmh: 5.2, inclinePercent: 2, mets: 4.4, bpm: 133 },
  ]);
  // O BPM do patamar é a mediana dos minutos depois do primeiro, em que a FC ainda se ajusta.
  const settling = { ...w, beats: w.beats!.map((b, m): MinuteBeats => (m === 9 ? [120 * 60, 60] : b)) };
  expect(plateaus(settling)[1]).toMatchObject({ fromMinute: 4, bpm: 133 });
  // Um trecho de 1 minuto é passagem, e um minuto com a lona quase toda parada corta o patamar.
  const passing = recorded([[4, 2, 126], [1, 2.5, 129], [30, 3, 133]]);
  expect(plateaus(passing).map((p) => [p.fromMinute, p.minutes, p.inclinePercent])).toEqual([
    [0, 4, 2],
    [5, 30, 3],
  ]);
  const paused = { ...w, loads: w.loads!.map((l, m): MinuteLoad => (m === 20 ? [5.2 * 20000, 2.5 * 20000, 20000] : l)) };
  expect(plateaus(paused).map((p) => [p.fromMinute, p.minutes, p.inclinePercent])).toEqual([
    [0, 4, 2],
    [4, 8, 3],
    [12, 3, 2.5],
    [16, 6, 2.5],
    [22, 13, 2],
  ]);
  // Sem leitura de BPM depois do primeiro minuto o trecho não vira patamar.
  const blind = { ...w, beats: w.beats!.map((b, m): MinuteBeats => (m >= 9 && m < 17 ? [0, 0] : b)) };
  expect(plateaus(blind).map((p) => p.fromMinute)).toEqual([0, 12, 22]);
  // Os registros mais antigos não têm a carga por minuto.
  expect(plateaus(done(2))).toEqual([]);
  expect(summarize(done(2)).plateaus).toBeUndefined();
  expect(historyItem(done(2), NOW).work).not.toHaveProperty('reference');
});

it('numa sessão contínua a carga de referência é o primeiro patamar no alvo, não a carga do fim', () => {
  // A carga subiu de 2% para 3%, onde o BPM chegou ao alvo (132 a 135), e desceu de volta a 2%
  // com a FC subindo aos poucos. A sessão terminou a 2% com 131 BPM.
  const w = recorded([[4, 2, 126], [8, 3, 133], [10, 2.5, 134], [13, 2, 133]]);
  const reference = {
    kmh: 5.2,
    inclinePercent: 3,
    mets: 4.8,
    targetKmh: 5.2,
    targetInclinePercent: 3,
    bpmEnd: 133,
    reference: { fromMinute: 4, minutes: 8 },
  };
  expect(summarize(w).work).toMatchObject(reference);
  expect(historyItem(w, NOW)).toMatchObject({ work: reference, position: 'na faixa' });
  expect(historyItem(w, NOW).plateaus).toHaveLength(4);
  // A partida de hoje repete os 3% do patamar, e não os 2% em que a sessão acabou.
  expect(planProcedure(data(base, [w]))).toEqual({ pace: 5.2, grade: 3, repeat: true });
  // Sem nenhum patamar no alvo vale o que chegou mais perto: 128 BPM a 2,5% (4,6 METs).
  // 4,6 + 7 ÷ 15 = 5,07 METs: 5,2 km/h a 3,5%.
  const short = recorded([[10, 2, 120], [25, 2.5, 128]], 2, 128);
  expect(historyItem(short, NOW).work).toMatchObject({ inclinePercent: 2.5, bpmEnd: 128, reference: { fromMinute: 10 } });
  expect(planProcedure(data(base, [short]))).toEqual({ pace: 5.2, grade: 3.5, repeat: false });
  // Um patamar curto no alvo não serve de referência: 4 minutos a 3,5% com 134 BPM é carga
  // alta demais, que logo passou do teto. Vale o primeiro de 5 minutos ou mais, a 3%.
  const brief = recorded([[4, 2.5, 124], [4, 3.5, 134], [27, 3, 133]], 2, 133);
  expect(historyItem(brief, NOW).work).toMatchObject({ inclinePercent: 3, bpmEnd: 133, reference: { fromMinute: 8 } });
  // Sem nenhum patamar de 5 minutos valem os de 3.
  const choppy = recorded([[4, 2.5, 124], [4, 3.5, 134], [4, 3, 133], [4, 3.5, 135], [4, 3, 133], [4, 2.5, 131], [4, 3, 133], [4, 2.5, 132], [3, 2, 130]]);
  expect(historyItem(choppy, NOW).work).toMatchObject({ inclinePercent: 3.5, bpmEnd: 134, reference: { fromMinute: 4, minutes: 4 } });
  // Com mais de um bloco de esforço a referência continua sendo o fim dos blocos.
  const blocks = { ...done(2, 133), loads: w.loads, beats: w.beats };
  expect(historyItem(blocks, NOW).work).not.toHaveProperty('reference');
  expect(historyItem(blocks, NOW).work).toMatchObject({ targetInclinePercent: 3, bpmEnd: 133 });
  // A avaliação recebe os patamares da sessão e de onde vieram os batimentos.
  const strapped = { ...w, totals: { ...w.totals, strapCount: w.totals.bpmCount } };
  const { system, user } = assessPrompt({ workout: strapped, history: [] });
  expect(user).toMatchObject({ session: { bpmSource: 'cinta', work: reference } });
  expect((user as { session: { plateaus: unknown[] } }).session.plateaus).toHaveLength(4);
  expect(system).toContain('plateaus');
  expect(system).not.toMatch(/leituras válidas do sensor de mão/);
});

it('a avaliação recebe só os dois números que decidem a FC máxima e prende a previsão aos limites', () => {
  const history = [done(2), { ...done(4), estimate: { level: 'Em adaptação', summary: '', maxBpm: 181 } }];
  const input = { workout: done(0), history };
  expect(assessBounds(input)).toEqual({ low: 170, high: 190 });
  const { system, user } = assessPrompt(input);
  expect(user).toMatchObject({
    profile: { age: 40 },
    session: { goal: 'Base aeróbica', work: { bpmEnd: 126, mets: 4.8 }, recoveryDrops: [16, 16] },
    recent: [{ daysAgo: 2 }, { daysAgo: 4, level: 'Em adaptação' }],
    // Pico de 126 em sessões concluídas sem redução: piso de 131, abaixo da estimativa pela idade.
    heart: { ageEstimateBpm: 180, floorBpm: 131 },
  });
  expect(Object.keys((user as { heart: object }).heart)).toEqual(['ageEstimateBpm', 'floorBpm']);
  // Previsões anteriores não vão: a FC máxima sai da idade e dos picos medidos, não do que já foi respondido.
  expect(JSON.stringify(user)).not.toMatch(/maxBpm/i);
  // Um pico sustentado acima da estimativa leva o piso, e os limites, para pico + 5.
  const hard = { workout: done(0, 178), history };
  expect(assessPrompt(hard).user).toMatchObject({ heart: { ageEstimateBpm: 180, floorBpm: 183 } });
  expect(assessBounds(hard)).toEqual({ low: 183, high: 190 });
  // Com uma redução forçada, o 178 do 1º bloco ainda leva a folga: depois dele a pessoa fez o 2º inteiro.
  const forced = [{ second: 900, stage: 1, decision: 'reduzir velocidade', bpm: 178 }];
  const reduced = { ...hard.workout, changes: forced };
  expect(assessBounds({ workout: reduced, history })).toEqual({ low: 183, high: 190 });
  // O 178 só no último bloco, sem outro depois dele: com a redução forçada, vale sem folga.
  const last = simulate(plan, (stage, index, into) => grip(index === 3 ? 178 : 126, 110)(stage, index, into), 2000);
  expect(assessBounds({ workout: { ...last, changes: forced }, history })).toEqual({ low: 178, high: 190 });
  expect(assessBounds({ workout: last, history })).toEqual({ low: 183, high: 190 });
  // Do perfil só vai a idade.
  expect(JSON.stringify(user)).not.toMatch(/weightKg|activity/);
  for (const level of levels.slice(1)) expect(system).toContain('"' + level + '"');
  const parse = parseAssess({ low: 170, high: 190 });
  expect(parse({ level: 'Base em formação', summary: ' ok ', maxBpm: '183' })).toEqual({
    level: 'Base em formação',
    summary: 'ok',
    maxBpm: 183,
  });
  expect(parse({ level: 'Base em formação', summary: 'ok', maxBpm: 230 }).maxBpm).toBe(190);
  expect(parse({ level: 'Base em formação', summary: 'ok', maxBpm: 120 }).maxBpm).toBe(170);
  expect(() => parse({ level: levels[0], summary: 'ok', maxBpm: 180 })).toThrow();
  expect(() => parse({ level: 'Base em formação', summary: '', maxBpm: 180 })).toThrow();
  expect(() => parse({ level: 'Base em formação', summary: 'ok' })).toThrow();
});

it('a revisão recebe o momento, a subida, a projeção até o fim da etapa, a série e os tiros já feitos', () => {
  // VO₂máx a 6,6 km/h e 1% (162 a 171 BPM com a máxima de 180): 600 s de aquecimento, tiros
  // de 240 s com 180 s leves. Aos 1120 s de treino a pessoa está a 100 s do 2º tiro.
  const plan = sessionPlan(vo2, 6.6, 1);
  const bpmAt = (stage: Stage | null, _: number, into: number) =>
    !stage || stage.measure ? 125 : Math.round(150 + into / 8);
  const done = simulate(plan, bpmAt, 1120);
  const w: Workout = {
    ...done,
    ended: null,
    restBpm: 98,
    changes: [{ second: 1000, stage: 2, decision: 'reduzir velocidade', bpm: 174, from: [4, 0], to: [3.5, 0], by: 'app' }],
  };
  const now = 1_120_000;
  const strap: TreadmillSample[] = Array.from({ length: 125 }, (_, k) => {
    const at = now - (124 - k) * 1000;
    const into = 100 - (124 - k);
    return {
      at,
      speedAt: at,
      inclineAt: at,
      speedKmh: into >= 0 ? 6.6 : 4,
      inclinationPercent: into >= 0 ? 1 : 0,
      heartRateBpm: into >= 0 ? Math.round(150 + into / 8) : 125,
      heartRateSource: 'strap',
      energyKcal: null,
      distanceM: null,
    };
  });
  const zone = { low: 162, high: 171 };
  const live = livePulse(strap, now)!;
  expect(live).toEqual({ bpm: 162, rise: 3 });
  const features = pulseFeatures(pulseWindow(strap, now - 100_000, now), zone)!;
  const load = { stage: plan.stages[3], easy: false, reached: true, secondsAtLoad: 100, closing: false, short: true };
  const { system, user } = reviewPrompt({
    workout: w,
    index: 3,
    left: 140,
    load,
    features,
    live,
    samples: strap,
    now,
    allowed: ['manter', 'reduzir'],
    maxRaiseBpm: 0,
    sinceRelief: 120,
  });
  expect(user).toMatchObject({
    zone: { objective: 'VO₂máx', low: 162, high: 171 },
    aim: { bpm: 171, low: 168, high: 171 },
    maxBpm: 180,
    stage: {
      name: 'VO₂máx 2/4',
      kind: 'principal',
      targetKmh: 6.6,
      targetInclinePercent: 1,
      secondsInStage: 100,
      secondsRemaining: 140,
      targetsReached: true,
      secondsAtLoad: 100,
      shortBlock: true,
      laterBlocks: 2,
    },
    // 162 agora, 3 acima de 30 s atrás: a reta chega a 162 + 3 × 140 ÷ 30 = 176, 5 acima do teto.
    // Para voltar ao meio do alvo (169,5) seriam 7 bpm a menos.
    bpm: {
      now: 162,
      risePer30s: 3,
      median: features.median,
      trend: 'subindo',
      position: 'na faixa',
      belowTopBpm: 9,
      projectedEndBpm: 176,
      projectedOverTopBpm: 5,
      endsAboveTop: true,
      endsBelowAim: false,
      reduceToAimBpm: 7,
    },
    allowed: ['manter', 'reduzir'],
    limits: { maxReduceBpm: 15, maxRaiseBpm: 0 },
    session: {
      goal: 'VO₂máx',
      elapsedSeconds: 1120,
      // Registro sem origem do repouso: é do primeiro minuto andando.
      restBpm: 98,
      restSource: 'andando',
      changes: [{ secondsAgo: 120, decision: 'reduzir velocidade', bpm: 174, from: [4, 0], to: [3.5, 0], by: 'app' }],
      // O alívio foi há 2 minutos: a FC ainda está respondendo a ele.
      secondsSinceRelief: 120,
      reliefSettling: true,
    },
  });
  const data = user as {
    series: { secondsAgo: number; bpm: number | null; kmh: number | null; inclinePercent: number | null }[];
    blocks: object[];
  };
  // Dois minutos em trechos de 10 s, do mais antigo ao mais novo, atravessando a troca de etapa.
  expect(data.series.map((r) => r.secondsAgo)).toEqual([110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]);
  expect(data.series[0]).toEqual({ secondsAgo: 110, bpm: 125, kmh: 4, inclinePercent: 0 });
  expect(data.series[11]).toEqual({ secondsAgo: 0, bpm: 162, kmh: 6.6, inclinePercent: 1 });
  // O 1º tiro, já feito: a carga em que terminou, o BPM do fim, o pico e as leituras acima do teto.
  const first = w.log![1];
  expect(data.blocks).toEqual([
    { name: 'VO₂máx 1/4', kmh: 6.6, inclinePercent: 1, endBpm: median(first.tail), peakBpm: first.top, aboveReadings: first.zone[2] },
  ]);
  expect(first.zone[2]).toBeGreaterThan(0);
  const at = (moment: typeof live | null, sinceRelief: number | null = null) =>
    reviewPrompt({ workout: w, index: 3, left: 140, load, features, live: moment, samples: strap, now, allowed: ['manter', 'reduzir'], maxRaiseBpm: 0, sinceRelief }).user;
  // A reta não passa da FC máxima e, com o BPM caindo, fica no momento.
  expect(at({ bpm: 175, rise: 10 })).toMatchObject({
    bpm: { projectedEndBpm: 180, projectedOverTopBpm: 9, position: 'acima', belowTopBpm: -4, endsAboveTop: true, reduceToAimBpm: 11 },
  });
  expect(at({ bpm: 165, rise: -4 })).toMatchObject({
    bpm: { risePer30s: -4, projectedEndBpm: 165, projectedOverTopBpm: -6, endsAboveTop: false, endsBelowAim: true, reduceToAimBpm: null },
  });
  // Sem a cinta não há leitura do momento: vale a mediana, e a subida e a projeção ficam em branco.
  expect(at(null)).toMatchObject({
    bpm: { now: features.median, risePer30s: null, projectedEndBpm: null, projectedOverTopBpm: null, endsAboveTop: null, endsBelowAim: true },
  });
  // Passados os 3 minutos, ou sem alívio nenhum, a FC já não responde a ele.
  expect(at(live, 180)).toMatchObject({ session: { secondsSinceRelief: 180, reliefSettling: false } });
  expect(at(live)).toMatchObject({ session: { secondsSinceRelief: null, reliefSettling: false } });
  // Do perfil nada vai além do que a conta precisa.
  expect(JSON.stringify(user)).not.toMatch(/weightKg|heightCm/);
  // O texto diz o papel da IA, que existe a trava, e define cada decisão e a saída por tipo.
  expect(system).toContain('Seu papel é antecipar');
  expect(system).toContain('O app tem uma trava própria');
  expect(system).toContain('folga negativa');
  for (const decision of reviewDecisions) expect(system).toContain('- "' + decision + '"');
  expect(system).toContain('{"reason": "<motivo>", "decision": "<decisão>", "bpm": <inteiro>}');
  expect(system).toContain('superestima');
  // O BPM do momento pode vir dos batimentos (RR): o texto diz como, e que vale o maior.
  expect(system).toContain('o maior entre ela e a mediana dos batimentos');
  expect(system).not.toContain('now: o BPM do momento: a mediana dos últimos 5 s da cinta.');
  // Logo depois de um alívio a IA só reduz com o corte anterior já no painel e a reta acima do teto.
  expect(system).toContain(
    'Se session.reliefSettling é true, o último alívio ainda está fazendo efeito: reduza só se stage.targetsReached é true (o corte anterior já está no painel) e endsAboveTop é true; senão, mantenha.',
  );
  expect(system).toContain('json');
});

it('a origem do repouso vai nos três prompts, para a IA não descontar duas vezes', () => {
  const still: Workout = { ...done(2), restBpm: 62, restSource: 'parado' };
  const walked: Workout = { ...done(4), restBpm: 86, restSource: 'andando' };
  // Registro sem origem: é do primeiro minuto andando.
  const legacy: Workout = { ...done(6), restBpm: 84 };
  // Plano: o repouso em uso já vem pronto (62 parado contra 71 e 69 andando) e diz de onde saiu.
  const plan = planPrompt({ profile, session: base, history: [still, walked, legacy], now: NOW });
  expect(plan.user.hr).toEqual({ restBpm: 62, restSource: 'parado', maxBpm: 180, maxSource: 'idade' });
  expect(plan.user.recent.map((r) => [r.restBpm, r.restSource])).toEqual([
    [62, 'parado'],
    [86, 'andando'],
    [84, 'andando'],
  ]);
  expect(planPrompt({ profile, session: base, history: [walked, legacy], now: NOW }).user.hr).toMatchObject({
    restBpm: 69,
    restSource: 'andando',
  });
  expect(plan.system).toContain('não desconte nada dela');
  expect(plan.system).toContain('"parado" = com a lona parada, perto do repouso real');
  expect(plan.system).not.toContain('menos 15 bpm porque a pessoa já está andando');

  // Avaliação: o repouso de hoje e o das sessões anteriores, cada um com a origem.
  const today: Workout = { ...done(0), restBpm: 60, restSource: 'parado' };
  const assessed = assessPrompt({ workout: today, history: [walked, legacy] });
  expect(assessed.user).toMatchObject({
    session: { restBpm: 60, restSource: 'parado' },
    recent: [
      { restBpm: 86, restSource: 'andando' },
      { restBpm: 84, restSource: 'andando' },
    ],
  });
  expect(assessPrompt({ workout: done(0), history: [] }).user).toMatchObject({
    session: { restBpm: null, restSource: null },
  });
  expect(assessed.system).toContain('Com restSource "parado" ela foi medida com a lona parada');
  expect(assessed.system).not.toContain('restBpm: FC lida no primeiro minuto de hoje. Fica de 10 a 20 bpm acima do repouso real.');

  // Revisão: o repouso de hoje, com a origem.
  const zone = dailyTarget(today.plan, profile, today.hr);
  const features = pulseFeatures([{ bpm: 126, at: 0, kmh: 5.2, incline: 3 }], zone)!;
  const load = { stage: today.plan!.stages[1], easy: false, reached: true, secondsAtLoad: 100, closing: false };
  const review = (w: Workout) =>
    reviewPrompt({ workout: w, index: 1, left: 200, load, features, live: null, samples: [], now: 0, allowed: ['manter'], maxRaiseBpm: 0, sinceRelief: null });
  expect(review(today).user).toMatchObject({ session: { restBpm: 60, restSource: 'parado' } });
  expect(review(legacy).user).toMatchObject({ session: { restBpm: 84, restSource: 'andando' } });
  expect(review(done(0)).user).toMatchObject({ session: { restBpm: null, restSource: null } });
  expect(review(today).system).toContain('com restSource "parado" foi medida com a lona parada, antes do treino');
  expect(review(today).system).not.toContain('restBpm (FC do primeiro minuto de hoje; null sem leitura)');
});

it('a carga do fim de um tiro passada ao seguinte ("manter carga") não conta como aumento nem como redução', () => {
  const w = done(0);
  const changes: Change[] = [
    { second: 600, stage: 3, decision: 'aumentar velocidade', bpm: 161, from: [6, 1], to: [6.4, 1], by: 'bloco' },
    { second: 1000, stage: 5, decision: 'manter carga', bpm: 167, from: [6, 1], to: [6.4, 1], by: 'bloco' },
    { second: 1400, stage: 7, decision: 'manter carga', bpm: 175, from: [6, 1], to: [6.4, 1], by: 'bloco' },
  ];
  expect(summarize({ ...w, changes })).toMatchObject({ increases: 1, reductions: 0 });
  expect(assessPrompt({ workout: { ...w, changes }, history: [] }).system).toContain('("manter carga") não conta');
  const zone = dailyTarget(w.plan, profile, w.hr);
  const features = pulseFeatures([{ bpm: 125, at: 0, kmh: 5.2, incline: 3 }], zone)!;
  const load = { stage: w.plan!.stages[1], easy: false, reached: true, secondsAtLoad: 100, closing: false, short: false };
  const { system } = reviewPrompt({ workout: { ...w, changes }, index: 1, left: 100, load, features, live: null, samples: [], now: 0, allowed: ['manter', 'reduzir'], maxRaiseBpm: 0, sinceRelief: null });
  expect(system).toContain('com decision "manter carga"');
});

it('com a cadência da cinta, a avaliação recebe a cadência média e a variação da passada, e a revisão dois números informativos', () => {
  const plan = sessionPlan(vo2, 6.6, 1);
  const w = simulate(plan, (stage) => (!stage || stage.measure ? 120 : 165), 2700);
  // Tiros a 6,6 km/h (110 m por minuto): 165 passos/min no 1º, 160 no 2º e no 3º e 150 no 4º. No 3º a
  // pessoa ficou 10 s fora da lona, com a cadência em zero.
  const steps: Record<number, number> = { 1: 165, 3: 160, 5: 160, 7: 150 };
  const log = w.log!.map((l, i) => {
    if (!steps[i]) return l;
    const off = i === 5 ? 10000 : 0;
    return { ...l, cadenceMs: steps[i] * (l.ms - off), cadenceDurationMs: l.ms, ...(off && { offBeltMs: off }) };
  });
  const s = summarize({ ...w, log });
  // A média não conta os segundos fora da lona; a passada do 4º tiro é 10% mais longa que a do 1º.
  expect(s.work).toMatchObject({ cadenceSpm: 159, strideChangePercent: 10 });
  expect(s.easy).toMatchObject({ cadenceSpm: null, strideChangePercent: null });
  // Sem a cadência (outra cinta, ou sem cinta), os dois ficam em branco, e a carga segue a mesma.
  expect(summarize(w).work).toMatchObject({ cadenceSpm: null, strideChangePercent: null, mets: s.work!.mets });
  const { system } = assessPrompt({ workout: { ...w, log }, history: [] });
  expect(system).toContain('strideChangePercent');
  expect(system).toContain('maior mediana de 10 leituras seguidas da cinta, ou de 3 do sensor de mão');
  expect(system).toContain('concluiu outro bloco de esforço ou seguiu 4 minutos ou mais no mesmo bloco');
  expect(system).toContain('quando o pico é de um bloco de esforço');
  expect(system).toContain('não passa da maior das duas fórmulas pela idade + 10');
  expect(system).toContain('nem a carga decidida numa recuperação para o bloco seguinte');
  // Na revisão: a cadência do momento e a variação em %, e o aviso de que o fim de uma recuperação pode mudar.
  const zone = dailyTarget(plan, profile, w.hr);
  const features = pulseFeatures([{ bpm: 165, at: 0, kmh: 6.6, incline: 1 }], zone)!;
  const load = { stage: plan.stages[3], easy: false, reached: true, secondsAtLoad: 100, closing: false, short: true };
  const input = { workout: w, index: 3, left: 140, load, features, live: null, samples: [], now: 0, allowed: ['manter', 'reduzir'] as ReviewDecision[], maxRaiseBpm: 0, sinceRelief: null };
  expect(reviewPrompt({ ...input, gait: { cadenceSpm: 162, cadenceChange: -0.0912 } }).user).toMatchObject({
    gait: { cadenceSpm: 162, cadenceChangePercent: -9.1 },
  });
  const review = reviewPrompt(input);
  expect(review.user).toMatchObject({ gait: { cadenceSpm: null, cadenceChangePercent: null } });
  expect(review.system).toContain('nenhuma regra abaixo depende deles');
  expect(review.system).toContain('secondsRemaining pode mudar de uma revisão para outra');
  expect(review.system).toContain('"trava", "ia", "app" ou "bloco"');
});

it('a resposta da revisão só vale com uma decisão aceita e bpm em número', () => {
  const parse = parseReview(['manter', 'reduzir']);
  expect(parse({ reason: ' sobe 4 por 30 s, vai passar do teto ', decision: 'reduzir', bpm: '6' })).toEqual({
    decision: 'reduzir',
    bpm: 6,
    reason: 'sobe 4 por 30 s, vai passar do teto',
  });
  expect(parse({ decision: 'reduzir', bpm: '5,4' }).bpm).toBe(5);
  expect(parse({ decision: 'manter', bpm: 0 })).toEqual({ decision: 'manter', bpm: 0, reason: '' });
  // Uma decisão fora da lista do momento é recusada, mesmo que exista em outra revisão.
  expect(() => parse({ decision: 'aumentar', bpm: 3 })).toThrow();
  expect(() => parse({ decision: 'subir', bpm: 3 })).toThrow();
  expect(parseReview(['manter', 'reduzir', 'aumentar'])({ decision: 'aumentar', bpm: 3 }).decision).toBe('aumentar');
  // Sem bpm em número também.
  expect(() => parse({ decision: 'reduzir' })).toThrow();
  expect(() => parse({ decision: 'reduzir', bpm: 'muito' })).toThrow();
  expect(() => parse({ decision: 'manter', bpm: '' })).toThrow();
  expect(() => parse(null)).toThrow();
});
