import { Lucide } from '@react-native-vector-icons/lucide';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Kicker } from '@/components/card';
import { Colors, NumeralType, withAlpha } from '@/constants/theme';

// As peças que as telas do app dividem: o estado no alto da tela, o selo de
// ícone, a linha de lista, os anéis e o anel de acerto.

export type IconName = ComponentProps<typeof Lucide>['name'];

/** O estado de um aparelho no alto da tela: um ponto ou um ícone na cor do estado, e o texto. */
export function StatusPill({
  label,
  color,
  icon,
  onPress,
}: {
  label: string;
  color: string;
  icon?: IconName;
  onPress?: () => void;
}) {
  const body = (
    <View
      style={[styles.pill, { borderColor: withAlpha(color, 0.35), backgroundColor: withAlpha(color, 0.08) }]}>
      {icon ? (
        <Lucide name={icon} size={12} color={color} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={styles.pillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** Um ícone num quadrado de canto redondo, tingido da cor do assunto. */
export function IconBadge({ icon, color, size = 38 }: { icon: IconName; color: string; size?: number }) {
  return (
    <View
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size * 0.31,
          borderColor: withAlpha(color, 0.3),
          backgroundColor: withAlpha(color, 0.12),
        },
      ]}>
      <Lucide name={icon} size={Math.round(size * 0.45)} color={color} />
    </View>
  );
}

/** O rótulo de um cartão com o ícone do assunto na frente. */
export function IconKicker({ icon, color, children }: { icon: IconName; color: string; children: ReactNode }) {
  return (
    <View style={styles.kicker}>
      <Lucide name={icon} size={13} color={color} />
      <Kicker color={color}>{children}</Kicker>
    </View>
  );
}

/** Uma linha de lista: selo, título, apoio e, à direita, a seta ou o que vier em `right`. */
export function ListRow({
  icon,
  color,
  title,
  sub,
  right,
  onPress,
}: {
  icon: IconName;
  color: string;
  title: string;
  sub?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title + (sub ? '. ' + sub : '')}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <IconBadge icon={icon} color={color} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {right ?? <Lucide name="chevron-right" size={18} color={Colors.dark.textSecondary} />}
    </Pressable>
  );
}

/** A linha fina entre duas linhas de um cartão. */
export function Divider() {
  return <View style={styles.divider} />;
}

/**
 * Anéis concêntricos na cor do assunto, com o conteúdo no centro: o pulso da
 * cinta e a busca de um aparelho.
 */
export function Rings({ size, color, children }: { size: number; color: string; children?: ReactNode }) {
  const half = size / 2;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {[1, 0.76, 0.52].map((share, i) => (
          <Circle
            key={share}
            cx={half}
            cy={half}
            r={half * share - 1}
            fill={color}
            fillOpacity={0.03 + i * 0.02}
            stroke={color}
            strokeOpacity={0.18 + i * 0.1}
            strokeWidth={1}
          />
        ))}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>{children}</View>
    </View>
  );
}

/** Um anel que se fecha conforme a fração, com o texto no centro: o acerto de um placar. */
export function ScoreRing({ share, color, label }: { share: number; color: string; label: string }) {
  const size = 84;
  const radius = 37;
  const angle = Math.min(Math.max(share, 0), 0.9999) * 2 * Math.PI - Math.PI / 2;
  const end = { x: size / 2 + radius * Math.cos(angle), y: size / 2 + radius * Math.sin(angle) };
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={Colors.dark.border} strokeWidth={9} fill="none" />
        {share > 0 && (
          <Path
            d={`M ${size / 2} ${size / 2 - radius} A ${radius} ${radius} 0 ${share > 0.5 ? 1 : 0} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`}
            stroke={color}
            strokeWidth={9}
            strokeLinecap="round"
            fill="none"
          />
        )}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <Text style={styles.ringText}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { ...NumeralType, fontSize: 15, letterSpacing: 0.4, color: Colors.dark.text },
  badge: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 4 },
  pressed: { opacity: 0.7 },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: Colors.dark.text },
  rowSub: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  divider: { height: 1, backgroundColor: Colors.dark.border },
  center: { alignItems: 'center', justifyContent: 'center' },
  ringText: { ...NumeralType, fontSize: 24, color: Colors.dark.text },
});
