import { Lucide } from '@react-native-vector-icons/lucide';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { IconKicker, StatusPill } from '@/components/kit';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { ZoneMeter } from '@/components/zones/zone-meter';
import { Colors, Metric, Neon, NumeralType, TitleType, ZoneColors, neonGlow, withAlpha } from '@/constants/theme';
import {
  averageCadence,
  formatHours,
  levelStep,
  minuteColumns,
  recentActivity,
  restLabel,
  zoneOf,
} from '@/workouts/briefing';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { evidence, levels, type Workout } from '@/workouts/model';
import { energyKcal, heartProfile } from '@/workouts/physiology';
import { zoneIndexes } from '@/workouts/week';
import { formatDecimal, formatDuration } from '@/utils/format';

export default function Evolution() {
  const session = useWorkoutSession();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const busy = useWorkout((s) => s.assessing);
  const error = useWorkout((s) => s.error);
  const [count, setCount] = useState(12);
  // A hora de abertura da tela: é dela que se contam os últimos 21 dias.
  const [now] = useState(() => Date.now());
  if (!profile) return <Redirect href="/perfil" />;
  // As sessões da esteira simulada não entram aqui: o app as descarta ao abrir.
  const list = history.filter((w) => w.source === 'ble');
  function erase(id: string, when: string) {
    Alert.alert('Apagar este registro?', 'O treino de ' + when + ' sai do histórico deste celular.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Apagar', style: 'destructive', onPress: () => session.remove(id) },
    ]);
  }
  const latest = list.find((w) => w.estimate && w.estimate.level !== 'Dados insuficientes');
  const hr = heartProfile(profile, list);
  const step = levelStep(latest?.estimate?.level);
  const recent = recentActivity(list, now);
  return (
    <WorkoutPage
      title="Minha evolução"
      accessory={
        <StatusPill
          icon="trending-up"
          color={Neon.violet}
          label={list.length === 1 ? '1 treino' : list.length + ' treinos'}
        />
      }>
      <Card hero accent={Neon.violet} style={local.hero}>
        <IconKicker icon="sparkles" color={Neon.violet}>
          Condicionamento estimado pela IA
        </IconKicker>
        <Text style={[local.level, neonGlow(Neon.violet, 22, 0.55)]}>
          {latest?.estimate?.level ?? 'Aguardando dados'}
        </Text>
        {/* Os três níveis em degraus; o de agora fica aceso. */}
        <View style={local.steps} accessible={false}>
          {levels.slice(1).map((name, index) => (
            <View key={name} style={local.step}>
              <View style={[local.stepBar, index === step && local.stepOn]} />
              <Text style={[local.stepName, index === step && local.stepNameOn]}>{name}</Text>
            </View>
          ))}
        </View>
        <Text style={local.note}>
          {latest
            ? 'Estimativa de ' +
              new Date(latest.started).toLocaleDateString('pt-BR') +
              '. ' +
              latest.estimate?.summary
            : 'Acompanhe como seu corpo responde ao esforço em cada sessão com leituras de BPM.'}
        </Text>
      </Card>
      <View style={local.tiles}>
        <Tile
          icon="heart-pulse"
          label="FC máxima"
          value={String(hr.max)}
          unit="BPM"
          color={Metric.heart}
          note={hr.maxSource === 'IA' ? 'prevista pela IA' : 'estimada pela idade'}
        />
        <Tile
          icon="calendar"
          label="Últimos 21 dias"
          value={String(recent.count)}
          unit={recent.count === 1 ? 'treino' : 'treinos'}
          color={Neon.volt}
          note={recent.count ? formatHours(recent.movingMs) + ' na esteira' : 'nenhum treino'}
        />
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Kicker style={local.section}>Histórico da esteira</Kicker>
      {!list.length && <Text style={styles.body}>Nenhum treino registrado aqui ainda.</Text>}
      {list.slice(0, count).map((w) => {
        const data = evidence(w);
        const kcal = energyKcal(w);
        const when = new Date(w.started).toLocaleString('pt-BR');
        const evaluating = busy.includes(w.id);
        // O repouso diz como foi medido: "repouso 62" parado, "1º minuto 86" andando.
        const rest = restLabel(w);
        const cadence = averageCadence(w);
        const backfilled = w.strap?.backfilledSeconds ?? 0;
        return (
          <Card key={w.id} style={local.session}>
            <View style={local.between}>
              <Kicker>{when}</Kicker>
              {!!w.plan?.objective && <ZoneMeter lit={zoneIndexes(w.plan.objective)} />}
            </View>
            <View style={local.between}>
              <Text style={local.goal} numberOfLines={1}>
                {data.goal}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'Apagar o registro de ' + when}
                disabled={evaluating}
                hitSlop={6}
                onPress={() => erase(w.id, when)}
                style={[local.trash, evaluating && local.dim]}>
                <Lucide name="trash-2" size={15} color={Colors.dark.textSecondary} />
              </Pressable>
            </View>
            <Beats workout={w} max={w.hr?.max ?? hr.max} />
            <View style={local.stats}>
              <Stat value={formatDuration(data.movingSeconds)} label="em movimento" />
              <Stat value={formatDecimal(data.distanceMeters / 1000, 2)} label="km" />
              <Stat value={data.averageBpm ? String(data.averageBpm) : '—'} label="BPM médios" />
              <Stat value={kcal ? String(kcal) : '—'} label="kcal" />
            </View>
            <Text style={local.caption}>
              {w.reason}
              {data.averageBpm ? ' · pico de ' + data.peakBpm + ' BPM' : ' · sem leitura de BPM'}
              {rest ? ' · ' + rest : ''}
              {' · ' + formatDecimal(data.averageKmh, 1) + ' km/h e '}
              {formatDecimal(data.averageIncline, 1)}% em média
              {cadence !== null ? ' · cadência de ' + cadence + ' passos/min' : ''}
              {backfilled > 0 ? ' · ' + backfilled + ' s recuperados da cinta' : ''}
            </Text>
            {w.estimate ? (
              <View style={local.estimate}>
                <IconKicker icon="sparkles" color={Neon.violet}>
                  {w.estimate.level}
                </IconKicker>
                <Text style={local.estimateText}>
                  {w.estimate.summary}
                  {w.estimate.maxBpm ? ' FC máxima prevista: ' + w.estimate.maxBpm + ' BPM.' : ''}
                </Text>
              </View>
            ) : (
              <UiButton
                variant="outline"
                color={Neon.violet}
                icon="sparkles"
                label={evaluating ? 'Avaliando…' : 'Avaliar com IA'}
                busy={evaluating}
                onPress={() => void session.evaluate(w)}
              />
            )}
          </Card>
        );
      })}
      {count < list.length && (
        <UiButton variant="ghost" label="Ver mais treinos" onPress={() => setCount(count + 12)} />
      )}
    </WorkoutPage>
  );
}

/** Os batimentos do treino, uma coluna por minuto, na cor da zona. Os registros antigos não têm. */
function Beats({ workout, max }: { workout: Workout; max: number }) {
  const minutes = Math.max(workout.beats?.length ?? 0, Math.ceil(workout.plan?.minutes ?? 0));
  if (!workout.beats?.length) return null;
  return (
    <View style={local.beats} accessible={false}>
      {minuteColumns(workout.beats, minutes).map((bpm, minute) => (
        <View key={minute} style={local.beat}>
          {bpm !== null && (
            <View
              style={{
                height: `${Math.max(8, Math.min(100, ((bpm - max / 2) / (max / 2)) * 100))}%`,
                borderRadius: 2,
                backgroundColor: ZoneColors[zoneOf(bpm, max)],
              }}
            />
          )}
        </View>
      ))}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={local.stat} accessible accessibilityLabel={value + ' ' + label}>
      <Text style={local.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={local.statLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {label}
      </Text>
    </View>
  );
}

function Tile({
  icon,
  label,
  value,
  unit,
  color,
  note,
}: {
  icon: 'heart-pulse' | 'calendar';
  label: string;
  value: string;
  unit: string;
  color: string;
  note: string;
}) {
  return (
    <Card accent={color} style={local.tile}>
      <IconKicker icon={icon} color={color}>
        {label}
      </IconKicker>
      <View style={local.tileValue} accessible accessibilityLabel={label + ': ' + value + ' ' + unit}>
        <Text style={[local.tileNumber, { color }, neonGlow(color, 18, 0.35)]}>{value}</Text>
        <Text style={local.tileUnit}>{unit}</Text>
      </View>
      <Text style={local.statLabel}>{note}</Text>
    </Card>
  );
}

const local = StyleSheet.create({
  hero: { padding: 18, gap: 12 },
  level: { ...TitleType, fontSize: 40, lineHeight: 44, color: Colors.dark.text },
  steps: { flexDirection: 'row', gap: 6 },
  step: { flex: 1, gap: 6 },
  stepBar: { height: 8, borderRadius: 4, backgroundColor: Colors.dark.borderStrong },
  stepOn: { backgroundColor: Neon.violet },
  stepName: {
    fontFamily: NumeralType.fontFamily,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Colors.dark.textSecondary,
  },
  stepNameOn: { color: Colors.dark.text },
  note: { fontSize: 13, lineHeight: 19, color: Colors.dark.textSecondary },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, padding: 14, gap: 4 },
  tileValue: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  tileNumber: { ...NumeralType, fontSize: 40, lineHeight: 42 },
  tileUnit: { ...NumeralType, fontSize: 16, color: Colors.dark.textSecondary },
  section: { paddingHorizontal: 4, paddingTop: 4 },
  session: { gap: 10 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  goal: { ...TitleType, flex: 1, fontSize: 28, lineHeight: 32, color: Colors.dark.text },
  trash: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.dark.border,
  },
  dim: { opacity: 0.45 },
  beats: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 40 },
  beat: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  stats: { flexDirection: 'row', gap: 6 },
  stat: { flex: 1 },
  statValue: { ...NumeralType, fontSize: 22, lineHeight: 26, color: Colors.dark.text },
  statLabel: { fontSize: 11, lineHeight: 15, color: Colors.dark.textSecondary },
  caption: { fontSize: 12, lineHeight: 17, color: Colors.dark.textSecondary },
  estimate: {
    padding: 12,
    gap: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: withAlpha(Neon.violet, 0.25),
    backgroundColor: withAlpha(Neon.violet, 0.07),
  },
  estimateText: { fontSize: 13, lineHeight: 19, color: Colors.dark.text },
});
