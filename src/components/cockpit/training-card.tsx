import { Lucide } from '@react-native-vector-icons/lucide';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Colors, Fonts, Metric, Neon, NumeralType, TitleType } from '@/constants/theme';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { currentCue } from '@/workouts/model';
import { pendingAction } from '@/workouts/guidance';
import { formatDuration, formatDecimal } from '@/utils/format';

/**
 * O que a pessoa precisa ver do guia de relance: em que etapa está, quanto
 * falta nela e a carga a pôr no painel. A faixa de batimentos e o que a IA
 * decidiu ficam no cartão da zona.
 */
export function TrainingCard() {
  const router = useRouter();
  const session = useWorkoutSession();
  const active = useWorkout((s) => s.active);
  const guidance = useWorkout((s) => s.guidance);
  const elapsed = Math.floor((active?.totals.movingMs ?? 0) / 1000);
  const plan = active?.plan;
  const cue = plan && currentCue(plan, elapsed);
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
          <View style={styles.right}>
            <Text style={styles.clock}>{formatDuration(cue.left)}</Text>
            <View style={styles.kicker}>
              <Lucide name="timer" size={12} color={Colors.dark.textSecondary} />
              <Text style={styles.small}>na etapa</Text>
            </View>
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
            <View
              style={[styles.targets, styles.flex]}
              accessible
              accessibilityLabel={
                'Alvo: ' +
                formatDecimal(cue.stage.speed, 1) +
                ' quilômetros por hora, inclinação ' +
                formatDecimal(cue.stage.incline, 1) +
                ' por cento'
              }>
              <Text style={styles.small}>Alvo</Text>
              <View style={styles.kicker}>
                <Lucide name="gauge" size={15} color={Metric.speed} />
                <Text style={styles.target}>{formatDecimal(cue.stage.speed, 1)} km/h</Text>
              </View>
              <View style={styles.kicker}>
                <Lucide name="trending-up" size={15} color={Metric.incline} />
                <Text style={styles.target}>{formatDecimal(cue.stage.incline, 1)}%</Text>
              </View>
            </View>
            {pendingAction(guidance) && (
              <Pressable
                accessibilityRole="button"
                onPress={() => session.minimizeCue(null)}
                hitSlop={12}
                style={styles.action}>
                <Text style={styles.link}>Ver aviso</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 11, gap: 7 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  targets: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  right: { alignItems: 'flex-end' },
  heading: { ...TitleType, fontSize: 24, color: Colors.dark.text },
  clock: { ...NumeralType, fontSize: 26, color: Neon.volt },
  small: { color: Colors.dark.textSecondary, fontSize: 12 },
  target: { color: Colors.dark.text, fontSize: 15 },
  track: {
    backgroundColor: Colors.dark.borderStrong,
    height: 3,
    borderRadius: 2,
  },
  fill: { height: 3, borderRadius: 2, backgroundColor: Neon.volt },
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
