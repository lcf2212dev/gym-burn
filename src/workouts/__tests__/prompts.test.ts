import type { TreadmillSample } from '@/treadmill/types';
import { decisions, objectives, pulseFeatures, type Reading } from '../adaptive';
import {
  accumulate,
  currentCue,
  goals,
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
  planPrompt,
  progressionCeiling,
  reviewPrompt,
  summarize,
} from '../prompts';

const profile: Profile = { age: 40, weightKg: 78, heightCm: 175, activity: 'Ativo' };
const DAY = 86400000;
const NOW = 1_800_000_000_000;

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

// 30 min: aquecimento 300 s, esforço 545 s, recuperação 109 s, esforço 546 s, volta à calma 300 s.
const plan: Plan = { ...makePlan('Resistência', 30, 5, 1, 10, 2), objective: 'Base aeróbica' };
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
const done = (daysAgo: number, work = 112, recovery = 96) =>
  simulate(plan, grip(work, recovery), 1800, NOW - daysAgo * DAY);

it('resume a sessão por tipo de bloco, com fim de bloco, recuperação e posição na faixa', () => {
  const s = summarize(done(0));
  expect(s).toMatchObject({
    goal: 'Resistência',
    objective: 'Base aeróbica',
    completionPercent: 100,
    zone: { low: 99, high: 117, method: 'máxima' },
    recoveryDrops: [16],
    reductions: 0,
    validatedPeakBpm: 112,
  });
  expect(s.work).toMatchObject({ kmh: 5, inclinePercent: 1, plannedKmh: 5, bpmEnd: 112 });
  expect(s.easy).toMatchObject({ kmh: 4, inclinePercent: 0 });
  // 60 leituras de esforço na faixa e 21 de recuperação abaixo dela.
  expect(s.zoneSharePercent).toEqual({ below: 26, inside: 74, above: 0 });
  expect(historyItem(done(3), NOW)).toMatchObject({
    daysAgo: 3,
    work: { kmh: 5, inclinePercent: 1, bpmEnd: 112 },
    position: 'na faixa',
    recoveryDrops: [16],
  });
});

it('trata registro antigo sem dados por etapa como aproximado e treino livre como um bloco só', () => {
  const old = { ...done(5), log: undefined, changes: undefined, hr: undefined, restBpm: undefined };
  expect(historyItem(old, NOW)).toMatchObject({
    approximate: true,
    work: { bpmEnd: old.totals.bpmCount ? Math.round(old.totals.bpmSum / old.totals.bpmCount) : null },
  });
  const free = summarize(simulate(null, () => 108, 600));
  expect(free).toMatchObject({ goal: 'Livre', completionPercent: null, easy: null });
  expect(free.work).toMatchObject({ kmh: 5, bpmEnd: 108 });
});

it('o plano recebe faixas, teto e só sessões válidas, e o teto segue o histórico', () => {
  const fragment = simulate(null, () => 100, 40, NOW - DAY);
  const history = [fragment, done(2), done(4)];
  const { system, user } = planPrompt({ profile, minutes: 45, goal: null, history, now: NOW });
  const data = user as {
    recent: { daysAgo: number }[];
    zones: Record<string, unknown>;
    ceiling: unknown;
    hr: unknown;
  };
  expect(data.recent.map((r) => r.daysAgo)).toEqual([2, 4]);
  expect(Object.keys(data.zones)).toEqual([...objectives]);
  expect(data.ceiling).toEqual({ pace: 5.5, grade: 2 });
  expect(data.hr).toEqual({ restBpm: null, maxBpm: 180, maxSource: 'idade' });
  for (const option of [...goals, ...objectives]) expect(system).toContain('"' + option + '"');
  expect(system).toContain('json');
  // Sem histórico vale o teto do nível de atividade.
  expect(progressionCeiling(profile, [fragment], NOW)).toEqual({ pace: 6, grade: 3 });
  expect(progressionCeiling({ ...profile, activity: undefined }, [], NOW)).toEqual({ pace: 5, grade: 2 });
  expect(progressionCeiling({ ...profile, activity: 'Treinado' }, [], NOW)).toEqual({ pace: 7, grade: 4 });
});

it('valida a resposta do plano, aceitando número em texto', () => {
  const reply = {
    why: ' Sessões anteriores abaixo da faixa. ',
    goal: 'Resistência',
    objective: 'Base aeróbica',
    pace: '5,2',
    grade: 1,
    workMinutes: 12.4,
    recoveryMinutes: '2',
  };
  expect(parsePlan(reply)).toEqual({
    why: 'Sessões anteriores abaixo da faixa.',
    goal: 'Resistência',
    objective: 'Base aeróbica',
    pace: 5.2,
    grade: 1,
    workMinutes: 12,
    recoveryMinutes: 2,
  });
  expect(() => parsePlan({ ...reply, goal: 'Corrida' })).toThrow();
  expect(() => parsePlan({ ...reply, objective: 'Máximo' })).toThrow();
  expect(() => parsePlan({ ...reply, pace: 12 })).toThrow();
  expect(() => parsePlan({ ...reply, grade: undefined })).toThrow();
  expect(() => parsePlan(null)).toThrow();
});

it('a revisão envia leituras relativas, o resumo já calculado e só aceita decisão permitida', () => {
  const workout = { ...done(0), changes: [{ second: 1500, stage: 1, decision: 'reduzir velocidade', bpm: 128 }] };
  const stage = plan.stages[3];
  const readings: Reading[] = [130, 131, 131, 132].map((bpm, i) => ({
    bpm,
    at: NOW - (3 - i) * 1000,
    kmh: 5,
    incline: 1,
  }));
  const features = pulseFeatures(readings, { low: 99, high: 117 })!;
  const allowed = ['manter', 'reduzir velocidade', 'reduzir inclinação'] as const;
  const { system, user } = reviewPrompt({
    workout,
    index: 3,
    left: 200,
    load: { stage, easy: false, reached: true, secondsAtLoad: 300 },
    readings,
    features,
    allowed: [...allowed],
    now: NOW,
  });
  expect(user).toMatchObject({
    zone: { objective: 'Base aeróbica', low: 99, high: 117 },
    stage: { kind: 'principal', targetKmh: 5, secondsInStage: stage.seconds - 200, secondsRemaining: 200, secondsAtLoad: 300 },
    bpm: { count: 4, median: 131, position: 'acima', marginBpm: 14 },
    readings: [{ secondsAgo: 3, bpm: 130 }, { secondsAgo: 2 }, { secondsAgo: 1 }, { secondsAgo: 0, bpm: 132 }],
    session: { changes: [{ decision: 'reduzir velocidade', bpm: 128 }] },
    allowed,
  });
  for (const option of decisions) expect(system).toContain('"' + option + '"');
  const parse = parseReview([...allowed]);
  expect(parse({ reason: ' 14 bpm acima ', decision: 'reduzir inclinação' })).toEqual({
    decision: 'reduzir inclinação',
    reason: '14 bpm acima',
  });
  // Uma decisão válida mas fora da lista do momento é rejeitada, para a chamada ser repetida.
  expect(() => parse({ decision: 'aumentar velocidade' })).toThrow();
  expect(() => parse({ decision: 'parar' })).toThrow();
});

it('a avaliação recebe os limites da FC máxima e prende a previsão a eles', () => {
  const history = [done(2), { ...done(4), estimate: { level: 'Em adaptação', summary: '', maxBpm: 181 } }];
  const input = { workout: done(0), history };
  expect(assessBounds(input)).toEqual({ low: 170, high: 190 });
  const { system, user } = assessPrompt(input);
  expect(user).toMatchObject({
    profile: { age: 40, activity: 'Ativo' },
    session: { work: { bpmEnd: 112 }, recoveryDrops: [16] },
    recent: [{ daysAgo: 2 }, { daysAgo: 4, level: 'Em adaptação', maxBpm: 181 }],
    heart: { foxMaxBpm: 180, tanakaMaxBpm: 180, observedPeakBpm: 112, previousMaxBpm: [181], bounds: { low: 170, high: 190 } },
  });
  // Peso e altura não vão: o prompt proíbe inferência por eles.
  expect(JSON.stringify(user)).not.toContain('weightKg');
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
