import { Lucide } from '@react-native-vector-icons/lucide';
import { StyleSheet, Text, View } from 'react-native';
import { Card } from '@/components/card';
import { IconLabel, type IconName } from '@/components/cockpit/icon-label';
import { Colors, Metric, Neon, NumeralType, neonGlow } from '@/constants/theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import { formatDecimal } from '@/utils/format';
import { gaitLine, gaitSpoken, onTarget } from '@/workouts/briefing';
import { useWorkout } from '@/workouts/context';
import { currentCue } from '@/workouts/model';

/**
 * A carga de agora, lida da esteira: velocidade e inclinação, cada uma na sua
 * cor. No treino guiado o alvo da etapa vai ao lado do rótulo, em verde quando
 * a esteira já está nele e em âmbar enquanto falta ajustar no painel. Com a
 * cadência da X2 Pro, o bloco de velocidade ganha um rodapé com a cadência e
 * a passada, sem crescer: os dois blocos apertam o respiro de cima e de baixo
 * para caber a linha.
 */
export function LoadTiles({ metrics }: { metrics: TreadmillMetrics }) {
  const active = useWorkout((s) => s.active);
  const gait = useWorkout((s) => s.gait);
  const elapsed = Math.floor((active?.totals.movingMs ?? 0) / 1000);
  const stage = active?.plan ? currentCue(active.plan, elapsed)?.stage : undefined;
  const footer = gaitLine(gait);
  const tiles: {
    icon: IconName;
    label: string;
    value: number | null;
    target: number | null;
    unit: string;
    spoken: string;
    color: string;
    footer?: string | null;
    footerSpoken?: string;
  }[] = [
    {
      icon: 'gauge',
      label: 'Velocidade',
      value: metrics.speedKmh,
      target: stage?.speed ?? null,
      unit: 'km/h',
      spoken: 'quilômetros por hora',
      color: Metric.speed,
      footer,
      footerSpoken: gaitSpoken(gait),
    },
    {
      icon: 'trending-up',
      label: 'Inclinação',
      value: metrics.inclinationPercent,
      target: stage?.incline ?? null,
      unit: '%',
      spoken: 'por cento',
      color: Metric.incline,
    },
  ];
  return (
    <View style={styles.row}>
      {tiles.map((tile) => {
        const hit = onTarget(tile.value, tile.target);
        const tone = hit ? Neon.mint : Neon.amber;
        const value = formatDecimal(tile.value, 1);
        return (
          <Card
            key={tile.icon}
            padded={false}
            accent={tile.color}
            style={[styles.tile, !!footer && styles.tight]}>
            <View
              accessible
              accessibilityLabel={
                tile.label +
                ' ' +
                value +
                ' ' +
                tile.spoken +
                (tile.target === null
                  ? ''
                  : ', alvo ' + formatDecimal(tile.target, 1) + (hit ? ', no alvo' : ', fora do alvo')) +
                (tile.footerSpoken ?? '')
              }>
              <View style={styles.head}>
                <IconLabel icon={tile.icon} label={tile.label} color={tile.color} />
                {tile.target !== null && (
                  <View style={styles.target}>
                    {hit && <Lucide name="check" size={13} color={tone} />}
                    <Text style={[styles.targetText, { color: tone }]}>
                      alvo {formatDecimal(tile.target, 1)}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.valueRow}>
                <Text
                  style={[
                    styles.value,
                    !!footer && styles.valueTight,
                    { color: tile.color },
                    neonGlow(tile.color, 18, 0.3),
                  ]}>
                  {value}
                </Text>
                <Text style={styles.unit}>{tile.unit}</Text>
              </View>
              {!!tile.footer && (
                <Text style={styles.footer} numberOfLines={1}>
                  {tile.footer}
                </Text>
              )}
            </View>
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  // O rótulo e o alvo em cima, o número embaixo: os dois blocos ficam com o
  // número do mesmo tamanho em qualquer largura de tela.
  tile: { flex: 1, paddingHorizontal: 14, paddingVertical: 9 },
  // Com o rodapé da cadência (13 de altura), a altura fica a mesma: 3 a menos
  // em cima, 8 embaixo e 2 na linha do número. Vale para os dois blocos, para
  // os números continuarem na mesma altura.
  tight: { paddingTop: 6, paddingBottom: 1 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  target: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  targetText: { fontSize: 12, lineHeight: 16 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  value: { ...NumeralType, fontSize: 46, lineHeight: 48 },
  valueTight: { lineHeight: 46 },
  unit: { fontSize: 13, color: Colors.dark.textSecondary },
  footer: { fontSize: 11, lineHeight: 13, color: Colors.dark.textSecondary },
});
