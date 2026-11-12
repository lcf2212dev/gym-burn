import { StyleSheet, Text, View } from 'react-native';

import { Surface } from '@/components/surface';
import { LabelType, NumeralType, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import {
  EMPTY_VALUE,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatKilometers,
  formatPace,
} from '@/utils/format';

interface Metric {
  value: string;
  label: string;
}

/**
 * Sexta medida: a velocidade média; se a esteira não a envia, o ganho de
 * elevação; depois os METs.
 */
function extraMetric(metrics: TreadmillMetrics): Metric {
  if (metrics.averageSpeedKmh !== null) {
    return { value: formatDecimal(metrics.averageSpeedKmh, 1), label: 'km/h médios' };
  }
  if (metrics.positiveElevationGainM !== null) {
    return { value: formatInteger(metrics.positiveElevationGainM), label: 'm de subida' };
  }
  if (metrics.metabolicEquivalent !== null) {
    return { value: formatDecimal(metrics.metabolicEquivalent, 1), label: 'METs' };
  }
  return { value: EMPTY_VALUE, label: 'km/h médios' };
}

function buildMetrics(metrics: TreadmillMetrics): Metric[] {
  const heartRate = metrics.heartRateBpm ? formatInteger(metrics.heartRateBpm) : EMPTY_VALUE;
  return [
    { value: formatDuration(metrics.elapsedTimeS), label: 'tempo' },
    { value: formatKilometers(metrics.distanceM), label: 'km' },
    { value: formatInteger(metrics.energyKcal), label: 'kcal' },
    { value: formatPace(metrics.speedKmh), label: 'min/km' },
    { value: heartRate, label: 'bpm' },
    extraMetric(metrics),
  ];
}

const COLUMNS = 3;

/**
 * Grade 3 × 2 das medidas do treino: cada leitura num cartão pequeno de
 * grafite, sem fios divisores. O valor é o que se lê de longe; o rótulo fica
 * miúdo, em caixa alta.
 */
export function MetricGrid({ metrics }: { metrics: TreadmillMetrics }) {
  const theme = useTheme();
  const items = buildMetrics(metrics);
  const rows = [items.slice(0, COLUMNS), items.slice(COLUMNS)];

  return (
    <View style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((item) => (
            <Surface
              key={item.label}
              accessible
              accessibilityLabel={`${item.label}: ${item.value}`}
              style={styles.cell}>
              <Text
                style={[
                  styles.value,
                  NumeralType,
                  { color: item.value === EMPTY_VALUE ? theme.textMuted : theme.text },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}>
                {item.value}
              </Text>
              <Text style={[styles.label, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
                {item.label}
              </Text>
            </Surface>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  cell: {
    flex: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two + Spacing.half,
  },
  value: {
    fontSize: 32,
    lineHeight: 36,
  },
  label: {
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 1.3,
  },
});
