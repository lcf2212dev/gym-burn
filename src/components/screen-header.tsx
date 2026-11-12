import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { LabelType, Neon, Spacing, TitleType } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface ScreenHeaderProps {
  title: string;
  /** Linha miúda acima do título; raro, para telas que precisam de contexto. */
  kicker?: string;
  /** Ação à direita: normalmente o botão Voltar. */
  right?: ReactNode;
  accent?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Topo das telas secundárias (registros, roteiro, coleta, sonda, diagnóstico):
 * um traço neon curto e o título em display condensado. Sem kicker por padrão —
 * repetir a marca em toda tela vira ruído.
 */
export function ScreenHeader({
  title,
  kicker,
  right,
  accent = Neon.volt,
  style,
}: ScreenHeaderProps) {
  const theme = useTheme();

  return (
    <View style={[styles.container, { borderColor: theme.border }, style]}>
      <View style={styles.titleBlock}>
        <View style={styles.kickerRow}>
          <View style={[styles.bar, { backgroundColor: accent }]} />
          {kicker ? (
            <Text style={[styles.kicker, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
              {kicker}
            </Text>
          ) : null}
        </View>
        <Text
          accessibilityRole="header"
          style={[styles.title, TitleType, { color: theme.text }]}
          numberOfLines={2}>
          {title}
        </Text>
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    borderBottomWidth: 1,
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 2,
  },
  bar: {
    width: 16,
    height: 2,
    borderRadius: 1,
  },
  kicker: {
    flexShrink: 1,
  },
  title: {
    fontSize: 26,
    lineHeight: 30,
  },
  right: {
    alignItems: 'flex-end',
  },
});
