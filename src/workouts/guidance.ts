import type { TreadmillSample } from '@/treadmill/types';
import { currentCue, inRange } from './model';

export type Cue = NonNullable<ReturnType<typeof currentCue>>;
export type Guidance = {
  index: number;
  speedReached: boolean;
  inclineReached: boolean;
  adjusted: boolean;
  bpmRequestedAt: number | null;
  bpmReceived: boolean;
};

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
  const bpmRequestedAt = prior?.bpmRequestedAt ?? (cue.measure ? now : null);
  const bpmReceived =
    !!prior?.bpmReceived ||
    (bpmRequestedAt !== null &&
      !!sample &&
      sample.at > bpmRequestedAt &&
      fresh(sample.at) &&
      inRange(sample.heartRateBpm, 25, 250));
  return { index: cue.index, speedReached, inclineReached, adjusted, bpmRequestedAt, bpmReceived };
}
