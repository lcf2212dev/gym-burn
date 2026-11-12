import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, Neon, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface BrandMarkProps {
  size?: 'sm' | 'md' | 'lg';
  /** Linha miúda abaixo do nome; `null` esconde. */
  subtitle?: string | null;
  style?: StyleProp<ViewStyle>;
}

/**
 * A marca: um losango volt e "GYM BURN" em display condensado. Aparece grande
 * na abertura e pequena no topo do painel. O losango é rotacionado dentro de um
 * invólucro maior para o canto visual cair na mesma margem do texto.
 */
export function BrandMark({ size = 'sm', subtitle = null, style }: BrandMarkProps) {
  const theme = useTheme();
  const sizes = {
    sm: { diamond: 10, name: 16, letterSpacing: 2.2 },
    md: { diamond: 12, name: 20, letterSpacing: 2.8 },
    lg: { diamond: 16, name: 32, letterSpacing: 3.6 },
  }[size];
  const diamond = sizes.diamond;
  const frame = Math.ceil(diamond * 1.42);

  return (
    <View style={[styles.row, style]}>
      <View style={[styles.diamondFrame, { width: frame, height: frame }]}>
        {/* Halo em anéis: a marca "acende" sem depender de sombra nativa. */}
        {GLOW_RINGS.map((ring) => (
          <View
            key={ring.alpha}
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: frame * ring.scale,
              height: frame * ring.scale,
              borderRadius: (frame * ring.scale) / 2,
              backgroundColor: withAlpha(Neon.volt, ring.alpha),
            }}
          />
        ))}
        <View
          style={[
            styles.diamond,
            {
              width: diamond,
              height: diamond,
              borderRadius: diamond / 5,
            },
          ]}
        />
      </View>
      <View style={styles.textBlock}>
        <Text
          style={[
            styles.name,
            {
              fontSize: sizes.name,
              letterSpacing: sizes.letterSpacing,
              color: theme.text,
            },
          ]}>
          Gym Burn
        </Text>
        {subtitle ? (
          <Text
            style={[styles.subtitle, { color: theme.textMuted }]}
            numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Anéis do halo da marca, do mais externo para o mais interno. */
const GLOW_RINGS = [
  { scale: 1.8, alpha: 0.035 },
  { scale: 1.5, alpha: 0.055 },
  { scale: 1.25, alpha: 0.08 },
] as const;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  diamondFrame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  diamond: {
    backgroundColor: Neon.volt,
    transform: [{ rotate: '45deg' }],
  },
  textBlock: {
    gap: 1,
  },
  name: {
    fontFamily: Fonts.display,
    textTransform: 'uppercase',
  },
  subtitle: {
    fontFamily: Fonts.label,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
  },
});
