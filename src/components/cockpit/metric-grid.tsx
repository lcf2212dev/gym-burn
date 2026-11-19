import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { IconLabel, type IconName } from '@/components/cockpit/icon-label';
import { Colors, Fonts, Metric, NumeralType } from '@/constants/theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import {
  formatDecimal,
  formatDuration,
  formatInteger,
  formatKilometers,
  formatPace,
} from '@/utils/format';

interface Tile {
  icon: IconName;
  label: string;
  value: string;
  unit: string;
  color: string;
  empty: boolean;
  /** Linha pequena abaixo do valor, para um número que só dá contexto. */
  note?: string;
}

/**
 * Monta as células do treino. As seis primeiras aparecem sempre; as demais só
 * quando a esteira envia o campo: uma célula com "—" no meio de números firmes
 * parece defeito, não ausência de dado.
 */
function buildTiles(metrics: TreadmillMetrics): Tile[] {
  // Esta esteira não envia a velocidade média: o app calcula pela distância e
  // pelo tempo que ela informa.
  const average =
    metrics.averageSpeedKmh ??
    (metrics.distanceM !== null && metrics.elapsedTimeS
      ? (metrics.distanceM / metrics.elapsedTimeS) * 3.6
      : null);
  const tiles: Tile[] = [
    {
      icon: 'timer',
      label: 'Tempo',
      value: formatDuration(metrics.elapsedTimeS),
      unit: '',
      color: Metric.time,
      empty: metrics.elapsedTimeS === null,
    },
    {
      icon: 'route',
      label: 'Distância',
      value: formatKilometers(metrics.distanceM),
      unit: 'km',
      color: Metric.distance,
      empty: metrics.distanceM === null,
    },
    {
      icon: 'flame',
      label: 'Calorias',
      value: formatInteger(metrics.totalEnergyKcal),
      unit: 'kcal',
      color: Metric.energy,
      empty: metrics.totalEnergyKcal === null,
      // O gasto por hora dá o ritmo da queima sem pedir uma célula só para ele.
      note:
        metrics.energyPerHourKcal === null
          ? undefined
          : formatInteger(metrics.energyPerHourKcal) + ' kcal/h',
    },
    {
      icon: 'footprints',
      label: 'Ritmo',
      value: formatPace(metrics.speedKmh),
      unit: '/km',
      color: Metric.speed,
      empty: metrics.speedKmh === null || metrics.speedKmh < 1,
    },
    {
      icon: 'circle-gauge',
      label: 'Média',
      value: formatDecimal(average, 1),
      unit: 'km/h',
      color: Metric.speed,
      empty: average === null,
    },
    {
      icon: 'zap',
      label: 'MET',
      value: formatDecimal(metrics.metabolicEquivalent, 1),
      unit: '',
      color: Metric.energy,
      empty: metrics.metabolicEquivalent === null,
    },
  ];

  if (metrics.positiveElevationGainM !== null) {
    tiles.push({
      icon: 'mountain',
      label: 'Subida',
      value: formatDecimal(metrics.positiveElevationGainM, 1),
      unit: 'm',
      color: Metric.distance,
      empty: false,
    });
  }
  if (metrics.remainingTimeS !== null) {
    tiles.push({
      icon: 'clock',
      label: 'Restante',
      value: formatDuration(metrics.remainingTimeS),
      unit: '',
      color: Metric.time,
      empty: false,
    });
  }
  if (metrics.powerOutputW !== null) {
    tiles.push({
      icon: 'power',
      label: 'Potência',
      value: formatInteger(metrics.powerOutputW),
      unit: 'W',
      color: Metric.energy,
      empty: false,
    });
  }
  if (metrics.forceOnBeltN !== null) {
    tiles.push({
      icon: 'dumbbell',
      label: 'Força',
      value: formatInteger(metrics.forceOnBeltN),
      unit: 'N',
      color: Metric.energy,
      empty: false,
    });
  }

  return tiles;
}

const COLUMNS = 3;

/**
 * Os números do treino num cartão só, em linhas de três: menos caixas na tela
 * do que um cartão por número, e o olho acha cada um sempre no mesmo lugar.
 */
export function MetricGrid({ metrics }: { metrics: TreadmillMetrics }) {
  const tiles = buildTiles(metrics);
  const rows = Array.from({ length: Math.ceil(tiles.length / COLUMNS) }, (_, row) =>
    tiles.slice(row * COLUMNS, (row + 1) * COLUMNS),
  );

  return (
    <Card padded={false} style={styles.card}>
      {rows.map((row, r) => (
        <View key={r} style={[styles.row, r > 0 && styles.rowDivider]}>
          {Array.from({ length: COLUMNS }, (_, c) => {
            const tile = row[c];
            return (
              <View
                key={c}
                style={[styles.cell, c > 0 && styles.cellDivider]}
                accessible={!!tile}
                accessibilityLabel={
                  tile
                    ? tile.label + ' ' + tile.value + ' ' + (tile.unit === '/km' ? 'minutos por quilômetro' : tile.unit)
                    : undefined
                }>
                {tile && (
                  <>
                    <IconLabel
                      icon={tile.icon}
                      label={tile.label}
                      color={tile.empty ? '#90A0B5' : tile.color}
                    />
                    <View style={styles.valueRow}>
                      <Text
                        style={[
                          styles.value,
                          NumeralType,
                          { color: tile.empty ? '#90A0B5' : tile.color },
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
                    {!!tile.note && (
                      <Text style={styles.note} numberOfLines={1}>
                        {tile.note}
                      </Text>
                    )}
                  </>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 2 },
  row: { flexDirection: 'row', paddingVertical: 9 },
  rowDivider: { borderTopWidth: 1, borderColor: Colors.dark.border },
  cell: { flex: 1, paddingHorizontal: 14, gap: 4 },
  cellDivider: { borderLeftWidth: 1, borderColor: Colors.dark.border },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  value: {
    fontFamily: Fonts.numeral,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  // Quem encolhe quando falta espaço é o valor, nunca a unidade.
  unit: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: '#90A0B5',
  },
  note: { fontSize: 11, color: '#90A0B5' },
});
