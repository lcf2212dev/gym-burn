import { useEffect, useRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Kicker } from '@/components/card';
import { Colors, Fonts, MaxContentWidth, Metric, TitleType } from '@/constants/theme';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { pendingAction, PULSE_READINGS } from '@/workouts/guidance';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { formatDecimal } from '@/utils/format';

function Target({
  label,
  target,
  actual,
  reached,
  color,
}: {
  label: string;
  target: string;
  actual: string;
  reached: boolean;
  color: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.target, { color }]}>{target}</Text>
      </View>
      <Text style={styles.detail}>{reached ? '✓ Atingida' : 'Atual  ' + actual}</Text>
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
  const key =
    action && active && g
      ? active.id + '/' + g.index + '/' + action + '/' + stage?.speed + '/' + stage?.incline
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
  const resting = bpm && g.index === 0 && active?.restBpm == null;
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
            <Kicker color={bpm ? Metric.heart : Metric.speed}>
              Etapa {g.index + 1} · {stage.name}
            </Kicker>
            <Text accessibilityRole="header" style={styles.title}>
              {resting ? 'Meça a FC de repouso' : bpm ? 'Meça seus batimentos' : 'Ajuste a esteira'}
            </Text>
            {bpm ? (
              <>
                <Text style={styles.detail}>
                  {resting
                    ? 'Ligue a lona na velocidade mínima e segure os sensores antes de acelerar. Essa leitura ajusta a faixa de BPM de hoje.'
                    : 'Apoie as mãos no sensor quando estiver confortável e segure por uns 10 segundos.'}
                </Text>
                <Text style={styles.detail}>
                  Leituras recebidas: {Math.min(g.bpmCount, PULSE_READINGS)} de {PULSE_READINGS}. O
                  aviso fecha sozinho.
                </Text>
              </>
            ) : (
              <>
                <Target
                  label="Velocidade"
                  target={formatDecimal(stage.speed, 1) + ' km/h'}
                  actual={formatDecimal(last?.speedKmh ?? null, 1) + ' km/h'}
                  reached={g.speedReached}
                  color={Metric.speed}
                />
                <Target
                  label="Inclinação"
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
            <Pressable accessibilityRole="button" onPress={close} style={styles.minimize}>
              <Text style={styles.label}>Minimizar aviso</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000060' },
  sheet: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    maxHeight: '85%',
    backgroundColor: '#141B25',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#546170',
    marginBottom: 14,
  },
  body: { gap: 10 },
  title: { ...TitleType, fontSize: 30, color: Colors.dark.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: Colors.dark.borderStrong,
    paddingTop: 8,
  },
  flex: { flex: 1 },
  label: { fontSize: 14, color: Colors.dark.text },
  detail: { fontSize: 14, lineHeight: 20, color: '#B9C5D5' },
  target: { fontFamily: Fonts.numeral, fontSize: 31 },
  minimize: { minHeight: 44, alignSelf: 'center', paddingHorizontal: 16, justifyContent: 'center' },
});
