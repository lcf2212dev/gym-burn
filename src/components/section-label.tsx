import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { LabelType, Neon, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface SectionLabelProps {
  label: string;
  accent?: string;
  /** Conteúdo alinhado à direita: uma tag, uma contagem, uma ação. */
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * O kicker das seções: um traço neon e o nome em caixa alta, miúdo, com muito
 * espaço entre as letras. É o que dá o ritmo de "painel de treino" à tela.
 */
export function SectionLabel({ label, accent = Neon.volt, right, style }: SectionLabelProps) {
  const theme = useTheme();

  return (
    <View style={[styles.row, style]}>
      <View style={[styles.bar, { backgroundColor: accent }]} />
      <Text style={[styles.label, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 18,
  },
  bar: {
    width: 18,
    height: 2,
    borderRadius: 1,
  },
  label: {
    flexShrink: 1,
  },
  right: {
    marginLeft: 'auto',
    flexShrink: 0,
  },
});
