import { StyleSheet, Text, View } from 'react-native';

import { Fonts, Spacing } from '@/constants/theme';
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

/** Grade 3 × 2 das medidas do treino, separadas por fios. */
export function MetricGrid({ metrics }: { metrics: TreadmillMetrics }) {
  const theme = useTheme();
  const items = buildMetrics(metrics);
  const rows = [items.slice(0, COLUMNS), items.slice(COLUMNS)];

  return (
    <View style={[styles.grid, { borderColor: theme.border }]}>
      {rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          style={[styles.row, rowIndex > 0 && styles.rowDivider, { borderColor: theme.border }]}>
          {row.map((item, columnIndex) => (
            <View
              key={item.label}
              accessible
              accessibilityLabel={`${item.label}: ${item.value}`}
              style={[
                styles.cell,
                columnIndex > 0 && styles.cellDivider,
                { borderColor: theme.border },
              ]}>
              <Text
                style={[styles.value, { color: theme.text }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}>
                {item.value}
              </Text>
              <Text style={[styles.label, { color: theme.textSecondary }]} numberOfLines={1}>
                {item.label}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  row: {
    flexDirection: 'row',
  },
  rowDivider: {
    borderTopWidth: 1,
  },
  cell: {
    flex: 1,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  cellDivider: {
    borderLeftWidth: 1,
  },
  value: {
    fontFamily: Fonts.numeral,
    fontSize: 32,
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
  },
});
