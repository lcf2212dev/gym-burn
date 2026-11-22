import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { IconLabel, type IconName } from '@/components/cockpit/icon-label';
import { Colors, Metric, NumeralType } from '@/constants/theme';
import type { TreadmillMetrics } from '@/treadmill/types';
import { formatDuration, formatInteger, formatKilometers } from '@/utils/format';

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
 * Os três totais do treino, um cartão cada: tempo, distância e calorias. O
 * resto do que a esteira envia fica nos dados da esteira (toque longo no nome).
 */
export function MetricTiles({ metrics }: { metrics: TreadmillMetrics }) {
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
  ];
  return (
    <View style={styles.row}>
      {tiles.map((tile) => (
        <Card key={tile.icon} padded={false} style={styles.tile}>
          <View
            style={styles.cell}
            accessible
            accessibilityLabel={tile.label + ' ' + tile.value + ' ' + tile.unit}>
          <IconLabel icon={tile.icon} label={tile.label} color={tile.empty ? EMPTY : tile.color} />
          <View style={styles.valueRow}>
            <Text
              style={[styles.value, { color: tile.empty ? EMPTY : Colors.dark.text }]}
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
          </View>
        </Card>
      ))}
    </View>
  );
}

/** Cor de um número que a esteira ainda não enviou. */
const EMPTY = '#90A0B5';

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1 },
  cell: { paddingHorizontal: 12, paddingVertical: 9, gap: 2 },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  // Quem encolhe quando falta espaço é o valor, nunca a unidade.
  value: { ...NumeralType, fontSize: 26, lineHeight: 30, letterSpacing: -0.3, flexShrink: 1 },
  unit: { fontSize: 12, color: EMPTY },
  note: { fontSize: 11, color: EMPTY },
});
