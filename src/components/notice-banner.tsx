import { Pressable, StyleSheet, Text } from 'react-native';

import { Surface } from '@/components/surface';
import { MinTouchTarget, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/** Aviso mais recente da sessão; um toque o dispensa. Não renderiza nada sem aviso. */
export function NoticeBanner() {
  const notice = useTreadmill((s) => s.notice);
  const { dismissNotice } = useTreadmillActions();
  const theme = useTheme();

  if (!notice) {
    return null;
  }

  const color = {
    error: theme.noticeError,
    warning: theme.noticeWarning,
    success: theme.noticeSuccess,
    info: theme.textSecondary,
  }[notice.kind];

  return (
    <Pressable
      onPress={dismissNotice}
      accessibilityRole="alert"
      accessibilityHint="Toque para fechar o aviso"
      style={({ pressed }) => [styles.press, pressed && styles.pressed]}>
      {/* O acento interno é a cor do tipo de aviso; o texto acompanha. */}
      <Surface accent={color} tone="raised" style={styles.banner}>
        <Text style={[styles.message, { color }]}>{notice.message}</Text>
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  press: {
    borderRadius: Radius.lg,
  },
  pressed: {
    opacity: 0.85,
  },
  banner: {
    minHeight: MinTouchTarget,
    justifyContent: 'center',
    paddingVertical: Spacing.three,
  },
  message: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: 600,
  },
});
