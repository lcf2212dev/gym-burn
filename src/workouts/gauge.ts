// A geometria do medidor em arco das zonas de frequência cardíaca: a escala
// vai de 50% a 100% da FC máxima, como o gráfico de zonas, e abre 220 graus.
// Aqui só há conta; quem desenha é `components/zones/zone-gauge.tsx`.

import type { Zone } from './model';

/** Ângulo do começo da escala, em graus: zero é a direita do centro e o sentido é o horário. */
export const GAUGE_START = -200;
export const GAUGE_SWEEP = 220;
/** Menos que isto de uma fronteira de zona, em pontos da FC máxima, a faixa gruda nela. */
const SNAP = 0.5;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Posição de um BPM na escala, de 0 (50% da FC máxima) a 1 (100%). */
export function gaugeShare(bpm: number, max: number) {
  return clamp((bpm - max / 2) / (max / 2), 0, 1);
}

export const gaugeAngle = (share: number) => GAUGE_START + share * GAUGE_SWEEP;

/**
 * Um trecho do arco, em % da FC máxima. `idle` é a zona apagada, `passed` o
 * que já ficou abaixo da leitura de agora, `band` a faixa do dia e `aim` a
 * mira dentro dela.
 */
export type GaugePiece = {
  from: number;
  to: number;
  /** Índice da zona, de 0 (Z1) a 4 (Z5): é ela que dá a cor do trecho. */
  zone: number;
  kind: 'idle' | 'passed' | 'band' | 'aim';
};

/**
 * Os trechos do arco, do começo ao fim da escala e sem buraco. A faixa e a
 * mira ficam inteiras com qualquer leitura: quem mostra o batimento de agora é
 * a seta, do lado de fora.
 */
export function gaugePieces(max: number, band: Zone, aim?: Zone | null, bpm?: number | null) {
  const percent = (value: number) => {
    const raw = clamp((value / max) * 100, 50, 100);
    const edge = Math.round(raw / 10) * 10;
    return Math.abs(raw - edge) < SNAP ? edge : raw;
  };
  const [low, high] = [percent(band.low), percent(band.high)];
  const [aimLow, aimHigh] = aim ? [percent(aim.low), percent(aim.high)] : [0, 0];
  const now = bpm == null ? null : clamp((bpm / max) * 100, 50, 100);
  const cuts = [50, 60, 70, 80, 90, 100, low, high, aimLow, aimHigh, ...(now === null ? [] : [now])]
    .filter((cut) => cut >= 50)
    .sort((a, b) => a - b);
  const pieces: GaugePiece[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const [from, to] = [cuts[i - 1], cuts[i]];
    if (to - from < 1e-6) continue;
    const middle = (from + to) / 2;
    const zone = Math.min(4, Math.floor((middle - 50) / 10));
    const kind =
      middle > aimLow && middle < aimHigh
        ? 'aim'
        : middle > low && middle < high
          ? 'band'
          : now !== null && middle < now
            ? 'passed'
            : 'idle';
    const last = pieces[pieces.length - 1];
    if (last && last.zone === zone && last.kind === kind) last.to = to;
    else pieces.push({ from, to, zone, kind });
  }
  return pieces;
}

/** Ponto a `r` do centro no ângulo dado, em graus. */
export function polar(cx: number, cy: number, r: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
}

/** Caminho SVG de um arco de círculo, no sentido horário. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const [start, end] = [polar(cx, cy, r, from), polar(cx, cy, r, to)];
  const large = to - from > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * Os quatro pontos da seta que marca a leitura de agora: a ponta encosta no
 * raio `r`, do lado de fora do arco, e o corpo se afasta dele por `size`.
 */
export function arrowPoints(cx: number, cy: number, r: number, degrees: number, size: number) {
  const radians = (degrees * Math.PI) / 180;
  const [ux, uy] = [Math.cos(radians), Math.sin(radians)];
  const at = (along: number, across: number) =>
    [cx + along * ux - across * uy, cy + along * uy + across * ux]
      .map((value) => Number(value.toFixed(2)) || 0)
      .join(',');
  return [at(r, 0), at(r + size, size / 2), at(r + size * 0.74, 0), at(r + size, -size / 2)].join(' ');
}
