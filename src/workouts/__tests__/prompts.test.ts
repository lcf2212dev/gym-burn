import type { TreadmillSample } from '@/treadmill/types';
import { decisions, pulseFeatures, type Reading } from '../adaptive';
import {
  accumulate,
  currentCue,
  levels,
  logStage,
  makePlan,
  newWorkout,
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
  PROMPT_VERSION,
  reviewPrompt,
  summarize,
} from '../prompts';
import { week, zones, type Session } from '../week';

// 40 anos: FC máxima estimada de 180. Base aeróbica de 117 a 135 BPM, VO₂máx de 162 a 171.
const profile: Profile = { age: 40, weightKg: 78, heightCm: 175 };
const DAY = 86400000;
const NOW = 1_800_000_000_000;
const base = week[1].session!;
const vo2 = week[2].session!;

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
const plan = planAt(5.6, 2.5);
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
  });
  expect(s.work).toMatchObject({
    kmh: 5.6,
    inclinePercent: 2.5,
    mets: 4.9,
    targetKmh: 5.6,
    targetInclinePercent: 2.5,
    bpmEnd: 126,
  });
  expect(s.easy).toMatchObject({ kmh: 4, inclinePercent: 0 });
  // A faixa é a dos blocos de esforço: as leituras da recuperação, abaixo dela, não entram.
  expect(s.zoneSharePercent).toEqual({ below: 0, inside: 100, above: 0 });
  expect(summarize(done(0, 140)).zoneSharePercent).toEqual({ below: 0, inside: 0, above: 100 });
  expect(historyItem(done(3), NOW)).toMatchObject({
    daysAgo: 3,
    goal: 'Base aeróbica',
    work: { kmh: 5.6, inclinePercent: 2.5, mets: 4.9, targetKmh: 5.6, targetInclinePercent: 2.5, bpmEnd: 126 },
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
  expect(data(week[3].session!, []).session).toMatchObject({
    zone: { objective: 'Recuperação', low: 90, high: 108 },
    aim: { bpm: 96, low: 90, high: 108 },
  });
  expect(user.hr).toEqual({ restBpm: null, maxBpm: 180, maxSource: 'idade' });
  expect(user.loads[0]).toEqual({ pace: 3, grade: 0, mets: 2.4 });
  // A escada não tem carga entre o teto da caminhada e o começo da corrida, e o prompt diz isso.
  expect(user.loads.filter((r) => r.pace > 5.6 && r.pace < 7)).toEqual([]);
  expect(system).toContain('A pessoa caminha até 5,6 km/h e só corre a partir de 7 km/h');
  expect(system).toContain('Nenhuma linha fica acima de 5,6 e abaixo de 7 km/h.');
  expect(system).toContain('o work.targetKmh dela é de até 5,6 ou de 7 em diante');
  expect(system).toContain('Com work.targetKmh acima de 5,6 e abaixo de 7, a carga da referência não pode ser repetida');
  expect(PROMPT_VERSION).toBe('6');
  // Do perfil só vai a idade.
  expect(user.profile).toEqual({ age: 40 });
  expect(JSON.stringify(user)).not.toMatch(/weightKg|heightCm|activity/);
  expect(system).toContain('json');
});

it('a conta do plano repete a carga que ficou junto do teto da faixa e recalcula pela reta de FC por MET', () => {
  // Sem nenhuma sessão: 1 + (135 − 70) ÷ 15 = 5,3 METs, e 5,6 km/h a 3,5% custa 5,3.
  expect(planProcedure(data(base, []))).toEqual({ pace: 5.6, grade: 3.5, repeat: false });
  // Mesma sessão com 133 BPM, a 2 do teto de 135: repete os alvos em que ela terminou.
  expect(planProcedure(data(base, [done(2, 133)]))).toEqual({ pace: 5.6, grade: 2.5, repeat: true });
  // 126 BPM está na faixa, mas 9 abaixo do teto: a 15 bpm por MET, o alvo sobe de 4,9 para 5,5 METs.
  expect(planProcedure(data(base, [done(2)]))).toEqual({ pace: 5.6, grade: 3.5, repeat: false });
  // 105 BPM a 4,9 METs, sem repouso: 15 bpm por MET, alvo de 6,9 METs.
  expect(planProcedure(data(base, [done(2, 105, 95)]))).toEqual({ pace: 5.6, grade: 6.5, repeat: false });
  // Com repouso de 70 a reta é da própria pessoa: 9 bpm por MET, alvo de 8,2 METs. A rampa a
  // 5,6 km/h para em 7,5 METs e não há carga até a corrida: a escolha é correr a 7 km/h.
  const rested = (restBpm: number) => [{ ...done(2, 105, 95), restBpm }];
  expect(planProcedure(data(base, rested(85)))).toEqual({ pace: 7, grade: 1, repeat: false });
  // Uma reta fora de 8 a 25 bpm por MET é leitura ruim: vale 15.
  expect(planProcedure(data(base, rested(115)))).toMatchObject({ pace: 5.6, grade: 6.5 });
  // Acima da faixa (151 BPM): alvo de 3,8 METs, e a carga recua para a caminhada plana a 5,6 km/h.
  expect(planProcedure(data(base, [done(2, 151, 130)]))).toMatchObject({ pace: 5.6, grade: 0 });
  // Primeiro VO₂máx, com pontos de 4,9 METs (126) e 3,1 METs (100): 14 bpm por MET, alvo de 8,0 METs.
  const two = [done(1), done(2, 100, 92, planAt(4.5, 0))];
  expect(planProcedure(data(vo2, two))).toEqual({ pace: 7, grade: 1, repeat: false });
  // Registro antigo só conta quando não há outro.
  const old = { ...done(1, 150, 130), log: undefined, changes: undefined, hr: undefined };
  expect(planProcedure(data(base, [old, done(2, 133)]))).toEqual({ pace: 5.6, grade: 2.5, repeat: true });
  // Em recuperação a faixa inteira serve: 100 BPM, dentro de 90–108, repete a carga.
  const easy = done(2, 100, 92, { ...planAt(4.5, 0), goal: 'Recuperação ativa', objective: 'Recuperação', zone: zones['Recuperação'] });
  expect(planProcedure(data(week[3].session!, [easy]))).toEqual({ pace: 4.5, grade: 0, repeat: true });
});

it('uma referência que terminou entre 5,6 e 7 km/h não é repetida: a carga sai da reta', () => {
  // Sessão antiga a 6 km/h e 2% (4,9 METs) com 133 BPM, dentro do alvo de 132 a 135.
  // Repetir pediria 6 km/h, que a escada já não tem: 4,9 + 2 ÷ 15 = 5,0 METs, 5,6 km/h a 2,5%.
  const six = done(2, 133, 110, planAt(6, 2));
  expect(historyItem(six, NOW).work).toMatchObject({ targetKmh: 6, targetInclinePercent: 2, mets: 4.9, bpmEnd: 133 });
  expect(planProcedure(data(base, [six]))).toEqual({ pace: 5.6, grade: 2.5, repeat: false });
  // A 6 km/h e 2,5% (5,1 METs) com 134 BPM: alvo de 5,2 METs, 5,6 km/h a 3%.
  expect(planProcedure(data(base, [done(2, 134, 110, planAt(6, 2.5))]))).toEqual({
    pace: 5.6,
    grade: 3,
    repeat: false,
  });
  // Nas duas pontas do vão a repetição continua: 5,6 km/h e 7 km/h.
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.6, 2.5))]))).toEqual({
    pace: 5.6,
    grade: 2.5,
    repeat: true,
  });
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(7, 1))]))).toEqual({ pace: 7, grade: 1, repeat: true });
  // Logo acima de 5,6 e logo abaixo de 7 também recalculam.
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(5.7, 2))]))).toMatchObject({ repeat: false });
  expect(planProcedure(data(base, [done(2, 133, 110, planAt(6.9, 1))]))).toMatchObject({ repeat: false });
  // Sem repetição exata, a resposta da IA pode cair na linha vizinha; a carga antiga é recusada.
  const parse = parsePlan(data(base, [six]));
  expect(parse({ pace: 5.6, grade: 2.5 })).toMatchObject({ pace: 5.6, grade: 2.5 });
  expect(parse({ pace: 5.6, grade: 3 })).toMatchObject({ grade: 3 });
  expect(() => parse({ pace: 6, grade: 2 })).toThrow();
});

it('confere a resposta do plano com a conta do app, aceitando número em texto', () => {
  // A conta dá 5,6 km/h a 6,5%.
  const parse = parsePlan(data(base, [done(2, 105, 95)]));
  expect(parse({ why: ' 105 BPM a 4,9 METs. ', pace: '5,6', grade: '6,5' })).toEqual({
    why: '105 BPM a 4,9 METs.',
    pace: 5.6,
    grade: 6.5,
  });
  // A linha vizinha da escada passa: é um arredondamento no meio da conta.
  expect(parse({ pace: 5.6, grade: 6 }).grade).toBe(6);
  expect(parse({ pace: 5.6, grade: 7 }).grade).toBe(7);
  // Mais longe que isso é erro de conta: a chamada é repetida.
  expect(() => parse({ pace: 5.6, grade: 7.5 })).toThrow();
  // Uma carga entre o teto da caminhada e a corrida não está na escada.
  expect(() => parse({ pace: 6, grade: 6.5 })).toThrow();
  expect(() => parse({ pace: 9, grade: 1 })).toThrow();
  expect(() => parse({ pace: 40, grade: 1 })).toThrow();
  expect(() => parse({ pace: 5.6 })).toThrow();
  expect(() => parse(null)).toThrow();
  // A repetição da sessão anterior tem de ser exata.
  const repeat = parsePlan(data(base, [done(2, 133)]));
  expect(repeat({ pace: 5.6, grade: 2.5 })).toMatchObject({ pace: 5.6, grade: 2.5 });
  expect(() => repeat({ pace: 5.6, grade: 3 })).toThrow();
});

it('a revisão envia leituras relativas, o resumo já calculado e só aceita o aumento permitido', () => {
  const workout = { ...done(0), changes: [{ second: 1500, stage: 1, decision: 'reduzir inclinação', bpm: 146 }] };
  const stage = plan.stages[3];
  const readings: Reading[] = [126, 127, 127, 128].map((bpm, i) => ({
    bpm,
    at: NOW - (3 - i) * 1000,
    kmh: 5.6,
    incline: 2.5,
  }));
  const features = pulseFeatures(readings, { low: 117, high: 135 })!;
  const allowed = ['manter', 'aumentar inclinação'] as const;
  const input = {
    workout,
    index: 3,
    left: 200,
    load: { stage, easy: false, reached: true, secondsAtLoad: 300 },
    readings,
    features,
    allowed: [...allowed],
    now: NOW,
  };
  const { system, user } = reviewPrompt(input);
  expect(user).toMatchObject({
    zone: { objective: 'Base aeróbica', low: 117, high: 135 },
    stage: {
      name: 'Base aeróbica 2/2',
      kind: 'principal',
      targetKmh: 5.6,
      targetInclinePercent: 2.5,
      secondsInStage: stage.seconds - 200,
      secondsRemaining: 200,
      secondsAtLoad: 300,
      laterBlocks: 0,
    },
    // A IA só é consultada com a mediana dentro da faixa e abaixo do teto.
    bpm: { count: 4, median: 127, position: 'na faixa', marginBpm: 0, belowTopBpm: 8 },
    readings: [{ secondsAgo: 3, bpm: 126 }, { secondsAgo: 2 }, { secondsAgo: 1 }, { secondsAgo: 0, bpm: 128 }],
    // As correções do app entram no histórico de ajustes do dia.
    session: { goal: 'Base aeróbica', changes: [{ decision: 'reduzir inclinação', bpm: 146 }] },
    profile: { age: 40 },
    allowed,
  });
  // No primeiro bloco ainda vem outro igual: um ajuste feito ali vale para ele.
  expect(reviewPrompt({ ...input, index: 1 }).user).toMatchObject({ stage: { laterBlocks: 1 } });
  // O prompt fala só em manter e aumentar: reduzir é com o app, que corrige sozinho fora da faixa.
  for (const option of decisions.filter((d) => !d.startsWith('reduzir')))
    expect(system).toContain('"' + option + '"');
  expect(system).not.toMatch(/reduzir|reduza/i);
  expect(system).toContain('o próprio app corrige a carga na hora, sem consultar você');
  const parse = parseReview([...allowed]);
  expect(parse({ reason: ' 8 bpm abaixo do teto ', decision: 'aumentar inclinação' })).toEqual({
    decision: 'aumentar inclinação',
    reason: '8 bpm abaixo do teto',
  });
  // Uma decisão válida mas fora da lista do momento é rejeitada, para a chamada ser repetida.
  expect(() => parse({ decision: 'aumentar velocidade' })).toThrow();
  expect(() => parse({ decision: 'reduzir inclinação' })).toThrow();
  expect(() => parse({ decision: 'parar' })).toThrow();
});

it('a avaliação recebe só os dois números que decidem a FC máxima e prende a previsão aos limites', () => {
  const history = [done(2), { ...done(4), estimate: { level: 'Em adaptação', summary: '', maxBpm: 181 } }];
  const input = { workout: done(0), history };
  expect(assessBounds(input)).toEqual({ low: 170, high: 190 });
  const { system, user } = assessPrompt(input);
  expect(user).toMatchObject({
    profile: { age: 40 },
    session: { goal: 'Base aeróbica', work: { bpmEnd: 126, mets: 4.9 }, recoveryDrops: [16, 16] },
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
  const reduced = { ...hard.workout, changes: [{ second: 900, stage: 1, decision: 'reduzir velocidade', bpm: 178 }] };
  expect(assessBounds({ workout: reduced, history })).toEqual({ low: 178, high: 190 });
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
