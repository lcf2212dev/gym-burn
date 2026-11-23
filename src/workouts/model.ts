import type { Objective } from './adaptive';
import type { SessionMode, TreadmillSample } from '@/treadmill/types';

/** As sessões do plano semanal. */
export const goals = ['Base aeróbica', 'VO₂máx', 'Recuperação ativa', 'Limiar'] as const;
export type Goal = (typeof goals)[number];
export type Profile = { age: number; weightKg: number; heightCm: number };

/**
 * O app não impõe teto de carga: os alvos só ficam dentro do que a esteira
 * alcança (Matrix T600X: 22 km/h e 15%).
 */
export const MAX_SPEED_KMH = 22;
export const MAX_INCLINE_PERCENT = 15;
// A escada de carga: a caminhada sobe pela velocidade até 5,2 km/h, depois pela
// inclinação até 7,5%, e a partir de 6 km/h a pessoa corre. De 5,3 a 5,9 km/h
// não existe alvo: é rápido demais para andar e lento demais para correr. A
// rampa da escada para em 7,5% porque dali a corrida a 6 km/h já custa mais.
export const WALK_TOP_KMH = 5.2;
export const HILL_TOP_PERCENT = 7.5;
export const RUN_FROM_KMH = 6;
/** Correndo, a rampa não passa disto: a carga da corrida muda pela velocidade. */
export const RUN_MAX_INCLINE_PERCENT = 2;

/**
 * Uma carga que o guia pode pedir: caminhada até 5,2 km/h com qualquer rampa,
 * ou corrida de 6 km/h em diante com até 2% de rampa.
 */
export const validLoad = (kmh: number, inclinePercent: number) =>
  kmh <= WALK_TOP_KMH || (kmh >= RUN_FROM_KMH && inclinePercent <= RUN_MAX_INCLINE_PERCENT);

/** METs de uma carga pelas equações do ACSM, de caminhada ou de corrida (1 MET é o repouso). */
export function acsm(kmh: number, inclinePercent: number, running: boolean) {
  const perMinute = (kmh * 1000) / 60;
  const grade = inclinePercent / 100;
  const oxygen = running
    ? 0.2 * perMinute + 0.9 * perMinute * grade + 3.5
    : 0.1 * perMinute + 1.8 * perMinute * grade + 3.5;
  return oxygen / 3.5;
}

/**
 * Custo metabólico de uma carga, em METs, como o plano o compara: caminhada
 * abaixo de 6 km/h, corrida a partir daí.
 */
export const metabolicCost = (kmh: number, inclinePercent: number) =>
  acsm(kmh, inclinePercent, kmh >= RUN_FROM_KMH);

/**
 * Custo metabólico para a conta de kcal. `running` é o passo medido pela
 * cadência da cinta (`stepGait`, em `gait.ts`): com ele vale a equação do que a
 * pessoa está fazendo, em qualquer velocidade (quem corre a 5,5 km/h gasta como
 * quem corre). Sem cadência vale a regra por velocidade, e entre 5,2 e 6 km/h,
 * onde a equação de caminhada subestima o passo apertado e a troca seca para a
 * de corrida quase dobraria o gasto de um décimo de km/h para o outro, o custo
 * vai de uma equação à outra em linha reta. Só serve para as kcal: a conta que
 * decide a carga é `metabolicCost`, sempre pela velocidade.
 */
export function energyCost(kmh: number, inclinePercent: number, running?: boolean | null) {
  if (running != null) return acsm(kmh, inclinePercent, running);
  if (kmh <= WALK_TOP_KMH || kmh >= RUN_FROM_KMH) return metabolicCost(kmh, inclinePercent);
  const share = (kmh - WALK_TOP_KMH) / (RUN_FROM_KMH - WALK_TOP_KMH);
  return (
    (1 - share) * acsm(WALK_TOP_KMH, inclinePercent, false) +
    share * acsm(RUN_FROM_KMH, inclinePercent, true)
  );
}

export type Stage = {
  name: string;
  speed: number;
  incline: number;
  seconds: number;
  measure: boolean;
};
export type Plan = {
  /** Nome da faixa de intensidade dos blocos de esforço. */
  objective?: Objective;
  /**
   * Faixa dos blocos de esforço, em % da FC máxima. Não existe nos planos
   * anteriores ao plano semanal, que usam as faixas antigas pelo nome.
   */
  zone?: [number, number];
  goal: Goal;
  minutes: number;
  stages: Stage[];
  /** Justificativa curta da IA para os alvos escolhidos. */
  why?: string;
};
export type Estimate = { level: string; summary: string; maxBpm?: number | null };
export type Totals = {
  movingMs: number;
  distanceM: number;
  inclineMs: number;
  inclineDurationMs: number;
  bpmCount: number;
  bpmSum: number;
  peakBpm: number;
  /** Quantas das leituras vieram da cinta no peito. Não existe nos registros mais antigos. */
  strapCount?: number;
  /**
   * Custo metabólico somado segundo a segundo, em METs × ms: a base da
   * estimativa de kcal. Não existe nos registros mais antigos.
   */
  metMs?: number;
  // Os três abaixo só existem com a cadência da XOSS X2 Pro.
  /** Cadência somada no tempo, em passos/min × ms, com a lona andando. */
  cadenceMs?: number;
  /** Os ms que entraram em `cadenceMs`. */
  cadenceDurationMs?: number;
  /** Passos estimados: a cadência vezes o tempo com a lona andando. */
  steps?: number;
};
/** FC de repouso e máxima usadas para calcular a faixa do treino. */
export type HeartProfile = { rest: number | null; max: number; maxSource: 'idade' | 'IA' };
export type Zone = { low: number; high: number };
/** O que foi medido em uma etapa do plano (ou no treino livre inteiro). */
export type StageLog = {
  ms: number;
  distanceM: number;
  inclineMs: number;
  inclineDurationMs: number;
  bpmCount: number;
  bpmSum: number;
  /** Leituras abaixo, dentro e acima da faixa do dia. */
  zone: [number, number, number];
  /** Últimas leituras da etapa: o BPM de fim de bloco sai da mediana delas. */
  tail: number[];
  /** Leituras entre 45 e 90 s da etapa: medem a queda na recuperação. */
  early: number[];
  /**
   * Maior mediana de leituras seguidas: um pico que não depende de uma leitura
   * solta. São 10 leituras com a cinta (3 s dela não seguram um surto de
   * artefato) e 3 com o sensor de mão, que lê em pegadas curtas.
   */
  top: number;
  /**
   * Quando o pico (`top`) aconteceu: os ms da etapa com a lona andando, no fim
   * das leituras que o validaram. Não existe nos registros mais antigos.
   */
  topAtMs?: number;
  /** Os ms em que a pessoa estava fora da lona (veja `gait.ts`); só aparece quando houve. */
  offBeltMs?: number;
  // Os quatro abaixo só existem com a cadência da XOSS X2 Pro.
  /** Cadência somada no tempo, em passos/min × ms. */
  cadenceMs?: number;
  cadenceDurationMs?: number;
  /** A primeira e a última cadência medidas na etapa, em passos/min. */
  cadenceFirst?: number;
  cadenceLast?: number;
};
/** Soma e quantidade das leituras de BPM de um minuto de treino em movimento. */
export type MinuteBeats = [sum: number, count: number];
/**
 * Carga medida num minuto de treino em movimento: a velocidade e a inclinação
 * somadas no tempo (km/h × ms e % × ms) e os ms que entraram na soma.
 */
export type MinuteLoad = [kmhMs: number, inclineMs: number, ms: number];
/**
 * Ajuste de carga aplicado durante o treino. `from` e `to` são os alvos de
 * antes e de depois, como [km/h, %]; não existem nos registros mais antigos.
 * `by` diz quem decidiu: a trava do aparelho (BPM do momento acima do teto), a
 * IA, a regra local do app ou, com `'bloco'`, a decisão tomada na recuperação
 * para o bloco seguinte (veja `intervals.ts`): aí `stage` é o bloco que ainda
 * vai começar e `bpm`, o BPM do fim do bloco anterior. Também não existe nos
 * registros mais antigos.
 */
export type Change = {
  second: number;
  stage: number;
  decision: string;
  bpm: number;
  from?: [number, number];
  to?: [number, number];
  by?: 'trava' | 'ia' | 'app' | 'bloco';
};
export type Workout = {
  id: string;
  started: number;
  source: SessionMode;
  profile: Profile;
  plan: Plan | null;
  totals: Totals;
  ended: number | null;
  reason: string;
  estimate: Estimate | null;
  // Os campos abaixo não existem nos registros anteriores à versão 2.1.
  /** FC lida no primeiro minuto e meio de lona em movimento. */
  restBpm?: number | null;
  hr?: HeartProfile;
  log?: StageLog[];
  changes?: Change[];
  /** As leituras de BPM minuto a minuto, para a linha do tempo do treino. */
  beats?: MinuteBeats[];
  /** A carga medida minuto a minuto, de onde saem os patamares da sessão. Os registros mais antigos não têm. */
  loads?: MinuteLoad[];
  /** Como a FC de repouso foi medida: com a lona parada ou já andando. */
  restSource?: 'parado' | 'andando';
  /**
   * A gravação do treino na memória da XOSS X2 Pro: quando o app a começou
   * (`recordedAt`), o arquivo FIT que casou com ela e quantos segundos da
   * trilha vieram dele.
   */
  strap?: { recordedAt?: number; file?: string; backfilledSeconds?: number };
};
export const levels = [
  'Dados insuficientes',
  'Em adaptação',
  'Base em formação',
  'Base consistente',
] as const;
export const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export const validBpm = (n: unknown): n is number => inRange(n, 25, 250);

export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function validProfile(p: Profile) {
  return (
    Number.isInteger(p.age) &&
    inRange(p.age, 1, 120) &&
    inRange(p.weightKg, 10, 500) &&
    inRange(p.heightCm, 50, 250)
  );
}

/** Minutos de cada parte da sessão: aquecimento, repetições de esforço com trecho leve, desaquecimento. */
export type Structure = {
  warmup: number;
  reps: number;
  work: number;
  recovery: number;
  cooldown: number;
};

// A estrutura vem do plano semanal; a IA escolhe só a carga dos blocos de
// esforço. Os trechos leves ficam em ritmo de caminhada, sem inclinação.
export function makePlan(goal: Goal, structure: Structure, pace: number, grade: number): Plan {
  const { warmup, reps, work, recovery, cooldown } = structure;
  if (
    !goals.includes(goal) ||
    !Number.isInteger(reps) ||
    !inRange(reps, 1, 30) ||
    !inRange(work, 0.5, 180) ||
    ![warmup, recovery, cooldown].every((minutes) => inRange(minutes, 0, 60)) ||
    !inRange(pace, 1, MAX_SPEED_KMH) ||
    !inRange(grade, 0, MAX_INCLINE_PERCENT)
  )
    throw new Error('A IA retornou alvos fora da faixa do guia.');
  const speed = Math.round(pace * 10) / 10;
  const incline = Math.round(grade * 2) / 2;
  const easy = Math.max(1, Math.min(speed, 4, Math.round(speed * 0.8 * 10) / 10));
  const stages: Stage[] = [];
  const add = (name: string, minutes: number, measure: boolean) => {
    const seconds = Math.round(minutes * 60);
    if (seconds > 0)
      stages.push({ name, speed: measure ? easy : speed, incline: measure ? 0 : incline, seconds, measure });
  };
  add('Aquecimento', warmup, true);
  for (let i = 0; i < reps; i++) {
    add(reps > 1 ? goal + ' ' + (i + 1) + '/' + reps : goal, work, false);
    add('Recuperação', recovery, true);
  }
  add('Volta à calma', cooldown, true);
  return { goal, minutes: stages.reduce((n, stage) => n + stage.seconds, 0) / 60, stages };
}

/** Por quanto tempo, no início do treino, uma leitura ainda conta como FC de repouso. */
export const REST_WINDOW_SECONDS = 90;
/** Tempo entre dois pedidos de leitura de BPM, do começo ao fim do treino. */
export const PULSE_INTERVAL_SECONDS = 180;

// O guia pede os batimentos num relógio fixo: um pedido a cada 3 minutos de
// lona andando (0:00, 3:00, 6:00…), em qualquer etapa e em qualquer
// velocidade. A troca de etapa não adia nem zera o pedido. O primeiro é a FC
// de repouso do dia e só vale enquanto a janela do repouso estiver aberta;
// sem resposta, ele caduca e o seguinte abre aos 3 minutos.
export function currentCue(plan: Plan, elapsed: number) {
  let start = 0;
  for (const [index, stage] of plan.stages.entries()) {
    const end = start + stage.seconds;
    if (elapsed < end) {
      const pulse = Math.floor(elapsed / PULSE_INTERVAL_SECONDS);
      return {
        index,
        stage,
        /** Segundos já feitos na etapa. */
        into: elapsed - start,
        left: end - elapsed,
        /** Número do pedido de leitura em vigor: muda a cada 3 minutos de treino. */
        pulse,
        /** O pedido de leitura está aberto neste segundo. */
        measure: pulse > 0 || elapsed < REST_WINDOW_SECONDS,
      };
    }
    start = end;
  }
  return null;
}

export function newWorkout(
  profile: Profile,
  source: SessionMode,
  plan: Plan | null,
  hr?: HeartProfile,
): Workout {
  const started = Date.now();
  return {
    id: String(started) + '-' + Math.random().toString(36).slice(2, 9),
    started,
    source,
    profile,
    plan,
    totals: {
      movingMs: 0,
      distanceM: 0,
      inclineMs: 0,
      inclineDurationMs: 0,
      bpmCount: 0,
      bpmSum: 0,
      peakBpm: 0,
      strapCount: 0,
      metMs: 0,
    },
    ended: null,
    reason: '',
    estimate: null,
    restBpm: null,
    hr,
    log: [],
    changes: [],
  };
}

// Só conta o intervalo entre duas amostras seguidas com a lona andando; uma
// lacuna do rádio maior que 5 s não vira tempo de treino.
function step(sample: TreadmillSample, previous: TreadmillSample | null) {
  const speed = sample.speedKmh;
  if (!speed || speed <= 0) return null;
  const gap = previous && previous.speedKmh && previous.speedKmh > 0 ? sample.at - previous.at : 0;
  return {
    speed,
    dt: gap > 0 && gap <= 5000 ? gap : 0,
    bpm: validBpm(sample.heartRateBpm) ? sample.heartRateBpm : null,
    strap: sample.heartRateSource === 'strap',
    cadence: inRange(sample.cadenceSpm, 0, 300) ? sample.cadenceSpm : null,
  };
}

/** Soma a cadência no tempo. Os campos só aparecem quando há cadência (ou já existiam). */
function cadenceTotals(
  t: { cadenceMs?: number; cadenceDurationMs?: number },
  cadence: number | null,
  dt: number,
) {
  if (cadence === null && t.cadenceMs === undefined) return null;
  return {
    cadenceMs: (t.cadenceMs ?? 0) + (cadence ?? 0) * dt,
    cadenceDurationMs: (t.cadenceDurationMs ?? 0) + (cadence === null ? 0 : dt),
  };
}

/** O passo da pessoa numa amostra, medido pela cinta (veja `gait.ts`). */
export type Footing = {
  /** Correndo pela cadência; sem ela (`null` ou ausente), as kcal saem da velocidade. */
  running?: boolean | null;
  /** A pessoa está fora da lona, com ela andando. */
  offBelt?: boolean;
};

/**
 * Soma a amostra aos totais do treino. `running` é o passo medido pela
 * cadência (veja `energyCost`); sem ele as kcal saem da velocidade. Fora da
 * lona (`offBelt`) o tempo e a distância da lona entram, mas o BPM não (é o
 * de quem está parado ao lado dela), e o gasto desses segundos é o de repouso,
 * 1 MET, e não o da carga.
 */
export function accumulate(
  t: Totals,
  sample: TreadmillSample,
  previous: TreadmillSample | null,
  { running, offBelt = false }: Footing = {},
): Totals {
  const s = step(sample, previous);
  if (!s) return t;
  const cadence = cadenceTotals(t, s.cadence, s.dt);
  const bpm = offBelt ? null : s.bpm;
  const cost = offBelt ? 1 : energyCost(s.speed, sample.inclinationPercent ?? 0, running);
  return {
    ...(cadence && { ...cadence, steps: (t.steps ?? 0) + ((s.cadence ?? 0) * s.dt) / 60000 }),
    movingMs: t.movingMs + s.dt,
    distanceM: t.distanceM + (s.speed * s.dt) / 3600,
    inclineMs: t.inclineMs + (sample.inclinationPercent ?? 0) * s.dt,
    inclineDurationMs: t.inclineDurationMs + (sample.inclinationPercent === null ? 0 : s.dt),
    bpmCount: t.bpmCount + (bpm === null ? 0 : 1),
    bpmSum: t.bpmSum + (bpm ?? 0),
    peakBpm: Math.max(t.peakBpm, bpm ?? 0),
    strapCount: (t.strapCount ?? 0) + (bpm !== null && s.strap ? 1 : 0),
    metMs: (t.metMs ?? 0) + cost * s.dt,
  };
}

export const emptyLog = (): StageLog => ({
  ms: 0,
  distanceM: 0,
  inclineMs: 0,
  inclineDurationMs: 0,
  bpmCount: 0,
  bpmSum: 0,
  zone: [0, 0, 0],
  tail: [],
  early: [],
  top: 0,
});

/** Leituras seguidas de que sai o pico validado: com a cinta e com o sensor de mão. */
const STRAP_PEAK_READINGS = 10;
const GRIP_PEAK_READINGS = 3;

/**
 * Acumula a amostra na etapa em curso. `into` são os segundos já feitos na
 * etapa. Com `offBelt` (a pessoa fora da lona, veja `gait.ts`) o tempo e a
 * carga entram, mas o BPM não: parada ao lado da lona a FC cai, e esse BPM
 * baixo puxaria para cima a carga do próximo plano.
 */
export function logStage(
  log: StageLog | undefined,
  sample: TreadmillSample,
  previous: TreadmillSample | null,
  zone: Zone,
  into: number,
  offBelt = false,
): StageLog {
  const l = log ?? emptyLog();
  const s = step(sample, previous);
  if (!s) return l;
  const cadence = cadenceTotals(l, s.cadence, s.dt);
  const next: StageLog = {
    ...l,
    ...(cadence && {
      ...cadence,
      cadenceFirst: l.cadenceFirst ?? s.cadence ?? undefined,
      cadenceLast: s.cadence ?? l.cadenceLast,
    }),
    ...(offBelt && { offBeltMs: (l.offBeltMs ?? 0) + s.dt }),
    ms: l.ms + s.dt,
    distanceM: l.distanceM + (s.speed * s.dt) / 3600,
    inclineMs: l.inclineMs + (sample.inclinationPercent ?? 0) * s.dt,
    inclineDurationMs: l.inclineDurationMs + (sample.inclinationPercent === null ? 0 : s.dt),
  };
  if (s.bpm === null || offBelt) return next;
  const tail = [...l.tail, s.bpm].slice(-10);
  const zoneCounts: StageLog['zone'] = [...l.zone];
  zoneCounts[s.bpm < zone.low ? 0 : s.bpm > zone.high ? 2 : 1]++;
  const run = s.strap ? STRAP_PEAK_READINGS : GRIP_PEAK_READINGS;
  const peak = tail.length >= run ? median(tail.slice(-run)) : 0;
  return {
    ...next,
    bpmCount: l.bpmCount + 1,
    bpmSum: l.bpmSum + s.bpm,
    zone: zoneCounts,
    tail,
    early: into >= 45 && into <= 90 && l.early.length < 10 ? [...l.early, s.bpm] : l.early,
    top: Math.max(l.top, peak),
    ...(peak > l.top && { topAtMs: next.ms }),
  };
}

/**
 * Soma a leitura de BPM desta amostra ao minuto em que o treino está.
 * `elapsed` são os segundos já feitos em movimento. Fora da lona (`offBelt`)
 * a leitura não entra: é dos minutos que saem os patamares do próximo plano.
 */
export function logBeats(
  beats: MinuteBeats[] | undefined,
  sample: TreadmillSample,
  previous: TreadmillSample | null,
  elapsed: number,
  offBelt = false,
): MinuteBeats[] {
  const bpm = offBelt ? null : (step(sample, previous)?.bpm ?? null);
  if (bpm === null) return beats ?? [];
  const minute = Math.floor(elapsed / 60);
  // Os minutos sem leitura ficam zerados: uma lista com buracos não sobrevive ao banco.
  return Array.from({ length: Math.max(beats?.length ?? 0, minute + 1) }, (_, i): MinuteBeats => {
    const [sum, count] = beats?.[i] ?? [0, 0];
    return i === minute ? [sum + bpm, count + 1] : [sum, count];
  });
}

/**
 * Soma a carga medida nesta amostra ao minuto em que o treino está. `elapsed`
 * são os segundos já feitos em movimento.
 */
export function logLoads(
  loads: MinuteLoad[] | undefined,
  sample: TreadmillSample,
  previous: TreadmillSample | null,
  elapsed: number,
): MinuteLoad[] {
  const s = step(sample, previous);
  if (!s || !s.dt) return loads ?? [];
  const minute = Math.floor(elapsed / 60);
  const incline = sample.inclinationPercent ?? 0;
  return Array.from({ length: Math.max(loads?.length ?? 0, minute + 1) }, (_, i): MinuteLoad => {
    const [kmhMs, inclineMs, ms] = loads?.[i] ?? [0, 0, 0];
    // Somas inteiras: o registro é gravado a cada 10 s e não precisa de 15 casas.
    return i === minute
      ? [Math.round(kmhMs + s.speed * s.dt), Math.round(inclineMs + incline * s.dt), ms + s.dt]
      : [kmhMs, inclineMs, ms];
  });
}

/** Sessão longa o bastante para entrar no histórico enviado à IA. */
export const validSession = (w: Workout) => w.totals.movingMs >= 180000;
/** Sem 3 minutos de movimento ou 10 leituras não há o que avaliar. */
export const insufficient = (w: Workout) => !validSession(w) || w.totals.bpmCount < 10;

export function evidence(w: Workout) {
  const t = w.totals;
  return {
    date: new Date(w.started).toISOString(),
    goal: w.plan?.goal ?? 'Livre',
    plannedMinutes: w.plan?.minutes ?? null,
    movingSeconds: Math.round(t.movingMs / 1000),
    distanceMeters: Math.round(t.distanceM),
    averageKmh: t.movingMs ? Math.round((t.distanceM * 36000) / t.movingMs) / 10 : null,
    averageIncline: t.inclineDurationMs
      ? Math.round((10 * t.inclineMs) / t.inclineDurationMs) / 10
      : null,
    bpmReadings: t.bpmCount,
    averageBpm: t.bpmCount ? Math.round(t.bpmSum / t.bpmCount) : null,
    peakBpm: t.peakBpm || null,
    endedBy: w.reason,
  };
}
