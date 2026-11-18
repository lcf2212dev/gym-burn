import { StyleSheet, View, type ViewProps } from 'react-native';

import { Glass, Radius, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SurfaceTone = 'default' | 'raised' | 'sunken' | 'hero';

export interface SurfaceProps extends ViewProps {
  /** Altura da superfície: `raised`/`hero` se aproximam, `sunken` afunda. */
  tone?: SurfaceTone;
  /**
   * Cor do halo em volta do cartão (zona de destaque: radar, esteira
   * conectando). Um cartão comum não tem halo: o brilho é reservado ao foco.
   */
  glow?: string | null;
  /** Barra de acento na borda esquerda (avisos, estados). */
  accent?: string | null;
  /** Só o contorno, sem preenchimento de vidro. */
  plain?: boolean;
  /** Padding interno padrão; desligue para listas que desenham as próprias linhas. */
  padded?: boolean;
  /** Raio do canto; por padrão `lg` e, no tom `hero`, o raio de painel. */
  radius?: number;
}

/**
 * O vidro escuro do app: preenchimento translúcido, contorno fino e um fio de
 * luz no topo. `overflow: hidden` mantém o acento e o fio dentro do canto
 * arredondado; o halo é desenhado pela própria sombra da View.
 */
export function Surface({
  tone = 'default',
  glow = null,
  accent = null,
  plain = false,
  padded = true,
  radius,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const theme = useTheme();
  const backgrounds: Record<SurfaceTone, string> = {
    default: Glass.card,
    raised: Glass.hero,
    sunken: Glass.well,
    hero: Glass.hero,
  };
  const borders: Record<SurfaceTone, string> = {
    default: theme.border,
    raised: theme.border,
    sunken: theme.border,
    hero: theme.borderStrong,
  };
  const resolvedRadius = radius ?? (tone === 'hero' ? Radius.hero : Radius.lg);

  return (
    <View
      style={[
        styles.base,
        {
          borderRadius: resolvedRadius,
          backgroundColor: plain ? 'transparent' : backgrounds[tone],
          borderColor: glow ? withAlpha(glow, 0.34) : borders[tone],
        },
        glow
          ? {
              boxShadow: `0px 0px 26px 0px ${withAlpha(glow, 0.18)}, 0px 12px 44px 0px ${withAlpha(glow, 0.1)}`,
            }
          : null,
        padded && styles.padded,
        style,
      ]}
      {...rest}>
      {/* Fio de luz no topo: dá volume ao vidro sem depender de gradiente. */}
      <View
        pointerEvents="none"
        style={[
          styles.gloss,
          { backgroundColor: withAlpha(glow ?? theme.text, glow ? 0.42 : 0.06) },
        ]}
      />
      {accent ? (
        <View
          pointerEvents="none"
          style={[styles.accentBar, { backgroundColor: accent }]}
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
    overflow: 'hidden',
  },
  padded: {
    padding: Spacing.four,
  },
  gloss: {
    position: 'absolute',
    top: 0,
    left: 18,
    right: 18,
    height: 1,
  },
  accentBar: {
    position: 'absolute',
    left: 0,
    top: 16,
    bottom: 16,
    width: 3,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
  },
});
