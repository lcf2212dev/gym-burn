import { StyleSheet, Text, View } from 'react-native';

import { Card, Kicker } from '@/components/card';
import {
  Fonts,
  LabelType,
  Metric,
  NumeralType,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import type { RangeInfo, TreadmillMetrics } from '@/treadmill/types';
import { EMPTY_VALUE, formatDecimal, formatPace, formatTrimmed } from '@/utils/format';

function MiniStat({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  color?: string;
}) {
  const empty = value === EMPTY_VALUE;
  return (
    <View style={styles.miniStat} accessible accessibilityLabel={`${label}: ${value} ${unit}`}>
      <Text style={[styles.miniLabel, LabelType]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.miniValueRow}>
        <Text
          style={[styles.miniValue, NumeralType, color && !empty ? { color } : null]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}>
          {value}
        </Text>
        <Text style={styles.miniUnit} numberOfLines={1}>
          {unit}
        </Text>
      </View>
    </View>
  );
}

function LivePill({ live }: { live: boolean }) {
  const color = live ? Metric.speed : '#FFC24B';
  return (
    <View style={[styles.pill, { borderColor: withAlpha(color, 0.5), backgroundColor: withAlpha(color, 0.12) }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{live ? 'ao vivo' : 'aguardando'}</Text>
    </View>
  );
}

/**
 * O número que se lê de longe: velocidade atual, o esforço dentro da faixa da
 * esteira e os três números que mudam a leitura do treino (ritmo, média, MET).
 */
export function SpeedHero({
  metrics,
  speedRange,
  live,
}: {
  metrics: TreadmillMetrics;
  speedRange: RangeInfo;
  live: boolean;
}) {
  const speed = metrics.speedKmh;
  const span = Math.max(speedRange.max - speedRange.min, 0.1);
  const fraction =
    speed === null ? 0 : Math.min(Math.max((speed - speedRange.min) / span, 0), 1);
  const hasSpeed = speed !== null;

  return (
    <Card hero accent={Metric.speed}>
      <View style={styles.header}>
        <Kicker color={Metric.speed}>Velocidade</Kicker>
        <LivePill live={live} />
      </View>

      <View style={styles.speedRow}>
        <Text
          style={[styles.speed, NumeralType, { color: hasSpeed ? Metric.speed : '#5C687A' }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.45}
          accessibilityLabel={`Velocidade: ${hasSpeed ? formatDecimal(speed, 1) : 'sem dados'} quilômetros por hora`}>
          {hasSpeed ? formatDecimal(speed, 1) : EMPTY_VALUE}
        </Text>
        <Text style={styles.speedUnit}>km/h</Text>
      </View>

      <View
        style={styles.track}
        accessible
        accessibilityLabel="Faixa de velocidade da esteira"
        accessibilityValue={{
          min: Math.round(speedRange.min),
          max: Math.round(speedRange.max),
          now: speed === null ? 0 : Math.round(speed),
        }}>
        <View
          style={[
            styles.trackFill,
            {
              width: `${Math.max(fraction * 100, hasSpeed ? 2 : 0)}%`,
              backgroundColor: Metric.speed,
            },
          ]}
        />
        {hasSpeed ? (
          <View
            style={[
              styles.knob,
              {
                left: `${fraction * 100}%`,
                borderColor: Metric.speed,
                backgroundColor: '#080B0F',
              },
            ]}
          />
        ) : null}
      </View>
      <View style={styles.rangeRow}>
        <Text style={styles.rangeText}>{formatTrimmed(speedRange.min, 2)}</Text>
        <Text style={styles.rangeText}>{formatTrimmed(speedRange.max, 2)} km/h</Text>
      </View>

      <View style={styles.divider} />

      <View style={styles.statsRow}>
        <MiniStat
          label="Ritmo"
          value={formatPace(metrics.speedKmh)}
          unit="min/km"
          color={Metric.speed}
        />
        <View style={styles.statDivider} />
        <MiniStat
          label="Média"
          value={formatDecimal(metrics.averageSpeedKmh, 1)}
          unit="km/h"
          color={Metric.speed}
        />
        <View style={styles.statDivider} />
        <MiniStat
          label="MET"
          value={formatDecimal(metrics.metabolicEquivalent, 1)}
          unit="esforço"
          color={Metric.energy}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 3,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillText: {
    fontFamily: Fonts.label,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  speedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  speed: {
    fontSize: 104,
    lineHeight: 108,
    letterSpacing: -1,
  },
  speedUnit: {
    fontFamily: Fonts.body,
    fontSize: 16,
    color: '#9AA7B8',
    paddingBottom: 14,
  },
  track: {
    height: 10,
    borderRadius: 5,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    justifyContent: 'center',
    marginTop: Spacing.one,
    overflow: 'visible',
  },
  trackFill: {
    height: 10,
    borderRadius: 5,
  },
  knob: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    marginLeft: -8,
    top: -3,
  },
  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  rangeText: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: '#5C687A',
  },
  divider: {
    height: 1,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    marginVertical: Spacing.three,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  statDivider: {
    width: 1,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    marginHorizontal: Spacing.three,
  },
  miniStat: {
    flex: 1,
    gap: 2,
  },
  miniLabel: {
    color: '#9AA7B8',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  miniValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  miniValue: {
    fontFamily: Fonts.numeral,
    fontSize: 26,
    lineHeight: 28,
    color: '#F3F7FF',
    fontVariant: ['tabular-nums'],
  },
  miniUnit: {
    fontFamily: Fonts.body,
    fontSize: 10,
    color: '#5C687A',
  },
});
