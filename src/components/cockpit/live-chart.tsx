import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Kicker } from '@/components/card';
import {
  ChartHeight,
  ChartSampleCount,
  Fonts,
  LabelType,
  Metric,
  NumeralType,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import type { TreadmillMetrics, TreadmillSample } from '@/treadmill/types';
import { EMPTY_VALUE, formatDecimal } from '@/utils/format';

type SeriesKey = 'speed' | 'incline' | 'heart';

interface SeriesDef {
  key: SeriesKey;
  label: string;
  short: string;
  unit: string;
  color: string;
  /** Fundo mínimo do gráfico: sem isso uma esteira a 5 km/h viraria uma parede. */
  floor: number;
  /** Passo para arredondar o fundo. */
  step: number;
  digits: number;
  read: (metrics: TreadmillMetrics) => number | null;
  readSample: (sample: TreadmillSample) => number | null;
}

const SERIES: readonly SeriesDef[] = [
  {
    key: 'speed',
    label: 'Velocidade',
    short: 'VEL',
    unit: 'km/h',
    color: Metric.speed,
    floor: 6,
    step: 1,
    digits: 1,
    read: (m) => m.speedKmh,
    readSample: (s) => s.speedKmh,
  },
  {
    key: 'incline',
    label: 'Inclinação',
    short: 'INCL',
    unit: '%',
    color: Metric.incline,
    floor: 5,
    step: 0.5,
    digits: 1,
    read: (m) => m.inclinationPercent,
    readSample: (s) => s.inclinationPercent,
  },
  {
    key: 'heart',
    label: 'Batimentos',
    short: 'BPM',
    unit: 'bpm',
    color: Metric.heart,
    floor: 100,
    step: 10,
    digits: 0,
    read: (m) => m.heartRateBpm,
    readSample: (s) => s.heartRateBpm,
  },
];

/**
 * Gráfico ao vivo: uma barra por segundo, do mais antigo (esquerda) ao agora
 * (direita). O fundo se ajusta ao que já chegou, então andar devagar ou subir
 * uma lombada continua legível.
 */
export function LiveChart({
  samples,
  metrics,
}: {
  samples: TreadmillSample[];
  metrics: TreadmillMetrics;
}) {
  const [selected, setSelected] = useState<SeriesKey>('speed');
  const series = SERIES.find((item) => item.key === selected) ?? SERIES[0];

  const recent = useMemo(() => samples.slice(-ChartSampleCount), [samples]);

  const values = useMemo(
    () =>
      recent
        .map((sample) => series.readSample(sample))
        .filter((value): value is number => value !== null),
    [recent, series],
  );

  const observedMax = values.length > 0 ? Math.max(...values) : 0;
  const domain = Math.max(
    series.floor,
    Math.ceil((observedMax * 1.15) / series.step) * series.step,
  );
  const observedMin = values.length > 0 ? Math.min(...values) : null;
  const max = values.length > 0 ? observedMax : null;

  // Os espaços da esquerda ficam vazios até o gráfico encher: as barras nascem
  // na direita, como um registro que começa a correr.
  const emptySlots = Math.max(0, ChartSampleCount - recent.length);
  const current = series.read(metrics);

  return (
    <Card accent={series.color}>
      <View style={styles.header}>
        <Kicker color={series.color}>Ao vivo</Kicker>
        <View style={styles.tabs}>
          {SERIES.map((item) => {
            const active = item.key === selected;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Série ${item.label}`}
                onPress={() => setSelected(item.key)}
                hitSlop={6}
                style={[
                  styles.tab,
                  {
                    borderColor: active ? withAlpha(item.color, 0.6) : 'transparent',
                    backgroundColor: active ? withAlpha(item.color, 0.14) : 'transparent',
                  },
                ]}>
                <Text
                  style={[
                    styles.tabText,
                    { color: active ? item.color : '#9AA7B8' },
                  ]}>
                  {item.short}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.readout}>
        <View style={styles.currentRow}>
          <Text style={[styles.current, NumeralType, { color: series.color }]}>
            {current === null ? EMPTY_VALUE : formatDecimal(current, series.digits)}
          </Text>
          <Text style={styles.unit}>{series.unit}</Text>
        </View>
        <View style={styles.extremes}>
          <Text style={styles.extremeLabel}>máx</Text>
          <Text style={[styles.extremeValue, NumeralType]}>
            {max === null ? EMPTY_VALUE : formatDecimal(max, series.digits)}
          </Text>
          <Text style={styles.extremeLabel}>mín</Text>
          <Text style={[styles.extremeValue, NumeralType]}>
            {observedMin === null ? EMPTY_VALUE : formatDecimal(observedMin, series.digits)}
          </Text>
        </View>
      </View>

      <View style={styles.plot}>
        <View style={[styles.gridLine, { top: '33%' }]} />
        <View style={[styles.gridLine, { top: '66%' }]} />
        {Array.from({ length: emptySlots }).map((_, index) => (
          <View key={`empty-${index}`} style={[styles.bar, styles.barEmpty]} />
        ))}
        {recent.map((sample, index) => {
          const value = series.readSample(sample);
          const height =
            value === null ? 0 : Math.max(2, Math.round((value / domain) * ChartHeight));
          return (
            <View
              key={`${sample.at}-${index}`}
              style={[
                styles.bar,
                {
                  height: Math.min(height, ChartHeight),
                  backgroundColor: withAlpha(series.color, value === null ? 0.12 : 0.82),
                },
              ]}
            />
          );
        })}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>1 amostra por segundo</Text>
        <Text style={styles.footerText}>escala 0–{formatDecimal(domain, 0)}</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  tabs: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  tab: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 3,
  },
  tabText: {
    fontFamily: Fonts.label,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
  },
  readout: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  currentRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
  },
  current: {
    fontSize: 40,
    lineHeight: 42,
  },
  unit: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: '#9AA7B8',
  },
  extremes: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  extremeLabel: {
    ...LabelType,
    fontSize: 9,
    letterSpacing: 1,
    color: '#5C687A',
  },
  extremeValue: {
    fontSize: 15,
    lineHeight: 18,
    color: '#9AA7B8',
  },
  plot: {
    height: ChartHeight,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1.5,
    marginTop: Spacing.three,
    paddingTop: Spacing.one,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha('#FFFFFF', 0.08),
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: withAlpha('#FFFFFF', 0.045),
  },
  bar: {
    flex: 1,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  barEmpty: {
    height: 2,
    backgroundColor: withAlpha('#FFFFFF', 0.06),
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  footerText: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: '#5C687A',
  },
});
