import { Lucide } from '@react-native-vector-icons/lucide';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LabelType } from '@/constants/theme';

export type IconName = ComponentProps<typeof Lucide>['name'];

/** O rótulo de um número do painel, com o ícone que deixa achá-lo de relance. */
export function IconLabel({ icon, label, color }: { icon: IconName; label: string; color: string }) {
  return (
    <View style={styles.row}>
      <Lucide name={icon} size={13} color={color} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { ...LabelType, flexShrink: 1, fontSize: 11, lineHeight: 13, letterSpacing: 1, color: '#9AA7B8' },
});
