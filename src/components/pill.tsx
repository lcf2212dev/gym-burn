import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, Neon, Radius, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type PillTone =
  | 'neutral'
  | 'volt'
  | 'cyan'
  | 'amber'
  | 'red'
  | 'mint'
  | 'violet'
  | 'magenta';

export interface PillProps {
  label: string;
  tone?: PillTone;
  /** Bolinha antes do rótulo: estado de conexão, "gravando", etc. */
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Tag de estado em caixa alta. Fundo translúcido + contorno na cor do tone;
 * o texto nunca fica sobre neon puro, para continuar legível.
 */
export function Pill({ label, tone = 'neutral', dot = false, style }: PillProps) {
  const theme = useTheme();
  const tones: Record<PillTone, string> = {
    neutral: theme.textSecondary,
    volt: Neon.volt,
    cyan: Neon.cyan,
    amber: Neon.amber,
    red: Neon.red,
    mint: Neon.mint,
    violet: Neon.violet,
    magenta: Neon.magenta,
  };
  const color = tones[tone];

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[
        styles.pill,
        {
          backgroundColor: tone === 'neutral' ? theme.backgroundSelected : withAlpha(color, 0.12),
          borderColor: tone === 'neutral' ? theme.border : withAlpha(color, 0.45),
        },
        style,
      ]}>
      {dot ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontFamily: Fonts.label,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
