import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {
  ActionColors,
  DisabledOpacity,
  Fonts,
  LabelType,
  MinTouchTarget,
  Neon,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * - `primary`: ação principal do app, bloco volt com texto carbono.
 * - `solid`: fundo em `color` e rótulo em `onColor` (botões da lona).
 * - `outline`: contorno neon e rótulo em `color` (secundário, botões de passo).
 * - `text`: só o rótulo em caixa alta, para ações discretas do cabeçalho.
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
  const accent = color ?? theme.text;
  const filled = variant === 'primary' || variant === 'solid';

  let background = 'transparent';
  let foreground = accent;
  let borderColor = 'transparent';
  let borderWidth = 0;

  if (variant === 'primary') {
    background = Neon.volt;
    foreground = ActionColors.onGo;
    // Um fio claro na borda dá o brilho de letreiro ao bloco cheio.
    borderColor = withAlpha('#FFFFFF', 0.2);
    borderWidth = 1;
  } else if (variant === 'solid') {
    background = accent;
    foreground = onColor ?? theme.background;
    borderColor = withAlpha('#FFFFFF', 0.18);
    borderWidth = 1;
  } else if (variant === 'outline') {
    background = withAlpha(accent, 0.04);
    borderColor = withAlpha(accent, 0.45);
    borderWidth = 1;
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
        { backgroundColor: background, borderColor, borderWidth },
        filled && { boxShadow:
          `0px 0px 14px ${withAlpha(background, 0.5)}, 0px 6px 30px ${withAlpha(background, 0.26)}` },
        // Fundos cheios acendem ao toque; os vazados ganham um banho de cor.
        pressed && filled && styles.pressedSolid,
        pressed && !filled && { backgroundColor: withAlpha(accent, 0.12) },
        disabled && styles.disabled,
        style,
      ]}>
      {filled ? <View style={styles.gloss} pointerEvents="none" /> : null}
      {busy && <ActivityIndicator size="small" color={foreground} />}
      <Text
        style={[
          styles.label,
          variant === 'text' && styles.textLabel,
          { color: foreground },
          labelStyle,
        ]}
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
    overflow: 'hidden',
  },
  boxed: {
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.lg,
  },
  text: {
    minWidth: MinTouchTarget,
    paddingHorizontal: Spacing.one,
    borderRadius: Radius.sm,
  },
  gloss: {
    position: 'absolute',
    top: 1,
    left: 12,
    right: 12,
    height: 1,
    borderRadius: 1,
    backgroundColor: withAlpha('#FFFFFF', 0.22),
  },
  pressedSolid: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
  disabled: {
    opacity: DisabledOpacity,
  },
  label: {
    fontFamily: Fonts.display,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: 0.3,
    ...Platform.select({ android: { includeFontPadding: false } }),
  },
  textLabel: {
    ...LabelType,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.6,
  },
});
