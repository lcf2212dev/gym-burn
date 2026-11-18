import { StyleSheet, Text, View } from 'react-native';
import { Card } from '@/components/card';
import { Colors, LabelType, Metric, NumeralType } from '@/constants/theme';
import type { TreadmillMetrics, TreadmillSample } from '@/treadmill/types';
import { formatDecimal, formatInteger } from '@/utils/format';

export function VitalsRow({
  metrics,
  samples,
}: {
  metrics: TreadmillMetrics;
  samples: TreadmillSample[];
}) {
  const pulses = samples
    .map((s) => s.heartRateBpm)
    .filter((b): b is number => b !== null)
    .slice(-24);
  const average = pulses.length
    ? Math.round(pulses.reduce((a, b) => a + b, 0) / pulses.length)
    : null;
  const stats = [
    {
      label: 'Velocidade',
      value: formatDecimal(metrics.speedKmh, 1),
      unit: 'km/h',
      color: Metric.speed,
    },
    {
      label: 'Inclinação',
      value: formatDecimal(metrics.inclinationPercent, 1),
      unit: '%',
      color: Metric.incline,
    },
    {
      label: 'Batimentos',
      value: formatInteger(metrics.heartRateBpm),
      unit: 'BPM',
      color: Metric.heart,
    },
  ];
  return (
    <Card padded={false} style={styles.card}>
      {stats.map((s, i) => (
        <View
          key={s.label}
          style={[styles.stat, i > 0 && styles.divider]}
          accessible
          accessibilityLabel={s.label + ' ' + s.value + ' ' + s.unit}>
          <Text style={styles.label}>{s.label}</Text>
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.value, { color: s.color }]}>
            {s.value}
          </Text>
          <Text style={styles.unit}>
            {s.unit}
            {i === 2 && average !== null ? ' · méd. ' + average : ''}
          </Text>
        </View>
      ))}
    </Card>
  );
}
const styles = StyleSheet.create({
  card: { flexDirection: 'row', paddingVertical: 9 },
  stat: { flex: 1, paddingHorizontal: 11 },
  divider: { borderLeftWidth: 1, borderColor: Colors.dark.border },
  label: { ...LabelType, color: Colors.dark.textSecondary, letterSpacing: 0.8 },
  value: { ...NumeralType, fontSize: 43, lineHeight: 46 },
  unit: { fontSize: 11, color: Colors.dark.textSecondary },
});
