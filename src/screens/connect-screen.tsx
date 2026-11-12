import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BrandMark } from '@/components/brand-mark';
import { DeviceRow } from '@/components/device-row';
import { GuideStrip } from '@/components/guide-strip';
import { NoticeBanner } from '@/components/notice-banner';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import {
  MaxContentWidth,
  MinTouchTarget,
  Neon,
  NumeralType,
  Spacing,
  TitleType,
  withAlpha,
} from '@/constants/theme';
import { useGuide, useGuideActions } from '@/guide/guide-context';
import { useTheme } from '@/hooks/use-theme';
import { DiagnosticsModal } from '@/screens/diagnostics-modal';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

const STEPS = [
  'Na esteira, segure o botão Bluetooth por 5 segundos, até o painel entrar no modo APP.',
  'Toque em Procurar esteiras e escolha a sua na lista. Se o painel mostrar um código, ele pode fazer parte do nome dela.',
];

/** O número do passo é o único acento neon dos cartões de instrução. */
const STEP_COLOR = Neon.volt;

/** Interruptor desenhado no tema: trilho e polegar nas cores do app. */
function NeonSwitch({
  value,
  onChange,
  accessibilityLabel,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value }}
      hitSlop={10}
      style={[
        styles.switchTrack,
        {
          backgroundColor: value ? withAlpha(Neon.volt, 0.16) : withAlpha(theme.text, 0.14),
          borderColor: value ? withAlpha(Neon.volt, 0.7) : withAlpha(theme.text, 0.28),
        },
      ]}>
      <View
        style={[
          styles.switchThumb,
          {
            backgroundColor: value ? Neon.volt : theme.text,
            alignSelf: value ? 'flex-end' : 'flex-start',
          },
        ]}
      />
    </Pressable>
  );
}

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
      {/* Halo frio e discreto: tira o preto chapado do fundo da tela de abertura. */}
      <AmbientGlow intensity={0.55} />
      <GuideStrip />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.topLine}>
            <View style={styles.topActions}>
              <ActionButton variant="text" label="Coleta" onPress={() => router.push('/coleta')} />
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

          <View style={styles.hero}>
            <BrandMark size="md" />
            <Text
              style={[styles.title, TitleType, { color: theme.text }]}
              accessibilityRole="header">
              Conecte sua esteira
            </Text>
          </View>

          <Surface padded={false}>
            {STEPS.map((step, index) => (
              <View
                key={step}
                style={[
                  styles.step,
                  index > 0 && { borderTopWidth: 1, borderTopColor: theme.border },
                ]}>
                <Text style={[styles.stepNumber, NumeralType, { color: STEP_COLOR }]}>
                  {index + 1}
                </Text>
                <Text style={[styles.stepText, { color: theme.text }]}>{step}</Text>
              </View>
            ))}
          </Surface>

          <View style={styles.actions}>
            <ActionButton
              variant="outline"
              label="Primeiro teste na esteira"
              onPress={openGuide}
              style={styles.secondaryButton}
              labelStyle={styles.secondaryLabel}
            />

            <ActionButton
              variant="outline"
              label="Coleta para engenharia reversa"
              onPress={() => router.push('/coleta')}
              style={styles.secondaryButton}
              labelStyle={styles.secondaryLabel}
            />
          </View>

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
            <View style={styles.devices}>
              <View
                accessible
                accessibilityRole="header"
                accessibilityLabel="Esteiras encontradas">
                <SectionLabel label="Esteiras encontradas" accent={Neon.cyan} />
              </View>
              <View style={styles.list}>
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

          <Surface style={styles.switchRow}>
            <Text
              style={[styles.switchLabel, { color: theme.text }]}
              onPress={() => setShowAll(!showAll)}>
              Mostrar outros aparelhos Bluetooth
            </Text>
            <NeonSwitch
              value={showAll}
              onChange={setShowAll}
              accessibilityLabel="Mostrar outros aparelhos Bluetooth"
            />
          </Surface>

          <Surface tone="raised" style={styles.demo}>
            <Text style={[styles.demoText, { color: theme.textSecondary }]}>
              Sem esteira por perto? Use uma esteira simulada para conhecer o app.
            </Text>
            <ActionButton
              variant="outline"
              label="Abrir modo demonstração"
              onPress={actions.openDemo}
              disabled={connecting}
            />
          </Surface>
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
    justifyContent: 'flex-end',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  hero: {
    gap: Spacing.two,
  },
  title: {
    fontSize: 38,
    lineHeight: 42,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  stepNumber: {
    minWidth: 22,
    fontSize: 30,
    lineHeight: 24,
    marginTop: -1,
  },
  stepText: {
    flex: 1,
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 22,
  },
  actions: {
    gap: Spacing.two,
  },
  // Abertura: as ações de apoio ficam mais leves que o CTA principal.
  secondaryButton: {
    minHeight: 52,
  },
  secondaryLabel: {
    fontSize: 18,
  },
  devices: {
    gap: Spacing.two,
  },
  list: {
    gap: Spacing.two,
  },
  empty: {
    fontSize: 15,
    lineHeight: 21,
    paddingTop: Spacing.two,
  },
  switchRow: {
    minHeight: MinTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  switchTrack: {
    width: 56,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    padding: 4,
    justifyContent: 'center',
  },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  switchLabel: {
    flex: 1,
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 22,
  },
  demo: {
    gap: Spacing.three,
  },
  demoText: {
    fontSize: 15,
    lineHeight: 21,
  },
});
