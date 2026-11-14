import { StyleSheet, Text, View } from 'react-native';

import { MaxContentWidth, Neon, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill } from '@/treadmill/treadmill-context';

/**
 * Faixa discreta no topo, acima do copiloto, que só aparece quando o teste do
 * canal alternativo precisa de uma ação do usuário (por exemplo, parar a lona).
 * Some sozinha quando o app consegue continuar.
 */
export function GizwitsProbeHintBanner() {
  const theme = useTheme();
  const hint = useTreadmill((s) => s.gizwitsProbe.hint);

  if (!hint) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        {
          backgroundColor: theme.backgroundElement,
          borderBottomColor: withAlpha(Neon.amber, 0.35),
        },
      ]}>
      <View style={styles.content}>
        <View style={[styles.dot, { backgroundColor: Neon.amber }]} />
        <Text style={[styles.message, { color: theme.text }]}>{hint}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderBottomWidth: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  message: {
    flex: 1,
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: 600,
  },
});
