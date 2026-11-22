import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Lucide } from '@react-native-vector-icons/lucide';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Divider, ScoreRing, StatusPill } from '@/components/kit';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { Colors, Neon, NumeralType, withAlpha } from '@/constants/theme';
import { scorePercent } from '@/workouts/briefing';
import type { Kind } from '@/workouts/ai';
import { runScenarios, scenarioCount, scoreboard, type Outcome } from '@/workouts/scenarios';
import { readCalls, type AiCall } from '@/workouts/storage';
import { formatClock } from '@/utils/format';

const kindLabel: Record<string, string> = {
  plan: 'Plano do dia',
  // Antes a IA também revia a carga durante o treino: o diário antigo ainda traz essas chamadas.
  review: 'Revisão durante o treino',
  assess: 'Avaliação',
};
const kinds = ['plan', 'assess'];
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
 * `gymburn://diagnostico?rodar=1&n=3&tipo=plan`.
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
    <WorkoutPage
      title="Diagnóstico"
      accessory={<StatusPill icon="sparkles" color={Neon.violet} label="DeepSeek" />}
      footer={
        <>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <UiButton
            icon="play"
            label={running ? 'Rodando… ' + outcomes.length + ' de ' + total : 'Rodar cenários'}
            busy={running}
            onPress={() => void run(3, null)}
          />
          <Text style={local.hint}>
            Uma rodada leva vários minutos e custa centavos de dólar do seu saldo.
          </Text>
        </>
      }>
      <Text style={local.note}>
        Os cenários enviam situações fixas de treino à DeepSeek com a sua chave e comparam a
        resposta com o desfecho esperado. São {scenarioCount.plan} de plano e{' '}
        {scenarioCount.assess} de avaliação, 3 vezes cada.
      </Text>
      {!!board.length && (
        <View style={local.board}>
          {board.map((b) => {
            const percent = scorePercent(b.correct, b.runs);
            // Verde com tudo certo ou quase; âmbar quando erra mais de uma em dez.
            const color = percent >= 90 ? Neon.mint : Neon.amber;
            return (
              <Card key={b.kind} accent={color} style={local.score}>
                <Kicker>{kindLabel[b.kind]}</Kicker>
                <View
                  style={local.scoreHead}
                  accessible
                  accessibilityLabel={b.correct + ' de ' + b.runs + ' certas, ' + percent + ' por cento'}>
                  <ScoreRing share={b.runs ? b.correct / b.runs : 0} color={color} label={percent + '%'} />
                  <View style={local.grow}>
                    <Text style={local.scoreValue}>
                      {b.correct} de {b.runs}
                    </Text>
                    <Text style={local.small}>certas</Text>
                  </View>
                </View>
                <Text style={local.small}>
                  Concordância {b.agreementPercent}% · {b.calls} chamadas · {b.failures}{' '}
                  {b.failures === 1 ? 'falha' : 'falhas'}
                </Text>
                {b.medianSeconds !== null && (
                  <Text style={local.small}>
                    Mediana de {b.medianSeconds} s, mais lenta em {b.slowestSeconds} s
                  </Text>
                )}
              </Card>
            );
          })}
        </View>
      )}
      {wrong.map((o, i) => (
        <Card key={i} accent={Neon.amber} style={local.wrong}>
          <View style={local.inline}>
            <View style={[local.dot, { backgroundColor: Neon.amber }]} />
            <Kicker color={Neon.amber}>
              {kindLabel[o.kind]} · {o.scenario} · {o.run}ª vez
            </Kicker>
          </View>
          <Text style={local.answer}>{o.answer}</Text>
          {!!(o.error ?? o.detail) && <Text style={local.note}>{o.error ?? o.detail}</Text>}
        </Card>
      ))}
      <Card style={local.journal}>
        <View style={local.between}>
          <View style={local.grow}>
            <Kicker>Diário das chamadas</Kicker>
            <Text style={local.small}>
              {calls.length > 1
                ? 'As ' + calls.length + ' mais recentes · só neste celular'
                : calls.length
                  ? 'A mais recente · só neste celular'
                  : 'Fica só neste celular'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Atualizar diário"
            hitSlop={6}
            onPress={() => setCalls(journal())}
            style={local.round}>
            <Lucide name="refresh-cw" size={15} color={Colors.dark.textSecondary} />
          </Pressable>
          {!!calls.length && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Compartilhar diário"
              hitSlop={6}
              onPress={() =>
                void Share.share({ message: JSON.stringify(calls, null, 1) }).catch(() => {})
              }
              style={[local.round, local.share]}>
              <Lucide name="share-2" size={15} color={Neon.cyan} />
            </Pressable>
          )}
        </View>
        {!calls.length && <Text style={local.note}>Nenhuma chamada registrada ainda.</Text>}
        {calls.slice(0, 30).map((c) => {
          const ok = !!c.data.note || !!c.data.ok;
          return (
            <View key={c.id} style={local.call}>
              <Divider />
              <View style={local.between}>
                <View style={local.inline}>
                  <View style={[local.dot, { backgroundColor: ok ? Neon.mint : Neon.red }]} />
                  <Text style={local.callHead}>
                    {formatClock(c.at)} · {kindLabel[c.kind] ?? c.kind}
                  </Text>
                </View>
                {typeof c.data.ms === 'number' && (
                  <Text style={local.time}>{Math.round(c.data.ms / 100) / 10} s</Text>
                )}
              </View>
              <Text style={[local.answer, !ok && local.failed]}>
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
                <View style={local.snippet}>
                  <Text style={local.small}>{c.data.content.trim().slice(0, 400)}</Text>
                </View>
              )}
            </View>
          );
        })}
      </Card>
    </WorkoutPage>
  );
}

const local = StyleSheet.create({
  grow: { flex: 1, gap: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  hint: { fontSize: 12, lineHeight: 16, textAlign: 'center', color: Colors.dark.textSecondary },
  note: { fontSize: 13, lineHeight: 19, color: Colors.dark.textSecondary },
  small: { fontSize: 12, lineHeight: 17, color: Colors.dark.textSecondary },
  board: { flexDirection: 'row', gap: 10 },
  score: { flex: 1, padding: 14, gap: 8 },
  scoreHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scoreValue: { ...NumeralType, fontSize: 22, lineHeight: 26, color: Colors.dark.text },
  wrong: { gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  answer: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: Colors.dark.text },
  failed: { color: Neon.red },
  journal: { gap: 10 },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.dark.border,
  },
  share: { borderColor: withAlpha(Neon.cyan, 0.45), backgroundColor: withAlpha(Neon.cyan, 0.06) },
  call: { gap: 6 },
  callHead: {
    fontFamily: NumeralType.fontFamily,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Colors.dark.text,
  },
  time: { ...NumeralType, fontSize: 14, color: Colors.dark.textSecondary },
  snippet: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.dark.border,
    backgroundColor: Colors.dark.surfaceSunken,
  },
});
