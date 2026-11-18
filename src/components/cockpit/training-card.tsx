import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Colors, Fonts, Neon, NumeralType, TitleType } from '@/constants/theme';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { currentCue } from '@/workouts/model';
import { dailyTarget } from '@/workouts/physiology';
import { pendingAction } from '@/workouts/guidance';
import { formatDuration, formatDecimal } from '@/utils/format';

export function TrainingCard() {
  const router = useRouter();
  const session = useWorkoutSession();
  const active = useWorkout((s) => s.active);
  const coach = useWorkout((s) => s.coach);
  const guidance = useWorkout((s) => s.guidance);
  const elapsed = Math.floor((active?.totals.movingMs ?? 0) / 1000);
  const plan = active?.plan;
  const cue = plan && currentCue(plan, elapsed);
  const target = plan && dailyTarget(plan, active.profile, active.hr);
  function finish() {
    Alert.alert('Encerrar registro do treino?', 'A IA avaliará o esforço registrado até aqui.', [
      { text: 'Continuar', style: 'cancel' },
      { text: 'Encerrar treino', onPress: () => session.finish('Encerrado no app') },
    ]);
  }
  return (
    <Card padded={false} style={styles.card} accent={Neon.volt}>
      <View style={styles.line}>
        <View style={styles.flex}>
          <Kicker color={Neon.volt}>
            {plan ? plan.goal + ' · ' + plan.minutes + ' min' : 'Treino na esteira'}
          </Kicker>
          <Text style={styles.heading}>
            {cue ? cue.stage.name : active ? 'Treino livre' : 'Escolha seu treino'}
          </Text>
        </View>
        {cue ? (
          <View style={styles.right}>
            <Text style={styles.clock}>{formatDuration(cue.left)}</Text>
            <Text style={styles.small}>na etapa</Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/treino')}
            style={styles.primary}>
            <Text style={styles.primaryLabel}>Treino do dia</Text>
          </Pressable>
        )}
      </View>
      {cue && plan && target && (
        <>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, (elapsed / (plan.minutes * 60)) * 100)}%` },
              ]}
            />
          </View>
          <Text style={styles.small}>
            Etapa {cue.index + 1}/{plan.stages.length} · {formatDecimal(cue.stage.speed, 1)} km/h ·{' '}
            {formatDecimal(cue.stage.incline, 1)}% · {formatDuration(elapsed)} feitos
          </Text>
          <Text style={styles.goal}>
            {target.objective} · {target.low}–{target.high} BPM estimados
            {active.restBpm ? ' · 1º minuto ' + active.restBpm : ''}
          </Text>
          {!!coach && <Text style={styles.small}>{coach}</Text>}
        </>
      )}
      {!!active && (
        <View style={styles.actions}>
          {pendingAction(guidance) && (
            <Pressable
              accessibilityRole="button"
              onPress={() => session.minimizeCue(null)}
              style={styles.action}>
              <Text style={styles.link}>Ver aviso</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Encerrar registro"
            onPress={finish}
            style={styles.action}>
            <Text style={styles.small}>Encerrar registro</Text>
          </Pressable>
        </View>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  card: { paddingHorizontal: 13, paddingVertical: 8, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  heading: { ...TitleType, fontSize: 24, color: Colors.dark.text },
  clock: { ...NumeralType, fontSize: 26, color: Neon.volt },
  small: { color: Colors.dark.textSecondary, fontSize: 12 },
  goal: { color: Colors.dark.text, fontSize: 13 },
  track: {
    backgroundColor: Colors.dark.borderStrong,
    height: 3,
    borderRadius: 2,
    marginVertical: 3,
  },
  fill: { height: 3, backgroundColor: Neon.volt },
  primary: {
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: Neon.volt,
  },
  primaryLabel: { fontFamily: Fonts.display, fontSize: 17, color: '#080B0F' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20 },
  action: { minHeight: 44, justifyContent: 'center' },
  link: { color: Neon.cyan, fontSize: 14 },
});
