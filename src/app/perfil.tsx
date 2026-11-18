import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import { Field, styles, WorkoutPage } from '@/components/workout-ui';
import { UiButton } from '@/components/ui-button';
import { Card } from '@/components/card';
import { hasApiKey, saveApiKey } from '@/workouts/ai';
import { activities, validProfile, type Activity } from '@/workouts/model';
import { heartProfile } from '@/workouts/physiology';
import { useWorkout, useWorkoutSession } from '@/workouts/context';

const activityHint: Record<Activity, string> = {
  Sedentário: 'Quase não faz exercício.',
  Ativo: 'Caminha ou treina de 1 a 3 vezes por semana.',
  Treinado: 'Treina 4 ou mais vezes por semana há meses.',
};

export default function ProfileScreen() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const session = useWorkoutSession();
  const [age, setAge] = useState(profile?.age.toString() ?? '');
  const [weight, setWeight] = useState(profile?.weightKg.toString().replace('.', ',') ?? '');
  const [height, setHeight] = useState(profile?.heightCm.toString() ?? '');
  const [activity, setActivity] = useState<Activity | undefined>(profile?.activity);
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    hasApiKey()
      .then(setConfigured)
      .catch(() => setError('Falha ao abrir o armazenamento seguro.'));
  }, []);
  // As demonstrações têm histórico próprio e não entram na frequência real.
  const hr = profile && heartProfile(profile, history.filter((w) => w.source === 'ble'));
  function save() {
    const p = {
      age: Number(age),
      weightKg: Number(weight.replace(',', '.')),
      heightCm: Number(height.replace(',', '.')),
      ...(activity ? { activity } : {}),
    };
    if (!validProfile(p)) {
      setError('Confira idade em anos, peso em kg e altura em cm.');
      return;
    }
    try {
      session.setProfile(p);
      Keyboard.dismiss();
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {
      setError('Falha ao salvar o perfil no aparelho.');
    }
  }
  function erase() {
    Alert.alert(
      'Apagar perfil e treinos?',
      'Perfil, histórico de treinos, plano do dia e diário da IA serão apagados deste celular. A chave da DeepSeek continua salva.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Apagar tudo',
          style: 'destructive',
          onPress: () => {
            try {
              session.reset();
              setAge('');
              setWeight('');
              setHeight('');
              setActivity(undefined);
              setError('');
            } catch {
              setError('Falha ao apagar os dados neste aparelho.');
            }
          },
        },
      ],
    );
  }
  async function configure() {
    setBusy(true);
    try {
      await saveApiKey(key);
      setKey('');
      setConfigured(true);
      setEditing(false);
      setError('');
      Keyboard.dismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar a chave.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkoutPage title="Meu perfil" back={!!profile}>
      <Text style={styles.body}>
        Seu perfil fica neste celular. Ao usar a IA, a DeepSeek recebe idade, peso, altura, nível de
        atividade e o resumo dos treinos, com as frequências de repouso e máxima estimadas. Durante
        o guia, a IA também recebe BPM, velocidade e inclinação recentes para revisar os alvos.
      </Text>
      <Field
        label="Idade (anos)"
        keyboardType="number-pad"
        value={age}
        onChangeText={setAge}
        maxLength={3}
      />
      <Field
        label="Peso (kg)"
        keyboardType="decimal-pad"
        value={weight}
        onChangeText={setWeight}
        maxLength={6}
      />
      <Field
        label="Altura (cm)"
        keyboardType="decimal-pad"
        value={height}
        onChangeText={setHeight}
        maxLength={6}
      />
      <View style={styles.group}>
        <Text style={styles.caption}>Nível de atividade</Text>
        <View style={styles.row}>
          {activities.map((item) => (
            <Pressable
              key={item}
              accessibilityRole="radio"
              accessibilityState={{ checked: activity === item }}
              accessibilityHint={activityHint[item]}
              onPress={() => setActivity(item)}
              style={[styles.option, item === activity && styles.selected]}>
              <Text style={styles.caption}>{item}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.body}>
          {activity
            ? activityHint[activity]
            : 'Orienta o primeiro plano enquanto ainda não há treinos registrados.'}
        </Text>
      </View>
      <UiButton label="Salvar perfil" onPress={save} />
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {hr && (
        <Card style={styles.card}>
          <Text style={styles.heading}>Frequência cardíaca</Text>
          <Text style={styles.body}>
            Repouso:{' '}
            {hr.rest
              ? hr.rest +
                ' BPM estimados: a menor leitura do primeiro minuto dos últimos treinos, menos 15 de quem já está andando.'
              : 'ainda não medida. O guia lê no primeiro minuto do próximo treino.'}
          </Text>
          <Text style={styles.body}>
            Máxima: {hr.max} BPM,{' '}
            {hr.maxSource === 'IA'
              ? 'prevista pela IA nas últimas avaliações.'
              : 'estimada pela idade até a primeira avaliação da IA.'}
          </Text>
        </Card>
      )}
      <Card style={styles.card}>
        <Text style={styles.heading}>DeepSeek</Text>
        {configured && !editing ? (
          <>
            <Text style={styles.body}>Chave pessoal configurada neste aparelho.</Text>
            <UiButton variant="ghost" label="Trocar chave" onPress={() => setEditing(true)} />
          </>
        ) : (
          <>
            <Field
              label="Chave pessoal da DeepSeek"
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="sk-…"
            />
            <UiButton
              label="Salvar chave"
              variant="outline"
              onPress={configure}
              busy={busy}
              disabled={!key.trim()}
            />
          </>
        )}
        <UiButton
          variant="ghost"
          label="Diagnóstico da IA"
          onPress={() => router.push('/diagnostico')}
        />
      </Card>
      {!!profile && (
        <Card style={styles.card}>
          <Text style={styles.heading}>Dados neste celular</Text>
          <Text style={styles.body}>
            Apaga perfil, histórico de treinos, plano do dia e diário da IA, para começar de novo. A
            chave da DeepSeek continua salva.
          </Text>
          <UiButton variant="ghost" label="Apagar perfil e treinos" onPress={erase} />
        </Card>
      )}
    </WorkoutPage>
  );
}
