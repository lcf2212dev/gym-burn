// A FC de repouso e a prontidão do dia, medidas com a pessoa parada na
// esteira, antes do treino. A esteira não lê batimentos com a lona parada; a
// cinta lê. Código puro, sem Expo: a sessão de treino junta os batimentos da
// cinta numa janela (`addStillBeat`) e, quando a lona começa a andar, chama
// estas contas.
//
// A prontidão é só uma sugestão na tela: não entra em nenhuma regra de carga,
// não bloqueia nada e não vai para a IA.

import { acceptRr, createRrFilter, rmssd } from '@/heart/rr';
import { median, validBpm, type Workout } from './model';

/** Uma notificação da cinta com a lona parada: o BPM dela e os RR crus do pacote. */
export type StillBeat = { at: number; bpm: number; rrMs: number[] };

/** A janela parado vai até os últimos 5 minutos de leituras. */
export const STILL_WINDOW_MS = 5 * 60_000;
/** Com menos que isto de leitura parado vale o caminho de sempre: o primeiro minuto e meio andando. */
export const STILL_MIN_MS = 60_000;
/** O repouso é a menor mediana de 30 s da janela. */
export const STILL_MEDIAN_MS = 30_000;
/**
 * Duas leituras mais distantes que isto não cobrem o tempo entre elas: a cinta
 * perdeu o contato ou o link (é o mesmo prazo em que a leitura dela deixa de
 * valer no treino).
 */
export const STILL_GAP_MS = 5000;
/** Uma janela de 30 s conta como cheia com esta folga: as notificações não chegam no milissegundo. */
const MEDIAN_SLACK_MS = 2000;
/** Acima desta parcela de RR descartados pelo filtro de artefatos, a medida da HRV não vale. */
export const MAX_REJECTED_SHARE = 0.1;
/** Os RR aceitos precisam cobrir o minuto, menos a parcela que pode ser descartada. */
const HRV_MIN_RR_MS = STILL_MIN_MS * (1 - MAX_REJECTED_SHARE);

/** A base da prontidão: os dias medidos nas últimas 4 semanas, sem contar hoje. */
export const BASELINE_DAYS = 28;
/** Com menos dias medidos que isto não há base para comparar. */
export const BASELINE_MIN_DAYS = 5;
/**
 * Piso do desvio-padrão de ln(RMSSD). Uma base muito regular (5 dias quase
 * iguais) teria um desvio tão pequeno que qualquer oscilação sairia do normal;
 * 0,1 em ln são cerca de 10% de RMSSD.
 */
export const READINESS_SD_FLOOR = 0.1;

const DAY_MS = 86_400_000;
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Soma a notificação à janela parado e corta o que passou de 5 minutos da mais
 * nova. Devolve uma lista nova.
 */
export function addStillBeat(beats: readonly StillBeat[], beat: StillBeat): StillBeat[] {
  return [...beats, beat].filter((b) => beat.at - b.at <= STILL_WINDOW_MS);
}

/** O tempo coberto por leituras, em ms: os intervalos entre leituras seguidas, sem as lacunas. */
export function coveredMs(beats: readonly StillBeat[]): number {
  let total = 0;
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i].at - beats[i - 1].at;
    if (gap > 0 && gap <= STILL_GAP_MS) total += gap;
  }
  return total;
}

/** Os segundos inteiros de leitura parado na janela: o andamento da medida, para a tela. */
export const stillSeconds = (beats: readonly StillBeat[]) => Math.floor(coveredMs(beats) / 1000);

/**
 * O repouso do dia, medido parado: a menor mediana de 30 s seguidos de leitura
 * na janela. `null` com menos de 60 s de leitura, ou sem nenhum trecho de 30 s
 * sem lacuna.
 */
export function stillRest(beats: readonly StillBeat[]): number | null {
  if (coveredMs(beats) < STILL_MIN_MS) return null;
  let lowest: number | null = null;
  let start = 0;
  for (let end = 0; end < beats.length; end++) {
    while (beats[end].at - beats[start].at > STILL_MEDIAN_MS) start++;
    const slice = beats.slice(start, end + 1);
    if (coveredMs(slice) < STILL_MEDIAN_MS - MEDIAN_SLACK_MS) continue;
    const value = median(slice.map((b) => b.bpm));
    if (validBpm(value) && (lowest === null || value < lowest)) lowest = value;
  }
  return lowest;
}

/** A variabilidade de uma medida parado: RMSSD (ms), ln(RMSSD), os RR recebidos e a parcela descartada. */
export type StillHrv = { rmssd: number; lnRmssd: number; beats: number; rejectedShare: number };

/**
 * A HRV da janela parado: o RMSSD dos RR aceitos pelo filtro de artefatos
 * (`acceptRr`) e o ln dele. `null` com menos de 60 s de leitura, sem RR, com
 * mais de 10% dos RR descartados ou com os aceitos cobrindo menos de 54 s.
 */
export function stillHrv(beats: readonly StillBeat[]): StillHrv | null {
  if (coveredMs(beats) < STILL_MIN_MS) return null;
  const filter = createRrFilter();
  const kept: number[] = [];
  let total = 0;
  for (const beat of beats) {
    for (const rr of beat.rrMs) {
      total++;
      if (acceptRr(filter, rr)) kept.push(rr);
    }
  }
  if (!total) return null;
  const rejectedShare = (total - kept.length) / total;
  const span = kept.reduce((sum, rr) => sum + rr, 0);
  if (rejectedShare > MAX_REJECTED_SHARE || span < HRV_MIN_RR_MS) return null;
  const value = rmssd(kept);
  if (value === null || !(value > 0)) return null;
  return {
    rmssd: round(value, 1),
    lnRmssd: round(Math.log(value), 3),
    beats: total,
    rejectedShare: round(rejectedShare, 3),
  };
}

/** A medida de prontidão de um dia, como fica na tabela `readiness`: uma por dia, a mais recente vale. */
export type ReadinessRecord = StillHrv & {
  /** O dia local, `AAAA-MM-DD`. */
  day: string;
  /** Quando foi medida. */
  at: number;
  /** O repouso medido na mesma janela. */
  restBpm: number | null;
};

const two = (n: number) => String(n).padStart(2, '0');

/** O dia local de um instante, `AAAA-MM-DD`: ordena como texto. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Quantos dias de calendário vão de `from` a `to` (`AAAA-MM-DD`). */
function daysBetween(from: string, to: string) {
  const local = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  // Arredondado: um dia com mudança de horário tem 23 ou 25 horas.
  return Math.round((local(to) - local(from)) / DAY_MS);
}

/**
 * A prontidão de hoje contra o normal da própria pessoa:
 * - `sem-medida`: hoje ainda não há medida;
 * - `coletando`: há medida hoje, mas menos de 5 dias medidos nas últimas 4 semanas;
 * - `normal`, `acima` ou `abaixo`: ln(RMSSD) de hoje dentro de ±1 desvio-padrão
 *   da média desses dias, acima ou abaixo (o desvio tem piso de 0,1).
 * `days` é quantos dias a base tem, sem contar hoje.
 */
export type Readiness =
  | { state: 'sem-medida'; days: number }
  | { state: 'coletando'; days: number; today: ReadinessRecord }
  | {
      state: 'normal' | 'acima' | 'abaixo';
      days: number;
      today: ReadinessRecord;
      mean: number;
      sd: number;
    };

export function readiness(records: readonly ReadinessRecord[], now: number): Readiness {
  const today = dayKey(now);
  // Um por dia, o mais recente.
  const byDay = new Map<string, ReadinessRecord>();
  for (const r of records) {
    const kept = byDay.get(r.day);
    if (!kept || r.at > kept.at) byDay.set(r.day, r);
  }
  const base = [...byDay.values()].filter((r) => {
    const ago = daysBetween(r.day, today);
    return ago >= 1 && ago <= BASELINE_DAYS && Number.isFinite(r.lnRmssd);
  });
  const days = base.length;
  const measured = byDay.get(today);
  if (!measured) return { state: 'sem-medida', days };
  if (days < BASELINE_MIN_DAYS) return { state: 'coletando', days, today: measured };
  const values = base.map((r) => r.lnRmssd);
  const mean = values.reduce((sum, v) => sum + v, 0) / days;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (days - 1);
  const sd = Math.max(Math.sqrt(variance), READINESS_SD_FLOOR);
  const state =
    measured.lnRmssd > mean + sd ? 'acima' : measured.lnRmssd < mean - sd ? 'abaixo' : 'normal';
  return { state, days, today: measured, mean: round(mean, 3), sd: round(sd, 3) };
}

/**
 * O repouso medido hoje e como foi medido: o mais recente medido parado, que
 * é o mais perto do repouso real; sem nenhum, o mais recente lido andando.
 * `null` sem nenhum.
 */
export function restToday(workouts: readonly Workout[], now: number) {
  const today = dayKey(now);
  const measured = [...workouts]
    .sort((a, b) => b.started - a.started)
    .filter((h) => dayKey(h.started) === today && validBpm(h.restBpm));
  const w = measured.find((h) => h.restSource === 'parado') ?? measured[0];
  if (!w || !validBpm(w.restBpm)) return null;
  return { bpm: w.restBpm, source: w.restSource ?? ('andando' as const) };
}
