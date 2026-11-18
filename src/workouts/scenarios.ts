// Cenários fixos para medir a precisão da IA no próprio aparelho, com a chave
// salva. Cada cenário tem um desfecho aceito; a mesma entrada é enviada algumas
// vezes para medir também a concordância entre repetições.

import {
  allowedDecisions,
  pulseFeatures,
  type Decision,
  type Objective,
  type Reading,
} from './adaptive';
import { callModel, type Kind } from './ai';
import {
  emptyLog,
  makePlan,
  median,
  type Goal,
  type HeartProfile,
  type Plan,
  type Profile,
  type StageLog,
  type Workout,
} from './model';
import { dailyTarget, foxMax } from './physiology';
import {
  assessBounds,
  assessPrompt,
  parseAssess,
  parsePlan,
  parseReview,
  planPrompt,
  progressionCeiling,
  reviewPrompt,
  type PlanChoice,
} from './prompts';

export type Outcome = {
  scenario: string;
  kind: Kind;
  run: number;
  ok: boolean;
  answer: string;
  detail?: string;
  /** `false` quando as regras locais resolveram sem consultar a IA. */
  called: boolean;
  ms: number;
  error?: string;
};

const DAY = 86400000;
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

// --- Sessões fabricadas ----------------------------------------------------

type Past = {
  daysAgo: number;
  goal?: Goal;
  objective?: Objective;
  minutes?: number;
  pace?: number;
  grade?: number;
  /** BPM estabilizado nos blocos de esforço e nos blocos leves. */
  bpmWork?: number | null;
  bpmEasy?: number | null;
  /** Queda em 1 min de recuperação. */
  drop?: number | null;
  /** Parcela do plano realmente feita. */
  completion?: number;
  reductions?: number;
  level?: string;
  maxBpm?: number;
};

function past(profile: Profile, now: number, p: Past): Workout {
  const plan: Plan = {
    ...makePlan(p.goal ?? 'Resistência', p.minutes ?? 45, p.pace ?? 5, p.grade ?? 1, 15, 2),
    objective: p.objective ?? 'Base aeróbica',
  };
  const hr: HeartProfile = { rest: null, max: foxMax(profile.age), maxSource: 'idade' };
  const zone = dailyTarget(plan, profile, hr);
  let budget = plan.minutes * 60 * (p.completion ?? 1);
  const log: StageLog[] = [];
  plan.stages.forEach((stage, i) => {
    const seconds = Math.min(stage.seconds, budget);
    budget -= seconds;
    if (seconds <= 0) return;
    const ms = seconds * 1000;
    const bpm = stage.measure ? (p.bpmEasy ?? null) : (p.bpmWork ?? null);
    const tail = bpm === null ? [] : [bpm - 1, bpm, bpm + 1, bpm, bpm, bpm + 1, bpm - 1, bpm];
    const afterWork = i > 0 && stage.measure && !plan.stages[i - 1].measure;
    const base = (p.bpmWork ?? 0) - (p.drop ?? 0);
    const early = afterWork && p.bpmWork != null && p.drop != null ? [base + 1, base, base - 1] : [];
    const counts: StageLog['zone'] = [0, 0, 0];
    [...tail, ...early].forEach((b) => counts[b < zone.low ? 0 : b > zone.high ? 2 : 1]++);
    log.push({
      ...emptyLog(),
      ms,
      distanceM: (stage.speed * ms) / 3600,
      inclineMs: stage.incline * ms,
      inclineDurationMs: ms,
      bpmCount: tail.length + early.length,
      bpmSum: total(tail) + total(early),
      zone: counts,
      tail,
      early,
      top: tail.length ? median(tail.slice(-3)) : 0,
    });
  });
  const movingMs = total(log.map((l) => l.ms));
  const started = now - p.daysAgo * DAY - movingMs;
  return {
    id: 'diag-' + p.daysAgo,
    started,
    source: 'demo',
    profile,
    plan,
    totals: {
      movingMs,
      distanceM: total(log.map((l) => l.distanceM)),
      inclineMs: total(log.map((l) => l.inclineMs)),
      inclineDurationMs: movingMs,
      bpmCount: total(log.map((l) => l.bpmCount)),
      bpmSum: total(log.map((l) => l.bpmSum)),
      peakBpm: Math.max(0, ...log.flatMap((l) => [...l.tail, ...l.early])),
    },
    ended: started + movingMs,
    reason: (p.completion ?? 1) >= 1 ? 'Duração concluída' : 'Encerrado no app',
    estimate: p.level ? { level: p.level, summary: '', maxBpm: p.maxBpm ?? null } : null,
    restBpm: null,
    hr,
    log,
    changes: Array.from({ length: p.reductions ?? 0 }, (_, k) => ({
      second: 600 + 200 * k,
      stage: 1,
      decision: 'reduzir velocidade',
      bpm: p.bpmWork ?? 0,
    })),
  };
}

const adult: Profile = { age: 40, weightKg: 78, heightCm: 175, activity: 'Ativo' };

// --- Revisão durante o treino ----------------------------------------------
// Pessoa de 40 anos em "Base aeróbica": faixa de 99 a 117 BPM. Plano de 45 min
// com dois blocos de esforço a 5,5 km/h e 2%.

type ReviewCase = {
  name: string;
  /** Etapa: 0 aquecimento, 1 esforço, 2 recuperação, 3 esforço, 4 volta à calma. */
  stage: number;
  into: number;
  reached: boolean;
  atLoad: number;
  bpm: number[];
  /** Velocidade medida, quando difere do alvo. */
  kmh?: number;
  change?: { secondsAgo: number; decision: Decision; bpm: number };
  expect: Decision[];
};

const reduce: Decision[] = ['reduzir velocidade', 'reduzir inclinação'];
const increase: Decision[] = ['aumentar velocidade', 'aumentar inclinação'];
const hold: Decision[] = ['manter'];

const reviewCases: ReviewCase[] = [
  { name: 'faixa-estavel', stage: 1, into: 400, reached: true, atLoad: 380, bpm: [110, 111, 110, 112, 111, 110], expect: hold },
  { name: 'acima-sustentado', stage: 1, into: 500, reached: true, atLoad: 480, bpm: [129, 130, 131, 130, 131, 132], expect: reduce },
  { name: 'acima-marginal', stage: 1, into: 500, reached: true, atLoad: 480, bpm: [119, 120, 119, 120, 119, 120], expect: hold },
  {
    name: 'acima-logo-apos-reducao',
    stage: 1,
    into: 600,
    reached: true,
    atLoad: 20,
    bpm: [124, 123, 123, 122, 122, 121],
    change: { secondsAgo: 45, decision: 'reduzir velocidade', bpm: 129 },
    expect: hold,
  },
  { name: 'abaixo-cedo-demais', stage: 1, into: 40, reached: true, atLoad: 25, bpm: [92, 93, 93, 94, 95, 95], expect: hold },
  { name: 'abaixo-estavel', stage: 1, into: 420, reached: true, atLoad: 400, bpm: [88, 89, 88, 89, 88, 89], expect: increase },
  { name: 'aquecimento-abaixo', stage: 0, into: 120, reached: true, atLoad: 100, bpm: [85, 86, 85, 86, 86, 85], expect: hold },
  { name: 'recuperacao-caindo', stage: 2, into: 50, reached: true, atLoad: 30, bpm: [128, 126, 124, 122, 120, 119], expect: hold },
  { name: 'volta-a-calma-presa-acima', stage: 4, into: 200, reached: true, atLoad: 180, bpm: [131, 131, 132, 131, 132, 132], expect: ['reduzir velocidade'] },
  { name: 'pico-isolado-no-fim', stage: 1, into: 500, reached: true, atLoad: 480, bpm: [110, 111, 110, 112, 111, 150], expect: hold },
  { name: 'abaixo-sem-atingir-alvo', stage: 1, into: 400, reached: false, atLoad: 0, bpm: [90, 90, 91, 90, 91, 90], kmh: 4.8, expect: hold },
  { name: 'acima-e-subindo', stage: 1, into: 300, reached: true, atLoad: 280, bpm: [123, 123, 124, 124, 125, 125], expect: reduce },
];

async function runReview(c: ReviewCase) {
  const now = Date.now();
  const plan: Plan = { ...makePlan('Resistência', 45, 5.5, 2, 15, 2), objective: 'Base aeróbica' };
  const stage = plan.stages[c.stage];
  const elapsed = total(plan.stages.slice(0, c.stage).map((s) => s.seconds)) + c.into;
  const hr: HeartProfile = { rest: null, max: foxMax(adult.age), maxSource: 'idade' };
  const kmh = c.kmh ?? stage.speed;
  const readings: Reading[] = c.bpm.map((bpm, k) => ({
    bpm,
    at: now - (c.bpm.length - 1 - k) * 1000,
    kmh,
    incline: stage.incline,
  }));
  const w: Workout = {
    id: 'diag',
    started: now - elapsed * 1000,
    source: 'demo',
    profile: adult,
    plan,
    totals: {
      movingMs: elapsed * 1000,
      distanceM: Math.round(elapsed * 1.4),
      inclineMs: elapsed * 1500,
      inclineDurationMs: elapsed * 1000,
      bpmCount: c.bpm.length,
      bpmSum: total(c.bpm),
      peakBpm: Math.max(...c.bpm),
    },
    ended: null,
    reason: '',
    estimate: null,
    restBpm: null,
    hr,
    log: [],
    changes: c.change
      ? [{ second: elapsed - c.change.secondsAgo, stage: c.stage, decision: c.change.decision, bpm: c.change.bpm }]
      : [],
  };
  const left = stage.seconds - c.into;
  // As mesmas regras locais da sessão: espera depois de um ajuste e lista de decisões possíveis.
  if (c.change && c.change.secondsAgo < 60) return { answer: 'manter', detail: 'espera após ajuste', called: false };
  const features = pulseFeatures(readings, dailyTarget(plan, adult, hr))!;
  const load = { stage, easy: stage.measure, reached: c.reached, secondsAtLoad: c.atLoad };
  const allowed = allowedDecisions(features, load);
  if (allowed.length === 1) return { answer: 'manter', detail: 'regra local: ' + features.position, called: false };
  const { decision, reason } = await callModel(
    'review',
    reviewPrompt({ workout: w, index: c.stage, left, load, readings, features, allowed, now }),
    parseReview(allowed),
    { journal: false },
  );
  return { answer: decision, detail: reason, called: true };
}

// --- Plano do dia -----------------------------------------------------------

type PlanCase = {
  name: string;
  profile: Profile;
  minutes: number;
  goal: Goal | null;
  history: (now: number) => Workout[];
  /** Devolve o motivo da reprovação, ou `null` se o plano serve. */
  check: (c: PlanChoice) => string | null;
};

const steady = (now: number, days: number[], p: Omit<Past, 'daysAgo'>) =>
  days.map((daysAgo) => past(adult, now, { level: 'Base em formação', maxBpm: 180, ...p, daysAgo }));

const planCases: PlanCase[] = [
  {
    name: 'sem-historico-sedentario',
    profile: { age: 58, weightKg: 82, heightCm: 170, activity: 'Sedentário' },
    minutes: 30,
    goal: null,
    history: () => [],
    check: (c) =>
      c.pace > 4.5 ? 'ritmo acima de 4,5' : c.grade > 1 ? 'inclinação acima de 1%' : c.objective === 'Resistência moderada' ? 'objetivo moderado sem histórico' : null,
  },
  {
    name: 'sem-historico-treinado',
    profile: { age: 30, weightKg: 70, heightCm: 175, activity: 'Treinado' },
    minutes: 45,
    goal: null,
    history: () => [],
    check: (c) => (c.pace < 5 || c.pace > 6.5 ? 'ritmo fora de 5,0 a 6,5' : c.grade > 3 ? 'inclinação acima de 3%' : null),
  },
  {
    name: 'progressao-um-passo',
    profile: adult,
    minutes: 45,
    goal: null,
    history: (now) => steady(now, [2, 4, 6], { pace: 5, grade: 1, bpmWork: 94, bpmEasy: 88, drop: 15 }),
    check: (c) => {
      const speed = c.pace > 5.05 && c.pace < 5.35 && near(c.grade, 1);
      const slope = near(c.pace, 5) && near(c.grade, 1.5);
      return speed || slope ? null : 'esperado um único passo acima de 5,0 km/h e 1%';
    },
  },
  {
    name: 'recuo-apos-sessao-dura',
    profile: adult,
    minutes: 45,
    goal: null,
    history: (now) => [
      past(adult, now, { daysAgo: 1, pace: 5.5, grade: 2, bpmWork: 128, bpmEasy: 112, drop: 9, reductions: 2, completion: 0.6, level: 'Em adaptação', maxBpm: 180 }),
      ...steady(now, [3, 5], { pace: 5.3, grade: 2, bpmWork: 114, bpmEasy: 100, drop: 14 }),
    ],
    check: (c) =>
      c.pace > 5.55 || c.grade > 2.05 ? 'carga acima da sessão que precisou de reduções' : c.pace > 5.25 && c.grade > 1.55 ? 'não recuou em relação a 5,5 km/h e 2%' : null,
  },
  {
    name: 'modo-fixo-intervalado',
    profile: adult,
    minutes: 40,
    goal: 'Intervalado',
    history: (now) => steady(now, [2, 4, 6], { pace: 5, grade: 1, bpmWork: 108, bpmEasy: 96, drop: 15 }),
    check: (c) =>
      c.goal !== 'Intervalado' ? 'trocou o modo pedido' : c.workMinutes > 5 ? 'bloco de esforço longo para intervalado' : c.recoveryMinutes > 3 ? 'recuperação longa' : c.pace < 4.5 || c.pace > 5.55 ? 'ritmo fora de 4,5 a 5,5' : c.grade > 1.55 ? 'inclinação acima de 1,5%' : null,
  },
  {
    name: 'menos-de-24h-de-descanso',
    profile: adult,
    minutes: 45,
    goal: null,
    history: (now) => [
      past(adult, now, { daysAgo: 0, objective: 'Resistência moderada', pace: 5.5, grade: 2, bpmWork: 122, bpmEasy: 104, drop: 16, level: 'Base em formação', maxBpm: 180 }),
      ...steady(now, [2, 4], { pace: 5.3, grade: 2, bpmWork: 112, bpmEasy: 98, drop: 15 }),
    ],
    check: (c) => (c.objective === 'Resistência moderada' ? 'repetiu objetivo moderado com menos de 24 h' : c.pace > 5.55 ? 'subiu o ritmo sem descanso' : null),
  },
];

async function runPlan(c: PlanCase) {
  const now = Date.now();
  const history = c.history(now);
  const raw = await callModel(
    'plan',
    planPrompt({ profile: c.profile, minutes: c.minutes, goal: c.goal, history, now }),
    parsePlan,
    { journal: false },
  );
  // O teto de progressão faz parte do sistema: o que vale é o plano final.
  const ceiling = progressionCeiling(c.profile, history, now);
  const choice: PlanChoice = {
    ...raw,
    goal: c.goal ?? raw.goal,
    pace: Math.min(raw.pace, ceiling.pace),
    grade: Math.min(raw.grade, ceiling.grade),
  };
  const problem = c.check(choice);
  return {
    answer: [choice.goal, choice.objective, choice.pace, choice.grade, choice.workMinutes + '/' + choice.recoveryMinutes].join(' | '),
    detail: problem ?? choice.why,
    ok: !problem,
    called: true,
  };
}

// --- Avaliação ao fim do treino ---------------------------------------------

type AssessCase = {
  name: string;
  profile: Profile;
  session: Omit<Past, 'daysAgo'>;
  history: (now: number, profile: Profile) => Workout[];
  levels: string[];
  /** Faixa aceita para a FC máxima prevista. */
  max: [number, number];
};

const older: Profile = { age: 50, weightKg: 80, heightCm: 172, activity: 'Ativo' };
const fine = (now: number, profile: Profile, days: number[], bpm: number[], extra: Omit<Past, 'daysAgo'> = {}) =>
  days.map((daysAgo, k) =>
    past(profile, now, { pace: 5, grade: 1, bpmWork: bpm[k], bpmEasy: 98, drop: 15, level: 'Base em formação', maxBpm: 180, ...extra, daysAgo }),
  );

const assessCases: AssessCase[] = [
  {
    name: 'primeira-sessao',
    profile: adult,
    session: { pace: 5, grade: 1, bpmWork: 110, bpmEasy: 98, drop: 14 },
    history: () => [],
    levels: ['Em adaptação'],
    max: [177, 183],
  },
  {
    name: 'base-em-formacao',
    profile: adult,
    session: { pace: 5, grade: 1, bpmWork: 111, bpmEasy: 98, drop: 14 },
    history: (now, p) => fine(now, p, [2, 5, 8], [112, 112, 113], { level: 'Em adaptação', drop: 14 }),
    levels: ['Base em formação'],
    max: [177, 183],
  },
  {
    name: 'base-consistente',
    profile: adult,
    session: { pace: 5, grade: 1, bpmWork: 109, bpmEasy: 96, drop: 22 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12, 15], [112, 112, 113, 114, 115], { drop: 21 }),
    levels: ['Base consistente'],
    max: [177, 183],
  },
  {
    name: 'acima-da-faixa-com-reducoes',
    profile: adult,
    session: { pace: 5.5, grade: 2, bpmWork: 126, bpmEasy: 110, drop: 10, reductions: 2 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12], [112, 112, 113, 113]),
    levels: ['Em adaptação'],
    max: [177, 183],
  },
  {
    name: 'pico-acima-da-estimativa',
    profile: older,
    session: { pace: 6, grade: 3, bpmWork: 176, bpmEasy: 150, drop: 12 },
    history: (now, p) => fine(now, p, [3, 6], [150, 152], { maxBpm: 172, level: 'Em adaptação' }),
    levels: ['Em adaptação'],
    max: [179, 183],
  },
  {
    name: 'maxima-estavel-entre-sessoes',
    profile: adult,
    session: { pace: 5, grade: 1, bpmWork: 111, bpmEasy: 98, drop: 15 },
    history: (now, p) => [
      ...fine(now, p, [2, 5], [112, 112], { maxBpm: 183 }),
      ...fine(now, p, [8], [113], { maxBpm: 182 }),
    ],
    levels: ['Base em formação'],
    max: [180, 186],
  },
  {
    name: 'sessao-interrompida-na-metade',
    profile: adult,
    session: { pace: 5, grade: 1, bpmWork: 112, bpmEasy: 98, drop: 15, completion: 0.5 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12], [112, 112, 113, 113]),
    levels: ['Em adaptação'],
    max: [177, 183],
  },
];

async function runAssess(c: AssessCase) {
  const now = Date.now();
  const workout = past(c.profile, now, { ...c.session, daysAgo: 0 });
  const history = c.history(now, c.profile);
  const input = { workout, history };
  const e = await callModel('assess', assessPrompt(input), parseAssess(assessBounds(input)), { journal: false });
  const max = e.maxBpm ?? 0;
  const levelOk = c.levels.includes(e.level);
  const maxOk = max >= c.max[0] && max <= c.max[1];
  return {
    answer: e.level + ' | ' + max,
    detail: (levelOk ? '' : 'nível esperado: ' + c.levels.join(' ou ') + '. ') + (maxOk ? '' : 'FC máxima esperada entre ' + c.max.join(' e ') + '. ') + e.summary,
    ok: levelOk && maxOk,
    called: true,
  };
}

// --- Execução e placar ------------------------------------------------------

export const scenarioCount = { plan: planCases.length, review: reviewCases.length, assess: assessCases.length };

export async function runScenarios(
  repeats: number,
  only: Kind | null,
  onResult: (done: Outcome[], total: number) => void,
) {
  type Result = { answer: string; detail?: string; called: boolean; ok?: boolean };
  const jobs: { scenario: string; kind: Kind; run: number; go: () => Promise<Result>; expect?: string[] }[] = [];
  for (let run = 1; run <= repeats; run++) {
    if (!only || only === 'review')
      for (const c of reviewCases)
        jobs.push({ scenario: c.name, kind: 'review', run, go: () => runReview(c), expect: c.expect });
    if (!only || only === 'plan')
      for (const c of planCases) jobs.push({ scenario: c.name, kind: 'plan', run, go: () => runPlan(c) });
    if (!only || only === 'assess')
      for (const c of assessCases) jobs.push({ scenario: c.name, kind: 'assess', run, go: () => runAssess(c) });
  }
  const done: Outcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const started = Date.now();
      const base = { scenario: job.scenario, kind: job.kind, run: job.run };
      let outcome: Outcome;
      try {
        const r = await job.go();
        outcome = {
          ...base,
          ok: r.ok ?? !!job.expect?.includes(r.answer),
          answer: r.answer,
          detail: r.detail,
          called: r.called,
          ms: Date.now() - started,
        };
      } catch (e) {
        outcome = { ...base, ok: false, answer: 'falha', called: true, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
      }
      done.push(outcome);
      console.log('[gymburn-diag] ' + JSON.stringify(outcome));
      onResult([...done], jobs.length);
    }
  };
  // Três chamadas por vez: termina em tempo razoável sem disputar o limite da conta.
  await Promise.all([worker(), worker(), worker()]);
  console.log('[gymburn-diag] resumo ' + JSON.stringify({ repeats, board: scoreboard(done) }));
  return done;
}

/** Acerto, concordância entre repetições e latência, por tipo de chamada. */
export function scoreboard(outcomes: Outcome[]) {
  return (['plan', 'review', 'assess'] as const).flatMap((kind) => {
    const rows = outcomes.filter((o) => o.kind === kind);
    if (!rows.length) return [];
    const names = [...new Set(rows.map((r) => r.scenario))];
    // Concordância: parcela das repetições de um cenário que deram a resposta mais comum.
    const agreement = names.map((name) => {
      const answers = rows.filter((r) => r.scenario === name).map((r) => r.answer);
      const most = Math.max(...answers.map((a) => answers.filter((b) => b === a).length));
      return most / answers.length;
    });
    const times = rows
      .filter((r) => r.called && !r.error)
      .map((r) => r.ms)
      .sort((a, b) => a - b);
    return [
      {
        kind,
        runs: rows.length,
        correct: rows.filter((r) => r.ok).length,
        correctPercent: Math.round((100 * rows.filter((r) => r.ok).length) / rows.length),
        agreementPercent: Math.round((100 * total(agreement)) / agreement.length),
        failures: rows.filter((r) => r.error).length,
        calls: rows.filter((r) => r.called).length,
        medianSeconds: times.length ? Math.round(times[times.length >> 1] / 100) / 10 : null,
        slowestSeconds: times.length ? Math.round(times[times.length - 1] / 100) / 10 : null,
      },
    ];
  });
}
