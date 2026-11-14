import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BrandMark } from '@/components/brand-mark';
import { DeviceRow } from '@/components/device-row';
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
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

const STEPS = [
  'No painel da esteira, segure o botão Bluetooth por 5 segundos, até entrar no modo APP.',
  'Quando o nome da sua esteira aparecer aqui, toque em Conectar.',
  'Não pareie pela tela de Bluetooth do celular: o app conecta direto, sem pareamento.',
];

const STEP_COLOR = Neon.volt;

/** Quanto esperar antes de procurar de novo sozinho. */
const RESCAN_DELAY_MS = 1_500;

/**
 * Primeira tela: procura esteiras sozinha ao abrir, mostra os nomes
 * encontrados e deixa o usuário confirmar a dele. A partir daí o app segue
 * sozinho no painel.
 */
export function ConnectScreen() {
  const theme = useTheme();
  const scan = useTreadmill((s) => s.scan);
  const devices = useTreadmill((s) => s.devices);
  const phase = useTreadmill((s) => s.phase);
  const connectingId = useTreadmill((s) => s.device?.id ?? null);
  const notice = useTreadmill((s) => s.notice);
  const actions = useTreadmillActions();

  // A busca começa sozinha e recomeça quando termina sem ninguém conectar.
  // Com aparelhos na lista ela para, para a lista não piscar: quem atualiza é
  // o botão "Procurar de novo".
  useEffect(() => {
    if (phase !== 'idle' || scan !== 'idle' || devices.length > 0) {
      return;
    }
    const timer = setTimeout(() => actions.startScan(), RESCAN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [actions, devices.length, phase, scan]);

  const appVersion = Constants.expoConfig?.version ?? null;
  const scanning = scan !== 'idle';
  const visible = devices.filter((device) => device.advertisesFtms || looksLikeMatrixConsole(device.name));
  const connecting = phase === 'connecting';

  const confirmAndConnect = (deviceId: string) => {
    // Tocar no nome da própria esteira é a confirmação; o painel conecta e o
    // copiloto assume dali em diante.
    actions.connect(deviceId);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <AmbientGlow intensity={0.55} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.header}>
            {/* Toque longo abre a esteira simulada; é atalho de teste, sem texto na tela. */}
            <Pressable
              onLongPress={actions.openDemo}
              delayLongPress={700}
              accessibilityLabel="Gym Burn"
              accessibilityHint="Toque longo abre o modo demonstração">
              <BrandMark size="md" />
            </Pressable>
            <Text
              style={[styles.title, TitleType, { color: theme.text }]}
              accessibilityRole="header">
              Encontre sua esteira
            </Text>
            <Pressable
              onLongPress={() => router.push('/sonda')}
              delayLongPress={800}
              accessibilityRole="text"
              accessibilityLabel={appVersion ? `Versão ${appVersion}` : 'Versão'}>
              <Text style={[styles.version, { color: theme.textSecondary }]}>
                {appVersion ? `versão ${appVersion}` : ''}
              </Text>
            </Pressable>
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

          {/* Avisos de erro (Bluetooth, permissão) aparecem aqui; o estado da
              busca vazio tem o cartão próprio logo abaixo. */}
          {notice && (notice.kind === 'error' || notice.kind === 'warning') ? (
            <NoticeBanner />
          ) : null}

          {connecting ? (
            <Surface tone="raised" style={styles.statusCard}>
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={Neon.volt} />
                <Text style={[styles.statusText, { color: theme.text }]}>Conectando…</Text>
              </View>
              <Text style={[styles.statusDetail, { color: theme.textSecondary }]}>
                Mantenha o celular perto do painel.
              </Text>
            </Surface>
          ) : null}

          {visible.length > 0 ? (
            <View style={styles.devices}>
              <SectionLabel label="Esteiras encontradas" accent={Neon.cyan} />
              <Text style={[styles.hint, { color: theme.textSecondary }]}>
                Toque no nome da sua esteira para conectar.
              </Text>
              <View style={styles.list}>
                {visible.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    connecting={connecting && device.id === connectingId}
                    disabled={connecting}
                    onConnect={confirmAndConnect}
                  />
                ))}
              </View>
              <ActionButton
                variant="text"
                label={scanning ? 'Procurando…' : 'Procurar de novo'}
                onPress={actions.startScan}
                disabled={connecting || scanning}
                labelStyle={styles.refreshLabel}
              />
            </View>
          ) : (
            <Surface tone="raised" style={styles.statusCard}>
              {scanning ? (
                <>
                  <View style={styles.statusRow}>
                    <ActivityIndicator size="small" color={Neon.cyan} />
                    <Text style={[styles.statusText, { color: theme.text }]}>
                      Procurando esteiras…
                    </Text>
                  </View>
                  <Text style={[styles.statusDetail, { color: theme.textSecondary }]}>
                    Isso leva alguns segundos. Deixe o celular perto do painel.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={[styles.statusText, { color: theme.text }]}>
                    Nenhuma esteira encontrada ainda.
                  </Text>
                  <Text style={[styles.statusDetail, { color: theme.textSecondary }]}>
                    Confira se o painel está no modo APP e se o Bluetooth do celular está ligado.
                  </Text>
                  <ActionButton
                    variant="outline"
                    color={Neon.cyan}
                    label="Procurar de novo"
                    onPress={actions.startScan}
                  />
                </>
              )}
            </Surface>
          )}

          <Text style={[styles.footnote, { color: theme.textSecondary }]}>
            Se a esteira não aparecer ou a conexão cair, feche o app e abra de novo.
          </Text>
        </View>
      </ScrollView>
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
  header: {
    gap: Spacing.two,
  },
  title: {
    fontSize: 38,
    lineHeight: 42,
  },
  version: {
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    minHeight: MinTouchTarget,
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
  devices: {
    gap: Spacing.two,
  },
  list: {
    gap: Spacing.two,
  },
  hint: {
    fontSize: 14,
    lineHeight: 19,
  },
  statusCard: {
    gap: Spacing.two,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statusText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: 600,
  },
  statusDetail: {
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  refreshLabel: {
    fontSize: 14,
  },
});
