import { StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Surface } from '@/components/surface';
import { Neon, Spacing, TitleType } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmillActions } from '@/treadmill/treadmill-context';

/**
 * Ocupa o lugar dos botões da lona até o usuário confirmar que a esteira
 * conectada é a dele. Numa academia com várias esteiras iguais lado a lado, a
 * lista de aparelhos não basta: comandar a do vizinho mexeria na lona de outra
 * pessoa. A sessão recusa qualquer comando antes dessa confirmação.
 */
export function IdentityCheck() {
  const theme = useTheme();
  const { confirmIdentity, disconnect } = useTreadmillActions();

  return (
    <Surface accent={Neon.amber} tone="raised" padded={false} style={styles.container}>
      <View style={styles.text}>
        <Text style={[styles.title, TitleType, { color: theme.text }]} accessibilityRole="header">
          Esta é a sua esteira?
        </Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          Confira no painel dela antes de comandar: o indicador Bluetooth acendeu e os números são
          os mesmos que aparecem aqui.
        </Text>
      </View>
      <ActionButton variant="primary" label="É esta esteira" onPress={confirmIdentity} />
      <ActionButton
        variant="outline"
        color={Neon.amber}
        label="Não é, desconectar"
        onPress={disconnect}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
  },
  text: {
    gap: Spacing.one,
  },
  title: {
    fontSize: 22,
    lineHeight: 26,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
});
