import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Glass, LabelType, Radius, Spacing, withAlpha } from '@/constants/theme';

interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Cor de destaque: contorno e brilho sutil (o "cartão principal" da grandeza). */
  accent?: string;
  /** Cartão principal: raio maior e fundo mais alto. */
  hero?: boolean;
  padded?: boolean;
}

/**
 * Superfície de vidro escuro: o tijolo de construção do cockpit. Fundo
 * translúcido, contorno fino de 1 px e, opcionalmente, o contorno na cor da
 * grandeza que ele mostra.
 */
export function Card({ children, style, accent, hero = false, padded = true }: CardProps) {
  return (
    <View
      style={[
        styles.card,
        hero ? styles.hero : null,
        accent ? { borderColor: withAlpha(accent, 0.28) } : null,
        padded ? styles.padded : null,
        style,
      ]}>
      {children}
    </View>
  );
}

/** Rótulo miúdo em caixa alta, o "kicker" de cada bloco. */
export function Kicker({
  children,
  color,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.kicker, LabelType, color ? { color } : null, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Glass.card,
    borderWidth: 1,
    borderColor: withAlpha('#FFFFFF', 0.07),
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  hero: {
    backgroundColor: Glass.hero,
    borderRadius: Radius.hero,
  },
  padded: {
    padding: Spacing.four,
  },
  kicker: {
    color: '#9AA7B8',
  },
});
