// A prévia do painel: um treino de VO₂máx parado no meio do segundo tiro, sem
// esteira e sem IA. As amostras são inventadas, uma por segundo, mas passam
// pelas mesmas contas da sessão de verdade, para o painel ler o registro como
// leria o de um treino real.

import type { TreadmillSample } from '@/treadmill/types';
import {
  accumulate,
  currentCue,
  emptyLog,
  logBeats,
  logLoads,
  logStage,
  newWorkout,
  type HeartProfile,
  type Profile,
  type Workout,
} from './model';
import { dailyTarget } from './physiology';
import { sessionPlan, sessions } from './week';

/** Onde a prévia para: 18:36 de treino, com 2:24 por fazer no segundo tiro. */
export const PREVIEW_SECONDS = 18 * 60 + 36;
/** A carga dos tiros da prévia. */
const PACE_KMH = 9.5;
const GRADE_PERCENT = 1;
/** Em quantos segundos os batimentos percorrem a maior parte do caminho até o novo patamar. */
const SETTLE_SECONDS = 30;
/** Quantas amostras a sessão da esteira guarda: as mesmas 300 da de verdade. */
const KEPT_SAMPLES = 300;

/**
 * O treino da prévia e as últimas amostras dele, terminando em `now`. A
 * esteira está na carga do tiro e os batimentos sobem para o alto da faixa.
 */
export function previewWorkout(profile: Profile, hr: HeartProfile, now: number) {
  // A terça do plano semanal, com a carga escolhida aqui no lugar da IA.
  const plan = sessionPlan(sessions.vo2Long, PACE_KMH, GRADE_PERCENT);
  const target = dailyTarget(plan, profile, hr);
  const started = now - PREVIEW_SECONDS * 1000;
  let active: Workout = { ...newWorkout(profile, 'demo', plan, hr), id: 'previa', started };
  const samples: TreadmillSample[] = [];
  let previous: TreadmillSample | null = null;
  let bpm = hr.max * 0.5;
  for (let second = 0; second <= PREVIEW_SECONDS; second++) {
    const { stage } = currentCue(plan, second)!;
    // Leve: 60% da FC máxima. Tiro: logo abaixo do teto da faixa.
    const goal = stage.measure ? hr.max * 0.6 : target.high - 2;
    bpm += (goal - bpm) / SETTLE_SECONDS;
    const sample: TreadmillSample = {
      at: started + second * 1000,
      speedKmh: stage.speed,
      inclinationPercent: stage.incline,
      heartRateBpm: Math.round(bpm),
      heartRateSource: 'strap',
      energyKcal: null,
      distanceM: null,
    };
    const totals = accumulate(active.totals, sample, previous);
    const elapsed = Math.floor(totals.movingMs / 1000);
    const cue = currentCue(plan, elapsed)!;
    const log = Array.from(
      { length: Math.max(cue.index + 1, active.log?.length ?? 0) },
      (_, i) => active.log?.[i] ?? emptyLog(),
    );
    log[cue.index] = logStage(log[cue.index], sample, previous, target, cue.into);
    active = {
      ...active,
      totals,
      beats: logBeats(active.beats, sample, previous, elapsed),
      loads: logLoads(active.loads, sample, previous, elapsed),
      log,
    };
    samples.push(sample);
    previous = sample;
  }
  return { active, samples: samples.slice(-KEPT_SAMPLES) };
}
