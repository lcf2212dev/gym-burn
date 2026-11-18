import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScannedDevice } from '@/ble/transport';
import { Pill } from '@/components/pill';
import { Surface } from '@/components/surface';
import {
  Fonts,
  MinTouchTarget,
  Neon,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { signalLabel, signalLevel, type SignalLevel } from '@/utils/format';

/** Alturas das barras, da menor para a maior: quatro barras, como um medidor. */
const BAR_HEIGHTS = [5, 8, 11, 14] as const;

export interface DeviceRowProps {
  device: ScannedDevice;
  /** Este é o aparelho que está sendo conectado agora. */
  connecting: boolean;
  /** Outro aparelho está sendo conectado: a linha fica inerte. */
  disabled: boolean;
  onConnect: (deviceId: string) => void;
}

/**
 * Um equipamento achado na busca. A linha inteira é o alvo: tocar nela conecta.
 * O sinal aparece em barras (contagem) e em palavra, para não depender de cor;
 * o CTA à direita é a pista visual do que o toque faz.
 */
export function DeviceRow({ device, connecting, disabled, onConnect }: DeviceRowProps) {
  const theme = useTheme();
  const name = device.name ?? 'Aparelho sem nome';
  const level = signalLevel(device.rssi);
  const signal = signalLabel(level);
  const label = `${name}. ${signal}.${device.advertisesFtms ? ' FTMS.' : ''} Toque para conectar.`;
  const unavailable = disabled && !connecting;

  return (
    <Pressable
      onPress={() => onConnect(device.id)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: connecting }}
      style={({ pressed }) => [styles.press, pressed && styles.pressed]}>
      <Surface
        tone={connecting ? 'raised' : 'default'}
        glow={connecting ? Neon.volt : null}
        padded={false}
        style={[styles.card, unavailable && styles.unavailable]}>
        <View style={styles.info}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {name}
          </Text>
          {device.name === null ? (
            <Text style={[styles.address, { color: theme.textSecondary }]} numberOfLines={1}>
              {device.id}
            </Text>
          ) : null}
          <View style={styles.meta}>
            <SignalBars level={level} activeColor={signalColor(level, theme)} inactiveColor={theme.border} />
            <Text
              style={[styles.signal, { color: level === 0 ? theme.textMuted : theme.textSecondary }]}
              numberOfLines={1}>
              {signal}
            </Text>
            {device.advertisesFtms ? (
              <Pill label="FTMS" tone="cyan" size="sm" style={styles.pill} />
            ) : null}
          </View>
        </View>

        {connecting ? (
          <View style={styles.connecting} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={Neon.volt} />
            <Text style={[styles.connectingText, { color: Neon.volt }]}>Conectando</Text>
          </View>
        ) : (
          <View
            style={[
              styles.cta,
              { backgroundColor: withAlpha(Neon.volt, 0.1), borderColor: withAlpha(Neon.volt, 0.45) },
            ]}
            pointerEvents="none">
            <Text style={[styles.ctaLabel, { color: Neon.volt }]} numberOfLines={1}>
              Conectar
            </Text>
          </View>
        )}
      </Surface>
    </Pressable>
  );
}

/** Cor da barra acesa; a contagem de barras já diz o nível sem a cor. */
function signalColor(level: SignalLevel, theme: ReturnType<typeof useTheme>): string {
  if (level === 0) {
    return theme.textMuted;
  }
  if (level >= 3) {
    return Neon.volt;
  }
  if (level === 2) {
    return theme.noticeWarning;
  }
  return theme.noticeError;
}

function SignalBars({
  level,
  activeColor,
  inactiveColor,
}: {
  level: SignalLevel;
  activeColor: string;
  inactiveColor: string;
}) {
  return (
    <View
      accessible={false}
      style={styles.bars}
      // As barras são redundantes com o texto ao lado; não viram foco próprio.
      importantForAccessibility="no-hide-descendants">
      {BAR_HEIGHTS.map((height, index) => {
        const filled = index < level;
        return (
          <View
            key={height}
            style={{
              width: 3,
              height,
              borderRadius: 1,
              backgroundColor: filled ? activeColor : inactiveColor,
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  press: {
    borderRadius: Radius.lg,
  },
  pressed: {
    opacity: 0.9,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingLeft: Spacing.four,
    paddingRight: Spacing.three,
    paddingVertical: Spacing.three,
  },
  unavailable: {
    opacity: 0.55,
  },
  info: {
    flex: 1,
    flexShrink: 1,
    gap: 3,
  },
  name: {
    fontFamily: Fonts.display,
    fontSize: 21,
    lineHeight: 24,
    letterSpacing: 0.3,
  },
  address: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 16,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: BAR_HEIGHTS[BAR_HEIGHTS.length - 1],
  },
  signal: {
    fontFamily: Fonts.label,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  pill: {
    marginLeft: 'auto',
  },
  cta: {
    minHeight: MinTouchTarget,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: Spacing.three,
  },
  ctaLabel: {
    fontFamily: Fonts.display,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  connecting: {
    minHeight: MinTouchTarget,
    minWidth: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  connectingText: {
    fontFamily: Fonts.display,
    fontSize: 15,
    lineHeight: 19,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
