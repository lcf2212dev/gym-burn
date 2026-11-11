import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Fonts, MinTouchTarget, Spacing } from '@/constants/theme';
import type { ScannedDevice } from '@/ble/transport';
import { useTheme } from '@/hooks/use-theme';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { signalLabel } from '@/utils/controls';

export interface DeviceRowProps {
  device: ScannedDevice;
  /** Este é o aparelho que está sendo conectado agora. */
  connecting: boolean;
  /** Outro aparelho está sendo conectado: o botão fica desabilitado. */
  disabled: boolean;
  onConnect: (deviceId: string) => void;
}

/** Uma linha da lista de aparelhos encontrados na busca. */
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
    <View style={[styles.row, { borderColor: theme.border }]}>
      <View style={styles.info}>
        <View style={styles.nameLine}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {name}
          </Text>
          {signal ? (
            <Text style={[styles.signal, { color: theme.textSecondary }]}>{signal}</Text>
          ) : null}
        </View>
        {/* Sem nome, o endereço é o que distingue um aparelho do outro. */}
        {device.name === null ? (
          <Text style={[styles.address, { color: theme.textSecondary }]} numberOfLines={1}>
            {device.id}
          </Text>
        ) : null}
        {tags.length > 0 ? (
          <View style={styles.tags}>
            {tags.map((tag) => (
              <Text
                key={tag}
                style={[styles.tag, { color: theme.textSecondary, borderColor: theme.border }]}>
                {tag}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {connecting ? (
        <View style={styles.connecting} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.text} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    borderBottomWidth: 1,
  },
  info: {
    flex: 1,
    gap: Spacing.one,
  },
  nameLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: Spacing.two,
  },
  name: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: 600,
  },
  signal: {
    fontSize: 14,
  },
  address: {
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  tags: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  tag: {
    fontSize: 13,
    fontWeight: 600,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.half,
  },
  connecting: {
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  connectingText: {
    fontSize: 16,
    fontWeight: 600,
  },
  button: {
    minWidth: 120,
  },
});
