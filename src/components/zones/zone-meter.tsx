import { StyleSheet, View } from 'react-native';

import { Colors, ZoneColors } from '@/constants/theme';

/**
 * As cinco zonas como barras de sinal, da Z1 à Z5: as que a faixa do treino
 * atravessa ficam acesas na cor delas. Deixa ver a intensidade do dia sem ler.
 */
export function ZoneMeter({ lit }: { lit: readonly number[] }) {
  return (
    <View style={styles.row} accessible={false}>
      {ZoneColors.map((color, zone) => (
        <View
          key={zone}
          style={[
            styles.bar,
            { height: 6 + zone * 3, backgroundColor: lit.includes(zone) ? color : Colors.dark.borderStrong },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  bar: { width: 5, borderRadius: 2 },
});
