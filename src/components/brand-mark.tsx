import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, Neon, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface BrandMarkProps {
  size?: 'sm' | 'md' | 'lg';
  /** Linha miúda abaixo do nome; `null` esconde. */
  subtitle?: string | null;
  /** Esconde o nome, deixando só o losango (marca d'água, rodapé). */
  markOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A marca do app: o losango lima com o raio vazado e "GYM BURN" em display
 * condensado. O raio é montado com duas barras inclinadas — sem ícone, sem
 * biblioteca, e escalando junto com o losango.
 *
 * O losango é rotacionado dentro de um invólucro maior para o canto visual
 * cair na mesma margem do texto; por dentro, o raio é contra-rotacionado para
 * ficar em pé na tela.
 */
export function BrandMark({ size = 'sm', subtitle = null, markOnly = false, style }: BrandMarkProps) {
  const theme = useTheme();
  const sizes = {
    sm: { diamond: 14, name: 16, letterSpacing: 2.6 },
    md: { diamond: 20, name: 21, letterSpacing: 3.2 },
    lg: { diamond: 32, name: 34, letterSpacing: 4.4 },
  }[size];
  const diamond = sizes.diamond;
  const frame = Math.ceil(diamond * 1.62);

  return (
    <View style={[styles.row, style]}>
      <View style={[styles.diamondFrame, { width: frame, height: frame }]}>
        {/* Halo em anéis: a marca "acende" sem depender de sombra nativa. */}
        {GLOW_RINGS.map((ring) => {
          const ringSize = frame * ring.scale;
          return (
            <View
              key={ring.alpha}
              pointerEvents="none"
              style={{
                position: 'absolute',
                width: ringSize,
                height: ringSize,
                left: (frame - ringSize) / 2,
                top: (frame - ringSize) / 2,
                borderRadius: ringSize / 2,
                backgroundColor: withAlpha(Neon.volt, ring.alpha),
              }}
            />
          );
        })}
        <View
          style={[
            styles.diamond,
            {
              width: diamond,
              height: diamond,
              borderRadius: diamond * 0.3,
              boxShadow: `0px 0px ${Math.round(diamond * 1.2)}px 0px ${withAlpha(Neon.volt, 0.55)}`,
            },
          ]}>
          <View
            style={[
              styles.boltBox,
              {
                width: diamond,
                height: diamond,
                transform: [{ rotate: '-45deg' }],
              },
            ]}>
            <Bolt size={diamond} color={theme.background} />
          </View>
        </View>
      </View>
      {markOnly ? null : (
        <View style={styles.textBlock}>
          <Text
            style={[
              styles.name,
              {
                fontSize: sizes.name,
                lineHeight: Math.round(sizes.name * 1.1),
                letterSpacing: sizes.letterSpacing,
                color: theme.text,
              },
            ]}>
            Gym Burn
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: theme.textMuted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** O raio vazado: duas barras paralelas inclinadas, com o degrau no meio. */
function Bolt({ size, color }: { size: number; color: string }) {
  const width = Math.max(2, size * 0.16);
  const height = size * 0.42;
  const radius = width / 2;

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: size * 0.5,
          top: size * 0.04,
          width,
          height,
          borderRadius: radius,
          backgroundColor: color,
          transform: [{ rotate: '22deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: size * 0.29,
          top: size * 0.52,
          width,
          height,
          borderRadius: radius,
          backgroundColor: color,
          transform: [{ rotate: '22deg' }],
        }}
      />
    </View>
  );
}

/** Anéis do halo da marca, do mais externo para o mais interno. */
const GLOW_RINGS = [
  { scale: 1.85, alpha: 0.03 },
  { scale: 1.5, alpha: 0.05 },
  { scale: 1.22, alpha: 0.075 },
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
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  boltBox: {
    alignItems: 'center',
    justifyContent: 'center',
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
