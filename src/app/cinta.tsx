import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { Metric } from '@/constants/theme';
import { useStrap, useStrapActions, useStrapHold } from '@/heart/strap-context';
import type { StrapPhase } from '@/heart/strap-session';

const STATUS: Record<StrapPhase, string> = {
  idle: 'Em espera.',
  searching: 'Procurando a cinta por perto…',
  connecting: 'Conectando…',
  connected: 'Conectada.',
};

/**
 * Pareamento da cinta de batimentos. A pessoa escolhe a cinta uma vez; daí em
 * diante o app conecta sozinho quando procura ou usa uma esteira. Com a tela
 * aberta a cinta fica conectada, para dar para conferir a leitura.
 */
export default function StrapScreen() {
  useStrapHold();
  const saved = useStrap((s) => s.saved);
  const phase = useStrap((s) => s.phase);
  const bpm = useStrap((s) => s.bpm);
  const battery = useStrap((s) => s.battery);
  const pairing = useStrap((s) => s.pairing);
  const candidates = useStrap((s) => s.candidates);
  const error = useStrap((s) => s.error);
  const actions = useStrapActions();

  // Sem cinta pareada, a busca começa ao abrir a tela e para ao sair dela.
  const paired = saved !== null;
  useEffect(() => {
    if (!paired) actions.startPairing();
    return actions.stopPairing;
  }, [actions, paired]);

  return (
    <WorkoutPage title="Cinta de batimentos">
      <Text style={styles.body}>
        Com uma cinta no peito o app lê os batimentos direto dela, uma vez por segundo, e o guia
        deixa de pedir as mãos no sensor. Sem a cinta, ou se a conexão dela cair, voltam a valer os
        batimentos do sensor de mão da esteira.
      </Text>
      {saved ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>{saved.name ?? 'Cinta pareada'}</Text>
          <Text style={styles.body} accessibilityLiveRegion="polite">
            {STATUS[phase]}
            {phase === 'connected' && battery !== null ? ' Bateria em ' + battery + '%.' : ''}
          </Text>
          {phase === 'connected' ? (
            <Text
              style={[styles.metric, { color: Metric.heart }]}
              accessibilityLabel={bpm === null ? 'Sem leitura' : bpm + ' batimentos por minuto'}>
              {bpm === null ? '–– BPM' : bpm + ' BPM'}
            </Text>
          ) : null}
          {phase === 'connected' && bpm === null ? (
            <Text style={styles.body}>
              A cinta conectou, mas ainda não mandou leitura. Ajuste-a no peito e umedeça os
              eletrodos.
            </Text>
          ) : null}
          {phase === 'idle' ? (
            <UiButton variant="outline" label="Procurar a cinta" onPress={actions.retry} />
          ) : null}
          <UiButton variant="ghost" label="Esquecer cinta" onPress={actions.forget} />
        </Card>
      ) : (
        <Card style={styles.card}>
          <Text style={styles.heading}>
            {pairing ? 'Procurando cintas…' : candidates.length ? 'Cintas encontradas' : 'Nenhuma cinta por perto'}
          </Text>
          <Text style={styles.body}>
            Vista a cinta antes de procurar: a maioria só liga o Bluetooth em contato com a pele.
            Serve qualquer monitor que use o perfil padrão de frequência cardíaca.
          </Text>
          <View style={styles.group}>
            {candidates.map((found) => (
              <Pressable
                key={found.id}
                accessibilityRole="button"
                accessibilityLabel={'Parear com ' + (found.name ?? 'monitor sem nome')}
                style={styles.option}
                onPress={() => actions.choose(found.id)}>
                <Text style={styles.caption}>{found.name ?? 'Monitor sem nome'}</Text>
              </Pressable>
            ))}
          </View>
          {pairing ? null : (
            <UiButton variant="outline" label="Procurar de novo" onPress={actions.startPairing} />
          )}
        </Card>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </WorkoutPage>
  );
}
