import type { TreadmillSample } from '@/treadmill/types';
import { currentCue, PULSE_INTERVAL_SECONDS, validBpm } from './model';

export type Cue = NonNullable<ReturnType<typeof currentCue>>;
export type Guidance = {
  index: number;
  speedReached: boolean;
  inclineReached: boolean;
  adjusted: boolean;
  /** Horário do pedido de batimentos em aberto ou, depois de atendido, do último. */
  bpmRequestedAt: number | null;
  /** Leituras válidas recebidas desde o pedido. */
  bpmCount: number;
  /** Horário da última leitura contada, para não contar a mesma amostra duas vezes. */
  bpmAt: number | null;
  bpmReceived: boolean;
  /** Segundo da etapa em que o pedido foi atendido: o seguinte abre 3 minutos depois. */
  bpmDoneInto: number | null;
};

/**
 * Leituras que fecham o aviso de batimentos: as 2 primeiras de uma pegada são
 * descartadas pela revisão, que precisa de mais 4.
 */
export const PULSE_READINGS = 6;
/** Um pedido repetido só abre se ainda houver este tempo de etapa para segurar o sensor. */
const PULSE_MIN_LEFT_SECONDS = 30;

export function pendingAction(g: Guidance | null) {
  if (!g) return null;
  if (g.bpmRequestedAt !== null && !g.bpmReceived) return 'bpm';
  return g.adjusted ? null : 'adjust';
}

export function advanceGuidance(
  previous: Guidance | null,
  cue: Cue | null,
  sample: TreadmillSample | null,
  now: number,
): Guidance | null {
  if (!cue) return null;
  const stage = previous?.index === cue.index ? previous : null;
  // Três minutos depois de uma leitura atendida o guia pede outra: o estado do
  // pedido recomeça do zero, e o aviso reabre.
  const again =
    cue.measure &&
    stage?.bpmDoneInto != null &&
    cue.into - stage.bpmDoneInto >= PULSE_INTERVAL_SECONDS &&
    cue.left >= PULSE_MIN_LEFT_SECONDS;
  const prior: Guidance | null =
    stage && again
      ? { ...stage, bpmRequestedAt: null, bpmCount: 0, bpmAt: null, bpmReceived: false, bpmDoneInto: null }
      : stage;
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
  const adjusted = !!prior?.adjusted || (speedReached && inclineReached);
  // Um pedido que a etapa deixou de fazer sem ter sido atendido caduca: é o
  // caso da FC de repouso, que só vale no início do treino.
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
  const bpmReceived = !!prior?.bpmReceived || bpmCount >= PULSE_READINGS;
  return {
    index: cue.index,
    speedReached,
    inclineReached,
    adjusted,
    bpmRequestedAt,
    bpmCount,
    bpmAt: counted ? sample.at : (prior?.bpmAt ?? null),
    bpmReceived,
    bpmDoneInto: bpmReceived ? (prior?.bpmDoneInto ?? cue.into) : null,
  };
}
