import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { UiButton } from '@/components/ui-button';
import { Field, styles, WorkoutPage } from '@/components/workout-ui';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { preparePlan, readPlan } from '@/workouts/storage';
import { dailyTarget } from '@/workouts/adaptive';
import { generatePlan } from '@/workouts/ai';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { goals, inRange, requestsPulse, type Goal, type Plan } from '@/workouts/model';
import { formatDecimal, formatDuration } from '@/utils/format';

export default function Training() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const session = useWorkoutSession();
  const source = useTreadmill((s) => (s.phase === 'connected' ? s.mode : 'ble'));
  const connected = useTreadmill((s) => s.phase === 'connected');
  const [goal, select] = useState<Goal | null>(null);
  const [minutes, setMinutes] = useState('45');
  const [plan, setPlan] = useState<Plan | null>(() => readPlan(source, profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!profile) return <Redirect href="/perfil" />;

  const target = plan && dailyTarget(plan, profile);

  async function generate() {
    const duration = Number(minutes);
    if (!profile) return;
    if (!Number.isInteger(duration) || !inRange(duration, 5, 180)) {
      setError('Escolha uma duração entre 5 e 180 minutos.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const recent = session.snapshot().history.filter((w) => w.source === source);
      const generated = await generatePlan(profile, duration, goal, recent);
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

  return (
    <WorkoutPage title="Treino do dia">
      {plan ? (
        <>
          <Card hero style={styles.card}>
            <Kicker>Plano da DeepSeek · {plan.minutes} min</Kicker>
            <Text style={styles.metric}>{plan.goal}</Text>
            {target && (
              <Text style={styles.caption}>
                {target.objective} · {target.low}–{target.high} BPM estimados
              </Text>
            )}
            <Text style={styles.body}>
              A IA revisa os alvos com os BPM recebidos durante o treino. Ajuste os alvos no painel
              conforme seu conforto. O guia avança enquanto a lona está em movimento.
            </Text>
          </Card>
          <UiButton
            label={connected ? 'Iniciar treino guiado' : 'Conectar esteira para iniciar'}
            onPress={start}
          />
          <UiButton variant="ghost" label="Alterar seleção" onPress={() => setPlan(null)} />
          {!connected && (
            <Text style={styles.body}>
              O plano de hoje está salvo neste celular. Abra-o no painel da esteira conectada para
              iniciar.
            </Text>
          )}
          {plan.stages.map((stage, i) => (
            <Card key={i} style={styles.group}>
              <Kicker>
                Etapa {i + 1} · {formatDuration(stage.seconds)}
              </Kicker>
              <Text style={styles.heading}>{stage.name}</Text>
              <Text style={styles.body}>
                {formatDecimal(stage.speed, 1)} km/h · inclinação {formatDecimal(stage.incline, 1)}%
                {requestsPulse(stage) && ' · leitura de BPM'}
              </Text>
            </Card>
          ))}
        </>
      ) : (
        <>
          <Text style={styles.body}>
            Deixe a IA escolher com base no seu perfil e nos treinos anteriores, ou selecione um
            objetivo.
          </Text>
          <View style={styles.row}>
            {([null, ...goals] as const).map((item) => (
              <Pressable
                key={item ?? 'auto'}
                accessibilityRole="radio"
                accessibilityState={{ checked: goal === item }}
                disabled={busy}
                onPress={() => select(item)}
                style={[styles.option, item === goal && styles.selected]}>
                <Text style={styles.caption}>{item ?? 'Escolha da IA'}</Text>
              </Pressable>
            ))}
          </View>
          <Field
            label="Duração (minutos)"
            value={minutes}
            editable={!busy}
            keyboardType="number-pad"
            maxLength={3}
            onChangeText={setMinutes}
          />
          <UiButton
            label={busy ? 'Preparando treino…' : 'Gerar treino com IA'}
            busy={busy}
            onPress={generate}
          />
        </>
      )}
      {!!error && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <UiButton variant="ghost" label="Abrir perfil" onPress={() => router.push('/perfil')} />
        </>
      )}
    </WorkoutPage>
  );
}
