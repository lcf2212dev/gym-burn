import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Share, Text } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import type { Kind } from '@/workouts/ai';
import { runScenarios, scenarioCount, scoreboard, type Outcome } from '@/workouts/scenarios';
import { readCalls, type AiCall } from '@/workouts/storage';
import { formatClock } from '@/utils/format';

const kindLabel: Record<string, string> = {
  plan: 'Plano do dia',
  review: 'Revisão durante o treino',
  assess: 'Avaliação',
};
const kinds = ['plan', 'review', 'assess'];
function journal(): AiCall[] {
  try {
    return readCalls();
  } catch {
    return [];
  }
}

/**
 * Diário das chamadas à IA e cenários fixos que medem a precisão dela com a
 * chave salva neste aparelho. Também abre por link, para rodar pelo adb:
 * `gymburn://diagnostico?rodar=1&n=3&tipo=review`.
 */
export default function Diagnostics() {
  useKeepAwake();
  const params = useLocalSearchParams<{
    rodar?: string;
    n?: string;
    tipo?: string;
  }>();
  const [calls, setCalls] = useState(journal);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const started = useRef(false);

  const run = useCallback(async (repeats: number, only: Kind | null) => {
    setRunning(true);
    setOutcomes([]);
    setError('');
    try {
      await runScenarios(repeats, only, (done, count) => {
        setOutcomes(done);
        setTotal(count);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao rodar os cenários.');
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (params.rodar !== '1' || started.current) return;
    started.current = true;
    const repeats = Math.min(5, Math.max(1, Number(params.n) || 3));
    const only = kinds.includes(params.tipo ?? '') ? (params.tipo as Kind) : null;
    // Fora do corpo do efeito: a rodada muda o estado da tela ao começar.
    setTimeout(() => void run(repeats, only), 0);
  }, [params, run]);

  const board = scoreboard(outcomes);
  const wrong = outcomes.filter((o) => !o.ok);
  return (
    <WorkoutPage title="Diagnóstico da IA">
      <Text style={styles.body}>
        Os cenários enviam situações fixas de treino à DeepSeek com a sua chave e comparam a
        resposta com o desfecho esperado. São {scenarioCount.plan} de plano, {scenarioCount.review}{' '}
        de revisão e {scenarioCount.assess} de avaliação, 3 vezes cada. Uma rodada completa leva
        vários minutos e custa centavos de dólar do seu saldo.
      </Text>
      <UiButton
        label={running ? 'Rodando… ' + outcomes.length + ' de ' + total : 'Rodar cenários'}
        busy={running}
        onPress={() => void run(3, null)}
      />
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {board.map((b) => (
        <Card key={b.kind} style={styles.card}>
          <Kicker>{kindLabel[b.kind]}</Kicker>
          <Text style={styles.metric}>
            {b.correct} de {b.runs} certas
          </Text>
          <Text style={styles.body}>
            Concordância entre repetições: {b.agreementPercent}%. Chamadas à IA: {b.calls}. Falhas:{' '}
            {b.failures}.
          </Text>
          {b.medianSeconds !== null && (
            <Text style={styles.body}>
              Tempo de resposta: mediana de {b.medianSeconds} s, mais lenta em {b.slowestSeconds} s.
            </Text>
          )}
        </Card>
      ))}
      {wrong.map((o, i) => (
        <Card key={i} style={styles.group}>
          <Kicker>
            {kindLabel[o.kind]} · {o.scenario} · {o.run}ª vez
          </Kicker>
          <Text style={styles.caption}>{o.answer}</Text>
          {!!(o.error ?? o.detail) && <Text style={styles.body}>{o.error ?? o.detail}</Text>}
        </Card>
      ))}
      <Text style={styles.heading}>Diário das chamadas</Text>
      <Text style={styles.body}>
        As {calls.length} chamadas mais recentes feitas pelos treinos, com o que foi enviado e o que
        voltou. O diário fica só neste celular.
      </Text>
      <UiButton variant="ghost" label="Atualizar diário" onPress={() => setCalls(journal())} />
      {!!calls.length && (
        <UiButton
          variant="outline"
          label="Compartilhar diário"
          onPress={() => void Share.share({ message: JSON.stringify(calls, null, 1) }).catch(() => {})}
        />
      )}
      {calls.slice(0, 30).map((c) => (
        <Card key={c.id} style={styles.group}>
          <Kicker>
            {formatClock(c.at)} · {kindLabel[c.kind] ?? c.kind}
            {typeof c.data.ms === 'number' ? ' · ' + Math.round(c.data.ms / 100) / 10 + ' s' : ''}
          </Kicker>
          <Text style={styles.caption}>
            {c.data.note
              ? String(c.data.note)
              : c.data.ok
                ? 'Resposta aceita'
                : 'Falhou: ' + String(c.data.error ?? '')}
            {typeof c.data.attempt === 'number' && c.data.attempt > 1
              ? ' · tentativa ' + c.data.attempt
              : ''}
          </Text>
          {typeof c.data.content === 'string' && (
            <Text style={styles.body}>{c.data.content.trim().slice(0, 400)}</Text>
          )}
        </Card>
      ))}
    </WorkoutPage>
  );
}
