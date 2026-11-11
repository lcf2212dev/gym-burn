import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { DeviceRow } from '@/components/device-row';
import { GuideStrip } from '@/components/guide-strip';
import { NoticeBanner } from '@/components/notice-banner';
import { MaxContentWidth, MinTouchTarget, Spacing } from '@/constants/theme';
import { useGuide, useGuideActions } from '@/guide/guide-context';
import { useTheme } from '@/hooks/use-theme';
import { DiagnosticsModal } from '@/screens/diagnostics-modal';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

const STEPS = [
  'Na esteira, segure o botão Bluetooth por 5 segundos, até o painel entrar no modo APP.',
  'Toque em Procurar esteiras e escolha a sua na lista. Se o painel mostrar um código, ele pode fazer parte do nome dela.',
];

/** Primeira tela: instruções, busca por esteiras e o modo demonstração. */
export function ConnectScreen() {
  const theme = useTheme();
  const scan = useTreadmill((s) => s.scan);
  const devices = useTreadmill((s) => s.devices);
  const phase = useTreadmill((s) => s.phase);
  const connectingId = useTreadmill((s) => s.device?.id ?? null);
  const hasLog = useTreadmill((s) => s.log.length > 0);
  const actions = useTreadmillActions();
  const guideActive = useGuide((s) => s.active);
  const guide = useGuideActions();
  const [showAll, setShowAll] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const openGuide = () => {
    if (!guideActive) {
      guide.start();
    }
    router.push('/roteiro');
  };

  const scanning = scan !== 'idle';
  const connecting = phase === 'connecting';
  // Alguns consoles não anunciam o serviço FTMS, e alguns nem o nome; com o
  // interruptor, o usuário pode tentar qualquer aparelho ao alcance.
  const visible = devices.filter(
    (d) => d.advertisesFtms || looksLikeMatrixConsole(d.name) || showAll,
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <GuideStrip />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View>
            <View style={styles.topLine}>
              <Text style={[styles.appName, { color: theme.textSecondary }]}>Gym Burn</Text>
              <View style={styles.topActions}>
                <ActionButton
                  variant="text"
                  label="Registros"
                  onPress={() => router.push('/registros')}
                />
                {/* Uma conexão que falhou também deixa registro: é daqui que se chega a ele. */}
                {hasLog ? (
                  <ActionButton
                    variant="text"
                    label="Diagnóstico"
                    onPress={() => setDiagnosticsOpen(true)}
                  />
                ) : null}
              </View>
            </View>
            <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
              Conecte sua esteira
            </Text>
          </View>

          <View style={styles.steps}>
            {STEPS.map((step, index) => (
              <View key={step} style={styles.step}>
                <Text style={[styles.stepNumber, { color: theme.text }]}>{index + 1}</Text>
                <Text style={[styles.stepText, { color: theme.text }]}>{step}</Text>
              </View>
            ))}
          </View>

          <ActionButton
            variant="outline"
            label="Primeiro teste na esteira"
            onPress={openGuide}
          />

          <NoticeBanner />

          {scanning ? (
            <ActionButton
              variant="primary"
              label="Parar busca"
              busy
              onPress={actions.stopScan}
            />
          ) : (
            <ActionButton
              variant="primary"
              label="Procurar esteiras"
              onPress={actions.startScan}
              disabled={connecting}
            />
          )}

          {scanning || visible.length > 0 ? (
            <View>
              <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
                Esteiras encontradas
              </Text>
              <View style={[styles.list, { borderColor: theme.border }]}>
                {visible.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    connecting={connecting && device.id === connectingId}
                    disabled={connecting}
                    onConnect={actions.connect}
                  />
                ))}
              </View>
              {visible.length === 0 ? (
                <Text style={[styles.empty, { color: theme.textSecondary }]}>
                  Procurando… Se a sua não aparecer, confira se o indicador Bluetooth do painel
                  está apagado: a esteira aceita um aparelho por vez.
                </Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.switchRow}>
            <Text
              style={[styles.switchLabel, { color: theme.text }]}
              onPress={() => setShowAll(!showAll)}>
              Mostrar outros aparelhos Bluetooth
            </Text>
            <Switch
              value={showAll}
              onValueChange={setShowAll}
              accessibilityLabel="Mostrar outros aparelhos Bluetooth"
            />
          </View>

          <View style={[styles.demo, { borderColor: theme.border }]}>
            <Text style={[styles.demoText, { color: theme.textSecondary }]}>
              Sem esteira por perto? Use uma esteira simulada para conhecer o app.
            </Text>
            <ActionButton
              variant="outline"
              label="Abrir modo demonstração"
              onPress={actions.openDemo}
              disabled={connecting}
            />
          </View>
        </View>
      </ScrollView>

      <DiagnosticsModal visible={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  topLine: {
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  appName: {
    fontSize: 16,
    fontWeight: 600,
  },
  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: 700,
  },
  steps: {
    gap: Spacing.three,
  },
  step: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  stepNumber: {
    width: 20,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 700,
  },
  stepText: {
    flex: 1,
    fontSize: 17,
    lineHeight: 24,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
    marginBottom: Spacing.two,
  },
  list: {
    borderTopWidth: 1,
  },
  empty: {
    fontSize: 15,
    lineHeight: 21,
    paddingTop: Spacing.three,
  },
  switchRow: {
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  switchLabel: {
    flex: 1,
    fontSize: 16,
  },
  demo: {
    gap: Spacing.three,
    paddingTop: Spacing.four,
    borderTopWidth: 1,
  },
  demoText: {
    fontSize: 15,
    lineHeight: 21,
  },
});
