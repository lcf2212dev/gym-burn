// Prompts enviados à DeepSeek e validação das respostas. Tudo aqui é função
// pura, sem Expo, para ser testado direto e usado pelos cenários de diagnóstico.
//
// Três regras valem para os dois prompts: o modelo recebe números já
// calculados pelo app (não precisa comparar nem fazer conta), cada opção tem
// definição escrita, e o formato de saída é descrito por tipo, sem exemplo
// preenchido que puxe a resposta para um valor.
//
// Durante o treino a IA não é consultada: o ajuste da carga é conta do app
// (`adaptive.ts`), feita na hora e sem depender de internet.

import {
  acsm,
  evidence,
  inRange,
  levels,
  MAX_INCLINE_PERCENT,
  MAX_SPEED_KMH,
  median,
  RUN_FROM_KMH,
  RUN_MAX_INCLINE_PERCENT,
  validLoad,
  validSession,
  WALK_TOP_KMH,
  type Estimate,
  type Profile,
  type StageLog,
  type Workout,
  type Zone,
} from './model';
import {
  aimBand,
  ageMax,
  dailyTarget,
  FORCED_REDUCTION_BPM,
  forcedReductions,
  heartProfile,
  loadLadder,
  maxBounds,
  maxFloor,
  mets,
  observedPeak,
} from './physiology';
import { describe, sessionMinutes, zones, type Session } from './week';

export const PROMPT_VERSION = '7';
export type Prompt = { system: string; user: object };

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = <T>(items: T[], pick: (item: T) => number) => items.reduce((a, b) => a + pick(b), 0);
const list = (items: readonly string[]) => items.map((i) => `"${i}"`).join(', ');
/** Número com vírgula decimal, como os prompts escrevem. */
const br = (n: number) => String(n).replace('.', ',');
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
  // O último bloco guarda os alvos já corrigidos pelos ajustes feitos durante o treino.
  const last = w.plan?.stages[indexes[indexes.length - 1]];
  const kmh = round1((sum(logs, (l) => l.distanceM) * 3600) / ms);
  const inclinePercent = inclineDuration
    ? round1(sum(logs, (l) => l.inclineMs) / inclineDuration)
    : null;
  // Corrida é o que foi planejado e feito de 6 km/h em diante. Um registro
  // antigo de caminhada apertada, com alvo abaixo disso e a lona a 6 km/h,
  // continua sendo caminhada: pela equação de corrida ele custaria 50% a mais.
  const running = kmh >= RUN_FROM_KMH && (!last || last.speed >= RUN_FROM_KMH);
  return {
    seconds: Math.round(ms / 1000),
    kmh,
    inclinePercent,
    mets: round1(acsm(kmh, inclinePercent ?? 0, running)),
    targetKmh: last?.speed ?? null,
    targetInclinePercent: last?.incline ?? null,
    bpmEnd: ends.length ? median(ends) : null,
    bpmReadings: sum(logs, (l) => l.bpmCount),
  };
}

/** Um trecho de minutos seguidos na mesma carga, dentro de um bloco de esforço. */
export type Plateau = {
  /** Minuto do bloco de esforço em que o patamar começou. */
  fromMinute: number;
  minutes: number;
  kmh: number;
  inclinePercent: number;
  mets: number;
  /**
   * BPM típico do patamar: a mediana dos minutos em que a FC já responde à
   * carga, sem o primeiro do patamar e sem os 3 primeiros do bloco.
   */
  bpm: number;
};

/** Um minuto com menos de meio minuto de lona andando não diz qual era a carga. */
const MINUTE_MIN_MS = 30000;
/** Nos primeiros minutos do bloco a FC ainda vem subindo do trecho leve anterior. */
const BLOCK_SETTLE_MINUTES = 3;
/** Patamares de uma sessão que vão para o prompt. */
const PLATEAU_LIMIT = 8;

/**
 * Os patamares dos blocos de esforço: minutos seguidos em que a carga medida
 * (0,1 km/h e 0,5%) foi a mesma, com 2 minutos ou mais e leitura de BPM em
 * algum minuto em que a FC já responde à carga. Sai da carga e dos batimentos
 * gravados minuto a minuto; lista vazia nos
 * registros mais antigos, que não têm a carga por minuto.
 */
export function plateaus(w: Workout): Plateau[] {
  const loads = w.loads ?? [];
  const beats = w.beats ?? [];
  if (!w.plan || !loads.length) return [];
  const found: Plateau[] = [];
  let start = 0;
  for (const stage of w.plan.stages) {
    const end = start + stage.seconds;
    // Só os minutos inteiros do bloco: os das bordas misturam duas etapas.
    const first = Math.ceil(start / 60);
    const last = Math.floor(end / 60);
    start = end;
    if (stage.measure) continue;
    let open: { from: number; kmh: number; incline: number; bpm: (number | null)[] } | null = null;
    const close = () => {
      const from = open?.from ?? 0;
      const settled = (open?.bpm ?? []).filter(
        (b, i): b is number => b !== null && i >= 1 && from + i >= BLOCK_SETTLE_MINUTES,
      );
      if (open && open.bpm.length >= 2 && settled.length)
        found.push({
          fromMinute: open.from,
          minutes: open.bpm.length,
          kmh: open.kmh,
          inclinePercent: open.incline,
          mets: mets(open.kmh, open.incline),
          bpm: median(settled),
        });
      open = null;
    };
    for (let minute = first; minute < last; minute++) {
      const [kmhMs, inclineMs, ms] = loads[minute] ?? [0, 0, 0];
      if (ms < MINUTE_MIN_MS) {
        close();
        continue;
      }
      const kmh = round1(kmhMs / ms);
      const incline = Math.round((2 * inclineMs) / ms) / 2;
      const [total, count] = beats[minute] ?? [0, 0];
      if (open && (open.kmh !== kmh || open.incline !== incline)) close();
      open ??= { from: minute - first, kmh, incline, bpm: [] };
      open.bpm.push(count ? Math.round(total / count) : null);
    }
    close();
  }
  return found;
}

/**
 * Duração mínima de um patamar de referência. Uma carga alta demais cai em
 * poucos minutos, quando o BPM passa do teto: valem os patamares de 5 minutos
 * ou mais e, só se não houver nenhum, os de 3.
 */
const REFERENCE_MINUTES = [5, 3];

/**
 * O patamar de referência de uma sessão contínua: o primeiro patamar longo em
 * que o BPM ficou no alvo da sessão; se nenhum ficou, o que chegou mais perto.
 * É a carga que serve de partida para a sessão seguinte. A carga em que a
 * sessão termina não serve: num bloco longo a FC sobe aos poucos na mesma
 * carga, e o fim do bloco pede menos carga que o começo.
 */
function referencePlateau(w: Workout, zone: Zone & { objective: string }, found: Plateau[]) {
  if (!w.plan || w.plan.stages.filter((s) => !s.measure).length !== 1) return null;
  const held = REFERENCE_MINUTES.map((minutes) => found.filter((p) => p.minutes >= minutes)).find(
    (list) => list.length,
  );
  if (!held) return null;
  const aim = aimBand(zone, zone.objective);
  const miss = (p: Plateau) => Math.abs(p.bpm - aim.bpm);
  return (
    held.find((p) => inRange(p.bpm, aim.low, aim.high)) ??
    held.reduce((best, p) => (miss(p) < miss(best) ? p : best))
  );
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
  const found = plateaus(w);
  const measured = group(w, work);
  const reference = referencePlateau(w, zone, found);
  return {
    ...base,
    bpmSource: (w.totals.strapCount ?? 0) * 2 > w.totals.bpmCount ? 'cinta' : 'sensor de mão',
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
    // Numa sessão contínua gravada minuto a minuto, a carga e o BPM dos blocos
    // de esforço são os do patamar de referência, não a média do bloco.
    work:
      measured && reference
        ? {
            ...measured,
            kmh: reference.kmh,
            inclinePercent: reference.inclinePercent,
            mets: reference.mets,
            targetKmh: reference.kmh,
            targetInclinePercent: reference.inclinePercent,
            bpmEnd: reference.bpm,
            reference: { fromMinute: reference.fromMinute, minutes: reference.minutes },
          }
        : measured,
    easy: group(w, easy),
    plateaus: found.length ? found.slice(0, PLATEAU_LIMIT) : undefined,
    recoveryDrops: drops.slice(0, 6),
    reductions: forcedReductions(w),
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
      ...('reference' in work ? { reference: work.reference } : {}),
    },
    plateaus: s.plateaus,
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

/** As 6 sessões válidas mais recentes. Fragmentos de segundos ficam de fora. */
export const recentValid = (history: Workout[]) => history.filter(validSession).slice(0, 6);

// --- Plano do dia ----------------------------------------------------------

const PLAN = `Você escolhe a carga (velocidade e inclinação) dos blocos de esforço do treino de esteira de hoje. A sessão do dia, a estrutura e a faixa de frequência cardíaca vêm do plano semanal da pessoa e não mudam: sua tarefa é achar a carga que leva o BPM do fim dos blocos de esforço para o alvo da sessão. Nas sessões de esforço o alvo é o alto da faixa: a pessoa quer treinar o mais perto possível do teto, sem passar dele. Na recuperação ativa a faixa é um teto a não passar, e o alvo fica na parte de baixo dela. A pessoa caminha até ${br(WALK_TOP_KMH)} km/h e só corre a partir de ${RUN_FROM_KMH} km/h: entre esses dois valores não existe carga válida. Correndo, a rampa não passa de ${RUN_MAX_INCLINE_PERCENT}%. A esteira é ajustada à mão no painel pela própria pessoa; o app só orienta. Ele acompanha os batimentos (o tempo todo com a cinta no peito, ou a cada 3 minutos pelo sensor de mão da esteira) e ajusta a carga durante o treino: sobe aos poucos até o alto da faixa e alivia quando o BPM passa do teto. Num bloco longo a frequência cardíaca sobe aos poucos na mesma carga, e por isso o fim do bloco pede menos carga que o começo: a carga que você escolhe é a de partida.

ENTRADA (json)
- today: data e hora locais.
- profile: age (anos).
- hr: restBpm (FC de repouso estimada: a menor leitura do primeiro minuto dos últimos treinos, menos 15 bpm porque a pessoa já está andando; null se nunca medida), maxBpm (FC máxima estimada) e maxSource ("idade" = 220 − idade; "IA" = previsão das avaliações anteriores).
- session: a sessão de hoje. goal (nome), structure (aquecimento, blocos de esforço e trechos leves), minutes, zone (objective = nome da intensidade; low e high = faixa de BPM dos blocos de esforço) e aim (o alvo dentro da faixa: bpm = o BPM a buscar no fim dos blocos de esforço; low e high = o trecho da faixa em que a carga de uma sessão anterior já acertou o alvo).
- recent: até 6 sessões válidas mais recentes, da mais nova para a mais antiga. Cada uma traz daysAgo (0 = menos de 24 h), goal, plannedMinutes, movingMinutes, completionPercent, work, plateaus, zone e position (work.bpmEnd em relação à faixa daquela sessão), recoveryDrops, reductions (reduções de carga feitas pelo app com o BPM ${FORCED_REDUCTION_BPM} ou mais acima do teto da faixa; os alívios menores, de rotina para quem treina junto do teto, não contam), increases (aumentos de carga durante a sessão), restBpm, level e endedBy. approximate = true marca registros antigos em que work traz médias da sessão inteira.
- work, em cada sessão de recent: a carga de referência dos blocos de esforço. kmh e inclinePercent realmente feitos, mets = custo metabólico dessa carga, targetKmh e targetInclinePercent = a carga a repetir, e bpmEnd = o BPM que essa carga deu (null = sem leitura). Quando work traz reference, a sessão foi contínua e gravada minuto a minuto, e o app já escolheu em plateaus o patamar de referência: o primeiro patamar longo (5 minutos ou mais; sem nenhum assim, 3) em que o BPM ficou no alvo daquela sessão ou, se nenhum ficou, o que chegou mais perto. reference.fromMinute é o minuto do bloco em que ele começou e reference.minutes, quanto durou. Sem reference, work é o conjunto dos blocos de esforço: carga média, alvos em que o último bloco terminou e BPM do fim dos blocos.
- plateaus, em cada sessão de recent (só nas gravadas minuto a minuto): os trechos de 2 minutos ou mais na mesma carga dentro dos blocos de esforço, na ordem em que aconteceram. Cada um traz fromMinute (minuto do bloco em que começou), minutes, kmh, inclinePercent, mets e bpm (BPM típico do trecho). Mostram como a carga e o BPM andaram na sessão. A conta abaixo usa só work, que já resume esses trechos: não refaça a escolha do patamar.
- loads: as cargas possíveis hoje, da mais leve à mais pesada, cada uma com pace (km/h), grade (%) e mets. mets é o custo metabólico (1 MET = repouso) pelas equações do ACSM: de caminhada abaixo de ${RUN_FROM_KMH} km/h e de corrida a partir de ${RUN_FROM_KMH} km/h. Nenhuma linha fica acima de ${br(WALK_TOP_KMH)} e abaixo de ${RUN_FROM_KMH} km/h, e as de corrida têm rampa de 1%.

COMO ESCOLHER
A frequência cardíaca sobe quase em linha reta com os METs. Siga os passos na ordem.
1. Sessões que contam: as de recent com work.bpmEnd diferente de null. As que têm approximate = true só contam se não houver nenhuma outra. Referência: a mais recente das que contam com o mesmo goal de session; se não houver, a mais recente das que contam, qualquer que seja o goal.
2. Se a referência tem o mesmo goal de session, o bpmEnd dela está entre session.aim.low e session.aim.high e a carga de work é válida, repita essa carga: pace = work.targetKmh e grade = work.targetInclinePercent. A escolha termina aqui. A carga de work é válida quando work.targetKmh é de até ${br(WALK_TOP_KMH)} (caminhada, com qualquer rampa), ou quando work.targetKmh é de ${RUN_FROM_KMH} em diante e work.targetInclinePercent é de até ${RUN_MAX_INCLINE_PERCENT} (corrida). Com work.targetKmh acima de ${br(WALK_TOP_KMH)} e abaixo de ${RUN_FROM_KMH}, ou de ${RUN_FROM_KMH} em diante com work.targetInclinePercent acima de ${RUN_MAX_INCLINE_PERCENT}, a carga da referência não pode ser repetida: siga para o passo 3.
3. Inclinação da reta, em bpm por MET:
- pegue, entre as sessões que contam, a de menor work.mets e a de maior work.mets; se os mets delas diferem em 1,0 ou mais, use (diferença de bpmEnd) ÷ (diferença de mets) entre as duas;
- senão, se hr.restBpm não é null, use (bpmEnd da referência − hr.restBpm) ÷ (mets da referência − 1);
- senão, use 15.
Se o resultado ficar abaixo de 8 ou acima de 25, use 15.
4. METs alvo = mets da referência + (session.aim.bpm − bpmEnd da referência) ÷ inclinação da reta. Sem nenhuma sessão que conte, METs alvo = 1 + (session.aim.bpm − repouso) ÷ 15, com repouso = hr.restBpm, ou 70 se for null.
5. Escolha em loads a linha de maior mets que não passa dos METs alvo. Se todas passam, escolha a primeira linha.

SAÍDA
Responda somente com um objeto json, neste formato:
{"why": "<frase>", "pace": <número>, "grade": <número>}
- why: uma frase em português do Brasil, com até 160 caracteres, para a pessoa que vai treinar: de que sessão anterior a escolha partiu, o BPM que a carga dela deu e o BPM buscado hoje. Escreva em linguagem comum, sem nomes de campos da entrada (nada de "bpmEnd", "mets", "aim" ou "plateaus"). Sem promessa de emagrecimento ou de saúde.
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
      aim: aimBand({ low, high }, session.objective),
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
    const target = 1 + (session.aim.bpm - (hr.restBpm ?? 70)) / 15;
    return { ...pick(loads, target), repeat: false };
  }
  const { targetKmh, targetInclinePercent } = reference.work;
  if (
    reference.goal === session.goal &&
    inRange(reference.bpm, session.aim.low, session.aim.high) &&
    targetKmh !== null &&
    targetInclinePercent !== null &&
    // Uma sessão antiga pode ter terminado numa carga que o guia já não pede.
    validLoad(targetKmh, targetInclinePercent)
  )
    return { pace: targetKmh, grade: targetInclinePercent, repeat: true };
  const byCost = [...counted].sort((a, b) => a.mets - b.mets);
  const [lightest, heaviest] = [byCost[0], byCost[byCost.length - 1]];
  let slope = 15;
  if (heaviest.mets - lightest.mets >= 1)
    slope = (heaviest.bpm - lightest.bpm) / (heaviest.mets - lightest.mets);
  else if (hr.restBpm !== null) slope = (reference.bpm - hr.restBpm) / (reference.mets - 1);
  if (!inRange(slope, 8, 25)) slope = 15;
  return { ...pick(loads, reference.mets + (session.aim.bpm - reference.bpm) / slope), repeat: false };
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

// --- Avaliação ao fim do treino --------------------------------------------

const ASSESS = `Você avalia uma sessão de esteira já encerrada a partir das medições do app. As sessões guiadas seguem o plano semanal da pessoa, em que cada sessão tem uma faixa de frequência cardíaca a cumprir nos blocos de esforço. Devolve o nível de condicionamento observado, um resumo curto e uma previsão da frequência cardíaca máxima da pessoa.

ENTRADA (json)
- profile: age.
- session: a sessão avaliada.
  - goal (sessão do plano semanal; "Livre" = sem plano), objective (nome da intensidade), plannedMinutes, movingSeconds, completionPercent (null no treino livre), distanceMeters, averageKmh, averageIncline, endedBy (como terminou).
  - bpmSource ("cinta" = cinta no peito, que lê o tempo todo; "sensor de mão" = sensor da esteira, que só lê enquanto a pessoa o segura), bpmReadings (leituras válidas, cerca de uma por segundo de leitura), bpmCoveragePercent, averageBpm, peakBpm (maior leitura isolada) e validatedPeakBpm (maior mediana de 3 leituras seguidas).
  - zone: low e high, a faixa de BPM dos blocos de esforço. zoneSharePercent: parcela das leituras dos blocos de esforço below, inside e above dessa faixa.
  - work e easy: resumo dos blocos de esforço e dos blocos leves (aquecimento, recuperações e volta à calma). Cada um traz seconds, kmh e inclinePercent realizados, mets (custo metabólico dessa carga; 1 MET = repouso), targetKmh e targetInclinePercent (alvos em que o último bloco terminou), bpmEnd (mediana das últimas leituras dos blocos, o valor mais próximo do BPM estabilizado) e bpmReadings. null quando não houve o bloco. Quando work traz reference, a sessão foi contínua e gravada minuto a minuto, e kmh, inclinePercent, mets, os alvos e bpmEnd de work são os do patamar de referência: o primeiro trecho longo (5 minutos ou mais; sem nenhum assim, 3) na mesma carga em que o BPM ficou no alvo da sessão (de 3 bpm abaixo do teto da faixa até ele; em recuperação, a faixa inteira) ou, se nenhum ficou, o que chegou mais perto. reference.fromMinute é o minuto do bloco em que ele começou e reference.minutes, quanto durou.
  - stages: o mesmo por etapa, quando a lista é curta. Aqui a carga é sempre a média da etapa e bpmEnd, o do fim dela.
  - plateaus (só nas sessões gravadas minuto a minuto): os trechos de 2 minutos ou mais na mesma carga dentro dos blocos de esforço, em ordem, com fromMinute (minuto do bloco em que começou), minutes, kmh, inclinePercent, mets e bpm (BPM típico do trecho). Num bloco longo é normal a carga subir no começo e descer mais adiante: a frequência cardíaca sobe aos poucos na mesma carga.
  - recoveryDrops: queda em bpm entre o fim de um bloco de esforço e cerca de 1 minuto de recuperação.
  - reductions: reduções de carga feitas pelo app com o BPM ${FORCED_REDUCTION_BPM} ou mais acima do teto da faixa. Os alívios menores, de rotina para quem treina junto do teto, não contam. increases: aumentos de carga durante a sessão.
  - restBpm: FC lida no primeiro minuto de hoje. Fica de 10 a 20 bpm acima do repouso real.
- recent: até 6 sessões válidas anteriores, da mais nova para a mais antiga, resumidas: daysAgo (em relação a esta sessão), goal, completionPercent, work (kmh, inclinePercent, mets, bpmEnd, com reference quando é o patamar de referência), plateaus, zone, position (bpmEnd em relação à faixa daquela sessão), recoveryDrops, reductions, increases, restBpm e level. approximate = true marca registros antigos em que work traz médias da sessão inteira.
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
Uma ou duas frases em português do Brasil, com até 300 caracteres, citando números medidos: carga dos blocos de esforço, BPM, faixa, recuperação. Com plateaus, pode dizer como a carga andou (por exemplo, em que carga o BPM chegou ao alto da faixa). Sem diagnóstico, sem VO2max, sem conselho médico e sem promessa.

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
