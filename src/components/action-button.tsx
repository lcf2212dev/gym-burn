import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { DisabledOpacity, MinTouchTarget, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * - `primary`: ação principal neutra (fundo na cor do texto).
 * - `solid`: fundo em `color` e rótulo em `onColor` (botões da lona).
 * - `outline`: contorno e rótulo em `color` (secundário, botões de passo).
 * - `text`: só o rótulo, para ações discretas do cabeçalho.
 */
export type ActionButtonVariant = 'primary' | 'solid' | 'outline' | 'text';

export interface ActionButtonProps {
  label: string;
  onPress: () => void;
  variant?: ActionButtonVariant;
  disabled?: boolean;
  /** Mostra um indicador de atividade antes do rótulo. */
  busy?: boolean;
  /** Cor de fundo (`solid`) ou do contorno e rótulo (`outline`, `text`). */
  color?: string;
  /** Cor do rótulo sobre `color` no `solid`. */
  onColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}

export function ActionButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  color,
  onColor,
  accessibilityLabel,
  style,
  labelStyle,
}: ActionButtonProps) {
  const theme = useTheme();

  let background = 'transparent';
  let foreground = color ?? theme.text;
  let borderColor = 'transparent';
  if (variant === 'primary') {
    background = theme.text;
    foreground = theme.background;
  } else if (variant === 'solid') {
    background = color ?? theme.text;
    foreground = onColor ?? theme.background;
  } else if (variant === 'outline') {
    borderColor = color ?? theme.text;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [
        styles.base,
        variant === 'text' ? styles.text : styles.boxed,
        { backgroundColor: background, borderColor },
        // Fundos cheios escurecem ao toque; os vazados ganham um fundo leve.
        pressed && (variant === 'primary' || variant === 'solid') && styles.pressedSolid,
        pressed && (variant === 'outline' || variant === 'text') && {
          backgroundColor: theme.backgroundSelected,
        },
        disabled && styles.disabled,
        style,
      ]}>
      {busy && <ActivityIndicator size="small" color={foreground} />}
      <Text
        style={[styles.label, variant === 'text' && styles.textLabel, { color: foreground }, labelStyle]}
        numberOfLines={1}>
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
  },
  boxed: {
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
    borderWidth: 2,
  },
  text: {
    minWidth: MinTouchTarget,
    paddingHorizontal: Spacing.two,
    borderRadius: 8,
  },
  pressedSolid: {
    opacity: 0.75,
  },
  disabled: {
    opacity: DisabledOpacity,
  },
  label: {
    fontSize: 18,
    fontWeight: 700,
  },
  textLabel: {
    fontSize: 16,
    fontWeight: 600,
  },
});
