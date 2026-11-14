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

interface Cell {
  value: string;
  unit: string;
  label: string;
  empty: boolean;
}

function heroCells(metrics: TreadmillMetrics): Cell[] {
  const speed = metrics.speedKmh;
  const incline = metrics.inclinationPercent;
  const heartRate = metrics.heartRateBpm;
  return [
    {
      value: speed === null ? EMPTY_VALUE : formatDecimal(speed, 1),
      unit: 'km/h',
      label: 'velocidade',
      empty: speed === null,
    },
    {
      value: incline === null ? EMPTY_VALUE : formatDecimal(incline, 1),
      unit: '%',
      label: 'inclinação',
      empty: incline === null,
    },
    {
      value: heartRate === null || heartRate <= 0 ? EMPTY_VALUE : formatInteger(heartRate),
      unit: 'bpm',
      label: 'batimentos',
      empty: heartRate === null || heartRate <= 0,
    },
  ];
}

function detailCells(metrics: TreadmillMetrics): Cell[] {
  return [
    {
      value: formatDuration(metrics.elapsedTimeS),
      unit: '',
      label: 'tempo',
      empty: metrics.elapsedTimeS === null,
    },
    {
      value: formatKilometers(metrics.distanceM),
      unit: 'km',
      label: 'distância',
      empty: metrics.distanceM === null,
    },
    {
      value: formatInteger(metrics.energyKcal),
      unit: 'kcal',
      label: 'calorias',
      empty: metrics.energyKcal === null,
    },
    {
      value: formatPace(metrics.speedKmh),
      unit: 'min/km',
      label: 'ritmo',
      empty: metrics.speedKmh === null || metrics.speedKmh <= 0,
    },
  ];
}

function HeroCell({ cell }: { cell: Cell }) {
  const theme = useTheme();
  return (
    <Surface accessible accessibilityLabel={`${cell.label}: ${cell.value} ${cell.unit}`} style={styles.heroCell}>
      <View style={styles.valueRow}>
        <Text
          style={[styles.heroValue, NumeralType, { color: cell.empty ? theme.textMuted : theme.text }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.55}>
          {cell.value}
        </Text>
        {cell.unit ? (
          <Text style={[styles.unit, { color: theme.textSecondary }]} numberOfLines={1}>
            {cell.unit}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.label, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
        {cell.label}
      </Text>
    </Surface>
  );
}

function DetailCell({ cell }: { cell: Cell }) {
  const theme = useTheme();
  return (
    <Surface accessible accessibilityLabel={`${cell.label}: ${cell.value} ${cell.unit}`} style={styles.detailCell}>
      <View style={styles.valueRow}>
        <Text
          style={[styles.detailValue, NumeralType, { color: cell.empty ? theme.textMuted : theme.text }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}>
          {cell.value}
        </Text>
        {cell.unit ? (
          <Text style={[styles.unit, { color: theme.textSecondary }]} numberOfLines={1}>
            {cell.unit}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.label, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
        {cell.label}
      </Text>
    </Surface>
  );
}

/**
 * Painel de monitoramento no topo do treino: velocidade, inclinação e
 * batimentos em números grandes (o que se lê de longe) e as demais medidas
 * logo abaixo, menores.
 */
export function MonitorPanel({ metrics }: { metrics: TreadmillMetrics }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.heroRow}>
        {heroCells(metrics).map((cell) => (
          <HeroCell key={cell.label} cell={cell} />
        ))}
      </View>
      <View style={styles.detailRow}>
        {detailCells(metrics).map((cell) => (
          <DetailCell key={cell.label} cell={cell} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.two,
  },
  heroRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  detailRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  heroCell: {
    flex: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingVertical: Spacing.three,
    minHeight: 118,
    justifyContent: 'space-between',
  },
  detailCell: {
    flex: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    minHeight: 74,
    justifyContent: 'space-between',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  heroValue: {
    fontSize: 46,
    lineHeight: 50,
  },
  detailValue: {
    fontSize: 27,
    lineHeight: 31,
  },
  unit: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
  },
  label: {
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 1.3,
  },
});
