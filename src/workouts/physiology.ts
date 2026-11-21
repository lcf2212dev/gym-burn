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
  type HeartProfile,
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

/** Maior pico validado (mediana de 3 leituras seguidas) entre as sessões. */
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
 * carga errada.
 */
export function forcedReductions(w: Workout) {
  const { high } = dailyTarget(w.plan, w.profile, w.hr);
  return (w.changes ?? []).filter(
    (c) => c.decision.startsWith('reduzir') && c.bpm >= high + FORCED_REDUCTION_BPM,
  ).length;
}

/** Sessão levada até o fim (90% do plano, ou 20 min de treino livre) sem redução forçada de carga. */
function sustained(w: Workout) {
  const finished = w.totals.movingMs >= (w.plan ? w.plan.minutes * 54000 : 1200000);
  return finished && !forcedReductions(w);
}

/** Quanto a FC máxima fica, no mínimo, acima do pico de uma sessão sustentada. */
const SUSTAINED_MARGIN_BPM = 5;

/**
 * Piso medido da FC máxima: o maior pico validado entre as sessões. Quando o
 * pico é de uma sessão sustentada, a pessoa seguiu andando depois dele, então
 * não estava no máximo: o piso fica 5 bpm acima.
 */
export function maxFloor(sessions: Workout[]) {
  const held = observedPeak(sessions.filter(sustained));
  const floor = Math.max(observedPeak(sessions) ?? 0, held === null ? 0 : held + SUSTAINED_MARGIN_BPM);
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
 * do ACSM: caminhada abaixo de 7 km/h, corrida a partir daí. A frequência
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
 * caminhada plana até 5,6 km/h, depois rampa a 5,6 km/h até 8%, depois corrida
 * a 1%. É o caminho que não pede corrida de quem ainda chega à faixa andando:
 * nenhuma linha fica entre o teto da caminhada e o começo da corrida.
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
