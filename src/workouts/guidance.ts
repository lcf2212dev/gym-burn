import type { TreadmillSample } from '@/treadmill/types';
import { currentCue, validBpm } from './model';

export type Cue = NonNullable<ReturnType<typeof currentCue>>;
export type Guidance = {
  index: number;
  speedReached: boolean;
  inclineReached: boolean;
  adjusted: boolean;
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
  const prior = previous?.index === cue.index ? previous : null;
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
  return {
    index: cue.index,
    speedReached,
    inclineReached,
    adjusted,
    bpmRequestedAt,
    bpmCount,
    bpmAt: counted ? sample.at : (prior?.bpmAt ?? null),
    bpmReceived: !!prior?.bpmReceived || bpmCount >= PULSE_READINGS,
  };
}
