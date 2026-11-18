import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Surface } from '@/components/surface';
import { Fonts, LabelType, MinTouchTarget, Neon, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import type { Notice } from '@/treadmill/types';

export interface NoticeBannerProps {
  /**
   * Aviso explícito. Sem esta prop o componente lê o aviso da sessão e o
   * dispensa sozinho — o modo controlado serve para a tela filtrar tipos.
   */
  notice?: Notice | null;
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Botão de fechar desenhado com duas linhas: sem biblioteca de ícones. */
const CLOSE_SIZE = MinTouchTarget;
const CLOSE_LINE = 14;

/**
 * Faixa de aviso: erro, atenção, sucesso ou informação. O acento interno e o
 * rótulo dizem o tipo sem depender de cor para quem não distingue as matizes.
 */
export function NoticeBanner({ notice: controlled, onDismiss, style }: NoticeBannerProps) {
  const theme = useTheme();
  const sessionNotice = useTreadmill((s) => s.notice);
  const actions = useTreadmillActions();
  const notice = controlled === undefined ? sessionNotice : controlled;
  const dismiss = onDismiss ?? actions.dismissNotice;

  if (!notice) {
    return null;
  }

  const meta = {
    error: { color: theme.noticeError, label: 'Erro' },
    warning: { color: theme.noticeWarning, label: 'Atenção' },
    success: { color: theme.noticeSuccess, label: 'Pronto' },
    info: { color: Neon.cyan, label: 'Aviso' },
  }[notice.kind];
  const urgent = notice.kind === 'error' || notice.kind === 'warning';

  return (
    <Surface accent={meta.color} tone="raised" padded={false} style={[styles.banner, style]}>
      <View style={styles.body}>
        <Text style={[styles.kind, LabelType, { color: meta.color }]}>{meta.label}</Text>
        <Text
          accessibilityRole={urgent ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          style={[styles.message, { color: theme.text }]}>
          {notice.message}
        </Text>
      </View>
      <Pressable
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Fechar aviso"
        accessibilityHint="Dispensa este aviso"
        hitSlop={4}
        style={({ pressed }) => [
          styles.close,
          pressed && { backgroundColor: withAlpha(theme.text, 0.06) },
        ]}>
        <View
          style={[
            styles.closeLine,
            { backgroundColor: theme.textSecondary, transform: [{ rotate: '45deg' }] },
          ]}
        />
        <View
          style={[
            styles.closeLine,
            { backgroundColor: theme.textSecondary, transform: [{ rotate: '-45deg' }] },
          ]}
        />
      </Pressable>
    </Surface>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingLeft: Spacing.four,
    paddingRight: Spacing.two,
    paddingVertical: Spacing.three,
  },
  body: {
    flex: 1,
    flexShrink: 1,
    gap: Spacing.half,
  },
  kind: {
    fontSize: 10,
    lineHeight: 13,
  },
  message: {
    fontFamily: Fonts.body,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
  },
  close: {
    width: CLOSE_SIZE,
    height: CLOSE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CLOSE_SIZE / 2,
  },
  closeLine: {
    position: 'absolute',
    width: CLOSE_LINE,
    height: 1.5,
    borderRadius: 1,
    top: CLOSE_SIZE / 2 - 0.75,
    left: (CLOSE_SIZE - CLOSE_LINE) / 2,
  },
});
