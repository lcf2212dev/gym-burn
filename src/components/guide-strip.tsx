import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LabelType, MaxContentWidth, MinTouchTarget, Neon, Spacing } from '@/constants/theme';
import { GUIDE_STEP_COUNT } from '@/guide/guide-logic';
import { useGuide } from '@/guide/guide-context';
import { useTheme } from '@/hooks/use-theme';

/**
 * Faixa fina no topo das telas enquanto o roteiro do primeiro teste está em
 * andamento: o passo atual e o que fazer agora. Um toque abre o roteiro. Não
 * renderiza nada fora do roteiro.
 */
export function GuideStrip() {
  const theme = useTheme();
  const active = useGuide((s) => s.active);
  const stepNumber = useGuide((s) => s.currentStepNumber);
  const hint = useGuide((s) => s.hint);

  if (!active) {
    return null;
  }

  const title =
    stepNumber === null ? 'Roteiro concluído' : `Roteiro, passo ${stepNumber} de ${GUIDE_STEP_COUNT}`;

  return (
    <Pressable
      onPress={() => router.push('/roteiro')}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint ?? ''}`}
      accessibilityHint="Abre o roteiro do primeiro teste"
      style={({ pressed }) => [
        styles.strip,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: theme.border,
        },
      ]}>
      <View style={styles.content}>
        {/* O traço volt marca o roteiro, a ação principal do primeiro teste. */}
        <View style={[styles.bar, { backgroundColor: Neon.volt }]} />
        <View style={styles.textBlock}>
          <Text style={[LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
            {title}
          </Text>
          {hint ? (
            <Text style={[styles.hint, { color: theme.text }]} numberOfLines={2}>
              {hint}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderBottomWidth: 1,
    paddingHorizontal: Spacing.three,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  bar: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
  },
  textBlock: {
    flex: 1,
    flexShrink: 1,
    gap: 2,
  },
  hint: {
    fontSize: 14,
    lineHeight: 18,
  },
});
