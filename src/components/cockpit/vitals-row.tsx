import { StyleSheet, Text, View } from 'react-native';

import { Card, Kicker } from '@/components/card';
import {
  Fonts,
  LabelType,
  Metric,
  NumeralType,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import { EMPTY_VALUE, formatDecimal, formatInteger } from '@/utils/format';

/** Faixa mecânica da T600X (0–15 %, passo 0,5 %): a declarada pelo FTMS é template. */
const INCLINE_MAX_PERCENT = 15;

/**
 * Inclinação e batimentos lado a lado: os dois números que dizem "como" está o
 * esforço. Mesma altura, mesma hierarquia, cores próprias.
 */
export function VitalsRow({
  inclinationPercent,
  heartRateBpm,
  heartSamples,
}: {
  inclinationPercent: number | null;
  heartRateBpm: number | null;
  /** Últimos batimentos válidos, para o mini gráfico. */
  heartSamples: number[];
}) {
  return (
    <View style={styles.row}>
      <InclineCard inclinationPercent={inclinationPercent} />
      <HeartCard heartRateBpm={heartRateBpm} heartSamples={heartSamples} />
    </View>
  );
}

function InclineCard({ inclinationPercent }: { inclinationPercent: number | null }) {
  const fraction =
    inclinationPercent === null
      ? 0
      : Math.min(Math.max(inclinationPercent / INCLINE_MAX_PERCENT, 0), 1);

  return (
    <Card accent={Metric.incline} style={styles.card}>
      <Kicker color={Metric.incline}>Inclinação</Kicker>
      <View style={styles.valueRow}>
        <Text
          style={[
            styles.value,
            NumeralType,
            { color: inclinationPercent === null ? '#5C687A' : Metric.incline },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          accessibilityLabel={`Inclinação: ${formatDecimal(inclinationPercent, 1)} por cento`}>
          {formatDecimal(inclinationPercent, 1)}
        </Text>
        <Text style={styles.unit}>%</Text>
      </View>
      <View style={styles.bar}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.max(fraction * 100, 2)}%`, backgroundColor: Metric.incline },
          ]}
        />
      </View>
      <Text style={styles.caption}>de {INCLINE_MAX_PERCENT} %</Text>
    </Card>
  );
}

function HeartCard({
  heartRateBpm,
  heartSamples,
}: {
  heartRateBpm: number | null;
  heartSamples: number[];
}) {
  const average =
    heartSamples.length > 0
      ? Math.round(heartSamples.reduce((sum, value) => sum + value, 0) / heartSamples.length)
      : null;
  // Escala das barrinhas: 60–200 bpm, para o traço não ficar colado no chão.
  const domain = 200;

  return (
    <Card accent={Metric.heart} style={styles.card}>
      <Kicker color={Metric.heart}>Batimentos</Kicker>
      <View style={styles.valueRow}>
        <Text
          style={[styles.value, NumeralType, { color: heartRateBpm === null ? '#5C687A' : Metric.heart }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          accessibilityLabel={
            heartRateBpm === null
              ? 'Batimentos: sem contato nas alças'
              : `Batimentos: ${formatInteger(heartRateBpm)} por minuto`
          }>
          {heartRateBpm === null ? EMPTY_VALUE : formatInteger(heartRateBpm)}
        </Text>
        <Text style={styles.unit}>bpm</Text>
      </View>
      <View style={styles.spark}>
        {heartSamples.length === 0 ? (
          <View style={styles.sparkEmpty} />
        ) : (
          heartSamples.map((value, index) => (
            <View
              key={`${index}-${value}`}
              style={[
                styles.sparkBar,
                {
                  height: Math.max(3, Math.round((value / domain) * 26)),
                  backgroundColor: withAlpha(Metric.heart, 0.55 + (index / heartSamples.length) * 0.45),
                },
              ]}
            />
          ))
        )}
      </View>
      <Text style={styles.caption}>
        {average === null ? 'sem contato nas alças' : `média ${formatInteger(average)} bpm`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  card: {
    flex: 1,
    padding: Spacing.three + 2,
    gap: 2,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  value: {
    fontSize: 46,
    lineHeight: 48,
    letterSpacing: -0.5,
  },
  unit: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: '#9AA7B8',
  },
  bar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    marginTop: Spacing.one,
    overflow: 'hidden',
  },
  barFill: {
    height: 6,
    borderRadius: 3,
  },
  spark: {
    height: 26,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: Spacing.one,
  },
  sparkEmpty: {
    height: 3,
    flex: 1,
    borderRadius: 2,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
  },
  sparkBar: {
    width: 3,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  caption: {
    ...LabelType,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.9,
    color: '#5C687A',
    marginTop: Spacing.two,
  },
});
