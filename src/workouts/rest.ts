// A FC de repouso e a prontidão do dia, medidas com a pessoa parada na
// esteira, antes do treino. A esteira não lê batimentos com a lona parada; a
// cinta lê. Código puro, sem Expo: a sessão de treino junta os batimentos da
// cinta numa janela (`addStillBeat`) e, quando a lona começa a andar, chama
// estas contas.
//
// A prontidão é só uma sugestão na tela: não entra em nenhuma regra de carga,
// não bloqueia nada e não vai para a IA.

import { classifyRr, createRrFilter, type RrVerdict } from '@/heart/rr';
import { median, validBpm, type Workout } from './model';

/** Uma notificação da cinta com a lona parada: o BPM dela e os RR crus do pacote. */
export type StillBeat = { at: number; bpm: number; rrMs: number[] };

/** A janela parado vai até os últimos 5 minutos de leituras. */
export const STILL_WINDOW_MS = 5 * 60_000;
/** Com menos que isto de leitura parado vale o caminho de sempre: o primeiro minuto e meio andando. */
export const STILL_MIN_MS = 60_000;
/** O repouso sai de trechos de 30 s, sem sobreposição. */
export const STILL_MEDIAN_MS = 30_000;
/**
 * A prontidão pede 2 minutos parado no total: o primeiro é de acomodação (a
 * pessoa acabou de subir na esteira), e a HRV sai do último.
 */
export const HRV_STILL_MS = 120_000;
/** A HRV sai sempre dos últimos 60 s antes de a lona andar: a mesma duração todo dia. */
export const HRV_SPAN_MS = 60_000;
/**
 * Duas leituras mais distantes que isto não cobrem o tempo entre elas: a cinta
 * perdeu o contato ou o link (é o mesmo prazo em que a leitura dela deixa de
 * valer no treino).
 */
export const STILL_GAP_MS = 5000;
/** Um trecho conta como cheio com esta folga: as notificações não chegam no milissegundo. */
const SLACK_MS = 2000;
/**
 * Num trecho coerente, a mediana do BPM da cinta e a de 60000/RR dos RR
 * aceitos diferem no máximo isto: uma cinta mal assentada manda um BPM que os
 * RR não confirmam.
 */
export const COHERENT_BPM = 5;
/** Num trecho de 30 s parado, o BPM não varia mais que isto. */
export const STILL_RANGE_BPM = 15;
/** Quantos RR aceitos, no mínimo, um trecho de 30 s precisa para a conferência. */
const SEGMENT_MIN_RR = 10;
/** Abaixo disto não é repouso de quem está em pé: é leitura falsa. */
export const REST_FLOOR_BPM = 40;
/**
 * Com 3 ou mais medidas parado no histórico, um repouso mais de 12 bpm abaixo
 * da mediana delas é descartado.
 */
export const REST_DROP_BPM = 12;
export const REST_HISTORY_MIN = 3;
/** Acima desta parcela de RR descartados pelo filtro de artefatos, a medida da HRV não vale. */
export const MAX_REJECTED_SHARE = 0.1;
/** Os RR aceitos precisam cobrir o minuto da HRV, menos a parcela que pode ser descartada. */
const HRV_MIN_RR_MS = HRV_SPAN_MS * (1 - MAX_REJECTED_SHARE);
/** Pares de RR seguidos, no mínimo, para o RMSSD. */
const HRV_MIN_PAIRS = 20;

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

/** Um treino com tanto tempo em movimento conta como esforço para a medida parado. */
export const EFFORT_MS = 60_000;
/** Depois de um esforço a FC ainda é a dele por este tempo: a janela parado não coleta. */
export const POST_EFFORT_MS = 10 * 60_000;
/** Depois de um esforço a HRV fica deprimida por horas: a prontidão só volta a ser gravada depois disto. */
export const READINESS_AFTER_EFFORT_MS = 3 * 3_600_000;

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
 * Um RR da janela, depois do filtro de artefatos: de que leitura veio, o que o
 * filtro fez com ele e se ele vem logo depois do RR anterior da lista (no
 * mesmo pacote, ou no pacote seguinte sem lacuna e sem pacote vazio no meio).
 */
type ScoredRr = { beat: number; rr: number; verdict: RrVerdict; follows: boolean };

/** Passa os RR da janela inteira pelo filtro, na ordem, para a referência estar assentada. */
function scoreRr(beats: readonly StillBeat[]): ScoredRr[] {
  const filter = createRrFilter();
  const out: ScoredRr[] = [];
  beats.forEach((beat, i) => {
    const before = beats[i - 1];
    const linked = !!before && beat.at - before.at <= STILL_GAP_MS && before.rrMs.length > 0;
    beat.rrMs.forEach((rr, k) =>
      out.push({ beat: i, rr, verdict: classifyRr(filter, rr), follows: k > 0 || linked }),
    );
  });
  return out;
}

/** O que um trecho da janela diz: o BPM da cinta e o dos RR aceitos, e se o filtro se re-semeou nele. */
function segment(beats: readonly StillBeat[], scored: readonly ScoredRr[], from: number, to: number) {
  const slice = beats.slice(from, to);
  const bpms = slice.map((b) => b.bpm);
  const rrs = scored.filter((s) => s.beat >= from && s.beat < to);
  const kept = rrs.filter((s) => s.verdict !== 'recusado');
  return {
    covered: coveredMs(slice),
    bpm: bpms.length ? median(bpms) : null,
    range: bpms.length ? Math.max(...bpms) - Math.min(...bpms) : 0,
    rrs,
    kept,
    rrBpm: kept.length ? median(kept.map((s) => 60000 / s.rr)) : null,
    reseeded: rrs.some((s) => s.verdict === 'resemeado'),
  };
}

/** O primeiro índice da janela com a leitura depois de `at`. */
const firstAfter = (beats: readonly StillBeat[], at: number) => {
  const i = beats.findIndex((b) => b.at > at);
  return i < 0 ? beats.length : i;
};

/**
 * As medidas parado anteriores, das mais novas para as mais antigas (até 5):
 * a referência do piso de plausibilidade.
 */
export function stillHistory(history: readonly Workout[]): number[] {
  return history
    .filter((w) => w.restSource === 'parado' && validBpm(w.restBpm))
    .slice(0, 5)
    .map((w) => w.restBpm!);
}

/**
 * O repouso do dia, medido parado. A janela é cortada em trechos de 30 s sem
 * sobreposição, do fim para o começo (a menor entre centenas de medianas
 * sobrepostas puxa para baixo mesmo sem artefato). Um trecho só é candidato se
 * é coerente: cheio (sem lacuna), com o BPM variando 15 bpm ou menos, com a
 * mediana do BPM da cinta a 5 bpm ou menos da de 60000/RR dos RR aceitos (pelo
 * menos 10) e sem re-semeadura do filtro de artefatos dentro dele. O repouso é
 * a menor mediana entre os candidatos. Não vale abaixo de 40 bpm nem, com 3 ou
 * mais medidas parado em `previous`, mais de 12 bpm abaixo da mediana delas.
 * `null` com menos de 60 s de leitura, sem candidato ou fora do plausível: aí
 * vale o caminho andando.
 */
export function stillRest(beats: readonly StillBeat[], previous: readonly number[] = []): number | null {
  if (!beats.length || coveredMs(beats) < STILL_MIN_MS) return null;
  const scored = scoreRr(beats);
  const end = beats[beats.length - 1].at;
  let lowest: number | null = null;
  for (let top = end; top - STILL_MEDIAN_MS >= beats[0].at - SLACK_MS; top -= STILL_MEDIAN_MS) {
    const s = segment(beats, scored, firstAfter(beats, top - STILL_MEDIAN_MS), firstAfter(beats, top));
    const coherent =
      s.bpm !== null &&
      s.covered >= STILL_MEDIAN_MS - SLACK_MS &&
      s.range <= STILL_RANGE_BPM &&
      s.kept.length >= SEGMENT_MIN_RR &&
      s.rrBpm !== null &&
      Math.abs(s.bpm - s.rrBpm) <= COHERENT_BPM &&
      !s.reseeded;
    if (coherent && (lowest === null || s.bpm! < lowest)) lowest = s.bpm;
  }
  if (lowest === null || !validBpm(lowest) || lowest < REST_FLOOR_BPM) return null;
  if (previous.length >= REST_HISTORY_MIN && lowest < median([...previous]) - REST_DROP_BPM) return null;
  return lowest;
}

/** A variabilidade de uma medida parado: RMSSD (ms), ln(RMSSD), os RR recebidos e a parcela descartada. */
export type StillHrv = { rmssd: number; lnRmssd: number; beats: number; rejectedShare: number };

/**
 * A HRV da janela, ou por que não há: `curta` (menos de 2 minutos parado, ou o
 * último minuto com lacuna), `sem-rr` (a cinta não mandou RR) ou `instavel`
 * (artefatos: RR descartados demais, re-semeadura do filtro, RR que não batem
 * com o BPM da cinta).
 */
export type HrvCheck =
  | { hrv: StillHrv; reason: null }
  | { hrv: null; reason: 'curta' | 'sem-rr' | 'instavel' };

/**
 * A HRV da janela parado: o RMSSD dos últimos 60 s antes de a lona andar, com
 * 2 minutos parado ou mais no total (o primeiro é de acomodação), e o ln dele.
 * Só valem as diferenças entre RR aceitos e seguidos: o par recomeça a cada
 * descarte, lacuna ou pacote sem RR. A medida é recusada com mais de 10% dos RR
 * descartados, com os aceitos cobrindo menos de 54 s, com alguma re-semeadura
 * do filtro no último minuto (um artefato sustentado vira o novo patamar e
 * passaria pelos 10%) ou com a mediana de 60000/RR a mais de 5 bpm da do BPM
 * da cinta.
 */
export function stillHrv(beats: readonly StillBeat[]): HrvCheck {
  if (!beats.length || coveredMs(beats) < HRV_STILL_MS - SLACK_MS) return { hrv: null, reason: 'curta' };
  const scored = scoreRr(beats);
  const end = beats[beats.length - 1].at;
  const from = firstAfter(beats, end - HRV_SPAN_MS);
  const s = segment(beats, scored, from, beats.length);
  if (s.covered < HRV_SPAN_MS - SLACK_MS) return { hrv: null, reason: 'curta' };
  if (!s.rrs.length) return { hrv: null, reason: 'sem-rr' };
  const rejectedShare = (s.rrs.length - s.kept.length) / s.rrs.length;
  const span = s.kept.reduce((sum, r) => sum + r.rr, 0);
  const coherent = s.bpm !== null && s.rrBpm !== null && Math.abs(s.bpm - s.rrBpm) <= COHERENT_BPM;
  if (rejectedShare > MAX_REJECTED_SHARE || span < HRV_MIN_RR_MS || s.reseeded || !coherent)
    return { hrv: null, reason: 'instavel' };
  let sum = 0;
  let pairs = 0;
  for (let j = 1; j < s.rrs.length; j++) {
    const [a, b] = [s.rrs[j - 1], s.rrs[j]];
    if (b.follows && a.verdict === 'aceito' && b.verdict === 'aceito') {
      sum += (b.rr - a.rr) ** 2;
      pairs++;
    }
  }
  if (pairs < HRV_MIN_PAIRS || !(sum > 0)) return { hrv: null, reason: 'instavel' };
  const value = Math.sqrt(sum / pairs);
  return {
    hrv: {
      rmssd: round(value, 1),
      lnRmssd: round(Math.log(value), 3),
      beats: s.rrs.length,
      rejectedShare: round(rejectedShare, 3),
    },
    reason: null,
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

/** Um treino de 1 minuto ou mais em movimento na esteira de verdade: quando começou e terminou. */
export type Effort = { started: number; ended: number };

/** Os esforços do histórico: treinos encerrados da esteira de verdade com 1 minuto ou mais em movimento. */
export function efforts(history: readonly Workout[]): Effort[] {
  return history.flatMap((w) =>
    w.source === 'ble' && w.ended && w.totals.movingMs >= EFFORT_MS ? [{ started: w.started, ended: w.ended }] : [],
  );
}

/** Quanto falta, em ms, para a janela parado voltar a coletar depois do último esforço; 0 sem espera. */
export function stillWait(list: readonly Effort[], now: number): number {
  const ended = Math.max(-Infinity, ...list.map((e) => e.ended));
  return Math.max(0, ended + POST_EFFORT_MS - now);
}

/**
 * Por que a prontidão de hoje não seria gravada agora: `antes-do-treino`, já
 * há a medida de hoje e um treino começou depois dela (a prontidão de hoje só
 * vale antes do treino); `depois-do-treino`, um treino terminou há menos de 3
 * horas (a HRV ainda está deprimida), até `until`. `null` sem trava. A janela
 * de 3 horas, e não o dia de calendário, vale também na virada do dia.
 */
export type ReadinessLock =
  | { reason: 'antes-do-treino' }
  | { reason: 'depois-do-treino'; until: number }
  | null;

export function readinessLock(
  list: readonly Effort[],
  records: readonly ReadinessRecord[],
  now: number,
): ReadinessLock {
  const today = dayKey(now);
  const measured = records.filter((r) => r.day === today);
  const first = measured.length ? Math.min(...measured.map((r) => r.at)) : null;
  if (first !== null && list.some((e) => e.started > first && e.started <= now)) return { reason: 'antes-do-treino' };
  const ended = Math.max(-Infinity, ...list.map((e) => e.ended));
  if (now - ended < READINESS_AFTER_EFFORT_MS) return { reason: 'depois-do-treino', until: ended + READINESS_AFTER_EFFORT_MS };
  return null;
}
