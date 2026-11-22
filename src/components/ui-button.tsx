import { Lucide } from '@react-native-vector-icons/lucide';
import type { ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {
  Fonts,
  MinTouchTarget,
  Neon,
  OnAccent,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * - `primary`: ação principal (voltar a procurar), bloco lima com texto carbono.
 * - `outline`: secundária, contorno na cor de acento.
 * - `ghost`: discreta, contorno neutro (ações de apoio sob listas).
 */
export type ButtonVariant = 'primary' | 'outline' | 'ghost';

export interface UiButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Cor de acento em `outline`; fixa em lima no `primary`. */
  color?: string;
  /** Ícone antes do rótulo; some enquanto o botão está ocupado. */
  icon?: ComponentProps<typeof Lucide>['name'];
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}

/**
 * Botão do app desenhado só com Views: alvo mínimo de 48, canto de pílula e
 * rótulo em display condensado. O `primary` ganha halo; os demais, contorno.
 *
 * A tela de conexão usa este botão em vez do antigo `ActionButton` (que tinha
 * os tons das teclas da lona e foi removido junto com os controles).
 */
export function UiButton({
  label,
  onPress,
  variant = 'primary',
  color,
  icon,
  disabled = false,
  busy = false,
  accessibilityLabel,
  style,
  labelStyle,
}: UiButtonProps) {
  const theme = useTheme();
  const accent = variant === 'primary' ? Neon.volt : (color ?? theme.textSecondary);
  const foreground = variant === 'primary' ? OnAccent : accent;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary'
          ? {
              backgroundColor: accent,
              borderColor: withAlpha(theme.text, 0.2),
              boxShadow: `0px 0px 20px 0px ${withAlpha(accent, 0.34)}`,
            }
          : variant === 'outline'
            ? {
                backgroundColor: withAlpha(accent, 0.06),
                borderColor: withAlpha(accent, 0.45),
              }
            : {
                backgroundColor: 'transparent',
                borderColor: theme.border,
              },
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon ? (
        <Lucide name={icon} size={18} color={foreground} />
      ) : null}
      <Text style={[styles.label, { color: foreground }, labelStyle]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.five,
    borderRadius: Radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.995 }],
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    fontFamily: Fonts.display,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
