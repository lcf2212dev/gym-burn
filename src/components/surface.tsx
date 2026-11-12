import { StyleSheet, View, type ViewProps } from 'react-native';

import { Radius, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SurfaceTone = 'default' | 'raised' | 'sunken';

export interface SurfaceProps extends ViewProps {
  /** Altura da superfície: `raised` se aproxima do usuário, `sunken` afunda. */
  tone?: SurfaceTone;
  /** Barra de acento na borda esquerda (avisos, estados, destaque). */
  accent?: string | null;
  /** Só o contorno, sem preenchimento: listas e blocos leves. */
  plain?: boolean;
  /** Padding interno padrão; desligue para listas que desenham as próprias linhas. */
  padded?: boolean;
}

/**
 * A superfície padrão do app: um cartão de grafite com contorno fino, canto
 * arredondado e um fio de luz no topo. O acento é uma barra interna (não uma
 * borda lateral), para o traço não deformar o raio do canto.
 */
export function Surface({
  tone = 'default',
  accent = null,
  plain = false,
  padded = true,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const theme = useTheme();
  const backgrounds: Record<SurfaceTone, string> = {
    default: theme.backgroundElement,
    raised: theme.surfaceRaised,
    sunken: theme.surfaceSunken,
  };

  return (
    <View
      style={[
        styles.base,
        padded && styles.padded,
        {
          backgroundColor: plain ? 'transparent' : backgrounds[tone],
          borderColor: accent ? withAlpha(accent, 0.3) : theme.border,
        },
        style,
      ]}
      {...rest}>
      {/* Fio de luz no topo: dá volume ao cartão sem sombra. */}
      <View style={[styles.gloss, { backgroundColor: withAlpha(theme.text, 0.05) }]} />
      {accent ? <View style={[styles.accentBar, { backgroundColor: accent }]} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  padded: {
    padding: Spacing.three,
  },
  gloss: {
    position: 'absolute',
    top: 0,
    left: 14,
    right: 14,
    height: 1,
  },
  accentBar: {
    position: 'absolute',
    left: 0,
    top: 14,
    bottom: 14,
    width: 3,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
  },
});
