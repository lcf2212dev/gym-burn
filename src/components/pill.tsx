import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, Metric, Neon, Radius, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type PillTone =
  | 'neutral'
  | 'volt'
  | 'cyan'
  | 'heart'
  | 'amber'
  | 'mint'
  | 'violet'
  | 'red';

export type PillSize = 'sm' | 'md';

export interface PillProps {
  label: string;
  /** Papel do dado: cada grandeza tem cor fixa no tema. */
  tone?: PillTone;
  size?: PillSize;
  /** Bolinha antes do rótulo: estado de conexão, "procurando", etc. */
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Tag de estado em caixa alta: fundo translúcido, contorno e texto na cor do
 * tom. O texto nunca fica sobre neon puro, para continuar legível a distância.
 */
export function Pill({ label, tone = 'neutral', size = 'md', dot = false, style }: PillProps) {
  const theme = useTheme();
  const tones: Record<PillTone, string> = {
    neutral: theme.textSecondary,
    volt: Neon.volt,
    cyan: Neon.cyan,
    heart: Metric.heart,
    amber: Neon.amber,
    mint: Neon.mint,
    violet: Neon.violet,
    red: Neon.red,
  };
  const color = tones[tone];
  const neutral = tone === 'neutral';

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[
        styles.pill,
        size === 'sm' ? styles.pillSm : styles.pillMd,
        {
          backgroundColor: neutral ? theme.backgroundSelected : withAlpha(color, 0.12),
          borderColor: neutral ? theme.border : withAlpha(color, 0.4),
        },
        style,
      ]}>
      {dot ? (
        <View style={[styles.dot, size === 'sm' ? styles.dotSm : styles.dotMd, { backgroundColor: color }]} />
      ) : null}
      <Text
        style={[styles.label, size === 'sm' ? styles.labelSm : styles.labelMd, { color }]}
        numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  pillMd: {
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillSm: {
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  dot: {
    borderRadius: Radius.pill,
  },
  dotMd: {
    width: 6,
    height: 6,
  },
  dotSm: {
    width: 5,
    height: 5,
  },
  label: {
    fontFamily: Fonts.label,
    textTransform: 'uppercase',
  },
  labelMd: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
  },
  labelSm: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1.2,
  },
});
