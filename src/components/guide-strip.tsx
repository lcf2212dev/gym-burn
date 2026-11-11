import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MaxContentWidth, MinTouchTarget, Spacing } from '@/constants/theme';
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
      <View style={[styles.content, { borderColor: theme.text }]}>
        <Text style={[styles.text, { color: theme.text }]} numberOfLines={2}>
          <Text style={styles.title}>{title}: </Text>
          {hint}
        </Text>
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
    justifyContent: 'center',
    paddingLeft: Spacing.three,
    paddingVertical: Spacing.one,
    borderLeftWidth: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
  },
  title: {
    fontWeight: 700,
  },
});
