import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { ScannedDevice } from '@/ble/transport';
import { ActionButton } from '@/components/action-button';
import { Pill, type PillTone } from '@/components/pill';
import { Surface } from '@/components/surface';
import { Fonts, MinTouchTarget, Neon } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { signalLabel } from '@/utils/controls';

/** Cada tag da esteira tem uma cor fixa no console. */
const TAG_TONES: Record<string, PillTone> = {
  Esteira: 'volt',
  Matrix: 'violet',
  'Em uso': 'amber',
};

export interface DeviceRowProps {
  device: ScannedDevice;
  /** Este é o aparelho que está sendo conectado agora. */
  connecting: boolean;
  /** Outro aparelho está sendo conectado: o botão fica desabilitado. */
  disabled: boolean;
  onConnect: (deviceId: string) => void;
}

/** Um cartão da lista de aparelhos encontrados na busca. */
export function DeviceRow({ device, connecting, disabled, onConnect }: DeviceRowProps) {
  const theme = useTheme();
  const name = device.name ?? 'Aparelho sem nome';
  const signal = signalLabel(device.rssi);
  const tags: string[] = [];
  if (device.ftms?.machineTypes.treadmill) {
    tags.push('Esteira');
  } else if (looksLikeMatrixConsole(device.name)) {
    tags.push('Matrix');
  }
  if (device.ftms && !device.ftms.available) {
    tags.push('Em uso');
  }

  return (
    <Surface tone="raised" padded={false} style={styles.card}>
      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
          {name}
        </Text>
        {/* Sem nome, o endereço é o que distingue um aparelho do outro. */}
        {device.name === null ? (
          <Text style={[styles.address, { color: theme.textSecondary }]} numberOfLines={1}>
            {device.id}
          </Text>
        ) : null}
        {signal || tags.length > 0 ? (
          <View style={styles.pills}>
            {signal ? <Pill label={signal} dot /> : null}
            {tags.map((tag) => (
              <Pill key={tag} label={tag} tone={TAG_TONES[tag] ?? 'neutral'} />
            ))}
          </View>
        ) : null}
      </View>

      {connecting ? (
        <View style={styles.connecting} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={Neon.volt} />
          <Text style={[styles.connectingText, { color: theme.text }]}>Conectando…</Text>
        </View>
      ) : (
        <ActionButton
          variant="primary"
          label="Conectar"
          accessibilityLabel={`Conectar em ${name}`}
          onPress={() => onConnect(device.id)}
          disabled={disabled}
          style={styles.button}
        />
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  info: {
    flex: 1,
    flexShrink: 1,
    gap: 6,
  },
  name: {
    fontFamily: Fonts.display,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: 0.3,
  },
  address: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 16,
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  connecting: {
    width: 120,
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  connectingText: {
    fontFamily: Fonts.display,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.3,
  },
  button: {
    width: 120,
  },
});
