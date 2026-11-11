import type { SupportedRange } from '@/ftms';

/** Passos dos botões de uma coluna de controle. */
export interface ControlSteps {
  small: number;
  big: number;
}

/** Velocidade: o menor passo da esteira (no mínimo 0,1 km/h) e 1 km/h. */
export function speedSteps(range: SupportedRange): ControlSteps {
  return { small: Math.max(range.step, 0.1), big: 1 };
}

/** Inclinação: o menor passo da esteira (no mínimo 0,5 %) e o dobro dele (no mínimo 1 %). */
export function inclinationSteps(range: SupportedRange): ControlSteps {
  const small = Math.max(range.step, 0.5);
  return { small, big: Math.max(2 * small, 1) };
}

/** Posição do valor dentro da faixa, de 0 a 1; `null` (sem dado) fica em 0. */
export function rangeFraction(value: number | null, range: SupportedRange): number {
  const span = range.max - range.min;
  if (value === null || !Number.isFinite(value) || span <= 0) {
    return 0;
  }
  return Math.min(Math.max((value - range.min) / span, 0), 1);
}

/**
 * Se a linha "alvo" deve aparecer: há alvo e ele difere do valor medido em mais
 * de meio passo. Sem valor medido, o alvo é a única informação e aparece.
 */
export function showsTarget(target: number | null, measured: number | null, step: number): boolean {
  if (target === null) {
    return false;
  }
  if (measured === null) {
    return true;
  }
  return Math.abs(target - measured) > step / 2;
}

/** A lona está em movimento segundo a última velocidade medida. */
export function isBeltMoving(speedKmh: number | null): boolean {
  return speedKmh !== null && speedKmh > 0;
}

/** Força do sinal em palavras; `null` quando o rádio não informou o RSSI. */
export function signalLabel(rssi: number | null): string | null {
  if (rssi === null) {
    return null;
  }
  if (rssi >= -60) {
    return 'sinal forte';
  }
  if (rssi >= -80) {
    return 'sinal médio';
  }
  return 'sinal fraco';
}
