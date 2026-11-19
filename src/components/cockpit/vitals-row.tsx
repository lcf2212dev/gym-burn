import { StyleSheet, Text, View } from 'react-native';
import { Card } from '@/components/card';
import { IconLabel, type IconName } from '@/components/cockpit/icon-label';
import { Colors, Metric, NumeralType } from '@/constants/theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import { formatDecimal, formatInteger } from '@/utils/format';

/** Os três números que se leem de longe, cada um com a unidade ao lado. */
export function VitalsRow({ metrics }: { metrics: TreadmillMetrics }) {
  const stats: { icon: IconName; label: string; value: string; unit: string; color: string }[] = [
    {
      icon: 'gauge',
      label: 'Velocidade',
      value: formatDecimal(metrics.speedKmh, 1),
      unit: 'km/h',
      color: Metric.speed,
    },
    {
      icon: 'trending-up',
      label: 'Inclinação',
      value: formatDecimal(metrics.inclinationPercent, 1),
      unit: '%',
      color: Metric.incline,
    },
    {
      icon: 'heart-pulse',
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
          <IconLabel icon={s.icon} label={s.label} color={s.color} />
          <View style={styles.valueRow}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.value, { color: s.color }]}>
              {s.value}
            </Text>
            <Text style={styles.unit}>{s.unit}</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}
const styles = StyleSheet.create({
  card: { flexDirection: 'row', paddingVertical: 10 },
  stat: { flex: 1, paddingHorizontal: 14, gap: 2 },
  divider: { borderLeftWidth: 1, borderColor: Colors.dark.border },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { ...NumeralType, fontSize: 43, lineHeight: 46, flexShrink: 1 },
  unit: { fontSize: 12, color: Colors.dark.textSecondary },
});
