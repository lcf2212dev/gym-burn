import { useKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BrandMark } from '@/components/brand-mark';
import { ControlPanel } from '@/components/control-panel';
import { GizwitsProbeCard } from '@/components/gizwits-probe-card';
import { GizwitsProbeHintBanner } from '@/components/gizwits-probe-hint-banner';
import { CopilotBanner } from '@/components/copilot-banner';
import { MonitorPanel } from '@/components/monitor-panel';
import { NoticeBanner } from '@/components/notice-banner';
import { StaleDataNotice } from '@/components/stale-data-notice';
import { Surface } from '@/components/surface';
import { MaxContentWidth, Spacing, TitleType } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  correctInclinationPercent,
  T600X_INCLINATION_RANGE,
} from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/**
 * Painel depois de conectar: o copiloto diz o que fazer no topo, e logo abaixo
 * fica o monitoramento — velocidade, inclinação, batimentos e as demais
 * medidas. O app não tem botões de comando: quem controla a esteira é o painel.
 */
export function DashboardScreen() {
  // A pessoa está correndo com o celular apoiado no painel: a tela não pode apagar.
  useKeepAwake();

  const theme = useTheme();
  const phase = useTreadmill((s) => s.phase);
  const deviceName = useTreadmill((s) => s.device?.name ?? null);
  const identityConfirmed = useTreadmill((s) => s.identityConfirmed);
  const belt = useTreadmill((s) => s.belt);
  const metrics = useTreadmill((s) => s.metrics);
  const declaredInclinationRange = useTreadmill(
    (s) => s.capabilities?.inclinationRange ?? T600X_INCLINATION_RANGE,
  );
  const gizwitsStatus = useTreadmill((s) => s.gizwitsProbe.status);
  const actions = useTreadmillActions();

  // O usuário tocou no nome da esteira dele para conectar: isso já é a
  // confirmação. O estado da sessão guarda essa confirmação para a sonda.
  useEffect(() => {
    if (!identityConfirmed && phase === 'connected') {
      actions.confirmIdentity();
    }
  }, [actions, identityConfirmed, phase]);

  // Assim que a esteira está confirmada, o painel faz sozinho o teste do canal
  // alternativo (Gizwits): assina o FFF4, pede “machine info” e mostra o
  // resultado no cartão. Só roda uma vez por conexão.
  useEffect(() => {
    const readyForProbe =
      gizwitsStatus === 'idle' || (gizwitsStatus === 'waitingBelt' && belt !== 'running');
    if (identityConfirmed && readyForProbe) {
      actions.runGizwitsProbe();
    }
  }, [actions, belt, gizwitsStatus, identityConfirmed]);

  // O FTMS desta família informa a inclinação ~6,667× maior que o painel; a
  // faixa declarada (0–50 %/3 %) é template do firmware e denuncia a escala.
  const displayMetrics = {
    ...metrics,
    inclinationPercent: correctInclinationPercent(
      metrics.inclinationPercent,
      declaredInclinationRange,
    ),
  };

  const disconnecting = phase === 'disconnecting';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safe, { backgroundColor: theme.background }]}>
      <AmbientGlow intensity={0.5} />
      {/* Fora da rolagem: no topo, a ação pedida pelo teste (se houver) e a instrução do copiloto. */}
      <GizwitsProbeHintBanner />
      <CopilotBanner />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <BrandMark size="sm" />
              <ActionButton
                variant="text"
                label={disconnecting ? 'Desconectando…' : 'Desconectar'}
                onPress={actions.disconnect}
                disabled={disconnecting}
              />
            </View>
            <Text
              style={[styles.deviceName, TitleType, { color: theme.text }]}
              numberOfLines={1}
              accessibilityRole="header">
              {deviceName ?? 'Esteira'}
            </Text>
          </View>

          {belt === 'safetyKey' ? (
            <Surface accent={theme.noticeError} style={styles.safetyCard}>
              <Text
                accessibilityRole="alert"
                style={[styles.safetyKeyText, { color: theme.noticeError }]}>
                Lona parada pelo Emergency Stop ou pela chave de segurança. Libere o botão, recoloque
                a chave e inicie pelo painel da esteira.
              </Text>
            </Surface>
          ) : null}
          <NoticeBanner />
          <StaleDataNotice />

          <MonitorPanel metrics={displayMetrics} />

          <ControlPanel />

          <GizwitsProbeCard />

          <Text style={[styles.footnote, { color: theme.textSecondary }]}>
            Para parar ou mudar velocidade e inclinação, use o painel da esteira. O botão vermelho
            (Emergency Stop) e a chave de segurança são a parada real.
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
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
  },
  header: {
    gap: Spacing.one,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  deviceName: {
    flexShrink: 1,
    fontSize: 22,
    lineHeight: 26,
  },
  safetyCard: {
    paddingVertical: Spacing.two + Spacing.half,
  },
  safetyKeyText: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 700,
  },
  footnote: {
    fontSize: 13,
    lineHeight: 19,
  },
});
