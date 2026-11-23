import type { TreadmillSample } from '@/treadmill/types';
import { currentCue, validBpm, type Stage } from './model';

export type Cue = NonNullable<ReturnType<typeof currentCue>>;
export type Guidance = {
  index: number;
  speedReached: boolean;
  inclineReached: boolean;
  adjusted: boolean;
  /** Desde quando valem os alvos em vigor: o começo da etapa ou o último ajuste de carga. */
  targetsSince: number;
  /** Número do pedido de batimentos em vigor: o guia abre um a cada 3 minutos de treino. */
  bpmSlot: number;
  /** Horário em que o pedido de batimentos em vigor abriu. */
  bpmRequestedAt: number | null;
  /** Leituras válidas recebidas desde o pedido. */
  bpmCount: number;
  /** Horário da última leitura contada, para não contar a mesma amostra duas vezes. */
  bpmAt: number | null;
  bpmReceived: boolean;
};

/**
 * Leituras que fecham o aviso de batimentos: as 2 primeiras de uma pegada são
 * descartadas pela revisão, que precisa de mais 4.
 */
export const PULSE_READINGS = 6;

/**
 * O aviso que a tela mostra. Com um pedido de batimentos e um ajuste da
 * esteira em aberto ao mesmo tempo, vale o mais recente: a etapa que acabou de
 * começar passa na frente de um pedido antigo, e o pedido novo passa na frente
 * de um ajuste que a pessoa deixou para lá. Assim nenhum dos dois esconde o
 * outro por mais de 3 minutos. A FC de repouso, no começo do treino, vem
 * sempre antes de acelerar.
 */
export function pendingAction(g: Guidance | null) {
  if (!g) return null;
  const bpm = g.bpmRequestedAt !== null && !g.bpmReceived;
  if (bpm && (g.adjusted || g.bpmSlot === 0 || g.bpmRequestedAt! > g.targetsSince)) return 'bpm';
  return g.adjusted ? null : 'adjust';
}

/**
 * A identidade do aviso que a tela mostra: uma chave nova reabre o aviso
 * minimizado e toca os bipes de novo. Cada pedido de batimentos é um aviso
 * novo; um ajuste, também, a cada vez que os alvos passam a valer, inclusive
 * quando o app volta a pedir uma redução que ainda não chegou ao painel.
 */
export function cueKey(workoutId: string, g: Guidance | null, stage: Stage | undefined) {
  const action = pendingAction(g);
  if (!action || !g) return null;
  const request = action === 'bpm' ? '@' + g.bpmRequestedAt : '@' + g.targetsSince;
  return workoutId + '/' + g.index + '/' + action + request + '/' + stage?.speed + '/' + stage?.incline;
}

export function advanceGuidance(
  previous: Guidance | null,
  cue: Cue | null,
  sample: TreadmillSample | null,
  now: number,
): Guidance | null {
  if (!cue) return null;
  const stage = previous?.index === cue.index ? previous : null;
  // O pedido de batimentos segue o relógio do treino, não a etapa: a cada 3
  // minutos abre um novo, do zero, e o aviso reabre. Um pedido sem resposta
  // atravessa a troca de etapa e é trocado pelo seguinte.
  const prior = previous?.bpmSlot === cue.pulse ? previous : null;
  const fresh = (at: number | null | undefined) => at != null && at <= now && now - at <= 5000;
  // Os pacotes FTMS podem vir divididos. Cada alvo precisa de uma leitura
  // recente do próprio campo, mesmo quando as notificações continuam chegando.
  const speedReached =
    !!sample &&
    fresh(sample.speedAt) &&
    sample.speedKmh !== null &&
    Math.abs(sample.speedKmh - cue.stage.speed) < 0.051;
  const inclineReached =
    !!sample &&
    fresh(sample.inclineAt) &&
    sample.inclinationPercent !== null &&
    Math.abs(sample.inclinationPercent - cue.stage.incline) < 0.251;
  const adjusted = !!stage?.adjusted || (speedReached && inclineReached);
  // Um pedido que deixou de valer sem ter sido atendido caduca: é o caso da
  // FC de repouso, que só vale no início do treino.
  const requested = prior?.bpmRequestedAt ?? null;
  const bpmRequestedAt = cue.measure ? (requested ?? now) : prior?.bpmReceived ? requested : null;
  const counted =
    bpmRequestedAt !== null &&
    !!sample &&
    sample.at > bpmRequestedAt &&
    sample.at !== prior?.bpmAt &&
    fresh(sample.at) &&
    validBpm(sample.heartRateBpm);
  const bpmCount = bpmRequestedAt === null ? 0 : (prior?.bpmCount ?? 0) + (counted ? 1 : 0);
  // Com a cinta no peito a leitura é contínua e ninguém precisa segurar o
  // sensor: o pedido já nasce atendido e o aviso não abre. Se a cinta cair, o
  // pedido seguinte volta a pedir as mãos no sensor da esteira.
  const strap =
    bpmRequestedAt !== null && !!sample && fresh(sample.at) && sample.heartRateSource === 'strap';
  return {
    index: cue.index,
    speedReached,
    inclineReached,
    adjusted,
    targetsSince: stage?.targetsSince ?? now,
    bpmSlot: cue.pulse,
    bpmRequestedAt,
    bpmCount,
    bpmAt: counted ? sample.at : (prior?.bpmAt ?? null),
    bpmReceived: !!prior?.bpmReceived || bpmCount >= PULSE_READINGS || strap,
  };
}
