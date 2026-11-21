// Cenários fixos para medir a precisão da IA no próprio aparelho, com a chave
// salva. Cada cenário tem um desfecho aceito; a mesma entrada é enviada algumas
// vezes para medir também a concordância entre repetições.

import {
  allowedDecisions,
  changeLabel,
  correctedStage,
  correction,
  correctionBpm,
  pulseFeatures,
  type Decision,
  type Reading,
} from './adaptive';
import { callModel, type Kind } from './ai';
import {
  emptyLog,
  median,
  metabolicCost,
  type HeartProfile,
  type Plan,
  type Profile,
  type StageLog,
  type Workout,
} from './model';
import { bpmPerMet, dailyTarget, foxMax, loadLadder } from './physiology';
import {
  assessBounds,
  assessPrompt,
  parseAssess,
  parsePlan,
  parseReview,
  planPrompt,
  reviewPrompt,
} from './prompts';
import { sessionPlan, week, type Session } from './week';

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

// As sessões do plano semanal usadas nos cenários.
const base = week[1].session!;
const vo2 = week[2].session!;
const recovery = week[3].session!;
const threshold = week[5].session!;

// --- Sessões fabricadas ----------------------------------------------------

type Past = {
  daysAgo: number;
  session?: Session;
  pace?: number;
  grade?: number;
  /** BPM estabilizado nos blocos de esforço e nos blocos leves. */
  bpmWork?: number | null;
  bpmEasy?: number | null;
  /** Leitura do primeiro minuto, de onde sai a FC de repouso. */
  rest?: number;
  /** Queda em 1 min de recuperação. */
  drop?: number | null;
  /** Parcela do plano realmente feita. */
  completion?: number;
  reductions?: number;
  level?: string;
  maxBpm?: number;
};

function past(profile: Profile, now: number, p: Past): Workout {
  const plan = sessionPlan(p.session ?? base, p.pace ?? 5.6, p.grade ?? 2.5);
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
    const start = (p.bpmWork ?? 0) - (p.drop ?? 0);
    const early = afterWork && p.bpmWork != null && p.drop != null ? [start + 1, start, start - 1] : [];
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
    restBpm: p.rest ?? null,
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

// 40 anos: FC máxima estimada de 180. Faixas: recuperação 90–108, base 117–135,
// limiar 153–162, VO₂máx 162–171. Fora da recuperação, o alvo é o teto da faixa.
const adult: Profile = { age: 40, weightKg: 78, heightCm: 175 };

// --- Revisão durante o treino ----------------------------------------------

type ReviewCase = {
  name: string;
  session: Session;
  pace: number;
  grade: number;
  /** Índice da etapa no plano da sessão. */
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

const hold: Decision[] = ['manter'];
// Base aeróbica a 5,6 km/h e 2,5%: aquecimento (0), esforço de 35 min (1), volta à calma (2).
const walk = { session: base, pace: 5.6, grade: 2.5 };
// VO₂máx a 5,6 km/h e 7%: aquecimento (0), tiros nas etapas 1, 3, 5 e 7, com recuperação depois de cada um.
const shots = { session: vo2, pace: 5.6, grade: 7 };

// Fora da faixa (117–135 na base) o app corrige sozinho, na primeira medida:
// esses casos não chegam à IA, e o desfecho é o ajuste que a conta do app dá.
// Dentro da faixa e abaixo do teto a IA decide se a carga sobe um degrau.
const reviewCases: ReviewCase[] = [
  // Dentro da faixa, mas 9 bpm abaixo do teto: a pessoa quer treinar no alto dela.
  { name: 'na-faixa-longe-do-teto', ...walk, stage: 1, into: 400, reached: true, atLoad: 380, bpm: [125, 126, 125, 127, 126, 125], expect: ['aumentar inclinação'] },
  // A 3 bpm do teto o alvo já foi atingido; a 4, ainda cabe um degrau.
  { name: 'junto-do-teto', ...walk, stage: 1, into: 600, reached: true, atLoad: 580, bpm: [132, 132, 131, 132, 133, 132], expect: hold },
  { name: 'quatro-abaixo-do-teto', ...walk, stage: 1, into: 600, reached: true, atLoad: 580, bpm: [131, 131, 130, 131, 132, 131], expect: ['aumentar inclinação'] },
  // Carga nova há menos de 4 minutos: a FC ainda sobe sozinha, e 7 bpm abaixo do teto não bastam.
  {
    name: 'abaixo-do-teto-apos-aumento',
    ...walk,
    stage: 1,
    into: 700,
    reached: true,
    atLoad: 140,
    bpm: [127, 128, 127, 128, 128, 127],
    change: { secondsAgo: 150, decision: 'aumentar inclinação', bpm: 124 },
    expect: hold,
  },
  // Carga nova há menos de 4 minutos, mas 13 bpm abaixo do teto já pedem mais carga.
  { name: 'carga-nova-longe-do-teto', ...walk, stage: 1, into: 128, reached: true, atLoad: 105, bpm: [121, 122, 122, 121, 122, 122], expect: ['aumentar inclinação'] },
  // 149 BPM, 14 acima do teto: a rampa sai inteira de uma vez.
  { name: 'acima-sustentado', ...walk, stage: 1, into: 500, reached: true, atLoad: 480, bpm: [147, 148, 149, 148, 149, 150], expect: ['reduzir inclinação'] },
  // 3 bpm acima do teto já bastam: não há tolerância acima da faixa.
  { name: 'acima-por-pouco', ...walk, stage: 1, into: 500, reached: true, atLoad: 480, bpm: [137, 138, 137, 138, 137, 138], expect: ['reduzir inclinação'] },
  // Acima da faixa com a carga nova há 20 s: o alívio não espera a FC estabilizar.
  { name: 'acima-sem-estabilizar', ...walk, stage: 1, into: 30, reached: true, atLoad: 20, bpm: [139, 140, 140, 141, 141, 142], expect: ['reduzir inclinação'] },
  // O único intervalo que resta é o de 1 minuto depois de um ajuste.
  {
    name: 'acima-logo-apos-reducao',
    ...walk,
    stage: 1,
    into: 600,
    reached: true,
    atLoad: 20,
    bpm: [142, 141, 141, 140, 140, 139],
    change: { secondsAgo: 45, decision: 'reduzir inclinação', bpm: 147 },
    expect: hold,
  },
  // Abaixo da faixa, mas com 25 s na carga: o BPM ainda é o do aquecimento.
  { name: 'abaixo-cedo-demais', ...walk, stage: 1, into: 40, reached: true, atLoad: 25, bpm: [102, 103, 103, 104, 105, 105], expect: hold },
  // 107 BPM, 10 abaixo do piso: a carga sobe 1 MET de uma vez, o máximo de uma correção.
  { name: 'abaixo-estavel', ...walk, stage: 1, into: 420, reached: true, atLoad: 400, bpm: [106, 107, 106, 107, 106, 107], expect: ['aumentar inclinação'] },
  { name: 'aquecimento-abaixo', ...walk, stage: 0, into: 120, reached: true, atLoad: 100, bpm: [95, 96, 95, 96, 96, 95], expect: hold },
  // Acima da faixa alivia em qualquer etapa, mesmo com a FC já caindo. A etapa leve para em 3 km/h.
  { name: 'volta-a-calma-acima-caindo', ...walk, stage: 2, into: 50, reached: true, atLoad: 30, bpm: [146, 144, 142, 140, 138, 137], expect: ['reduzir velocidade'] },
  { name: 'volta-a-calma-presa-acima', ...walk, stage: 2, into: 200, reached: true, atLoad: 180, bpm: [149, 149, 150, 149, 150, 150], expect: ['reduzir velocidade'] },
  // Junto do teto, uma leitura solta não muda a mediana nem pede ajuste.
  { name: 'pico-isolado-no-fim', ...walk, stage: 1, into: 500, reached: true, atLoad: 480, bpm: [132, 133, 132, 133, 133, 165], expect: hold },
  { name: 'abaixo-sem-atingir-alvo', ...walk, stage: 1, into: 400, reached: false, atLoad: 0, bpm: [105, 105, 106, 105, 106, 105], kmh: 5.2, expect: hold },
  { name: 'acima-e-subindo', ...walk, stage: 1, into: 300, reached: true, atLoad: 280, bpm: [141, 141, 142, 142, 143, 143], expect: ['reduzir inclinação'] },
  // No meio do tiro a FC ainda está disparando: não é hora de aumentar a carga.
  { name: 'tiro-abaixo-subindo', ...shots, stage: 1, into: 135, reached: true, atLoad: 125, bpm: [150, 151, 153, 154, 156, 157], expect: hold },
  { name: 'tiro-abaixo-estavel', ...shots, stage: 1, into: 150, reached: true, atLoad: 140, bpm: [150, 151, 150, 151, 150, 151], expect: ['aumentar inclinação'] },
  // Correndo, a carga muda pela velocidade.
  { name: 'limiar-correndo-acima', session: threshold, pace: 8, grade: 1, stage: 1, into: 300, reached: true, atLoad: 280, bpm: [172, 173, 172, 173, 174, 173], expect: ['reduzir velocidade'] },
  // Em dia de recuperação a faixa é teto: abaixo dela nada sobe.
  { name: 'recuperacao-abaixo-do-teto', session: recovery, pace: 4.5, grade: 0, stage: 1, into: 600, reached: true, atLoad: 580, bpm: [84, 85, 84, 85, 85, 84], expect: hold },
  // Caminhando abaixo de 5,6 km/h, a carga sobe pela velocidade.
  { name: 'caminhada-na-faixa-longe-do-teto', session: base, pace: 5, grade: 0, stage: 1, into: 420, reached: true, atLoad: 400, bpm: [124, 125, 124, 125, 124, 125], expect: ['aumentar velocidade'] },
  // Abaixo da faixa, a velocidade vai ao teto da caminhada e o resto sobe pela rampa.
  { name: 'caminhada-abaixo-estavel', session: base, pace: 5, grade: 0, stage: 1, into: 420, reached: true, atLoad: 400, bpm: [104, 105, 104, 105, 104, 105], expect: ['aumentar inclinação'] },
];

/**
 * O que a sessão faria com o caso: a resposta das regras locais, quando elas
 * resolvem sozinhas, ou a entrada que iria à IA.
 */
function reviewInput(c: ReviewCase, now: number) {
  const plan: Plan = sessionPlan(c.session, c.pace, c.grade);
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
  // As mesmas regras locais da sessão: espera depois de um ajuste, correção
  // fora da faixa e lista de decisões possíveis.
  if (c.change && c.change.secondsAgo < 60) return { local: 'espera após ajuste', answer: 'manter' };
  const zone = dailyTarget(plan, adult, hr);
  const features = pulseFeatures(readings, zone)!;
  const load = {
    stage,
    easy: stage.measure || plan.objective === 'Recuperação',
    reached: c.reached,
    secondsAtLoad: c.atLoad,
  };
  const fix = correction(features, load);
  if (fix) {
    const measured = { at: now, speedKmh: kmh, inclinationPercent: stage.incline, heartRateBpm: null, energyKcal: null, distanceM: null };
    const slope = bpmPerMet(features.median, metabolicCost(kmh, stage.incline), hr.rest);
    const revised = correctedStage(stage, fix, correctionBpm(fix, features, zone) / slope, measured);
    return {
      local: 'correção do app: ' + revised.speed + ' km/h e ' + revised.incline + '%',
      answer: revised === stage ? 'manter' : changeLabel(stage, revised),
    };
  }
  const allowed = allowedDecisions(features, load);
  if (allowed.length === 1) return { local: 'regra local: ' + features.position, answer: 'manter' };
  return {
    allowed,
    prompt: reviewPrompt({ workout: w, index: c.stage, left, load, readings, features, allowed, now }),
  };
}

/** A entrada de cada cenário de revisão com o desfecho esperado, para os testes conferirem o gabarito. */
export const reviewChecks = (now: number) =>
  reviewCases.map((c) => {
    const input = reviewInput(c, now);
    return {
      name: c.name,
      expect: c.expect,
      local: input.local ?? null,
      /** O que o app faz sozinho, nos casos que não chegam à IA. */
      answer: input.answer ?? null,
      user: input.prompt?.user ?? null,
    };
  });

async function runReview(c: ReviewCase) {
  const input = reviewInput(c, Date.now());
  if (!input.prompt) return { answer: input.answer, detail: input.local, called: false };
  const { decision, reason } = await callModel('review', input.prompt, parseReview(input.allowed), {
    journal: false,
  });
  return { answer: decision, detail: reason, called: true };
}

// --- Plano do dia -----------------------------------------------------------

type PlanCase = {
  name: string;
  session: Session;
  history: (now: number) => Workout[];
  /** A carga que o procedimento do prompt dá para esta entrada. */
  expect: { pace: number; grade: number };
  /** `true` quando só vale a carga exata (repetir a sessão anterior). */
  exact?: boolean;
};

const steady = (now: number, days: number[], p: Omit<Past, 'daysAgo'>) =>
  days.map((daysAgo) => past(adult, now, { level: 'Base em formação', maxBpm: 180, ...p, daysAgo }));

const planCases: PlanCase[] = [
  // Sem nenhum ponto: 1 + (135 − 70) ÷ 15 = 5,3 METs.
  { name: 'base-sem-historico', session: base, history: () => [], expect: { pace: 5.6, grade: 3.5 } },
  // Um ponto só (3,5 km/h a 2% com 99 BPM) e repouso de 62: 16 bpm por MET, alvo de 5,5 METs.
  {
    name: 'base-um-ponto-com-repouso',
    session: base,
    history: (now) => [past(adult, now, { daysAgo: 1, session: recovery, pace: 3.5, grade: 2, bpmWork: 99, bpmEasy: 90, rest: 77 })],
    expect: { pace: 5.6, grade: 3.5 },
  },
  // 133 BPM, a 2 do teto de 135: a carga já acertou o alvo.
  {
    name: 'base-junto-do-teto-repete',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 5.6, grade: 2.5, bpmWork: 133, bpmEasy: 108, drop: 16 }),
    expect: { pace: 5.6, grade: 2.5 },
    exact: true,
  },
  // A última base terminou a 6 km/h, que a escada já não tem: mesmo com 133 BPM, junto do
  // teto, a carga não se repete. De 4,9 METs, o alvo vai a 5,0: vale a linha de 5,6 km/h e 2,5%.
  {
    name: 'base-acima-do-teto-da-caminhada',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 6, grade: 2, bpmWork: 133, bpmEasy: 108, drop: 16 }),
    expect: { pace: 5.6, grade: 2.5 },
  },
  // 126 BPM está na faixa, mas 9 abaixo do teto: a 15 bpm por MET, o alvo sobe de 4,9 para 5,5 METs.
  {
    name: 'base-na-faixa-sobe-ao-teto',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 5.6, grade: 2.5, bpmWork: 126, bpmEasy: 104, drop: 16 }),
    expect: { pace: 5.6, grade: 3.5 },
  },
  // Dois pontos (4,9 METs com 108 e 3,4 com 88): 13 bpm por MET, alvo de 6,9 METs.
  {
    name: 'base-abaixo-da-faixa-sobe',
    session: base,
    history: (now) => [
      ...steady(now, [2], { pace: 5.6, grade: 2.5, bpmWork: 108, bpmEasy: 92, drop: 15 }),
      ...steady(now, [5], { session: recovery, pace: 5, grade: 0, bpmWork: 88, bpmEasy: 82 }),
    ],
    expect: { pace: 5.6, grade: 6.5 },
  },
  // 5,8 METs deram 146 BPM, com repouso de 70: 15,8 bpm por MET, alvo de 5,1 METs.
  {
    name: 'base-acima-da-faixa-recua',
    session: base,
    history: (now) => steady(now, [2], { pace: 5.6, grade: 4.5, bpmWork: 146, bpmEasy: 118, drop: 12, rest: 85 }),
    expect: { pace: 5.6, grade: 3 },
  },
  // Primeiro VO₂máx, com pontos de base (4,9 METs, 126) e de recuperação (3,1 METs, 100): alvo de 8,0 METs.
  // A caminhada a 5,6 km/h para em 7,5 METs (rampa de 8%): entra a primeira linha de corrida.
  {
    name: 'vo2-primeira-vez',
    session: vo2,
    history: (now) => [
      ...steady(now, [1], { pace: 5.6, grade: 2.5, bpmWork: 126, bpmEasy: 104, drop: 16 }),
      ...steady(now, [2], { session: recovery, pace: 4.5, grade: 0, bpmWork: 100, bpmEasy: 92 }),
    ],
    expect: { pace: 7, grade: 1 },
  },
  {
    name: 'limiar-correndo-junto-do-teto',
    session: threshold,
    history: (now) => [
      ...steady(now, [1], { pace: 5.6, grade: 2.5, bpmWork: 126, bpmEasy: 104, drop: 16 }),
      ...steady(now, [7], { session: threshold, pace: 8.5, grade: 1, bpmWork: 160, bpmEasy: 120, drop: 24 }),
    ],
    expect: { pace: 8.5, grade: 1 },
    exact: true,
  },
  // Em recuperação a faixa é teto e o alvo fica no terço de baixo (96 BPM). 4,9 METs deram
  // 150 BPM, com repouso de 70: 20,5 bpm por MET. O alvo pede 2,3 METs, abaixo da carga mais
  // leve da escada: vale a primeira linha.
  {
    name: 'recuperacao-primeira-linha',
    session: recovery,
    history: (now) => steady(now, [1, 3], { pace: 5.6, grade: 2.5, bpmWork: 150, bpmEasy: 120, drop: 16, rest: 85 }),
    expect: { pace: 3, grade: 0 },
  },
];

const sameLoad = (a: { pace: number; grade: number }, b: { pace: number; grade: number }) =>
  Math.abs(a.pace - b.pace) < 0.05 && Math.abs(a.grade - b.grade) < 0.05;

/** A entrada de cada cenário de plano com a carga esperada, para os testes conferirem o gabarito. */
export const planChecks = (now: number) =>
  planCases.map((c) => ({
    name: c.name,
    data: planPrompt({ profile: adult, session: c.session, history: c.history(now), now }).user,
    expect: c.expect,
    exact: !!c.exact,
  }));

async function runPlan(c: PlanCase) {
  const now = Date.now();
  const prompt = planPrompt({ profile: adult, session: c.session, history: c.history(now), now });
  // A conferência com a conta do app já acontece em `parsePlan`, como no treino real.
  const choice = await callModel('plan', prompt, parsePlan(prompt.user), { journal: false });
  // Fora da repetição exata, a linha vizinha da escada também serve.
  const ladder = loadLadder();
  const at = ladder.findIndex((row) => sameLoad(row, c.expect));
  const near = at >= 0 && !c.exact && [ladder[at - 1], ladder[at + 1]].some((row) => row && sameLoad(row, choice));
  const ok = sameLoad(choice, c.expect) || near;
  return {
    answer: choice.pace + ' km/h | ' + choice.grade + '%',
    detail: (ok ? '' : 'esperado ' + c.expect.pace + ' km/h e ' + c.expect.grade + '%. ') + choice.why,
    ok,
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

const older: Profile = { age: 50, weightKg: 80, heightCm: 172 };
const fine = (now: number, profile: Profile, days: number[], bpm: number[], extra: Omit<Past, 'daysAgo'> = {}) =>
  days.map((daysAgo, k) =>
    past(profile, now, { bpmWork: bpm[k], bpmEasy: 104, drop: 15, level: 'Base em formação', maxBpm: 180, ...extra, daysAgo }),
  );

const assessCases: AssessCase[] = [
  {
    name: 'primeira-sessao',
    profile: adult,
    session: { bpmWork: 125, bpmEasy: 104, drop: 14 },
    history: () => [],
    levels: ['Em adaptação'],
    max: [177, 183],
  },
  {
    name: 'base-em-formacao',
    profile: adult,
    session: { bpmWork: 126, bpmEasy: 104, drop: 14 },
    history: (now, p) => fine(now, p, [2, 5, 8], [127, 127, 128], { level: 'Em adaptação', drop: 14 }),
    levels: ['Base em formação'],
    max: [177, 183],
  },
  {
    name: 'base-consistente',
    profile: adult,
    session: { bpmWork: 124, bpmEasy: 102, drop: 22 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12, 15], [127, 127, 128, 129, 130], { drop: 21 }),
    levels: ['Base consistente'],
    max: [177, 183],
  },
  {
    name: 'acima-da-faixa-com-reducoes',
    profile: adult,
    session: { grade: 4, bpmWork: 144, bpmEasy: 116, drop: 10, reductions: 2 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12], [127, 127, 128, 128]),
    levels: ['Em adaptação'],
    max: [177, 183],
  },
  // Tiros concluídos com pico de 176, acima da estimativa pela idade (172): a máxima é pico + 5.
  {
    name: 'pico-acima-da-estimativa',
    profile: older,
    session: { session: vo2, pace: 6, grade: 8, bpmWork: 176, bpmEasy: 150, drop: 12 },
    history: (now, p) => fine(now, p, [3, 6], [122, 124], { maxBpm: 172, level: 'Em adaptação' }),
    levels: ['Em adaptação'],
    max: [179, 183],
  },
  {
    // Hoje foi leve, mas há 5 dias a pessoa sustentou 177 bpm até o fim: o piso de 182 continua valendo.
    name: 'maxima-estavel-entre-sessoes',
    profile: adult,
    session: { bpmWork: 126, bpmEasy: 104, drop: 15 },
    history: (now, p) => [
      ...fine(now, p, [2], [127]),
      ...fine(now, p, [5], [177], { session: vo2, pace: 6.5, grade: 8, bpmEasy: 150, maxBpm: 182 }),
      ...fine(now, p, [8], [128]),
    ],
    levels: ['Base em formação'],
    max: [181, 183],
  },
  {
    name: 'sessao-interrompida-na-metade',
    profile: adult,
    session: { bpmWork: 127, bpmEasy: 104, drop: 15, completion: 0.5 },
    history: (now, p) => fine(now, p, [3, 6, 9, 12], [127, 127, 128, 128]),
    levels: ['Em adaptação'],
    max: [177, 183],
  },
  // Tiros na faixa de 90–95% são o planejado: intensidade alta não é sinal de adaptação.
  {
    name: 'tiros-na-faixa',
    profile: adult,
    session: { session: vo2, pace: 6, grade: 7, bpmWork: 165, bpmEasy: 132, drop: 26 },
    history: (now, p) => fine(now, p, [1, 3, 6], [127, 127, 128]),
    levels: ['Base em formação'],
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
