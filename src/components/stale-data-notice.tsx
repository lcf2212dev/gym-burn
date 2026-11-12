import { StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill } from '@/treadmill/treadmill-context';

/** A partir de quanto tempo sem notificação o painel avisa que os números estão velhos. */
const STALE_AFTER_MS = 5000;

/**
 * "Sem dados da esteira há N s". Fica num componente próprio para o relógio de
 * 1 s não renderizar o painel inteiro.
 */
export function StaleDataNotice() {
  const updatedAt = useTreadmill((s) => s.metrics.updatedAt);
  const now = useNow();
  const theme = useTheme();

  if (updatedAt === null || now === null || now - updatedAt <= STALE_AFTER_MS) {
    return null;
  }

  const seconds = Math.floor((now - updatedAt) / 1000);
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: theme.noticeWarning }]} />
      <Text accessibilityRole="alert" style={[styles.text, { color: theme.noticeWarning }]}>
        Sem dados da esteira há {seconds} s
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: 600,
  },
});
