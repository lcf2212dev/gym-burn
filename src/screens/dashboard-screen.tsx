import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BeltControls } from '@/components/belt-controls';
import { BrandMark } from '@/components/brand-mark';
import { ControlColumn } from '@/components/control-column';
import { GuideStrip } from '@/components/guide-strip';
import { IdentityCheck } from '@/components/identity-check';
import { MetricGrid } from '@/components/metric-grid';
import { NoticeBanner } from '@/components/notice-banner';
import { Pill } from '@/components/pill';
import { StaleDataNotice } from '@/components/stale-data-notice';
import { Surface } from '@/components/surface';
import {
  LabelType,
  MaxContentWidth,
  Neon,
  Spacing,
  TitleType,
  speedHeatColor,
  withAlpha,
} from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DiagnosticsModal } from '@/screens/diagnostics-modal';
import { T600X_INCLINATION_RANGE, T600X_SPEED_RANGE } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import { inclinationSteps, isBeltMoving, rangeFraction, speedSteps } from '@/utils/controls';
import { CONTROL_STATE_LABELS } from '@/utils/labels';

const UNDECLARED_CONTROL = 'A esteira não declara este controle; o comando pode ser recusado.';

/**
 * Painel do treino: inclinação à esquerda e velocidade à direita, como no
 * console. É a tela lida de longe, apoiada no painel da esteira: fundo
 * carbono, dois cartões com números de placar e o rodapé com as teclas da lona.
 */
export function DashboardScreen() {
  // A pessoa está correndo com o celular apoiado no painel: a tela não pode apagar.
  useKeepAwake();

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mode = useTreadmill((s) => s.mode);
  const phase = useTreadmill((s) => s.phase);
  const deviceName = useTreadmill((s) => s.device?.name ?? null);
  const capabilities = useTreadmill((s) => s.capabilities);
  const control = useTreadmill((s) => s.control);
  const identityConfirmed = useTreadmill((s) => s.identityConfirmed);
  const belt = useTreadmill((s) => s.belt);
  const busy = useTreadmill((s) => s.busy);
  const metrics = useTreadmill((s) => s.metrics);
  const targetSpeed = useTreadmill((s) => s.targetSpeedKmh);
  const targetInclination = useTreadmill((s) => s.targetInclinationPercent);
  const actions = useTreadmillActions();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  // Durante a desconexão as capacidades podem já ter sido limpas.
  const speedRange = capabilities?.speedRange ?? T600X_SPEED_RANGE;
  const inclinationRange = capabilities?.inclinationRange ?? T600X_INCLINATION_RANGE;
  const targets = capabilities?.feature?.targets ?? null;

  // Sem Control Point não há o que comandar; sem a confirmação de que a esteira
  // é a do usuário, a sessão recusa os comandos.
  const canControl = control !== 'unavailable' && identityConfirmed;
  // Lona freando depois de um Parar ainda tem velocidade, mas não está rodando.
  const beltMoving = belt === 'running' && isBeltMoving(metrics.speedKmh);
  const disconnecting = phase === 'disconnecting';

  // A cor do estado do controle é fixa: menta quando o controle é nosso,
  // vermelho quando a esteira recusa ou retoma, ciano enquanto negocia.
  const controlTone =
    control === 'granted'
      ? 'mint'
      : control === 'denied' || control === 'lost'
        ? 'red'
        : control === 'unavailable'
          ? 'neutral'
          : 'cyan';

  return (
    <SafeAreaView
      // A borda de baixo é do rodapé fixo.
      edges={['top', 'left', 'right']}
      style={[styles.safe, { backgroundColor: theme.background }]}>
      {/* Halo discreto que tira o preto chapado do fundo; fica atrás de tudo. */}
      <AmbientGlow intensity={0.5} />
      {/* Fora da rolagem, como o rodapé: a rolagem encolhe, Parar continua à vista. */}
      <GuideStrip />
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
            <View style={styles.nameRow}>
              <Text
                style={[styles.deviceName, TitleType, { color: theme.text }]}
                numberOfLines={1}
                accessibilityRole="header">
                {deviceName ?? 'Esteira sem nome'}
              </Text>
              {mode === 'demo' ? <Pill label="Demonstração" tone="neutral" /> : null}
            </View>
            <View style={styles.statusRow}>
              <View style={styles.statusLeft} accessibilityLiveRegion="polite">
                <Pill label={CONTROL_STATE_LABELS[control]} tone={controlTone} dot />
                {busy ? (
                  <View style={styles.busy}>
                    <ActivityIndicator size="small" color={theme.textSecondary} />
                    <Text style={[styles.busyText, LabelType, { color: theme.textSecondary }]}>
                      Enviando…
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.headerActions}>
                <ActionButton
                  variant="text"
                  label="Coleta"
                  onPress={() => router.push('/coleta')}
                />
                <ActionButton
                  variant="text"
                  label="Diagnóstico"
                  onPress={() => setDiagnosticsOpen(true)}
                />
              </View>
            </View>
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

          {/* Dois cartões de controle lado a lado, sem divisor: o próprio vão separa. */}
          <View style={styles.columns}>
            <Surface tone="raised" style={styles.columnCard}>
              <ControlColumn
                title="Inclinação"
                unit="%"
                spokenUnit="por cento"
                noun="inclinação"
                value={metrics.inclinationPercent}
                target={targetInclination}
                range={inclinationRange}
                steps={inclinationSteps(inclinationRange)}
                onChange={actions.changeInclination}
                disabled={!canControl}
                accentColor={theme.incline}
                meterColor={theme.incline}
                warning={canControl && targets?.inclination === false ? UNDECLARED_CONTROL : null}
              />
            </Surface>
            <Surface tone="raised" style={styles.columnCard}>
              <ControlColumn
                title="Velocidade"
                unit="km/h"
                spokenUnit="km/h"
                noun="velocidade"
                value={metrics.speedKmh}
                target={targetSpeed}
                range={speedRange}
                steps={speedSteps(speedRange)}
                onChange={actions.changeSpeed}
                // O app nunca põe a lona em movimento por um "+": só o botão Iniciar.
                disabled={!canControl || !beltMoving}
                accentColor={Neon.volt}
                meterColor={speedHeatColor(rangeFraction(metrics.speedKmh, speedRange))}
                hint={canControl && !beltMoving ? 'Inicie a lona para ajustar a velocidade.' : null}
                warning={canControl && targets?.speed === false ? UNDECLARED_CONTROL : null}
              />
            </Surface>
          </View>

          <MetricGrid metrics={metrics} />

          <Text style={[styles.footnote, { color: theme.textSecondary }]}>
            Para parar pela esteira, aperte o botão vermelho Emergency Stop ou puxe a chave de
            segurança.
          </Text>
        </View>
      </ScrollView>

      {/* Fora da rolagem: Parar fica sempre à vista. */}
      <View
        style={[
          styles.footer,
          {
            borderTopColor: withAlpha(Neon.volt, 0.25),
            backgroundColor: theme.surfaceSunken,
            paddingBottom: insets.bottom + Spacing.two,
          },
        ]}>
        <View style={styles.footerContent}>
          {identityConfirmed ? <BeltControls /> : <IdentityCheck />}
        </View>
      </View>

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
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
    paddingBottom: Spacing.five,
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
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  deviceName: {
    flexShrink: 1,
    fontSize: 22,
    lineHeight: 26,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  busyText: {
    letterSpacing: 1.4,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  safetyCard: {
    paddingVertical: Spacing.two + Spacing.half,
  },
  safetyKeyText: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 700,
  },
  columns: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.two,
  },
  columnCard: {
    flex: 1,
    paddingHorizontal: Spacing.two + Spacing.one,
    paddingVertical: Spacing.two + Spacing.one,
  },
  footnote: {
    fontSize: 13,
    lineHeight: 19,
  },
  footer: {
    borderTopWidth: 1,
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  footerContent: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
});
