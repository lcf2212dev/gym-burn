import { StyleSheet, View } from 'react-native';

import { BeltControls } from '@/components/belt-controls';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill } from '@/treadmill/treadmill-context';

/**
 * Rodapé com os botões da lona para as telas que cobrem o painel (diagnóstico, roteiro,
 * registros): Parar tem que continuar à vista em qualquer tela. Não renderiza nada sem uma
 * esteira confirmada que aceite comandos.
 *
 * A borda fina no topo separa a "tampa" da tela sem pesar.
 */
export function BeltFooter() {
  const theme = useTheme();
  const canCommandBelt = useTreadmill(
    (s) =>
      s.phase === 'connected' &&
      s.identityConfirmed &&
      (s.vendor.enabled || s.control !== 'unavailable'),
  );

  if (!canCommandBelt) {
    return null;
  }

  return (
    <View
      style={[
        styles.footer,
        {
          borderTopColor: theme.border,
          backgroundColor: theme.background,
        },
      ]}>
      <View style={styles.content}>
        <BeltControls />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    borderTopWidth: 1,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
});
