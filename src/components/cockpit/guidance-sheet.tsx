import { Lucide } from '@react-native-vector-icons/lucide';
import { useEffect, useRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Kicker } from '@/components/card';
import type { IconName } from '@/components/cockpit/icon-label';
import {
  Colors,
  MaxContentWidth,
  Metric,
  NumeralType,
  TitleType,
  neonGlow,
  withAlpha,
} from '@/constants/theme';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { pendingAction, PULSE_READINGS } from '@/workouts/guidance';
import { REST_WINDOW_SECONDS } from '@/workouts/model';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { formatDecimal } from '@/utils/format';

const DONE = '#3DE8A0';

/** O ícone grande que diz, antes de qualquer texto, o que o aviso pede. */
function Badge({ icon, color, size = 34 }: { icon: IconName; color: string; size?: number }) {
  return (
    <View
      style={[
        styles.badge,
        { borderColor: withAlpha(color, 0.5), backgroundColor: withAlpha(color, 0.12) },
      ]}>
      <Lucide name={icon} size={size} color={color} />
    </View>
  );
}

/**
 * Um alvo do painel. A seta diz para que lado mexer: para cima quando a
 * esteira está abaixo do alvo, para baixo quando está acima. Ao chegar, vira
 * um visto.
 */
function Target({
  icon,
  label,
  target,
  measured,
  goal,
  actual,
  reached,
  color,
}: {
  icon: IconName;
  label: string;
  target: string;
  /** Valor medido e valor pedido, para saber o sentido do ajuste. */
  measured: number | null;
  goal: number;
  actual: string;
  reached: boolean;
  color: string;
}) {
  const up = measured !== null && measured < goal;
  const action = reached
    ? label + ' no alvo'
    : measured === null
      ? 'Ajuste a ' + label.toLowerCase()
      : (up ? 'Aumente a ' : 'Diminua a ') + label.toLowerCase();
  return (
    <View style={styles.row} accessible accessibilityLabel={action + ': ' + target + '. Atual ' + actual}>
      <Badge
        icon={reached ? 'check' : measured === null ? icon : up ? 'arrow-up' : 'arrow-down'}
        color={reached ? DONE : color}
      />
      <View style={styles.flex}>
        <View style={styles.inline}>
          <Lucide name={icon} size={15} color={color} />
          <Text style={styles.label}>{action}</Text>
        </View>
        <Text style={[styles.target, { color }, neonGlow(color, 18, 0.35)]}>{target}</Text>
      </View>
      <View style={styles.actual}>
        <Kicker color={reached ? DONE : undefined}>{reached ? 'Atingida' : 'Atual'}</Kicker>
        <Text style={styles.actualValue}>{actual}</Text>
      </View>
    </View>
  );
}

export function GuidanceSheet() {
  const active = useWorkout((s) => s.active);
  const g = useWorkout((s) => s.guidance);
  const minimized = useWorkout((s) => s.minimizedCue);
  const session = useWorkoutSession();
  const last = useTreadmill((s) => s.samples.at(-1));
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const action = pendingAction(g);
  const stage = g && active?.plan?.stages[g.index];
  // Cada pedido de batimentos da etapa é um aviso novo: reabre e toca de novo,
  // mesmo que o anterior tenha sido minimizado.
  const request = action === 'bpm' ? '@' + g?.bpmRequestedAt : '';
  const key =
    action && active && g
      ? active.id + '/' + g.index + '/' + action + request + '/' + stage?.speed + '/' + stage?.incline
      : null;
  const visible = !!key && key !== minimized;
  const player = useAudioPlayer(require('@/assets/audio/cue.wav'));
  const { isLoaded } = useAudioPlayerStatus(player);
  // Um aviso pode ser minimizado e reaberto, ou voltar após a leitura de BPM.
  const running = !!active;
  const sounded = useRef(new Set<string>());
  useEffect(() => {
    if (!running) sounded.current.clear();
    if (!key || !visible || !isLoaded || sounded.current.has(key)) return;
    let current = true;
    void (async () => {
      await setAudioModeAsync({ interruptionMode: 'mixWithOthers' });
      if (!current) return;
      await player.seekTo(0);
      if (current) {
        player.play();
        sounded.current.add(key);
      }
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [key, visible, isLoaded, player, running]);

  if (!visible || !g || !stage) return null;
  const close = () => session.minimizeCue(key);
  const bpm = action === 'bpm';
  // A primeira leitura do treino é a FC de repouso do dia: a esteira só lê
  // batimentos com a lona andando, então ela é feita na velocidade mínima.
  // Passada a janela do repouso, o pedido da primeira etapa é uma leitura comum.
  const resting =
    bpm &&
    g.index === 0 &&
    active?.restBpm == null &&
    active.totals.movingMs < REST_WINDOW_SECONDS * 1000;
  return (
    <Modal
      visible
      transparent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={close}
      statusBarTranslucent
      navigationBarTranslucent
      presentationStyle="overFullScreen">
      <View style={styles.overlay}>
        <Pressable accessible={false} onPress={close} style={StyleSheet.absoluteFill} />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.handle} />
          <ScrollView bounces={false} contentContainerStyle={styles.body}>
            <View style={styles.heading}>
              <Badge
                icon={bpm ? 'heart-pulse' : 'sliders-horizontal'}
                color={bpm ? Metric.heart : Metric.speed}
                size={38}
              />
              <View style={styles.flex}>
                <Kicker color={bpm ? Metric.heart : Metric.speed}>
                  Etapa {g.index + 1} · {stage.name}
                </Kicker>
                <Text accessibilityRole="header" style={styles.title}>
                  {resting ? 'Meça a FC de repouso' : bpm ? 'Meça seus batimentos' : 'Ajuste a esteira'}
                </Text>
              </View>
            </View>
            {bpm ? (
              <>
                <Text style={styles.detail}>
                  {resting
                    ? 'Ligue a lona na velocidade mínima e segure os sensores antes de acelerar. Essa leitura é o ponto de partida para a IA calcular a carga dos próximos treinos.'
                    : 'Apoie as mãos no sensor quando estiver confortável e segure por uns 10 segundos.'}
                </Text>
                <View
                  style={styles.readings}
                  accessible
                  accessibilityLabel={
                    'Leituras recebidas: ' +
                    Math.min(g.bpmCount, PULSE_READINGS) +
                    ' de ' +
                    PULSE_READINGS
                  }>
                  <View style={styles.flex}>
                    <Kicker color={Metric.heart}>Leituras recebidas</Kicker>
                    <View style={styles.dots}>
                      {Array.from({ length: PULSE_READINGS }, (_, i) => (
                        <View key={i} style={[styles.dot, i < g.bpmCount && styles.dotOn]} />
                      ))}
                    </View>
                  </View>
                  <Text style={[styles.count, neonGlow(Metric.heart, 18, 0.4)]}>
                    {Math.min(g.bpmCount, PULSE_READINGS)}
                  </Text>
                  <Text style={styles.countOf}>de {PULSE_READINGS}</Text>
                </View>
                <Text style={styles.detail}>O aviso fecha sozinho.</Text>
              </>
            ) : (
              <>
                <Target
                  icon="gauge"
                  label="Velocidade"
                  measured={last?.speedKmh ?? null}
                  goal={stage.speed}
                  target={formatDecimal(stage.speed, 1) + ' km/h'}
                  actual={formatDecimal(last?.speedKmh ?? null, 1) + ' km/h'}
                  reached={g.speedReached}
                  color={Metric.speed}
                />
                <Target
                  icon="trending-up"
                  label="Inclinação"
                  measured={last?.inclinationPercent ?? null}
                  goal={stage.incline}
                  target={formatDecimal(stage.incline, 1) + '%'}
                  actual={formatDecimal(last?.inclinationPercent ?? null, 1) + '%'}
                  reached={g.inclineReached}
                  color={Metric.incline}
                />
                <Text style={styles.detail}>
                  Use o painel da esteira. O aviso fecha quando os dois valores atingirem os alvos.
                </Text>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: withAlpha(Colors.dark.surfaceSunken, 0.72) },
  sheet: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    maxHeight: '85%',
    backgroundColor: Colors.dark.surfaceRaised,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderTopWidth: 1,
    borderColor: withAlpha('#FFFFFF', 0.1),
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.dark.borderStrong,
    marginBottom: 14,
  },
  body: { gap: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { ...TitleType, fontSize: 32, lineHeight: 36, color: Colors.dark.text },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderTopWidth: 1,
    borderColor: Colors.dark.border,
    paddingTop: 12,
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // As leituras recebidas: uma cápsula por leitura e a contagem em número grande.
  readings: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: withAlpha(Metric.heart, 0.28),
    backgroundColor: Colors.dark.surfaceSunken,
  },
  dots: { flexDirection: 'row', gap: 6, marginTop: 8, marginBottom: 6 },
  dot: { flex: 1, maxWidth: 34, height: 10, borderRadius: 5, backgroundColor: Colors.dark.borderStrong },
  dotOn: { backgroundColor: Metric.heart },
  count: { ...NumeralType, fontSize: 44, lineHeight: 46, color: Metric.heart },
  countOf: { ...NumeralType, fontSize: 17, lineHeight: 20, paddingBottom: 6, color: Colors.dark.textSecondary },
  flex: { flex: 1 },
  label: { fontSize: 14, color: Colors.dark.textSecondary },
  detail: { fontSize: 14, lineHeight: 20, color: '#B9C5D5' },
  target: { ...NumeralType, fontSize: 44, lineHeight: 48 },
  actual: { alignItems: 'flex-end' },
  actualValue: { ...NumeralType, fontSize: 22, lineHeight: 26, color: Colors.dark.text },
});
