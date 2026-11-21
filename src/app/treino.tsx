import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { Colors, Neon, NumeralType } from '@/constants/theme';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { preparePlan, readPlan } from '@/workouts/storage';
import { generatePlan } from '@/workouts/ai';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { RUN_FROM_KMH, WALK_TOP_KMH, type Plan } from '@/workouts/model';
import { aimBand, dailyTarget, heartProfile } from '@/workouts/physiology';
import { describe, sessionMinutes, week, zones, zoneSpan } from '@/workouts/week';
import { formatDecimal, formatDuration } from '@/utils/format';

// A semana começa na segunda; o domingo, de descanso, fecha a lista.
const DAYS = [1, 2, 3, 4, 5, 6, 0];

export default function Training() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const session = useWorkoutSession();
  const source = useTreadmill((s) => (s.phase === 'connected' ? s.mode : 'ble'));
  const connected = useTreadmill((s) => s.phase === 'connected');
  const [today] = useState(() => new Date().getDay());
  // O dia cujo treino será feito: começa em hoje, e a lista da semana deixa trocar.
  const [day, pick] = useState(today);
  const [plan, setPlan] = useState<Plan | null>(() => {
    // Um plano preparado antes do plano semanal não tem faixa própria, e um com
    // alvo entre o teto da caminhada e o começo da corrida é de antes desse teto:
    // nos dois casos vale gerar outro.
    const stored = readPlan(source, profile);
    const unwalkable = stored?.stages.some((s) => s.speed > WALK_TOP_KMH && s.speed < RUN_FROM_KMH);
    return stored?.zone && !unwalkable ? stored : null;
  });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState('');
  if (!profile) return <Redirect href="/perfil" />;

  const recent = history.filter((w) => w.source === source);
  const hr = heartProfile(profile, recent);
  const target = plan && dailyTarget(plan, profile, hr);
  const aim = target && aimBand(target, target.objective);
  // Em dia de recuperação a faixa é teto: ninguém busca o alto dela.
  const chasing = !!target && !!aim && aim.low > target.low;
  const chosen = week[day].session;
  const work = plan?.stages.filter((s) => !s.measure) ?? [];
  // A recuperação é um teto ("abaixo de"); as outras faixas têm piso e teto.
  const range = (objective: keyof typeof zones) => {
    const [low, high] = zones[objective].map((p) => Math.round((hr.max * p) / 100));
    return objective === 'Recuperação' ? 'até ' + high + ' BPM' : low + '–' + high + ' BPM';
  };

  async function generate() {
    if (!profile || !chosen) return;
    setBusy(true);
    setAttempt(1);
    setError('');
    try {
      const generated = await generatePlan(profile, chosen, recent, { onAttempt: setAttempt });
      preparePlan(source, profile, generated);
      setPlan(generated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao preparar o treino.');
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (!plan) return;
    try {
      if (connected) session.start(plan);
      router.dismissTo('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar o treino.');
    }
  }

  // A ação principal fica presa no rodapé, sempre à mão e com margem da borda.
  const footer = (
    <>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {plan ? (
        <>
          <UiButton
            label={connected ? 'Iniciar treino guiado' : 'Conectar esteira para iniciar'}
            onPress={start}
          />
          <UiButton variant="ghost" label="Alterar seleção" onPress={() => setPlan(null)} />
        </>
      ) : (
        <UiButton
          label={
            !busy
              ? 'Gerar treino com IA'
              : attempt > 1
                ? 'Preparando treino… tentativa ' + attempt
                : 'Preparando treino…'
          }
          busy={busy}
          disabled={!chosen}
          onPress={generate}
        />
      )}
    </>
  );

  return (
    <WorkoutPage title="Treino do dia" footer={footer}>
      {plan ? (
        <>
          <Card hero style={styles.card}>
            <Kicker>Plano da DeepSeek · {plan.minutes} min</Kicker>
            <Text style={styles.metric}>{plan.goal}</Text>
            <View style={local.facts}>
              {target && (
                <Fact
                  label={work.length > 1 ? 'Faixa nos blocos de esforço' : 'Faixa de batimentos'}
                  value={
                    plan.objective === 'Recuperação'
                      ? 'até ' + target.high + ' BPM'
                      : target.low + '–' + target.high + ' BPM'
                  }
                />
              )}
              {aim && chasing && (
                <Fact label="Mira: o alto da faixa" value={aim.low + '–' + aim.high + ' BPM'} />
              )}
              {work[0] && (
                <Fact
                  label="Carga do esforço"
                  value={
                    formatDecimal(work[0].speed, 1) + ' km/h · ' + formatDecimal(work[0].incline, 1) + '%'
                  }
                />
              )}
            </View>
            {!!plan.why && <Text style={styles.body}>{plan.why}</Text>}
          </Card>
          {!connected && (
            <Text style={styles.body}>
              O plano de hoje está salvo neste celular. Abra-o no painel da esteira conectada para
              iniciar.
            </Text>
          )}
          <Card style={local.list}>
            <Kicker>Etapas</Kicker>
            {plan.stages.map((stage, i) => (
              <View key={i} style={[local.line, i > 0 && local.divider]}>
                <Text style={local.time}>{formatDuration(stage.seconds)}</Text>
                <Text
                  style={[local.name, local.grow, !stage.measure && local.strong]}
                  numberOfLines={1}>
                  {stage.name}
                </Text>
                <Text style={local.side}>
                  {formatDecimal(stage.speed, 1)} km/h · {formatDecimal(stage.incline, 1)}%
                </Text>
              </View>
            ))}
          </Card>
          <Text style={styles.body}>
            {chasing
              ? 'O guia pede os batimentos a cada 3 minutos. As leituras dos blocos de esforço vão à IA, que ajusta a carga para manter os batimentos perto do teto da faixa.'
              : 'O guia pede os batimentos a cada 3 minutos, e a IA alivia a carga se eles passarem do teto.'}
          </Text>
        </>
      ) : (
        <>
          <Card hero style={styles.card}>
            <Kicker>
              {day === today ? 'Hoje · ' : 'No lugar do treino de hoje · '}
              {week[day].day}
            </Kicker>
            <Text style={styles.metric}>{chosen ? chosen.title : 'Descanso'}</Text>
            {chosen ? (
              <>
                <View style={local.facts}>
                  <Fact label="Duração" value={sessionMinutes(chosen) + ' min'} />
                  <Fact label={chosen.percent + ' da FC máxima'} value={range(chosen.objective)} />
                  <Fact
                    label={'Esforço ' + zoneSpan(chosen.objective).feel}
                    value={zoneSpan(chosen.objective).ids}
                  />
                </View>
                <Text style={styles.body}>{describe(chosen)}.</Text>
              </>
            ) : (
              <Text style={styles.body}>
                Domingo é o dia de descanso do seu plano. Se quiser treinar mesmo assim, toque em
                um dia da semana abaixo.
              </Text>
            )}
          </Card>
          {busy && (
            <Text style={styles.body}>
              A IA analisa seu histórico antes de responder. Pode levar até alguns minutos.
            </Text>
          )}
          <Card style={local.list}>
            <Kicker>Plano semanal</Kicker>
            {DAYS.map((index, i) => {
              const entry = week[index];
              const selected = index === day;
              return (
                <Pressable
                  key={index}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy || !entry.session }}
                  disabled={busy || !entry.session}
                  onPress={() => pick(index)}
                  style={[local.line, local.touch, i > 0 && local.divider]}>
                  <Text style={[local.time, selected && local.picked]}>{entry.day.slice(0, 3)}</Text>
                  <View style={local.grow}>
                    <Text
                      style={[local.name, selected && local.picked, !entry.session && local.muted]}>
                      {entry.session?.title ?? 'Descanso'}
                      {index === today ? ' · hoje' : ''}
                    </Text>
                    {!!entry.session && (
                      <Text style={local.side}>
                        {zoneSpan(entry.session.objective).ids} · {entry.session.percent}
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </Card>
          <Text style={styles.body}>
            Cada treino tem 45 minutos. Para fazer hoje o treino de outro dia, toque nele.
          </Text>
        </>
      )}
      {!!error && (
        <UiButton variant="ghost" label="Abrir perfil" onPress={() => router.push('/perfil')} />
      )}
    </WorkoutPage>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={local.fact} accessible accessibilityLabel={label + ': ' + value}>
      <Text style={local.factValue}>{value}</Text>
      <Text style={local.side}>{label}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 10 },
  fact: { gap: 2 },
  factValue: { ...NumeralType, fontSize: 24, lineHeight: 27, color: Colors.dark.text },
  list: { gap: 0 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  touch: { minHeight: 46 },
  divider: { borderTopWidth: 1, borderColor: Colors.dark.border },
  time: { ...NumeralType, width: 50, fontSize: 16, color: Colors.dark.textSecondary },
  grow: { flex: 1, gap: 1 },
  name: { fontSize: 16, color: Colors.dark.text },
  strong: { fontWeight: '700' },
  picked: { color: Neon.volt, fontWeight: '700' },
  muted: { color: Colors.dark.textSecondary },
  side: { fontSize: 13, color: Colors.dark.textSecondary },
});
