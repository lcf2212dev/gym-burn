import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { useWorkoutSession, useWorkout } from '@/workouts/context';
import { evidence } from '@/workouts/model';
import { formatDuration, formatDecimal } from '@/utils/format';

export default function Evolution() {
  const session = useWorkoutSession();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const busy = useWorkout((s) => s.assessing);
  const error = useWorkout((s) => s.error);
  const [count, setCount] = useState(12);
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
  return (
    <WorkoutPage title="Minha evolução">
      <Card hero style={styles.card}>
        <Kicker>Condicionamento estimado pela IA</Kicker>
        <Text style={styles.metric}>{latest?.estimate?.level ?? 'Aguardando dados'}</Text>
        <Text style={styles.body}>
          {latest
            ? 'Estimativa de ' +
              new Date(latest.started).toLocaleDateString('pt-BR') +
              '. ' +
              latest.estimate?.summary
            : 'Acompanhe como seu corpo responde ao esforço em cada sessão com leituras de BPM.'}
        </Text>
      </Card>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.heading}>Histórico da esteira</Text>
      {!list.length && <Text style={styles.body}>Nenhum treino registrado aqui ainda.</Text>}
      {list.slice(0, count).map((w) => {
        const data = evidence(w);
        return (
          <Card key={w.id} style={styles.card}>
            <Kicker>{new Date(w.started).toLocaleString('pt-BR')}</Kicker>
            <Text style={styles.heading}>{data.goal}</Text>
            <Text style={styles.body}>
              {formatDuration(data.movingSeconds)} em movimento ·{' '}
              {formatDecimal(data.distanceMeters / 1000, 2)} km · {w.reason}
            </Text>
            <Text style={styles.body}>
              {formatDecimal(data.averageKmh, 1)} km/h médios ·{' '}
              {formatDecimal(data.averageIncline, 1)}% de inclinação média
            </Text>
            <Text style={styles.caption}>
              {data.averageBpm
                ? data.averageBpm + ' BPM médios · pico de ' + data.peakBpm
                : 'Sem leitura de BPM'}
              {w.restBpm ? ' · 1º minuto ' + w.restBpm : ''}
            </Text>
            {w.estimate ? (
              <>
                <Text style={styles.caption}>{w.estimate.level}</Text>
                <Text style={styles.body}>{w.estimate.summary}</Text>
                {!!w.estimate.maxBpm && (
                  <Text style={styles.body}>FC máxima prevista: {w.estimate.maxBpm} BPM</Text>
                )}
              </>
            ) : (
              <UiButton
                variant="outline"
                label={busy.includes(w.id) ? 'Avaliando…' : 'Avaliar com IA'}
                busy={busy.includes(w.id)}
                onPress={() => void session.evaluate(w)}
              />
            )}
            <UiButton
              variant="ghost"
              label="Apagar registro"
              disabled={busy.includes(w.id)}
              onPress={() => erase(w.id, new Date(w.started).toLocaleString('pt-BR'))}
            />
          </Card>
        );
      })}
      {count < list.length && (
        <UiButton variant="ghost" label="Ver mais treinos" onPress={() => setCount(count + 12)} />
      )}
    </WorkoutPage>
  );
}
