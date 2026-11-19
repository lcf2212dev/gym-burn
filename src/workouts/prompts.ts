// Prompts enviados à DeepSeek e validação das respostas. Tudo aqui é função
// pura, sem Expo, para ser testado direto e usado pelos cenários de diagnóstico.
//
// Três regras valem para os três prompts: o modelo recebe números já
// calculados pelo app (não precisa comparar nem fazer conta), cada opção tem
// definição escrita, e o formato de saída é descrito por tipo, sem exemplo
// preenchido que puxe a resposta para um valor.

import { decisions, type Decision, type Features, type Load, type Reading } from './adaptive';
import {
  evidence,
  inRange,
  levels,
  MAX_INCLINE_PERCENT,
  MAX_SPEED_KMH,
  median,
  validSession,
  type Estimate,
  type Profile,
  type StageLog,
  type Workout,
  type Zone,
} from './model';
import {
  ageMax,
  dailyTarget,
  heartProfile,
  loadLadder,
  maxBounds,
  maxFloor,
  mets,
  observedPeak,
} from './physiology';
import { describe, sessionMinutes, zones, type Session } from './week';

export const PROMPT_VERSION = '4';
export type Prompt = { system: string; user: object };

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = <T>(items: T[], pick: (item: T) => number) => items.reduce((a, b) => a + pick(b), 0);
const list = (items: readonly string[]) => items.map((i) => `"${i}"`).join(', ');
// Alguns modelos devolvem número entre aspas ou com vírgula decimal.
const num = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN;
const position = (bpm: number, zone: Zone) =>
  bpm > zone.high ? 'acima' : bpm < zone.low ? 'abaixo' : 'na faixa';

function localTime(now: number) {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  const day = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getDay()];
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} (${day})`;
}

// --- Resumos das sessões ---------------------------------------------------

function group(w: Workout, indexes: number[]) {
  const logs = indexes.map((i) => w.log?.[i]).filter((l): l is StageLog => !!l && l.ms > 0);
  if (!logs.length) return null;
  const ms = sum(logs, (l) => l.ms);
  const inclineDuration = sum(logs, (l) => l.inclineDurationMs);
  const ends = logs.filter((l) => l.tail.length >= 3).map((l) => median(l.tail));
  // O último bloco guarda os alvos já corrigidos pela revisão durante o treino.
  const last = w.plan?.stages[indexes[indexes.length - 1]];
  const kmh = round1((sum(logs, (l) => l.distanceM) * 3600) / ms);
  const inclinePercent = inclineDuration
    ? round1(sum(logs, (l) => l.inclineMs) / inclineDuration)
    : null;
  return {
    seconds: Math.round(ms / 1000),
    kmh,
    inclinePercent,
    mets: mets(kmh, inclinePercent ?? 0),
    targetKmh: last?.speed ?? null,
    targetInclinePercent: last?.incline ?? null,
    bpmEnd: ends.length ? median(ends) : null,
    bpmReadings: sum(logs, (l) => l.bpmCount),
  };
}

/** Tudo o que foi medido numa sessão, no formato que os prompts recebem. */
export function summarize(w: Workout) {
  const base = evidence(w);
  const zone = dailyTarget(w.plan, w.profile, w.hr);
  const stages = w.plan?.stages ?? [];
  const logs = w.log ?? [];
  const done = logs.map((_, i) => i).filter((i) => (logs[i]?.ms ?? 0) > 0);
  // No treino livre não há etapas: o registro único conta como bloco principal.
  const work = w.plan ? done.filter((i) => stages[i] && !stages[i].measure) : done;
  const easy = w.plan ? done.filter((i) => stages[i]?.measure) : [];
  // A faixa é a dos blocos de esforço: só as leituras deles entram na conta.
  const counts = [0, 1, 2].map((k) => sum(work, (i) => logs[i]?.zone[k] ?? 0));
  const total = counts[0] + counts[1] + counts[2];
  const drops: number[] = [];
  for (const i of easy) {
    const before = logs[i - 1];
    if (i > 0 && !stages[i - 1].measure && before?.tail.length >= 3 && logs[i].early.length >= 2)
      drops.push(median(before.tail) - median(logs[i].early));
  }
  const changes = w.changes ?? [];
  return {
    ...base,
    objective: zone.objective,
    completionPercent: w.plan
      ? Math.min(100, Math.round((100 * base.movingSeconds) / (w.plan.minutes * 60)))
      : null,
    bpmCoveragePercent: base.movingSeconds
      ? Math.min(100, Math.round((100 * base.bpmReadings) / base.movingSeconds))
      : 0,
    zone: { low: zone.low, high: zone.high },
    zoneSharePercent: total
      ? {
          below: Math.round((100 * counts[0]) / total),
          inside: Math.round((100 * counts[1]) / total),
          above: Math.round((100 * counts[2]) / total),
        }
      : null,
    work: group(w, work),
    easy: group(w, easy),
    recoveryDrops: drops.slice(0, 6),
    reductions: changes.filter((c) => c.decision.startsWith('reduzir')).length,
    increases: changes.filter((c) => c.decision.startsWith('aumentar')).length,
    restBpm: w.restBpm ?? null,
    validatedPeakBpm: observedPeak([w]),
  };
}

function stageList(w: Workout) {
  const rows = (w.plan?.stages ?? []).flatMap((stage, i) => {
    const s = group(w, [i]);
    return s
      ? [{ name: stage.name, kind: stage.measure ? 'leve' : 'principal', ...s }]
      : [];
  });
  // Uma lista longa de blocos iguais só dilui o que importa: o resumo basta.
  return rows.length && rows.length <= 14 ? rows : undefined;
}

/** Uma sessão anterior em poucas linhas. `now` é o instante de referência de `daysAgo`. */
export function historyItem(w: Workout, now: number) {
  const s = summarize(w);
  // Registros anteriores à 2.1 não têm dados por etapa: sobram as médias da sessão.
  const work = s.work ?? {
    kmh: s.averageKmh,
    inclinePercent: s.averageIncline,
    mets: s.averageKmh === null ? null : mets(s.averageKmh, s.averageIncline ?? 0),
    targetKmh: null,
    targetInclinePercent: null,
    bpmEnd: s.averageBpm,
  };
  return {
    daysAgo: Math.max(0, Math.floor((now - w.started) / 86400000)),
    goal: s.goal,
    plannedMinutes: s.plannedMinutes,
    movingMinutes: Math.round(s.movingSeconds / 60),
    completionPercent: s.completionPercent,
    work: {
      kmh: work.kmh,
      inclinePercent: work.inclinePercent,
      mets: work.mets,
      targetKmh: work.targetKmh,
      targetInclinePercent: work.targetInclinePercent,
      bpmEnd: work.bpmEnd,
    },
    zone: s.zone,
    position: work.bpmEnd === null ? null : position(work.bpmEnd, s.zone),
    recoveryDrops: s.recoveryDrops,
    reductions: s.reductions,
    increases: s.increases,
    restBpm: s.restBpm,
    level: w.estimate?.level ?? null,
    endedBy: s.endedBy,
    ...(s.work ? {} : { approximate: true }),
  };
}

/** As 5 sessões válidas mais recentes. Fragmentos de segundos ficam de fora. */
export const recentValid = (history: Workout[]) => history.filter(validSession).slice(0, 5);

// --- Plano do dia ----------------------------------------------------------

const PLAN = `Você escolhe a carga (velocidade e inclinação) dos blocos de esforço do treino de esteira de hoje. A sessão do dia, a estrutura e a faixa de frequência cardíaca vêm do plano semanal da pessoa e não mudam: sua tarefa é achar a carga que leva o BPM do fim dos blocos de esforço para dentro da faixa. A esteira é ajustada à mão no painel pela própria pessoa; o app só orienta, lê os batimentos a cada 3 minutos e corrige a carga durante o treino.

ENTRADA (json)
- today: data e hora locais.
- profile: age (anos).
- hr: restBpm (FC de repouso estimada: a menor leitura do primeiro minuto dos últimos treinos, menos 15 bpm porque a pessoa já está andando; null se nunca medida), maxBpm (FC máxima estimada) e maxSource ("idade" = 220 − idade; "IA" = previsão das avaliações anteriores).
- session: a sessão de hoje. goal (nome), structure (aquecimento, blocos de esforço e trechos leves), minutes, zone (objective = nome da intensidade; low e high = faixa de BPM dos blocos de esforço) e aimBpm (o BPM a buscar no fim dos blocos de esforço: o terço de baixo da faixa).
- recent: sessões válidas mais recentes, da mais nova para a mais antiga. Cada uma traz daysAgo (0 = menos de 24 h), goal, plannedMinutes, movingMinutes, completionPercent, work (carga dos blocos de esforço: kmh e inclinePercent realmente feitos, mets = custo metabólico dessa carga, targetKmh e targetInclinePercent = alvos em que o último bloco terminou, e bpmEnd = BPM no fim dos blocos; bpmEnd null = sem leitura), zone e position (bpmEnd em relação à faixa daquela sessão), recoveryDrops, reductions e increases (ajustes de carga pedidos pelo app durante a sessão), restBpm, level e endedBy. approximate = true marca registros antigos em que work traz médias da sessão inteira.
- loads: as cargas possíveis hoje, da mais leve à mais pesada, cada uma com pace (km/h), grade (%) e mets. mets é o custo metabólico (1 MET = repouso) pelas equações do ACSM: de caminhada abaixo de 7 km/h e de corrida a partir de 7 km/h.

COMO ESCOLHER
A frequência cardíaca sobe quase em linha reta com os METs. Siga os passos na ordem.
1. Sessões que contam: as de recent com work.bpmEnd diferente de null. As que têm approximate = true só contam se não houver nenhuma outra. Referência: a mais recente das que contam com o mesmo goal de session; se não houver, a mais recente das que contam, qualquer que seja o goal.
2. Se a referência tem o mesmo goal de session e o bpmEnd dela está entre session.zone.low e session.zone.high, repita a carga em que ela terminou: pace = work.targetKmh e grade = work.targetInclinePercent. A escolha termina aqui.
3. Inclinação da reta, em bpm por MET:
- pegue, entre as sessões que contam, a de menor work.mets e a de maior work.mets; se os mets delas diferem em 1,0 ou mais, use (diferença de bpmEnd) ÷ (diferença de mets) entre as duas;
- senão, se hr.restBpm não é null, use (bpmEnd da referência − hr.restBpm) ÷ (mets da referência − 1);
- senão, use 15.
Se o resultado ficar abaixo de 8 ou acima de 25, use 15.
4. METs alvo = mets da referência + (session.aimBpm − bpmEnd da referência) ÷ inclinação da reta. Sem nenhuma sessão que conte, METs alvo = 1 + (session.aimBpm − repouso) ÷ 15, com repouso = hr.restBpm, ou 70 se for null.
5. Escolha em loads a linha de maior mets que não passa dos METs alvo. Se todas passam, escolha a primeira linha.

SAÍDA
Responda somente com um objeto json, neste formato:
{"why": "<frase>", "pace": <número>, "grade": <número>}
- why: uma frase em português do Brasil, com até 160 caracteres, para a pessoa que vai treinar: de que sessão anterior a escolha partiu, o BPM em que ela terminou e o BPM buscado hoje. Escreva em linguagem comum, sem nomes de campos da entrada (nada de "bpmEnd", "mets" ou "aimBpm"). Sem promessa de emagrecimento ou de saúde.
- pace: de 1 a ${MAX_SPEED_KMH}, em km/h, com uma casa decimal. grade: de 0 a ${MAX_INCLINE_PERCENT}, em %, múltiplo de 0,5. Fora do passo 2, use exatamente os valores de uma linha de loads.`;

export type PlanInput = { profile: Profile; session: Session; history: Workout[]; now: number };

function planData({ profile, session, history, now }: PlanInput) {
  const hr = heartProfile(profile, history);
  const [low, high] = zones[session.objective].map((percent) =>
    Math.round((hr.max * percent) / 100),
  );
  return {
    today: localTime(now),
    profile: { age: profile.age },
    hr: { restBpm: hr.rest, maxBpm: hr.max, maxSource: hr.maxSource },
    session: {
      goal: session.goal,
      structure: describe(session),
      minutes: sessionMinutes(session),
      zone: { objective: session.objective, low, high },
      aimBpm: low + Math.round((high - low) / 3),
    },
    recent: recentValid(history).map((w) => historyItem(w, now)),
    loads: loadLadder(),
  };
}
export type PlanData = ReturnType<typeof planData>;

export function planPrompt(input: PlanInput) {
  return { system: PLAN, user: planData(input) };
}

/**
 * O procedimento do prompt do plano, passo a passo, em código. É a conta que a
 * IA deve fazer: serve para conferir a resposta dela e de gabarito dos cenários.
 * `repeat` indica que a carga é a repetição da sessão anterior (passo 2).
 */
export function planProcedure({ session, hr, recent, loads }: PlanData) {
  const measured = recent.flatMap((r) =>
    r.work.bpmEnd === null || r.work.mets === null
      ? []
      : [{ ...r, mets: r.work.mets, bpm: r.work.bpmEnd, rough: 'approximate' in r }],
  );
  const counted = measured.some((r) => !r.rough) ? measured.filter((r) => !r.rough) : measured;
  const reference = counted.find((r) => r.goal === session.goal) ?? counted[0];
  if (!reference) {
    const target = 1 + (session.aimBpm - (hr.restBpm ?? 70)) / 15;
    return { ...pick(loads, target), repeat: false };
  }
  const { targetKmh, targetInclinePercent } = reference.work;
  if (
    reference.goal === session.goal &&
    inRange(reference.bpm, session.zone.low, session.zone.high) &&
    targetKmh !== null &&
    targetInclinePercent !== null
  )
    return { pace: targetKmh, grade: targetInclinePercent, repeat: true };
  const byCost = [...counted].sort((a, b) => a.mets - b.mets);
  const [lightest, heaviest] = [byCost[0], byCost[byCost.length - 1]];
  let slope = 15;
  if (heaviest.mets - lightest.mets >= 1)
    slope = (heaviest.bpm - lightest.bpm) / (heaviest.mets - lightest.mets);
  else if (hr.restBpm !== null) slope = (reference.bpm - hr.restBpm) / (reference.mets - 1);
  if (!inRange(slope, 8, 25)) slope = 15;
  return { ...pick(loads, reference.mets + (session.aimBpm - reference.bpm) / slope), repeat: false };
}

/** A linha de maior custo que não passa do alvo; se todas passam, a primeira. */
function pick(loads: PlanData['loads'], target: number) {
  const fits = loads.filter((row) => row.mets <= target);
  const { pace, grade } = fits[fits.length - 1] ?? loads[0];
  return { pace, grade };
}

export type PlanChoice = { why: string; pace: number; grade: number };

type LoadChoice = { pace: number; grade: number };
const sameLoad = (a: LoadChoice, b: LoadChoice) =>
  Math.abs(a.pace - b.pace) < 0.05 && Math.abs(a.grade - b.grade) < 0.05;

/**
 * Valida a resposta do plano e confere a carga com a conta do app. Vale a
 * linha calculada ou uma vizinha da escada (a diferença de um arredondamento no
 * meio da conta); a repetição da sessão anterior tem de ser exata. Fora disso a
 * resposta é recusada e a chamada, repetida: sem teto de carga, é essa
 * conferência que segura um erro de conta da IA.
 */
export const parsePlan =
  (data: PlanData) =>
  (raw: unknown): PlanChoice => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const choice = {
      why: typeof r.why === 'string' ? r.why.trim().slice(0, 240) : '',
      pace: num(r.pace),
      grade: num(r.grade),
    };
    if (!inRange(choice.pace, 1, MAX_SPEED_KMH) || !inRange(choice.grade, 0, MAX_INCLINE_PERCENT))
      throw new Error('A IA retornou alvos fora da faixa do guia.');
    const want = planProcedure(data);
    const at = data.loads.findIndex((row) => sameLoad(row, want));
    const near =
      !want.repeat &&
      at >= 0 &&
      [data.loads[at - 1], data.loads[at + 1]].some((row) => row && sameLoad(row, choice));
    if (!sameLoad(choice, want) && !near)
      throw new Error('A IA não fechou a conta da carga de hoje. Tente novamente.');
    return choice;
  };

// --- Revisão durante o treino ----------------------------------------------

const REVIEW = `Você acompanha um treino de esteira em andamento e decide se a carga da etapa atual deve mudar agora. A sessão segue o plano semanal da pessoa: os blocos de esforço têm uma faixa de frequência cardíaca a cumprir. A pessoa ajusta a esteira à mão no painel: cada mudança que você pedir interrompe o treino com um aviso sonoro. Peça mudança só quando os dados sustentam.

ENTRADA (json)
- zone: objective (nome da intensidade), low e high em BPM. É a faixa dos blocos de esforço, calculada sobre a FC máxima estimada: uma estimativa com erro de vários bpm, não um limiar medido.
- stage: name, kind ("principal" = bloco de esforço; "leve" = aquecimento, recuperação ou volta à calma), targetKmh, targetInclinePercent, secondsInStage, secondsRemaining, targetsReached (a esteira está nos dois alvos), secondsAtLoad (há quanto tempo está neles; 0 se não está) e laterBlocks (blocos de esforço que ainda virão depois deste; um ajuste feito agora vale também para eles).
- bpm: resumo das leituras válidas do sensor de mão. count, spanSeconds, median, latest, min, max, trend ("subindo", "estável" ou "caindo": compara a segunda metade das leituras com a primeira e só acusa mudança de 2 bpm ou mais), changeBpm (essa diferença), position (mediana em relação à faixa: "acima", "na faixa" ou "abaixo") e marginBpm (distância da mediana até a borda da faixa).
- readings: as mesmas leituras, da mais antiga para a mais nova, com secondsAgo, bpm, kmh e inclinePercent medidos.
- session: goal (sessão do plano semanal), plannedMinutes, elapsedSeconds, restBpm (FC do primeiro minuto de hoje, ou null) e changes (ajustes de carga já aplicados hoje, com secondsAgo, decision e o bpm que os motivou).
- profile: age.
- allowed: as decisões que o app aceita neste momento. Além de "manter" vem no máximo uma mudança: entre velocidade e inclinação, o app já escolheu a que cabe nesta carga.

EFEITO DE CADA DECISÃO
- "manter": nada muda.
- "reduzir velocidade": alvo de velocidade −0,3 km/h. "reduzir inclinação": alvo de inclinação −0,5%.
- "aumentar velocidade": alvo de velocidade +0,2 km/h. "aumentar inclinação": alvo de inclinação +0,5%.

COMO DECIDIR
A frequência cardíaca leva de 2 a 3 minutos para se estabilizar depois de uma mudança de carga, e leituras de sensor de mão oscilam 1 ou 2 bpm sem que isso seja tendência.
1. Com position "acima", siga a primeira regra que servir:
- Mantenha se session.changes tem uma redução com secondsAgo < 120: o efeito dela ainda não apareceu.
- Em etapa "leve" com secondsInStage < 120, BPM acima da faixa é a recuperação normal depois do esforço: mantenha, a menos que trend seja "subindo" e marginBpm ≥ 10.
- Reduza se marginBpm ≥ 10.
- Reduza se marginBpm ≥ 5 e trend não é "caindo".
- Nos demais casos (marginBpm ≤ 4, ou trend "caindo"), mantenha.
2. Com position "abaixo" (o app só oferece aumento em bloco de esforço com os alvos atingidos há 120 s ou mais), siga a primeira regra que servir:
- Mantenha se session.changes tem um aumento com secondsAgo < 180 ou se trend é "subindo": a FC ainda está respondendo.
- Mantenha se secondsRemaining ≤ 120 e laterBlocks = 0: não há tempo para o ajuste fazer efeito.
- Aumente se marginBpm ≥ 5.
- Nos demais casos, mantenha.
"Reduza" e "aumente" querem dizer a mudança que estiver em allowed.

SAÍDA
Responda somente com um objeto json, neste formato:
{"reason": "<motivo>", "decision": "<decisão>"}
- reason: até 12 palavras em português do Brasil, citando o dado decisivo.
- decision: exatamente uma das opções de allowed.`;

export type ReviewInput = {
  workout: Workout;
  /** Índice da etapa atual e segundos que faltam nela. */
  index: number;
  left: number;
  load: Load;
  readings: Reading[];
  features: Features;
  allowed: Decision[];
  now: number;
};

export function reviewPrompt(i: ReviewInput): Prompt {
  const w = i.workout;
  const { stage } = i.load;
  const zone = dailyTarget(w.plan, w.profile, w.hr);
  const elapsed = Math.round(w.totals.movingMs / 1000);
  const f = i.features;
  return {
    system: REVIEW,
    user: {
      zone,
      stage: {
        name: stage.name,
        kind: stage.measure ? 'leve' : 'principal',
        targetKmh: stage.speed,
        targetInclinePercent: stage.incline,
        secondsInStage: stage.seconds - i.left,
        secondsRemaining: i.left,
        targetsReached: i.load.reached,
        secondsAtLoad: Math.round(i.load.secondsAtLoad),
        laterBlocks: (w.plan?.stages ?? []).slice(i.index + 1).filter((s) => !s.measure).length,
      },
      bpm: {
        count: f.count,
        spanSeconds: f.spanSeconds,
        median: f.median,
        latest: f.latest,
        min: f.min,
        max: f.max,
        trend: f.trend,
        changeBpm: f.change,
        position: f.position,
        marginBpm: f.margin,
      },
      readings: i.readings.map((r) => ({
        secondsAgo: Math.max(0, Math.round((i.now - r.at) / 1000)),
        bpm: r.bpm,
        kmh: r.kmh,
        inclinePercent: r.incline,
      })),
      session: {
        goal: w.plan?.goal ?? 'Livre',
        plannedMinutes: w.plan?.minutes ?? null,
        elapsedSeconds: elapsed,
        restBpm: w.restBpm ?? null,
        changes: (w.changes ?? []).map((c) => ({
          secondsAgo: Math.max(0, elapsed - c.second),
          decision: c.decision,
          bpm: c.bpm,
        })),
      },
      profile: { age: w.profile.age },
      allowed: i.allowed,
    },
  };
}

export const parseReview = (allowed: Decision[]) => (raw: unknown) => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const decision = r.decision as Decision;
  if (!decisions.includes(decision) || !allowed.includes(decision))
    throw new Error('Resposta de ajuste inválida.');
  return { decision, reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 120) : '' };
};

// --- Avaliação ao fim do treino --------------------------------------------

const ASSESS = `Você avalia uma sessão de esteira já encerrada a partir das medições do app. As sessões guiadas seguem o plano semanal da pessoa, em que cada sessão tem uma faixa de frequência cardíaca a cumprir nos blocos de esforço. Devolve o nível de condicionamento observado, um resumo curto e uma previsão da frequência cardíaca máxima da pessoa.

ENTRADA (json)
- profile: age.
- session: a sessão avaliada.
  - goal (sessão do plano semanal; "Livre" = sem plano), objective (nome da intensidade), plannedMinutes, movingSeconds, completionPercent (null no treino livre), distanceMeters, averageKmh, averageIncline, endedBy (como terminou).
  - bpmReadings (leituras válidas do sensor de mão, cerca de uma por segundo de contato), bpmCoveragePercent, averageBpm, peakBpm (maior leitura isolada) e validatedPeakBpm (maior mediana de 3 leituras seguidas).
  - zone: low e high, a faixa de BPM dos blocos de esforço. zoneSharePercent: parcela das leituras dos blocos de esforço below, inside e above dessa faixa.
  - work e easy: resumo dos blocos de esforço e dos blocos leves (aquecimento, recuperações e volta à calma). Cada um traz seconds, kmh e inclinePercent realizados, mets (custo metabólico dessa carga; 1 MET = repouso), targetKmh e targetInclinePercent (alvos em que o último bloco terminou), bpmEnd (mediana das últimas leituras dos blocos, o valor mais próximo do BPM estabilizado) e bpmReadings. null quando não houve o bloco.
  - stages: o mesmo por etapa, quando a lista é curta.
  - recoveryDrops: queda em bpm entre o fim de um bloco de esforço e cerca de 1 minuto de recuperação.
  - reductions e increases: ajustes de carga pedidos pelo app durante a sessão, para trazer o BPM à faixa.
  - restBpm: FC lida no primeiro minuto de hoje. Fica de 10 a 20 bpm acima do repouso real.
- recent: sessões válidas anteriores, da mais nova para a mais antiga, resumidas: daysAgo (em relação a esta sessão), goal, completionPercent, work (kmh, inclinePercent, mets, bpmEnd), zone, position (bpmEnd em relação à faixa daquela sessão), recoveryDrops, reductions, increases, restBpm e level. approximate = true marca registros antigos em que work traz médias da sessão inteira.
- heart: os dois números que decidem a FC máxima, já calculados pelo app. ageEstimateBpm é a estimativa pela idade (média de 220 − idade e 208 − 0,7 × idade). floorBpm é o piso medido: o maior pico validado de todas as sessões, esta incluída, com 5 bpm a mais quando o pico é de uma sessão concluída sem reductions (quem seguiu até o fim depois do pico não estava no máximo); null se não há pico validado.

NÍVEL (level)
Aplique na ordem. Vale o primeiro critério atendido.
1. "Em adaptação" se ocorrer qualquer um destes:
- recent tem menos de 2 sessões (ainda não há base para comparar);
- reductions ≥ 1;
- sessão guiada com completionPercent < 70;
- work.bpmEnd passa de zone.high em 5 bpm ou mais;
- zoneSharePercent.above ≥ 40.
2. "Base consistente" se ocorrerem todos estes:
- recent tem 4 ou mais sessões com daysAgo ≤ 21;
- a sessão foi concluída (completionPercent ≥ 90, ou treino livre com movingSeconds ≥ 1200) sem reductions;
- work.bpmEnd dentro ou abaixo da faixa;
- há sinal de eficiência em relação à sessão mais recente de recent com o mesmo goal: work.mets igual (diferença de até 0,3) com bpmEnd igual ou menor, com tolerância de 3 bpm, ou work.mets maior com bpmEnd dentro da faixa;
- se houver recoveryDrops, a mediana é ≥ 20.
3. "Base em formação" nos demais casos.
Sem work.bpmEnd (nenhuma leitura nos blocos de esforço), julgue por averageBpm, diga isso no resumo e não passe de "Base em formação".
Nunca use "${levels[0]}": o app trata esse caso sem consultar você.

RESUMO (summary)
Uma ou duas frases em português do Brasil, com até 300 caracteres, citando números medidos: carga dos blocos de esforço, BPM, faixa, recuperação. Sem diagnóstico, sem VO2max, sem conselho médico e sem promessa.

FC MÁXIMA (maxBpm)
A FC máxima é uma característica da pessoa e não muda de uma sessão para outra. Treino submáximo não a mede: só confirma um piso.
- maxBpm é o maior entre heart.ageEstimateBpm e heart.floorBpm. Com floorBpm null, é heart.ageEstimateBpm.
- Não ajuste esse valor por nenhum outro dado da entrada. BPM alto em carga leve indica pouco condicionamento, e BPM baixo em carga alta indica bom condicionamento; nenhum dos dois muda a FC máxima.

SAÍDA
Responda somente com um objeto json, neste formato:
{"level": "<nível>", "summary": "<resumo>", "maxBpm": <inteiro>}
- level: um de ${list(levels.slice(1))}.`;

export type AssessInput = { workout: Workout; history: Workout[] };

/** Limites da FC máxima para esta sessão, dado o piso medido até aqui. */
export function assessBounds({ workout, history }: AssessInput) {
  return maxBounds(workout.profile.age, maxFloor([workout, ...history]));
}

export function assessPrompt({ workout: w, history }: AssessInput): Prompt {
  return {
    system: ASSESS,
    user: {
      profile: { age: w.profile.age },
      session: { ...summarize(w), stages: stageList(w) },
      // A previsão anterior da FC máxima não vai: ela sai da idade e dos picos
      // medidos. Ancorada na resposta passada, um erro se repetiria para sempre.
      recent: recentValid(history).map((h) => historyItem(h, w.started)),
      heart: { ageEstimateBpm: ageMax(w.profile.age), floorBpm: maxFloor([w, ...history]) },
    },
  };
}

export const parseAssess =
  (bounds: Zone) =>
  (raw: unknown): Estimate => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const maxBpm = Math.round(num(r.maxBpm));
    if (
      !levels.slice(1).includes(r.level as (typeof levels)[number]) ||
      !summary ||
      summary.length > 1000 ||
      !Number.isFinite(maxBpm)
    )
      throw new Error('Avaliação incompleta. Tente novamente.');
    return {
      level: r.level as string,
      summary,
      // A previsão fica presa aos limites: uma resposta ruim não desloca a faixa.
      maxBpm: Math.min(bounds.high, Math.max(bounds.low, maxBpm)),
    };
  };
