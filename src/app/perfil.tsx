import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, Text } from 'react-native';
import { Field, styles, WorkoutPage } from '@/components/workout-ui';
import { UiButton } from '@/components/ui-button';
import { Card } from '@/components/card';
import { hasApiKey, saveApiKey } from '@/workouts/ai';
import { validProfile } from '@/workouts/model';
import { useWorkout, useWorkoutSession } from '@/workouts/context';

export default function ProfileScreen() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const session = useWorkoutSession();
  const [age, setAge] = useState(profile?.age.toString() ?? '');
  const [weight, setWeight] = useState(profile?.weightKg.toString().replace('.', ',') ?? '');
  const [height, setHeight] = useState(profile?.heightCm.toString() ?? '');
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
  function save() {
    const p = {
      age: Number(age),
      weightKg: Number(weight.replace(',', '.')),
      heightCm: Number(height.replace(',', '.')),
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
        Seu perfil fica neste celular. Ao usar a IA, a DeepSeek recebe idade, peso, altura e o
        resumo dos treinos. Durante o guia, a IA também recebe BPM, velocidade e inclinação recentes
        para revisar os alvos.
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
      <UiButton label="Salvar perfil" onPress={save} />
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
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
      </Card>
    </WorkoutPage>
  );
}
