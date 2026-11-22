import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Polygon } from 'react-native-svg';

import { AimColor, Colors, NumeralType, ZoneColors, withAlpha } from '@/constants/theme';
import { arcPath, arrowPoints, gaugeAngle, gaugePieces, gaugeShare, polar } from '@/workouts/gauge';
import type { Zone } from '@/workouts/model';

/** Folga, em graus, de cada lado de uma fronteira de zona. */
const GAP = 0.9;
/** Tamanho da seta que marca a leitura de agora. */
const ARROW = 22;
/** Margem em volta do arco: com a seta, cabe ela inteira em qualquer ponto da escala. */
const MARGIN = { still: 12, live: ARROW + 8 };

/**
 * O medidor em arco das zonas de frequência cardíaca, de 50% a 100% da FC
 * máxima. A faixa do dia fica acesa na cor da zona e a mira, dentro dela, num
 * vermelho mais vivo. Com `bpm` (mesmo `null`, sem leitura) o medidor é o do
 * treino: uma seta do lado de fora aponta a leitura de agora e o que ficou
 * abaixo dela acende. O conteúdo do centro vem de quem usa.
 */
export function ZoneGauge({
  max,
  band,
  aim,
  bpm,
  tone = Colors.dark.text,
  caption,
  maxWidth = 380,
  children,
}: {
  max: number;
  band: Zone;
  aim?: Zone | null;
  bpm?: number | null;
  /** Cor da seta: a do estado da leitura. */
  tone?: string;
  /** Linha sob o arco, entre os dois extremos da escala. */
  caption?: string;
  /** Largura máxima do medidor: quem tem pouca altura de tela pede um arco menor. */
  maxWidth?: number;
  children?: ReactNode;
}) {
  const [measured, setMeasured] = useState(0);
  const live = bpm !== undefined;
  const width = Math.min(measured, maxWidth);
  const margin = live ? MARGIN.live : MARGIN.still;
  const outer = Math.max(width / 2 - margin, 0);
  const thickness = outer * 0.14;
  const radius = outer - thickness / 2;
  const [cx, cy] = [width / 2, outer + margin];
  // O arco desce 20 graus abaixo do centro; embaixo dele vai a linha dos extremos.
  const foot = cy + outer * 0.342;
  const height = foot + 26;
  const angle = (percent: number) => gaugeAngle((percent - 50) / 50);
  const pieces = gaugePieces(max, band, aim, bpm);
  const lit = new Set(pieces.filter((p) => p.kind === 'band' || p.kind === 'aim').map((p) => p.zone));
  const arcs = pieces.map((piece) => {
    const edge = (percent: number, side: 1 | -1) =>
      angle(percent) + (percent % 10 === 0 ? side * GAP : 0);
    const d = arcPath(cx, cy, radius, edge(piece.from, 1), edge(piece.to, -1));
    const color = piece.kind === 'aim' ? AimColor : ZoneColors[piece.zone];
    // Com a mira acesa e sem leitura, a faixa recua um pouco para ela aparecer.
    const opacity =
      piece.kind === 'idle' ? 0.26 : piece.kind === 'passed' ? 0.7 : piece.kind === 'band' && aim && !live ? 0.55 : 1;
    const glows = piece.kind === 'aim' || (piece.kind === 'band' && !aim);
    return { key: piece.from + piece.kind, d, color, opacity, glows };
  });
  const arrow =
    live && bpm !== null ? arrowPoints(cx, cy, outer + 5, gaugeAngle(gaugeShare(bpm, max)), ARROW) : null;
  const ends = [polar(cx, cy, radius, angle(50)), polar(cx, cy, radius, angle(100))];

  return (
    <View
      style={[styles.box, { height: width ? height : 220 }]}
      onLayout={(event) => setMeasured(event.nativeEvent.layout.width)}>
      {width > 0 && (
        <View style={{ width, height }}>
          <Svg width={width} height={height}>
            <Path
              d={arcPath(cx, cy, outer + 7, angle(50), angle(100))}
              stroke={withAlpha('#FFFFFF', 0.05)}
              strokeWidth={8}
              fill="none"
            />
            {/* O brilho de neon é o próprio trecho, mais largo e quase transparente, por baixo. */}
            {arcs
              .filter((arc) => arc.glows)
              .flatMap((arc) =>
                [
                  [thickness + 22, 0.07],
                  [thickness + 10, 0.16],
                ].map(([weight, alpha]) => (
                  <Path
                    key={arc.key + weight}
                    d={arc.d}
                    stroke={arc.color}
                    strokeOpacity={alpha}
                    strokeWidth={weight}
                    fill="none"
                  />
                )),
              )}
            {arcs.map((arc) => (
              <Path
                key={arc.key}
                d={arc.d}
                stroke={arc.color}
                strokeOpacity={arc.opacity}
                strokeWidth={thickness}
                fill="none"
              />
            ))}
            {arrow && (
              <>
                <Polygon
                  points={arrow}
                  fill={tone}
                  fillOpacity={0.25}
                  stroke={tone}
                  strokeOpacity={0.25}
                  strokeWidth={11}
                  strokeLinejoin="round"
                />
                <Polygon points={arrow} fill={tone} stroke={tone} strokeWidth={3} strokeLinejoin="round" />
              </>
            )}
          </Svg>
          {ZoneColors.map((_, zone) => {
            const at = polar(cx, cy, outer - thickness - 17, angle(55 + zone * 10));
            return (
              <Text
                key={zone}
                style={[styles.zone, { left: at.x - 16, top: at.y - 9 }, lit.has(zone) && styles.zoneLit]}>
                Z{zone + 1}
              </Text>
            );
          })}
          <View style={[styles.center, { top: cy - outer * 0.56, height: outer * 0.92 }]}>{children}</View>
          <Text style={[styles.end, { left: ends[0].x - 30, top: foot + 6 }]}>
            {Math.round(max / 2)}
          </Text>
          <Text style={[styles.end, { left: ends[1].x - 30, top: foot + 6 }]}>{max}</Text>
          {!!caption && (
            <Text style={[styles.caption, { top: foot + 6 }]} numberOfLines={1}>
              {caption}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: 'stretch', alignItems: 'center' },
  zone: {
    ...NumeralType,
    position: 'absolute',
    width: 32,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 18,
    color: Colors.dark.textSecondary,
  },
  zoneLit: { color: Colors.dark.text },
  center: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  end: {
    ...NumeralType,
    position: 'absolute',
    width: 60,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 16,
    color: Colors.dark.textSecondary,
  },
  caption: {
    position: 'absolute',
    left: 56,
    right: 56,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 16,
    color: Colors.dark.textSecondary,
  },
});
