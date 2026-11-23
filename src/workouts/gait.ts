// O passo da pessoa, pela cadência da XOSS X2 Pro. Código puro, sem Expo: a
// sessão de treino chama a cada amostra e guarda o estado.
//
// A cadência entra só no que é informativo ou de proteção: a conta das kcal
// (andando ou correndo), a passada, o "fora da lona" e o aviso de cadência
// caindo. A conta que decide a carga continua na escala por velocidade
// (`metabolicCost`): misturar as duas quebraria a reta entre carga e FC.
//
// Cadência `undefined` (sem fonte) ou `null` (consulta atrasada, download em
// curso, app em segundo plano) nunca conta como zero: zero é a cinta medindo
// que a pessoa parou de dar passos.

import type { TreadmillSample } from '@/treadmill/types';
import { median } from './model';

/** A cadência suavizada é a mediana dos últimos 10 s. */
export const CADENCE_SMOOTH_MS = 10_000;
/**
 * Passos por minuto a partir dos quais a pessoa corre, e abaixo dos quais
 * anda. Entre os dois fica o que já era: caminhada apertada e trote lento
 * passam por 140 sem trocar de equação a cada segundo.
 */
export const RUN_FROM_SPM = 145;
export const WALK_BELOW_SPM = 135;
/** O "fora da lona" só vale num bloco de esforço a partir desta velocidade. */
export const OFF_BELT_MIN_KMH = 5;
/** Tempo com a cadência em zero e a lona andando até a pessoa contar como fora dela. */
export const OFF_BELT_MS = 10_000;
/** A base do aviso de cadência caindo: o primeiro minuto do bloco numa velocidade só. */
export const CADENCE_BASE_MS = 60_000;
/** A cadência comparada com a base: a média dos últimos 30 s. */
export const CADENCE_RECENT_MS = 30_000;
/** Queda da cadência, na mesma velocidade, que dispara o aviso. */
export const CADENCE_DROP = 0.08;
/** O aviso de cadência caindo, uma vez por bloco. */
export const FATIGUE_TIP = 'Cadência caindo: passos mais curtos e rápidos';
/** O mínimo de leituras na base e nos últimos 30 s para a comparação valer. */
const CADENCE_READINGS = 20;
/** A mesma tolerância com que o guia dá a velocidade por atingida. */
const SPEED_TOLERANCE_KMH = 0.051;

const round1 = (n: number) => Math.round(n * 10) / 10;
const measured = (spm: number | null | undefined): spm is number =>
  typeof spm === 'number' && Number.isFinite(spm) && spm >= 0;

/**
 * A cadência do momento, em passos por minuto: a mediana das cadências medidas
 * nos últimos 10 s, zeros inclusive. `null` sem nenhuma medida.
 */
export function smoothCadence(samples: TreadmillSample[], now: number): number | null {
  const values = samples
    .filter((s) => s.at > now - CADENCE_SMOOTH_MS && s.at <= now)
    .map((s) => s.cadenceSpm)
    .filter(measured);
  return values.length ? Math.round(median(values)) : null;
}

/**
 * Andando (`false`) ou correndo (`true`), pela cadência suavizada, com
 * histerese: corre de 145 passos/min em diante, anda abaixo de 135, e entre os
 * dois segue como estava. Sem cadência, `null`: vale a regra por velocidade.
 */
export function stepGait(running: boolean | null, cadence: number | null): boolean | null {
  if (cadence === null) return null;
  if (cadence >= RUN_FROM_SPM) return true;
  if (cadence < WALK_BELOW_SPM) return false;
  return running ?? cadence >= (RUN_FROM_SPM + WALK_BELOW_SPM) / 2;
}

/** A passada, em metros por passo: a velocidade da lona sobre a cadência. `null` sem as duas. */
export function strideM(kmh: number | null, cadence: number | null): number | null {
  if (!kmh || kmh <= 0 || !cadence || cadence <= 0) return null;
  return Math.round(((kmh * 1000) / 60 / cadence) * 100) / 100;
}

/** O estado do "fora da lona" numa etapa. */
export type Belt = {
  stage: number;
  /** A cadência já passou de zero nesta etapa: a cinta está contando os passos. */
  seen: boolean;
  /** Desde quando a cadência está em zero, medida, com a lona a 5 km/h ou mais. */
  zeroSince: number | null;
  off: boolean;
};

export type GaitInput = {
  stage: number;
  /** A etapa é um bloco de esforço do treino guiado. */
  effort: boolean;
  at: number;
  kmh: number | null;
  spm: number | null | undefined;
};

/**
 * O "fora da lona": num bloco de esforço a 5 km/h ou mais, a cadência já foi
 * maior que zero nesta etapa e fica em zero por 10 s com a lona andando. A
 * pessoa saiu para o lado (água, toalha, celular) e a lona segue. Vale até a
 * cadência voltar. Sem cadência medida (`null`, `undefined`) não há como dizer
 * onde a pessoa está: o estado volta ao normal, para uma fonte perdida no meio
 * do treino não deixar a carga presa nem o BPM fora das contas.
 */
export function trackBelt(belt: Belt | null, input: GaitInput): Belt {
  const current = belt?.stage === input.stage ? belt : { stage: input.stage, seen: false, zeroSince: null, off: false };
  const { spm } = input;
  if (!measured(spm)) return { ...current, zeroSince: null, off: false };
  if (spm > 0) return { ...current, seen: true, zeroSince: null, off: false };
  if (!input.effort || !current.seen || (input.kmh ?? 0) < OFF_BELT_MIN_KMH)
    return { ...current, zeroSince: null, off: false };
  const zeroSince = current.zeroSince ?? input.at;
  return { ...current, zeroSince, off: input.at - zeroSince >= OFF_BELT_MS };
}

/** A cadência de um bloco de esforço, para o aviso de cadência caindo. */
export type CadenceTrend = {
  stage: number;
  /**
   * O primeiro minuto do bloco numa velocidade só: enquanto ele não fecha, uma
   * troca de velocidade (a lona ainda acelerando desde a etapa leve) recomeça a
   * base.
   */
  base: { kmh: number; from: number; sum: number; count: number } | null;
  /** As cadências dos últimos 30 s, com a velocidade de cada uma. */
  recent: { at: number; spm: number; kmh: number }[];
  /** O aviso deste bloco já saiu. */
  warned: boolean;
};

/**
 * Acumula a cadência de um bloco de esforço. Zeros (fora da lona) e cadência
 * sem valor não entram. Fora de um bloco de esforço não há nada a acompanhar.
 * `warn` é `true` na amostra em que a cadência média dos últimos 30 s cai 8% ou
 * mais abaixo da do primeiro minuto do bloco, na mesma velocidade: passos mais
 * longos e lentos são o começo da fadiga. Uma vez por bloco.
 */
export function trackCadence(trend: CadenceTrend | null, input: GaitInput) {
  let t: CadenceTrend =
    trend?.stage === input.stage ? trend : { stage: input.stage, base: null, recent: [], warned: false };
  const { spm, at } = input;
  if (!input.effort || !measured(spm) || spm <= 0 || !input.kmh || input.kmh <= 0)
    return { trend: t, warn: false };
  const kmh = round1(input.kmh);
  const base = t.base;
  const open = !!base && at - base.from < CADENCE_BASE_MS;
  t = {
    ...t,
    base:
      !base || (open && base.kmh !== kmh)
        ? { kmh, from: at, sum: spm, count: 1 }
        : open
          ? { ...base, sum: base.sum + spm, count: base.count + 1 }
          : base,
    recent: [...t.recent.filter((r) => r.at > at - CADENCE_RECENT_MS), { at, spm, kmh }],
  };
  const change = cadenceChange(t, at);
  const warn = !t.warned && change !== null && change <= -CADENCE_DROP;
  return { trend: warn ? { ...t, warned: true } : t, warn };
}

/**
 * Quanto a cadência média dos últimos 30 s mudou em relação ao primeiro minuto
 * do bloco, em fração (−0,08 = 8% a menos). `null` sem a base fechada, sem 20
 * leituras em cada lado ou com a velocidade diferente da base: com outra
 * velocidade a cadência muda sozinha.
 */
export function cadenceChange(trend: CadenceTrend | null, at: number): number | null {
  const base = trend?.base;
  if (!trend || !base || at - base.from < CADENCE_BASE_MS || base.count < CADENCE_READINGS) return null;
  const recent = trend.recent.filter((r) => r.at > at - CADENCE_RECENT_MS);
  if (recent.length < CADENCE_READINGS || recent.some((r) => Math.abs(r.kmh - base.kmh) > SPEED_TOLERANCE_KMH))
    return null;
  const mean = recent.reduce((n, r) => n + r.spm, 0) / recent.length;
  return mean / (base.sum / base.count) - 1;
}
