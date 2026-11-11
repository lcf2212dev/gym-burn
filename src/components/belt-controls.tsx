import { StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { ActionColors, Spacing, StopButtonHeight } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/**
 * Os botões da lona, nas cores dos botões físicos. Ficam fixos no rodapé do
 * painel: Parar tem que estar sempre à vista, sem rolar a tela.
 *
 * Iniciar e Pausar dividem o mesmo lugar, conforme o estado da lona: com a
 * lona rodando, os dois botões visíveis a freiam. Para um segundo toque em
 * Pausar não cair no Retomar que aparece no lugar, a sessão bloqueia o Iniciar
 * (`startBlocked`) até a lona parar de girar.
 *
 * Sem Control Point, os botões dão lugar a uma explicação.
 */
export function BeltControls() {
  const theme = useTheme();
  const control = useTreadmill((s) => s.control);
  const belt = useTreadmill((s) => s.belt);
  const startBlocked = useTreadmill((s) => s.startBlocked);
  const { start, pause, stop } = useTreadmillActions();

  if (control === 'unavailable') {
    return (
      <Text style={[styles.readOnly, { color: theme.text }]}>
        Esta esteira só transmite dados por Bluetooth. Ajuste velocidade e inclinação pelo painel
        dela.
      </Text>
    );
  }

  return (
    <View style={styles.row}>
      {belt === 'running' ? (
        <ActionButton
          variant="solid"
          color={ActionColors.pause}
          onColor={ActionColors.onPause}
          label="Pausar"
          accessibilityLabel="Pausar a lona"
          onPress={pause}
          style={styles.toggle}
          labelStyle={styles.label}
        />
      ) : (
        <ActionButton
          variant="solid"
          color={ActionColors.go}
          onColor={ActionColors.onGo}
          label={belt === 'paused' ? 'Retomar' : 'Iniciar'}
          accessibilityLabel={belt === 'paused' ? 'Retomar a lona' : 'Iniciar a lona'}
          onPress={start}
          // Com a chave de segurança fora, a lona só volta pelo painel da esteira.
          // E logo depois de Pausar ou Parar, só quando ela parar de girar.
          disabled={belt === 'safetyKey' || startBlocked}
          style={styles.toggle}
          labelStyle={styles.label}
        />
      )}
      <ActionButton
        variant="solid"
        color={ActionColors.stop}
        onColor={ActionColors.onStop}
        label="Parar"
        accessibilityLabel="Parar a lona"
        onPress={stop}
        style={styles.stop}
        labelStyle={styles.label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  toggle: {
    flex: 2,
    minHeight: StopButtonHeight,
    borderWidth: 0,
  },
  // O maior alvo de toque da tela.
  stop: {
    flex: 3,
    minHeight: StopButtonHeight,
    borderWidth: 0,
  },
  label: {
    fontSize: 22,
  },
  readOnly: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
  },
});
