import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { LabelType, MaxContentWidth, Neon, Spacing, withAlpha } from '@/constants/theme';
import { COPILOT_STEP_COUNT, copilotView, type CopilotInput } from '@/copilot/copilot';
import { createCopilotStore } from '@/copilot/copilot-store';
import { useTheme } from '@/hooks/use-theme';
import { useNow } from '@/hooks/use-now';
import { correctInclinationPercent, T600X_INCLINATION_RANGE } from '@/treadmill/t600x';
import { useTreadmill } from '@/treadmill/treadmill-context';

/**
 * Faixa fina no topo do painel com o que fazer agora. O copiloto avança
 * sozinho quando a esteira mostra o efeito do pedido; o usuário não toca em
 * nada. Some quando a sequência termina.
 */
export function CopilotBanner() {
  const theme = useTheme();
  const belt = useTreadmill((s) => s.belt);
  const speedKmh = useTreadmill((s) => s.metrics.speedKmh);
  const rawIncline = useTreadmill((s) => s.metrics.inclinationPercent);
  const heartRateBpm = useTreadmill((s) => s.metrics.heartRateBpm);
  const updatedAt = useTreadmill((s) => s.metrics.updatedAt);
  const inclineRange = useTreadmill(
    (s) => s.capabilities?.inclinationRange ?? T600X_INCLINATION_RANGE,
  );
  const now = useNow(500);

  const inclinePercent = correctInclinationPercent(rawIncline, inclineRange);
  const store = useMemo(() => createCopilotStore(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // O relógio de meio segundo é o que move o copiloto: a cada tique ele olha
  // os dados mais recentes e decide se o passo atual já pode avançar.
  useEffect(() => {
    if (now === null) {
      return;
    }
    const input: CopilotInput = {
      belt,
      speedKmh,
      inclinePercent,
      heartRateBpm,
      updatedAt,
      now,
    };
    store.update(input);
  }, [belt, heartRateBpm, inclinePercent, now, speedKmh, store, updatedAt]);

  if (state === null || now === null) {
    return null;
  }

  const input: CopilotInput = {
    belt,
    speedKmh,
    inclinePercent,
    heartRateBpm,
    updatedAt,
    now,
  };
  const view = copilotView(state, input);
  if (!view.message) {
    return null;
  }

  const accent =
    view.tone === 'success' ? Neon.mint : view.tone === 'waiting' ? Neon.amber : Neon.volt;

  return (
    <View
      style={[
        styles.strip,
        {
          backgroundColor: theme.backgroundElement,
          borderBottomColor: withAlpha(accent, 0.35),
        },
      ]}>
      <View style={styles.content}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <View style={styles.textBlock}>
          {view.step !== null ? (
            <Text style={[LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
              Passo {view.step} de {COPILOT_STEP_COUNT}
            </Text>
          ) : null}
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[styles.message, { color: theme.text }]}>
            {view.message}
          </Text>
        </View>
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
  textBlock: {
    flex: 1,
    flexShrink: 1,
    gap: 2,
  },
  message: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: 600,
  },
});
