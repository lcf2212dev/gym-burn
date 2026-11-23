// Cenários fixos para medir a precisão da IA no próprio aparelho, com a chave
// salva. Cada cenário tem um desfecho aceito; a mesma entrada é enviada algumas
// vezes para medir também a concordância entre repetições.

import { callModel, type Kind } from './ai';
import {
  emptyLog,
  median,
  type HeartProfile,
  type MinuteBeats,
  type MinuteLoad,
  type Profile,
  type StageLog,
  type Workout,
} from './model';
import { dailyTarget, foxMax, loadLadder } from './physiology';
import { assessBounds, assessPrompt, parseAssess, parsePlan, planPrompt } from './prompts';
import { sessionPlan, sessions, type Session } from './week';

export type Outcome = {
  scenario: string;
  kind: Kind;
  run: number;
  ok: boolean;
  answer: string;
  detail?: string;
  called: boolean;
  ms: number;
  error?: string;
};

const DAY = 86400000;
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);

// As sessões do plano semanal usadas nos cenários.
const base = sessions.base;
const vo2 = sessions.vo2Long;
const recovery = sessions.recovery;
const threshold = sessions.threshold;

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
  /**
   * Como a carga andou no bloco de esforço de uma sessão contínua gravada
   * minuto a minuto: trechos seguidos, cada um com minutos, rampa e BPM.
   */
  ramp?: { minutes: number; grade: number; bpm: number }[];
};

function past(profile: Profile, now: number, p: Past): Workout {
  const plan = sessionPlan(p.session ?? base, p.pace ?? 5.2, p.grade ?? 3);
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
  // A carga e os batimentos minuto a minuto, como a sessão real grava.
  const loads: MinuteLoad[] = [];
  const beats: MinuteBeats[] = [];
  if (p.ramp) {
    const minute = (kmh: number, grade: number, bpm: number) => {
      loads.push([kmh * 60000, grade * 60000, 60000]);
      beats.push([bpm * 60, 60]);
    };
    const [warmup, work, ...rest] = plan.stages;
    for (let m = 0; m < warmup.seconds / 60; m++) minute(warmup.speed, 0, p.bpmEasy ?? 100);
    const steps = p.ramp.flatMap((r) => Array.from({ length: r.minutes }, () => r));
    for (let m = 0; m < work.seconds / 60; m++) {
      const at = steps[Math.min(m, steps.length - 1)];
      minute(work.speed, at.grade, at.bpm);
    }
    for (const stage of rest)
      for (let m = 0; m < stage.seconds / 60; m++) minute(stage.speed, 0, p.bpmEasy ?? 100);
  }
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
    ...(p.ramp ? { loads, beats } : {}),
  };
}

// 40 anos: FC máxima estimada de 180. Faixas: recuperação 90–108, base 117–135,
// limiar 153–162, VO₂máx 162–171. Fora da recuperação, o alvo é o teto da faixa.
const adult: Profile = { age: 40, weightKg: 78, heightCm: 175 };

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
  // Sem nenhum ponto: 1 + (135 − 70) ÷ 15 = 5,3 METs, que é 5,2 km/h a 4%.
  { name: 'base-sem-historico', session: base, history: () => [], expect: { pace: 5.2, grade: 4 } },
  // Um ponto só (3,5 km/h a 2% com 99 BPM) e repouso de 62: 16 bpm por MET, alvo de 5,5 METs.
  {
    name: 'base-um-ponto-com-repouso',
    session: base,
    history: (now) => [past(adult, now, { daysAgo: 1, session: recovery, pace: 3.5, grade: 2, bpmWork: 99, bpmEasy: 90, rest: 77 })],
    expect: { pace: 5.2, grade: 4.5 },
  },
  // 133 BPM, a 2 do teto de 135: a carga já acertou o alvo.
  {
    name: 'base-junto-do-teto-repete',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 5.2, grade: 3, bpmWork: 133, bpmEasy: 108, drop: 16 }),
    expect: { pace: 5.2, grade: 3 },
    exact: true,
  },
  // A última base terminou a 5,6 km/h, que a escada já não tem: mesmo com 133 BPM, junto do
  // teto, a carga não se repete. De 4,6 METs, o alvo vai a 4,7: vale a linha de 5,2 km/h e 2,5%.
  {
    name: 'base-acima-do-teto-da-caminhada',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 5.6, grade: 2, bpmWork: 133, bpmEasy: 108, drop: 16 }),
    expect: { pace: 5.2, grade: 2.5 },
  },
  // 126 BPM está na faixa, mas 9 abaixo do teto: a 15 bpm por MET, o alvo sobe de 4,8 para 5,4 METs.
  {
    name: 'base-na-faixa-sobe-ao-teto',
    session: base,
    history: (now) => steady(now, [2, 4, 7], { pace: 5.2, grade: 3, bpmWork: 126, bpmEasy: 104, drop: 16 }),
    expect: { pace: 5.2, grade: 4 },
  },
  // Dois pontos (4,8 METs com 108 e 3,4 com 88): 14 bpm por MET, alvo de 6,7 METs.
  {
    name: 'base-abaixo-da-faixa-sobe',
    session: base,
    history: (now) => [
      ...steady(now, [2], { pace: 5.2, grade: 3, bpmWork: 108, bpmEasy: 92, drop: 15 }),
      ...steady(now, [5], { session: recovery, pace: 5, grade: 0, bpmWork: 88, bpmEasy: 82 }),
    ],
    expect: { pace: 5.2, grade: 7 },
  },
  // 5,7 METs deram 146 BPM, com repouso de 70: 16,2 bpm por MET, alvo de 5,0 METs.
  {
    name: 'base-acima-da-faixa-recua',
    session: base,
    history: (now) => steady(now, [2], { pace: 5.2, grade: 5, bpmWork: 146, bpmEasy: 118, drop: 12, rest: 85 }),
    expect: { pace: 5.2, grade: 3.5 },
  },
  // Sessão contínua gravada minuto a minuto: a carga subiu de 2% para 3%, onde o BPM chegou ao
  // alvo (133), e desceu de volta a 2% com a FC subindo aos poucos. A partida de hoje é a
  // carga do primeiro patamar no alvo, 3%, e não a do fim da sessão.
  {
    name: 'base-patamar-no-alvo-repete',
    session: base,
    history: (now) =>
      steady(now, [2], {
        pace: 5.2,
        grade: 2,
        bpmWork: 131,
        bpmEasy: 104,
        drop: 15,
        ramp: [
          { minutes: 4, grade: 2, bpm: 126 },
          { minutes: 8, grade: 3, bpm: 133 },
          { minutes: 10, grade: 2.5, bpm: 134 },
          { minutes: 13, grade: 2, bpm: 133 },
        ],
      }),
    expect: { pace: 5.2, grade: 3 },
    exact: true,
  },
  // Primeiro VO₂máx, com pontos de base (4,8 METs, 126) e de recuperação (3,1 METs, 100): alvo de 7,7 METs.
  // A caminhada a 5,2 km/h para em 6,8 METs (rampa de 7,5%): entra a corrida, a 6,5 km/h.
  {
    name: 'vo2-primeira-vez',
    session: vo2,
    history: (now) => [
      ...steady(now, [1], { pace: 5.2, grade: 3, bpmWork: 126, bpmEasy: 104, drop: 16 }),
      ...steady(now, [2], { session: recovery, pace: 4.5, grade: 0, bpmWork: 100, bpmEasy: 92 }),
    ],
    expect: { pace: 6.5, grade: 1 },
  },
  {
    name: 'limiar-correndo-junto-do-teto',
    session: threshold,
    history: (now) => [
      ...steady(now, [1], { pace: 5.2, grade: 3, bpmWork: 126, bpmEasy: 104, drop: 16 }),
      ...steady(now, [7], { session: threshold, pace: 8.5, grade: 1, bpmWork: 160, bpmEasy: 120, drop: 24 }),
    ],
    expect: { pace: 8.5, grade: 1 },
    exact: true,
  },
  // Um limiar antigo correndo a 8,5 km/h e 3% deu 160 BPM, junto do teto de 162. Correndo a
  // rampa não passa de 2%, então a carga não se repete: de 10,2 METs o alvo vai a 10,3, e na
  // escada, que só tem corrida a 1%, isso é 9 km/h.
  {
    name: 'limiar-correndo-rampa-alta-recalcula',
    session: threshold,
    history: (now) => [
      ...steady(now, [1], { pace: 5.2, grade: 3, bpmWork: 126, bpmEasy: 104, drop: 16 }),
      ...steady(now, [7], { session: threshold, pace: 8.5, grade: 3, bpmWork: 160, bpmEasy: 120, drop: 24 }),
    ],
    expect: { pace: 9, grade: 1 },
  },
  // Em recuperação a faixa é teto e o alvo fica no terço de baixo (96 BPM). 4,8 METs deram
  // 150 BPM, com repouso de 70: 21 bpm por MET. O alvo pede 2,2 METs, abaixo da carga mais
  // leve da escada: vale a primeira linha.
  {
    name: 'recuperacao-primeira-linha',
    session: recovery,
    history: (now) => steady(now, [1, 3], { pace: 5.2, grade: 3, bpmWork: 150, bpmEasy: 120, drop: 16, rest: 85 }),
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
    session: { session: vo2, pace: 6.5, grade: 1, bpmWork: 176, bpmEasy: 150, drop: 12 },
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
      ...fine(now, p, [5], [177], { session: vo2, pace: 7, grade: 1, bpmEasy: 150, maxBpm: 182 }),
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
    session: { session: vo2, pace: 6.5, grade: 1, bpmWork: 165, bpmEasy: 132, drop: 26 },
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

export const scenarioCount = { plan: planCases.length, assess: assessCases.length };

export async function runScenarios(
  repeats: number,
  only: Kind | null,
  onResult: (done: Outcome[], total: number) => void,
) {
  type Result = { answer: string; detail?: string; called: boolean; ok?: boolean };
  const jobs: { scenario: string; kind: Kind; run: number; go: () => Promise<Result> }[] = [];
  for (let run = 1; run <= repeats; run++) {
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
          ok: !!r.ok,
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
  return (['plan', 'assess'] as const).flatMap((kind) => {
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
