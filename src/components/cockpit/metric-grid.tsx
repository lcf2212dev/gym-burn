import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { Fonts, LabelType, Metric, NumeralType, Spacing, withAlpha } from '@/constants/theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import {
  formatDecimal,
  formatDuration,
  formatInteger,
  formatKilometers,
  formatPace,
} from '@/utils/format';

interface Tile {
  label: string;
  value: string;
  unit: string;
  color: string;
  empty: boolean;
}

/**
 * Monta os cartões do treino. Só aparecem os campos que a esteira realmente
 * enviou: um cartão com "—" no meio de números firmes parece defeito, não
 * ausência de dado — a lista completa, com o que não veio, fica em "Dados".
 */
function buildTiles(metrics: TreadmillMetrics): Tile[] {
  const tiles: Tile[] = [
    {
      label: 'Tempo',
      value: formatDuration(metrics.elapsedTimeS),
      unit: '',
      color: Metric.time,
      empty: metrics.elapsedTimeS === null,
    },
    {
      label: 'Distância',
      value: formatKilometers(metrics.distanceM),
      unit: 'km',
      color: Metric.distance,
      empty: metrics.distanceM === null,
    },
    {
      label: 'Calorias',
      value: formatInteger(metrics.totalEnergyKcal),
      unit: 'kcal',
      color: Metric.energy,
      empty: metrics.totalEnergyKcal === null,
    },
    {
      label: 'Ritmo',
      value: formatPace(metrics.speedKmh),
      unit: 'min/km',
      color: Metric.speed,
      empty: metrics.speedKmh === null || metrics.speedKmh < 1,
    },
    {
      label: 'Média',
      value: formatDecimal(metrics.averageSpeedKmh, 1),
      unit: 'km/h',
      color: Metric.speed,
      empty: metrics.averageSpeedKmh === null,
    },
    {
      label: 'MET',
      value: formatDecimal(metrics.metabolicEquivalent, 1),
      unit: '',
      color: Metric.energy,
      empty: metrics.metabolicEquivalent === null,
    },
    {
      label: 'Energia',
      value: formatInteger(metrics.energyPerHourKcal),
      unit: 'kcal/h',
      color: Metric.energy,
      empty: metrics.energyPerHourKcal === null,
    },
    {
      label: 'Por minuto',
      value: formatInteger(metrics.energyPerMinuteKcal),
      unit: 'kcal/min',
      color: Metric.energy,
      empty: metrics.energyPerMinuteKcal === null,
    },
  ];

  if (metrics.positiveElevationGainM !== null) {
    tiles.push({
      label: 'Subida',
      value: formatDecimal(metrics.positiveElevationGainM, 1),
      unit: 'm',
      color: Metric.distance,
      empty: false,
    });
  }
  if (metrics.remainingTimeS !== null) {
    tiles.push({
      label: 'Restante',
      value: formatDuration(metrics.remainingTimeS),
      unit: '',
      color: Metric.time,
      empty: false,
    });
  }
  if (metrics.powerOutputW !== null) {
    tiles.push({
      label: 'Potência',
      value: formatInteger(metrics.powerOutputW),
      unit: 'W',
      color: Metric.energy,
      empty: false,
    });
  }
  if (metrics.forceOnBeltN !== null) {
    tiles.push({
      label: 'Força',
      value: formatInteger(metrics.forceOnBeltN),
      unit: 'N',
      color: Metric.energy,
      empty: false,
    });
  }

  return tiles;
}

/** Grade de números do treino: o "painel de instrumentos" abaixo do gráfico. */
export function MetricGrid({ metrics }: { metrics: TreadmillMetrics }) {
  const tiles = buildTiles(metrics);

  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <Card
          key={tile.label}
          padded={false}
          style={styles.tile}
          accent={tile.empty ? undefined : tile.color}>
          <Text style={[styles.label, LabelType]} numberOfLines={1}>
            {tile.label}
          </Text>
          <View style={styles.valueRow}>
            <Text
              style={[
                styles.value,
                NumeralType,
                { color: tile.empty ? '#5C687A' : tile.color },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}>
              {tile.value}
            </Text>
            {tile.unit ? (
              <Text style={styles.unit} numberOfLines={1}>
                {tile.unit}
              </Text>
            ) : null}
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  tile: {
    width: '31.5%',
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.two + 2,
    minHeight: 76,
    justifyContent: 'space-between',
    backgroundColor: withAlpha('#121823', 0.6),
  },
  label: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1,
    color: '#9AA7B8',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
    marginTop: Spacing.two,
  },
  value: {
    fontFamily: Fonts.numeral,
    fontSize: 25,
    lineHeight: 27,
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  unit: {
    fontFamily: Fonts.body,
    fontSize: 9,
    color: '#5C687A',
    flexShrink: 1,
  },
});
