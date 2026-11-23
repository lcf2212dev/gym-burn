import {
  energyCost,
  HILL_TOP_PERCENT,
  inRange,
  MAX_SPEED_KMH,
  median,
  metabolicCost,
  RUN_FROM_KMH,
  validBpm,
  WALK_TOP_KMH,
  type Change,
  type HeartProfile,
  type StageLog,
  type Plan,
  type Profile,
  type Workout,
  type Zone,
} from './model';

export type Pulse = { at: number; bpm: number };

/** Duas leituras separadas por mais que isto pertencem a pegadas diferentes no sensor. */
export const CONTACT_GAP_MS = 3000;

export const foxMax = (age: number) => 220 - age;
export const tanakaMax = (age: number) => Math.round(208 - 0.7 * age);
/** FC máxima estimada só pela idade: a média das duas fórmulas. */
export const ageMax = (age: number) => Math.round((foxMax(age) + tanakaMax(age)) / 2);

/**
 * Limites aceitos para a FC máxima prevista pela IA. Caminhada submáxima não
 * mede a máxima: o erro típico de qualquer previsão é de ±10 bpm. O piso medido
 * (`maxFloor`) é o único dado duro, e a previsão nunca fica abaixo dele.
 */
export function maxBounds(age: number, floor: number | null) {
  const estimates = [foxMax(age), tanakaMax(age)];
  const low = Math.max(Math.min(...estimates) - 10, floor ?? 0);
  return { low, high: Math.max(Math.max(...estimates) + 10, low) };
}

/** Maior pico validado (mediana de 10 leituras seguidas da cinta, ou de 3 do sensor de mão) entre as sessões. */
export function observedPeak(history: Workout[]) {
  const top = Math.max(0, ...history.flatMap((w) => (w.log ?? []).map((l) => l?.top ?? 0)));
  return top || null;
}

/** Quantos bpm acima do teto da faixa fazem de um alívio uma redução forçada. */
export const FORCED_REDUCTION_BPM = 5;

/**
 * Reduções de carga que pesam na avaliação da sessão: as feitas com o BPM 5 ou
 * mais acima do teto da faixa. O app alivia a carga já com 1 bpm de excesso, e
 * para quem treina junto do teto esse alívio pequeno é rotina, não sinal de
 * carga errada. A decisão tomada na recuperação para o bloco seguinte (`by:
 * 'bloco'`) também não conta: ela não alivia ninguém no meio do esforço.
 */
export function forcedReductions(w: Workout) {
  const { high } = dailyTarget(w.plan, w.profile, w.hr);
  return (w.changes ?? []).filter(
    (c) => c.by !== 'bloco' && c.decision.startsWith('reduzir') && c.bpm >= high + FORCED_REDUCTION_BPM,
  ).length;
}

/** Sessão levada até o fim (90% do plano, ou 20 min de treino livre) sem redução forçada de carga. */
function sustained(w: Workout) {
  const finished = w.totals.movingMs >= (w.plan ? w.plan.minutes * 54000 : 1200000);
  return finished && !forcedReductions(w);
}

/** Quanto a FC máxima fica, no mínimo, acima do pico de uma sessão sustentada. */
const SUSTAINED_MARGIN_BPM = 5;
/** Um bloco de esforço com tanto da duração feita conta como concluído. */
const BLOCK_DONE_SHARE = 0.9;
/** Quanto tempo a pessoa tem de seguir no mesmo bloco depois do pico para ele contar como sustentado. */
const HELD_AFTER_PEAK_MS = 240_000;
/** Um alívio até tanto depois do pico diz que ele pesou: aí seguir no bloco não conta. */
const PEAK_RELIEF_SECONDS = 60;

/** O ajuste baixou a carga. O nome não basta: o aumento de uma corrida com rampa antiga baixa a rampa. */
function eased(c: Change) {
  if (c.from && c.to) return metabolicCost(...c.to) < metabolicCost(...c.from);
  return c.decision.startsWith('reduzir');
}

/**
 * Os picos validados de uma sessão em que a pessoa seguiu depois deles, só dos
 * blocos de esforço (no treino livre, o registro único): o pico do
 * aquecimento, de uma recuperação ou da volta à calma nunca leva folga. São
 * todos, se a sessão foi levada até o fim sem redução forçada; senão, os de
 * cada bloco depois do qual a pessoa concluiu outro bloco de esforço (90% da
 * duração ou mais, sem contar o tempo fora da lona), ou em que ela seguiu 4
 * min ou mais no mesmo bloco, na lona, sem alívio no minuto seguinte ao pico.
 * Esses valem mesmo com redução forçada na sessão: quem fez mais um tiro
 * depois de chegar a 179 não estava no máximo. O primeiro critério só precisa
 * da ordem das etapas (o pico é o da etapa em que aconteceu), e vale também
 * nos registros mais antigos; o segundo precisa de quando foi o pico.
 */
function heldPeaks(w: Workout): number[] {
  const logs = w.log ?? [];
  const stages = w.plan?.stages ?? [];
  const effort = (i: number) => (w.plan ? !!stages[i] && !stages[i].measure : i === 0);
  if (sustained(w)) return logs.flatMap((l, i) => (l?.top && effort(i) ? [l.top] : []));
  const starts = stages.map((_, i) => stages.slice(0, i).reduce((n, s) => n + s.seconds, 0));
  const onBelt = (l: StageLog | undefined) => (l?.ms ?? 0) - (l?.offBeltMs ?? 0);
  const done = (i: number) =>
    effort(i) && !!stages[i] && onBelt(logs[i]) >= stages[i].seconds * 1000 * BLOCK_DONE_SHARE;
  return logs.flatMap((l, i) => {
    if (!l?.top || !effort(i)) return [];
    if (stages.some((_, j) => j > i && done(j))) return [l.top];
    if (l.topAtMs === undefined) return [];
    // Não se sabe se o tempo fora da lona foi antes ou depois do pico: ele sai todo.
    if (onBelt(l) - l.topAtMs < HELD_AFTER_PEAK_MS) return [];
    const peak = (starts[i] ?? 0) + l.topAtMs / 1000;
    const relief = (w.changes ?? []).some(
      (c) => c.stage === i && c.by !== 'bloco' && eased(c) && c.second >= peak && c.second <= peak + PEAK_RELIEF_SECONDS,
    );
    return relief ? [] : [l.top];
  });
}

/**
 * Piso medido da FC máxima: o maior pico validado entre as sessões. Quando a
 * pessoa seguiu depois do pico (veja `heldPeaks`), ela não estava no máximo: o
 * piso fica 5 bpm acima dele, sem passar do limite alto das estimativas pela
 * idade (`maxBounds`, a maior delas + 10). A folga é uma suposição; o pico
 * observado em si é medida, e vale como piso mesmo acima desse limite.
 */
export function maxFloor(sessions: Workout[]) {
  const held = sessions.flatMap((w) =>
    heldPeaks(w).map((top) => Math.min(top + SUSTAINED_MARGIN_BPM, maxBounds(w.profile.age, null).high)),
  );
  const floor = Math.max(observedPeak(sessions) ?? 0, ...held);
  return floor || null;
}

/**
 * Leitura de repouso do dia. A esteira só lê batimentos com a lona andando,
 * então vale a leitura mais cedo possível: as primeiras do treino, sem as 2
 * iniciais de cada pegada (o sensor de mão ainda está estabilizando). Fica de
 * 10 a 20 bpm acima do repouso real; `heartProfile` desconta isso. `closed`
 * indica que a janela inicial acabou.
 */
export function restingBpm(readings: Pulse[], closed: boolean): number | null {
  const kept: number[] = [];
  let contact = 0;
  let last = -Infinity;
  for (const r of readings) {
    contact = r.at - last > CONTACT_GAP_MS ? 1 : contact + 1;
    last = r.at;
    if (contact > 2) kept.push(r.bpm);
  }
  if (kept.length >= 5) return median(kept.slice(0, 5));
  return closed && kept.length >= 4 ? median(kept) : null;
}

/**
 * Quanto a leitura do primeiro minuto fica acima do repouso real: a pessoa já
 * está em pé e andando devagar.
 */
export const WALKING_OFFSET_BPM = 15;

/**
 * Repouso e máxima em uso, a partir do histórico da mesma origem (mais novo
 * primeiro). O repouso é a menor das 5 últimas leituras de início de treino,
 * menos o desconto de quem já está andando; serve de ponto de partida para a
 * relação entre carga e frequência cardíaca. A máxima é a mediana das 3 últimas
 * previsões da IA, para uma resposta ruim não deslocar a faixa sozinha.
 */
export function heartProfile(profile: Profile, history: Workout[]): HeartProfile {
  const rests = history
    .map((w) => w.restBpm)
    .filter(validBpm)
    .slice(0, 5);
  const predicted = history
    .map((w) => w.estimate?.maxBpm)
    .filter(validBpm)
    .slice(0, 3);
  return {
    rest: rests.length ? Math.min(...rests) - WALKING_OFFSET_BPM : null,
    max: predicted.length ? median(predicted) : foxMax(profile.age),
    maxSource: predicted.length ? 'IA' : 'idade',
  };
}

// O plano semanal dá as faixas em % da FC máxima, e cada plano carrega a sua.
// Estas são as dos planos gravados antes dele, que só tinham o nome do objetivo.
const legacyBands: Record<string, [number, number]> = {
  'Recuperação leve': [50, 60],
  'Base aeróbica': [55, 65],
  'Resistência moderada': [60, 70],
};
/** Sem plano (treino livre) vale a base aeróbica do plano semanal. */
const FREE_ZONE: [number, number] = [65, 75];

function legacyObjective(plan: Plan) {
  const goal: string = plan.goal;
  return (
    plan.objective ??
    (goal === 'Recuperação ativa'
      ? 'Recuperação leve'
      : goal === 'Resistência'
        ? 'Resistência moderada'
        : 'Base aeróbica')
  );
}

/** Nome da faixa de intensidade do treino. */
export function planObjective(plan: Plan | null): string {
  return !plan ? 'Base aeróbica' : plan.zone ? (plan.objective ?? plan.goal) : legacyObjective(plan);
}

/** Faixa de BPM dos blocos de esforço: os percentuais do plano sobre a FC máxima em uso. */
export function dailyTarget(plan: Plan | null, profile: Profile, hr?: HeartProfile) {
  const max = hr?.max ?? foxMax(profile.age);
  const [low, high] =
    plan?.zone ?? (plan ? (legacyBands[legacyObjective(plan)] ?? legacyBands['Base aeróbica']) : FREE_ZONE);
  return {
    objective: planObjective(plan),
    low: Math.round((max * low) / 100),
    high: Math.round((max * high) / 100),
  };
}

/** Quantos bpm abaixo do teto da faixa ainda contam como estar no alvo. */
export const AIM_SPAN_BPM = 3;

/**
 * Onde o BPM dos blocos de esforço deve ficar dentro da faixa do dia. A pessoa
 * treina no alto da faixa: a conta do plano busca o teto (`bpm`), e de 3 bpm
 * abaixo dele até ele (`low` a `high`) a carga já está certa. Em dia de
 * recuperação a faixa é um teto a não passar: a conta busca o terço de baixo e
 * a faixa inteira serve.
 */
export function aimBand(zone: Zone, objective: string) {
  if (objective.startsWith('Recuperação'))
    return { bpm: zone.low + Math.round((zone.high - zone.low) / 3), low: zone.low, high: zone.high };
  return { bpm: zone.high, low: zone.high - AIM_SPAN_BPM, high: zone.high };
}

/**
 * Custo metabólico de uma carga, em METs com uma casa decimal, pelas equações
 * do ACSM: caminhada abaixo de 6 km/h, corrida a partir daí. A frequência
 * cardíaca sobe quase em linha reta com ele, o que permite comparar cargas
 * diferentes.
 */
export function mets(kmh: number, inclinePercent: number) {
  return Math.round(metabolicCost(kmh, inclinePercent) * 10) / 10;
}

/** bpm por MET quando não há FC de repouso para traçar a reta da pessoa. */
export const DEFAULT_BPM_PER_MET = 15;

/**
 * Inclinação da reta entre carga e frequência cardíaca, em bpm por MET, a
 * partir de uma leitura (`bpm` numa carga de `cost` METs) e da FC de repouso.
 * Fora de 8 a 25, ou sem repouso, vale 15: a mesma conta do plano do dia.
 */
export function bpmPerMet(bpm: number, cost: number, rest: number | null) {
  const slope = rest === null ? NaN : (bpm - rest) / (cost - 1);
  return inRange(slope, 8, 25) ? slope : DEFAULT_BPM_PER_MET;
}

/**
 * kcal por minuto a 1 MET, por kg de peso: 3,5 ml de oxigênio por kg por
 * minuto, a 5 kcal por litro.
 */
const KCAL_PER_MET_MINUTE_KG = 0.0175;

/**
 * Estimativa das kcal gastas na sessão: o custo metabólico da carga medida a
 * cada segundo (velocidade e inclinação) vezes o peso do perfil. É a conta do
 * painel da esteira, feita com o peso da pessoa, e inclui o gasto de repouso
 * do período. A frequência cardíaca não entra: com a carga medida, ela não
 * melhora a estimativa. `null` sem tempo em movimento.
 */
export function energyKcal(w: Workout) {
  const t = w.totals;
  if (!t.movingMs) return null;
  // Os registros mais antigos não têm a soma segundo a segundo: a conta sai da
  // carga média de cada etapa, ou da sessão inteira.
  const average = (p: { ms: number; distanceM: number; inclineMs: number; inclineDurationMs: number }) =>
    energyCost((p.distanceM * 3600) / p.ms, p.inclineDurationMs ? p.inclineMs / p.inclineDurationMs : 0) * p.ms;
  const logs = (w.log ?? []).filter((l) => l?.ms > 0);
  const metMs =
    t.metMs ??
    (logs.length ? logs.reduce((n, l) => n + average(l), 0) : average({ ...t, ms: t.movingMs }));
  return Math.round((metMs / 60000) * KCAL_PER_MET_MINUTE_KG * w.profile.weightKg);
}

/**
 * As cargas entre as quais a IA escolhe, da mais leve à mais pesada:
 * caminhada plana até 5,2 km/h, depois rampa a 5,2 km/h até 7,5%, depois
 * corrida a 1%, de 6 km/h em diante. É o caminho que não pede corrida de quem
 * ainda chega à faixa andando: nenhuma linha fica entre o teto da caminhada e
 * o começo da corrida.
 *
 * Limitação conhecida: essa ordem (rampa até 7,5%, depois corrida) vem das
 * equações do ACSM, e a de corrida superestima a corrida lenta. Para quem
 * corre devagar, correr a 6 km/h custa menos do que a escada supõe: nos dados
 * desta pessoa, 5,6 km/h com 3,6% andando e 6 km/h com 1% correndo terminam no
 * mesmo BPM, e 5,2 km/h com 7,5% pesa mais. Por isso um alívio nunca troca a
 * corrida pela rampa (`correctedStage`). Calibrar a troca entre caminhada e
 * corrida pelos dados da pessoa (agora há cadência) fica para depois.
 */
export function loadLadder() {
  const rows: { pace: number; grade: number; mets: number }[] = [];
  // Só entra a carga que custa mais que a anterior: assim cada METs tem uma linha só.
  const add = (pace: number, grade: number) => {
    const cost = mets(pace, grade);
    if (cost > (rows[rows.length - 1]?.mets ?? 0)) rows.push({ pace, grade, mets: cost });
  };
  for (let pace = 3; pace < WALK_TOP_KMH; pace += 0.5) add(pace, 0);
  for (let grade = 0; grade <= HILL_TOP_PERCENT; grade += 0.5) add(WALK_TOP_KMH, grade);
  for (let pace = RUN_FROM_KMH; pace <= MAX_SPEED_KMH; pace += 0.5) add(pace, 1);
  return rows;
}
