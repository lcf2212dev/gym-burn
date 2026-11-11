import { Pressable, StyleSheet, Text } from 'react-native';

import { MinTouchTarget, Spacing } from '@/constants/theme';
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
      style={({ pressed }) => [
        styles.banner,
        { borderColor: color },
        pressed && { backgroundColor: theme.backgroundSelected },
      ]}>
      <Text style={[styles.message, { color }]}>{notice.message}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: MinTouchTarget,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderLeftWidth: 4,
  },
  message: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
  },
});
