import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import { Neon, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill } from '@/treadmill/treadmill-context';

/**
 * Resultado do plano automático do protocolo Gizwits no 0xFFF0.
 *
 * O painel dispara sozinho depois que o usuário confirma a esteira: pede
 * “machine info”, tenta variantes seguras se não houver resposta e, quando o
 * canal responde, testa só comandos de leitura/parada. Nada aqui liga ou ajusta
 * a lona.
 */
export function GizwitsProbeCard() {
  const theme = useTheme();
  const probe = useTreadmill((s) => s.gizwitsProbe);

  // Idle e “sem canal” (inclusive demonstração) não viram cartão: não há notícia.
  if (probe.status === 'idle' || probe.status === 'unavailable') return null;

  const replies = probe.attempts.filter((attempt) => attempt.status === 'reply').length;
  const attemptsText =
    probe.attempts.length > 0
      ? `${replies} de ${probe.attempts.length} tentativa(s) com resposta.`
      : null;

  const statusText =
    probe.status === 'running'
      ? probe.stage
        ? `Testando o canal alternativo: ${probe.stage}…`
        : 'Testando o canal alternativo da esteira…'
      : probe.status === 'waitingBelt'
        ? (probe.hint ?? 'No painel, pare a esteira para eu continuar o teste.')
        : probe.status === 'compatible'
          ? 'Canal alternativo compatível: a esteira respondeu.'
          : probe.status === 'incompatible'
            ? 'O canal alternativo não respondeu a nenhuma tentativa.'
            : `O teste do canal alternativo não pôde ser feito: ${probe.detail ?? 'erro desconhecido'}.`;

  return (
    <Surface
      tone="raised"
      style={styles.card}
      accent={probe.status === 'compatible' ? Neon.volt : undefined}>
      <View style={styles.header}>
        <SectionLabel label="Teste automático do canal alternativo" accent={Neon.violet} />
        {probe.status === 'running' ? <ActivityIndicator size="small" color={Neon.violet} /> : null}
      </View>
      <Text style={[styles.status, { color: theme.text }]}>{statusText}</Text>
      {probe.status === 'compatible' && probe.replyHex ? (
        <>
          {probe.replyCommand ? (
            <Text style={[styles.detail, { color: theme.textSecondary }]}>
              Primeira resposta: {probe.replyCommand}.
            </Text>
          ) : null}
          <Text style={[styles.hex, { color: theme.textSecondary }]} numberOfLines={2}>
            {probe.replyHex}
            {probe.replyBytes > 64 ? '…' : ''}
          </Text>
        </>
      ) : null}
      {attemptsText ? (
        <Text style={[styles.detail, { color: theme.textSecondary }]}>{attemptsText}</Text>
      ) : null}
      {probe.status === 'incompatible' ? (
        <Text style={[styles.detail, { color: theme.textSecondary }]}>
          Se quiser tentar outro caminho, o app AFG Pro está instalado no celular — veja se ele
          encontra esta esteira. O detalhe de cada tentativa fica na Sonda.
        </Text>
      ) : null}
      <Text style={[styles.footnote, { color: theme.textSecondary }]}>
        Só leitura e parada: nada aqui liga ou ajusta a esteira. O detalhe de cada tentativa fica na
        Sonda (toque longo na versão).
      </Text>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.one,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  status: {
    fontSize: 14,
    lineHeight: 19,
  },
  detail: {
    fontSize: 12,
    lineHeight: 16,
  },
  hex: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'monospace',
  },
  footnote: {
    fontSize: 11,
    lineHeight: 15,
    paddingTop: 2,
  },
});
