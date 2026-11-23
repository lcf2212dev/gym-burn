// Os treinos de blocos: a carga do próximo bloco, decidida na recuperação, e a
// duração da recuperação, guiada pelo coração. Código puro, sem Expo: a sessão
// de treino chama e grava o resultado no plano.
//
// Num tiro a carga não sobe no meio, e a FC ainda sobe quando ele acaba: o que
// cada tiro ensina (terminou acima do teto, ou bem abaixo) só serve para o
// tiro seguinte. A decisão é tomada aos 15 s da recuperação, com o BPM do fim
// do bloco já fechado e antes de a pessoa voltar ao esforço.

import type { TreadmillSample } from '@/treadmill/types';
import {
  correctedStage,
  MAX_RAISE_METS,
  raiseMargin,
  RELIEF_SETTLE_SECONDS,
  type Correction,
} from './adaptive';
import {
  median,
  metabolicCost,
  RUN_FROM_KMH,
  validBpm,
  validLoad,
  type Change,
  type Plan,
  type Stage,
  type StageLog,
  type Zone,
} from './model';
import { AIM_SPAN_BPM, bpmPerMet } from './physiology';

/** Quantos segundos de recuperação esperar antes de decidir a carga do próximo bloco. */
export const NEXT_BLOCK_AT_SECONDS = 15;
/** O fim do bloco: os últimos 20 s dele. */
const END_WINDOW_MS = 20_000;
/** Só com a cinta: pelo menos tantas leituras dela nos últimos 20 s do bloco. */
export const END_STRAP_READINGS = 10;
/** Um bloco mais curto que isto não decide o seguinte: o fim dele ainda é a lona acelerando. */
const END_MIN_BLOCK_SECONDS = 60;
/** O acúmulo de um bloco para o outro quando ainda não há dois blocos para medir. */
export const DEFAULT_CARRY_BPM = 2;
/** O maior corte da decisão, em METs: a carga do próximo bloco não muda mais que isto de uma vez. */
const NEXT_BLOCK_MAX_METS = 1;
/**
 * Depois de um alívio a menos de 3 min do fim do bloco, o BPM do fim ainda
 * responde ao corte: a decisão tira só o excesso, até meio MET.
 */
const SETTLING_MAX_METS = 0.5;
/** A previsão acima de teto − 1 pede corte; o corte mira teto − 3, o começo do alvo. */
const CUT_ABOVE_BPM = 1;
const EPSILON = 1e-9;
/** A mesma tolerância com que o guia dá um alvo por atingido. */
const SPEED_TOLERANCE_KMH = 0.051;
const INCLINE_TOLERANCE_PERCENT = 0.251;

const effortIndexes = (plan: Plan) => plan.stages.flatMap((s, i) => (s.measure ? [] : [i]));
const cost = (s: { speed: number; incline: number }) => metabolicCost(s.speed, s.incline);

/** Uma recuperação entre dois blocos de esforço: a etapa leve logo depois de um, com outro mais adiante. */
export function betweenBlocks(plan: Plan, index: number) {
  const stages = plan.stages;
  return (
    !!stages[index]?.measure &&
    index > 0 &&
    !stages[index - 1].measure &&
    stages.slice(index + 1).some((s) => !s.measure)
  );
}

/** Em que segundo de treino (lona andando) a etapa começa. */
const startOf = (plan: Plan, index: number) => plan.stages.slice(0, index).reduce((n, s) => n + s.seconds, 0);

/** O fim de um bloco de esforço: a carga medida nos últimos 20 s dele e o BPM do fim. */
export type BlockEnd = { index: number; speed: number; incline: number; bpm: number };

/**
 * A carga em que o bloco terminou: a mediana da velocidade e da inclinação
 * medidas nos últimos 20 s dele (até `until`, o começo da recuperação), nos
 * degraus do guia; dentro da tolerância de atingido, vale o alvo. É a carga
 * que deu o BPM do fim, mesmo quando a pessoa não seguiu um corte. Junto, as
 * leituras da cinta nesse trecho. `null` sem amostra com a lona andando.
 */
export function blockEnd(samples: TreadmillSample[], until: number, stage: Stage) {
  const window = samples.filter((s) => s.at >= until - END_WINDOW_MS && s.at < until);
  const moving = window.filter((s) => (s.speedKmh ?? 0) > 0);
  if (!moving.length) return null;
  // Em décimos de km/h e meios pontos: a mediana do modelo arredonda para inteiro.
  const kmh = median(moving.map((s) => Math.round((s.speedKmh ?? 0) * 10))) / 10;
  const grade = median(moving.map((s) => Math.round((s.inclinationPercent ?? 0) * 2))) / 2;
  return {
    speed: Math.abs(kmh - stage.speed) < SPEED_TOLERANCE_KMH ? stage.speed : kmh,
    incline: Math.abs(grade - stage.incline) < INCLINE_TOLERANCE_PERCENT ? stage.incline : grade,
    strapReadings: window.filter((s) => s.heartRateSource === 'strap' && validBpm(s.heartRateBpm)).length,
  };
}

/**
 * O acúmulo de um bloco para o outro, em bpm: a média das diferenças de BPM do
 * fim entre blocos de esforço seguidos, descontado o que a mudança de carga
 * entre eles explica pela reta de bpm por MET. Sem nenhum par, 2 bpm. Nunca
 * negativo: na mesma carga a FC não cai de um tiro para o outro, e um acúmulo
 * negativo (ruído da correção) só serviria para subir a carga. Um par em que
 * um bloco terminou andando e o outro correndo (pela velocidade medida no fim
 * dele: quem não seguiu um corte e continuou correndo conta como correndo) não
 * entra: a diferença de METs entre as duas equações não diz o esforço real
 * (para quem corre devagar a corrida custa menos do que a equação diz), e
 * viraria um acúmulo falso de até 15 bpm.
 */
export function carryBpm(plan: Plan, ends: BlockEnd[], rest: number | null) {
  const efforts = effortIndexes(plan);
  const running = (e: BlockEnd) => e.speed >= RUN_FROM_KMH;
  const diffs: number[] = [];
  for (let k = 1; k < ends.length; k++) {
    const [a, b] = [ends[k - 1], ends[k]];
    if (efforts.indexOf(b.index) - efforts.indexOf(a.index) !== 1 || running(a) !== running(b)) continue;
    const slope = bpmPerMet(b.bpm, cost(b), rest);
    diffs.push(b.bpm - a.bpm - slope * (cost(b) - cost(a)));
  }
  if (!diffs.length) return DEFAULT_CARRY_BPM;
  return Math.max(0, diffs.reduce((n, d) => n + d, 0) / diffs.length);
}

/** O alívio baixou a carga (o nome não basta: o aumento de uma corrida com rampa antiga baixa a rampa). */
function eased(c: Change) {
  if (c.from && c.to) return metabolicCost(...c.to) < metabolicCost(...c.from);
  return c.decision.startsWith('reduzir');
}

export type NextBlockInput = {
  plan: Plan;
  /** A recuperação em curso. */
  index: number;
  log: (StageLog | undefined)[];
  changes: Change[];
  zone: Zone;
  rest: number | null;
  /** Os fins dos blocos de esforço desta sessão, em ordem; o último é o do bloco que acabou. */
  ends: BlockEnd[];
  /** Leituras da cinta nos últimos 20 s do bloco que acabou. */
  strapReadings: number;
  /** A pessoa está fora da lona, ou voltou há pouco: a carga não sobe. */
  offBelt: boolean;
};

/** A decisão para o próximo bloco. */
export type NextBlock = {
  /** O bloco de esforço que vem. */
  index: number;
  /** O BPM previsto para o fim dele, na carga em que o anterior terminou. */
  predictedBpm: number;
  /** O acúmulo usado na previsão, em bpm. */
  carryBpm: number;
  /** O que a previsão pede: cortar, manter a carga do fim do anterior ou subir. */
  verdict: 'reduzir' | 'manter' | 'aumentar';
  /** A carga do próximo bloco antes e depois da decisão (iguais quando nada muda). */
  from: Stage;
  to: Stage;
  /** As etapas cuja carga muda: o próximo bloco e, num corte, os seguintes que custam mais. */
  stages: number[];
};

/**
 * A carga do próximo bloco, decidida na recuperação (`index`) entre dois
 * blocos de esforço. Só com a cinta: pelo menos 10 leituras dela nos últimos
 * 20 s do bloco que acabou; `null` sem isso, sem o fim medido do bloco ou com
 * ele numa carga que o guia não pede.
 *
 * A referência é a carga em que o bloco terminou e o BPM do fim (a mediana do
 * `tail`). A previsão para o fim do próximo bloco na mesma carga é esse BPM
 * mais o acúmulo (`carryBpm`). Acima de teto − 1, a carga desce o bastante
 * para a previsão voltar a teto − 3, até 1 MET. Mais de 3 bpm abaixo do teto,
 * ela sobe o que couber com a margem de `raiseMargin`, até 1 MET, se o bloco
 * (e o começo da recuperação) não teve leitura acima do teto, nenhum bloco da
 * sessão teve corte da trava e a pessoa não saiu da lona; é o único caminho de
 * aumento num tiro. Depois de
 * um alívio a menos de 3 min do fim do bloco, o BPM do fim ainda responde ao
 * corte: a decisão tira só o excesso observado sobre o teto, até meio MET, e a
 * carga não sobe. Como a conta parte da carga do fim do bloco, a redução já
 * herdada pelo próximo bloco não é somada de novo.
 *
 * A carga decidida vale para o próximo bloco quando custa menos que a dele (e
 * para os seguintes que custam mais, como toda redução), mas um próximo bloco
 * de corrida não desce abaixo do piso da corrida (6 km/h plano): a troca para
 * a caminhada só vale dentro do bloco em que é feita. Depois de um bloco que
 * terminou andando por causa dessa troca, a decisão não reduz de novo: o
 * próximo já começa no piso da corrida. Acima da carga dele, ela vale só para
 * o próximo, como todo aumento, até 1 MET acima da carga planejada dele, e só
 * quando a previsão pediu aumento ou, num "manter", com as mesmas condições do
 * aumento (nada acima do teto no bloco nem no começo da recuperação, pela
 * cinta ou pelo BPM do momento; nenhum corte da trava na sessão; ninguém fora
 * da lona): a carga em que ele terminou no alvo passa ao seguinte. Um corte
 * nunca sobe o próximo bloco, mesmo partindo de uma carga de fim acima do
 * plano. Um bloco de menos de 1 min não decide
 * nada: nos últimos 20 s dele a lona ainda pode estar acelerando, e a
 * referência ficaria abaixo do que a pessoa fez.
 */
export function nextBlockLoad(input: NextBlockInput): NextBlock | null {
  const { plan, index, zone, rest, ends } = input;
  if (!betweenBlocks(plan, index) || input.strapReadings < END_STRAP_READINGS) return null;
  if (plan.stages[index - 1].seconds < END_MIN_BLOCK_SECONDS) return null;
  const end = ends[ends.length - 1];
  if (!end || end.index !== index - 1 || !validLoad(end.speed, end.incline)) return null;
  const next = effortIndexes(plan).find((i) => i > index)!;
  const current = plan.stages[next];
  const reference: Stage = { ...current, speed: end.speed, incline: end.incline };
  const slope = bpmPerMet(end.bpm, cost(reference), rest);
  const carry = carryBpm(plan, ends, rest);
  const predicted = Math.round(end.bpm + carry);
  const block = input.log[index - 1];
  const since = startOf(plan, index) - RELIEF_SETTLE_SECONDS;
  const settling = input.changes.some(
    (c) => c.stage === index - 1 && c.by !== 'bloco' && eased(c) && c.second >= since,
  );
  const trava = input.changes.some((c) => c.by === 'trava');
  // Acima do teto: uma leitura da cinta ou o BPM do momento, o que a trava usa
  // (com os RR ele pode passar do teto sem nenhuma leitura da cinta passar).
  const above = (l: StageLog | undefined) => !!l && (l.zone[2] > 0 || (l.liveTop ?? 0) > zone.high);
  // Num tiro a FC ainda sobe depois do fim: acima do teto nos primeiros
  // segundos da recuperação também diz que a carga não pode subir.
  const recovery = input.log[index];
  // As condições de todo caminho que sobe a carga do próximo bloco: o aumento e
  // o "manter" que passa a carga do fim adiante.
  const raisable =
    !above(block) && !above(recovery) && !block?.offBeltMs && !input.offBelt && !settling && !trava;
  // O tiro terminou andando porque um alívio nele tirou a pessoa da corrida: o
  // próximo já começa no piso da corrida (a troca vale só para a etapa em que
  // foi feita), e a decisão não reduz de novo a partir da caminhada.
  const walkedOff =
    end.speed < RUN_FROM_KMH &&
    input.changes.some(
      (c) => c.stage === index - 1 && c.by !== 'bloco' && !!c.from && !!c.to && c.from[0] >= RUN_FROM_KMH && c.to[0] < RUN_FROM_KMH,
    );
  let kind: Correction | null = null;
  let mets = 0;
  if (settling) {
    const excess = end.bpm - zone.high;
    if (excess > 0) [kind, mets] = ['aliviar', Math.min(SETTLING_MAX_METS, excess / slope)];
  } else if (predicted > zone.high - CUT_ABOVE_BPM) {
    kind = 'aliviar';
    mets = Math.min(NEXT_BLOCK_MAX_METS, (predicted - (zone.high - AIM_SPAN_BPM)) / slope);
  } else if (predicted < zone.high - AIM_SPAN_BPM && raisable) {
    const room = raiseMargin(zone.high - predicted);
    if (room > 0) [kind, mets] = ['subir', Math.min(MAX_RAISE_METS, room / slope)];
  }
  // A conta de `correctedStage` parte da carga medida quando ela está abaixo
  // do alvo: com a amostra nos próprios alvos, parte da referência.
  const at: TreadmillSample = {
    at: 0,
    speedKmh: reference.speed,
    inclinationPercent: reference.incline,
    heartRateBpm: null,
    energyKcal: null,
    distanceM: null,
  };
  let decided = kind ? correctedStage(reference, kind, mets, at, kind === 'subir') : reference;
  // Um próximo bloco de corrida não herda caminhada: o corte mais fundo que ele
  // recebe é o piso da corrida, 6 km/h plano. O que faltar fica para a trava,
  // dentro dele.
  if (current.speed >= RUN_FROM_KMH && decided.speed < RUN_FROM_KMH)
    decided = { ...decided, speed: RUN_FROM_KMH, incline: 0 };
  // Para cima, no máximo 1 MET acima da carga planejada do próximo bloco, por
  // qualquer caminho: quem terminou a 7,6 km/h num alvo de 6,0 não leva o
  // próximo tiro a 7,6.
  if (cost(decided) > cost(current) + NEXT_BLOCK_MAX_METS) {
    const from = { ...at, speedKmh: current.speed, inclinationPercent: current.incline };
    decided = correctedStage(current, 'subir', NEXT_BLOCK_MAX_METS, from, true);
  }
  const verdict = kind === 'aliviar' ? 'reduzir' : kind === 'subir' ? 'aumentar' : 'manter';
  let stages: number[] = [];
  if (cost(decided) < cost(current) - EPSILON) {
    if (!walkedOff)
      stages = effortIndexes(plan).filter((i) => i >= next && cost(plan.stages[i]) > cost(decided) + EPSILON);
  }
  // Acima da carga do próximo bloco, ela só vai a ele quando a previsão pediu
  // aumento ou, num "manter", com as mesmas condições do aumento: sem isso, um
  // aumento do bloco anterior que deu certo (terminou no alvo) voltaria à carga
  // do plano sem aviso no bloco seguinte.
  else if (cost(decided) > cost(current) + EPSILON && raisable && kind !== 'aliviar') stages = [next];
  const to = stages.length ? { ...current, speed: decided.speed, incline: decided.incline } : current;
  return { index: next, predictedBpm: predicted, carryBpm: carry, verdict, from: current, to, stages };
}

/** A recuperação entre blocos termina quando o BPM do momento cai a este tanto da FC máxima em uso. */
export const RECOVERY_END_SHARE = 0.65;
/** Limites da recuperação guiada pelo coração, em segundos. */
export const RECOVERY_MIN_SECONDS = 120;
export const RECOVERY_MAX_SECONDS = 300;
/** A volta à calma, que paga o tempo a mais das recuperações, nunca fica abaixo disto. */
export const COOLDOWN_MIN_SECONDS = 180;
/**
 * O alongamento entra nos últimos segundos da recuperação, e não no último: um
 * pacote da esteira que se perde ali não deixa o bloco seguinte começar antes.
 */
const EXTEND_AHEAD_SECONDS = 5;

export type PaceInput = {
  plan: Plan;
  /** A recuperação em curso e os segundos já feitos nela. */
  index: number;
  into: number;
  /** A duração dela no plano, antes de qualquer mudança. */
  planned: number;
  /** O BPM do momento; `null` sem leitura recente da cinta. */
  bpm: number | null;
  maxBpm: number;
};

/** A recuperação mudou: as etapas novas e o porquê. */
export type Pace = {
  stages: Stage[];
  /** A duração nova da recuperação, em segundos. */
  seconds: number;
  /** `cedo`: o BPM já caiu; `alongada`: ainda não caiu; `plano`: sem leitura, volta ao tempo do plano. */
  reason: 'cedo' | 'alongada' | 'plano';
};

/**
 * A recuperação entre blocos guiada pelo coração. Ela termina quando o BPM do
 * momento cai a 65% da FC máxima em uso, com no mínimo 2 e no máximo 5
 * minutos; sem leitura vale o tempo do plano. A duração do treino não muda: a
 * volta à calma (a última etapa) paga a diferença e nunca fica abaixo de 3
 * min. O tempo que ela pode emprestar (a duração dela menos 3 min) é dividido
 * pelas recuperações que ainda faltam, para a primeira não gastar tudo.
 * Devolve `null` quando nada muda; a soma das etapas continua a mesma.
 */
export function paceRecovery({ plan, index, into, planned, bpm, maxBpm }: PaceInput): Pace | null {
  const stages = plan.stages;
  const cooldown = stages.length - 1;
  const efforts = effortIndexes(plan);
  if (!betweenBlocks(plan, index) || !stages[cooldown].measure || cooldown <= efforts[efforts.length - 1])
    return null;
  const current = stages[index].seconds;
  // A volta à calma como estava no começo desta recuperação, e quanto dela pode ir para cada uma.
  const budget = Math.max(0, stages[cooldown].seconds + (current - planned) - COOLDOWN_MIN_SECONDS);
  const remaining = stages.filter((_, i) => i >= index && betweenBlocks(plan, i)).length;
  const limit = Math.max(planned, Math.min(RECOVERY_MAX_SECONDS, planned + Math.floor(budget / remaining)));
  // Os segundos da recuperação contando este: com eles ela termina agora.
  const done = into + 1;
  let seconds = current;
  let reason: Pace['reason'] = 'plano';
  if (bpm === null) {
    if (current > planned) seconds = Math.max(planned, done);
  } else if (bpm <= Math.round(maxBpm * RECOVERY_END_SHARE)) {
    if (done >= RECOVERY_MIN_SECONDS && done < current) [seconds, reason] = [done, done < planned ? 'cedo' : 'alongada'];
  } else if (current < limit && done >= current - EXTEND_AHEAD_SECONDS) {
    [seconds, reason] = [limit, 'alongada'];
  }
  if (seconds === current) return null;
  const next = stages.map((s, i) =>
    i === index ? { ...s, seconds } : i === cooldown ? { ...s, seconds: s.seconds + current - seconds } : s,
  );
  return { stages: next, seconds, reason };
}
