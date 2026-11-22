import { Lucide } from '@react-native-vector-icons/lucide';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Colors, Fonts, Neon, NumeralType, TitleType, neonGlow } from '@/constants/theme';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { currentCue } from '@/workouts/model';
import { pendingAction } from '@/workouts/guidance';
import { formatDuration, formatDecimal } from '@/utils/format';

/**
 * O que a pessoa precisa ver do guia de relance: em que etapa está, quanto
 * falta nela, o andamento do treino e o que vem a seguir. A carga da etapa
 * fica nos blocos de velocidade e inclinação; a faixa de batimentos, no
 * medidor.
 */
export function TrainingCard() {
  const router = useRouter();
  const session = useWorkoutSession();
  const active = useWorkout((s) => s.active);
  const guidance = useWorkout((s) => s.guidance);
  const elapsed = Math.floor((active?.totals.movingMs ?? 0) / 1000);
  const plan = active?.plan;
  const cue = plan && currentCue(plan, elapsed);
  const next = plan && cue ? plan.stages[cue.index + 1] : undefined;
  return (
    <Card padded={false} style={styles.card} accent={Neon.volt}>
      <View style={styles.line}>
        <View style={styles.flex}>
          <View style={styles.kicker}>
            <Lucide name={plan && cue ? 'flag' : 'footprints'} size={13} color={Neon.volt} />
            <Kicker color={Neon.volt}>
              {plan && cue
                ? // Nos tiros o nome da etapa já traz o da sessão.
                  (cue.stage.name.startsWith(plan.goal) ? '' : plan.goal + ' · ') +
                  'etapa ' +
                  (cue.index + 1) +
                  ' de ' +
                  plan.stages.length
                : 'Treino na esteira'}
            </Kicker>
          </View>
          <Text style={styles.heading} numberOfLines={1} adjustsFontSizeToFit>
            {cue ? cue.stage.name : active ? 'Treino livre' : 'Escolha seu treino'}
          </Text>
        </View>
        {cue ? (
          <View style={styles.right} accessible accessibilityLabel={'Faltam ' + formatDuration(cue.left) + ' na etapa'}>
            <Text style={styles.small}>na etapa</Text>
            <Text style={styles.clock}>{formatDuration(cue.left)}</Text>
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
      {cue && plan && (
        <>
          <View
            style={styles.track}
            accessible
            accessibilityLabel="Andamento do treino"
            accessibilityValue={{ min: 0, max: Math.round(plan.minutes), now: Math.floor(elapsed / 60) }}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, (elapsed / (plan.minutes * 60)) * 100)}%` },
              ]}
            />
          </View>
          <View style={styles.line}>
            <Text style={[styles.small, styles.flex]} numberOfLines={1}>
              {next
                ? 'A seguir · ' +
                  next.name +
                  ' · ' +
                  formatDuration(next.seconds) +
                  ' · ' +
                  formatDecimal(next.speed, 1) +
                  ' km/h'
                : 'Última etapa'}
            </Text>
            {pendingAction(guidance) ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => session.minimizeCue(null)}
                hitSlop={12}
                style={styles.action}>
                <Text style={styles.link}>Ver aviso</Text>
              </Pressable>
            ) : (
              <Text style={styles.total}>
                {formatDuration(elapsed)} de {formatDuration(Math.round(plan.minutes * 60))}
              </Text>
            )}
          </View>
        </>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  line: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  flex: { flex: 1 },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  right: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  heading: { ...TitleType, fontSize: 28, lineHeight: 32, color: Colors.dark.text },
  clock: { ...NumeralType, fontSize: 40, lineHeight: 42, color: Neon.volt, ...neonGlow(Neon.volt, 18, 0.45) },
  small: { color: Colors.dark.textSecondary, fontSize: 12, lineHeight: 16, paddingBottom: 6 },
  total: { ...NumeralType, fontSize: 14, lineHeight: 16, color: Colors.dark.text, paddingBottom: 6 },
  track: {
    backgroundColor: Colors.dark.border,
    height: 4,
    borderRadius: 2,
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: Neon.volt },
  primary: {
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: Neon.volt,
  },
  primaryLabel: { fontFamily: Fonts.display, fontSize: 17, color: '#080B0F' },
  action: { minHeight: 24, justifyContent: 'center' },
  link: { color: Neon.cyan, fontSize: 14 },
});
