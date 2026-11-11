import { useKeepAwake } from 'expo-keep-awake';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltControls } from '@/components/belt-controls';
import { ControlColumn } from '@/components/control-column';
import { GuideStrip } from '@/components/guide-strip';
import { IdentityCheck } from '@/components/identity-check';
import { MetricGrid } from '@/components/metric-grid';
import { NoticeBanner } from '@/components/notice-banner';
import { StaleDataNotice } from '@/components/stale-data-notice';
import { MaxContentWidth, Spacing, speedHeatColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DiagnosticsModal } from '@/screens/diagnostics-modal';
import { T600X_INCLINATION_RANGE, T600X_SPEED_RANGE } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import { inclinationSteps, isBeltMoving, rangeFraction, speedSteps } from '@/utils/controls';
import { CONTROL_STATE_LABELS } from '@/utils/labels';

const UNDECLARED_CONTROL = 'A esteira não declara este controle; o comando pode ser recusado.';

/** Painel do treino: inclinação à esquerda e velocidade à direita, como no console. */
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

  return (
    <SafeAreaView
      // A borda de baixo é do rodapé fixo.
      edges={['top', 'left', 'right']}
      style={[styles.safe, { backgroundColor: theme.background }]}>
      {/* Fora da rolagem, como o rodapé: a rolagem encolhe, Parar continua à vista. */}
      <GuideStrip />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerLine}>
              <View style={styles.headerTitle}>
                <Text
                  style={[styles.deviceName, { color: theme.text }]}
                  numberOfLines={1}
                  accessibilityRole="header">
                  {deviceName ?? 'Esteira sem nome'}
                </Text>
                {mode === 'demo' ? (
                  <Text
                    style={[styles.tag, { color: theme.textSecondary, borderColor: theme.border }]}>
                    Demonstração
                  </Text>
                ) : null}
              </View>
              <ActionButton
                variant="text"
                label={disconnecting ? 'Desconectando…' : 'Desconectar'}
                onPress={actions.disconnect}
                disabled={disconnecting}
              />
            </View>
            <View style={styles.headerLine}>
              <View style={styles.headerTitle} accessibilityLiveRegion="polite">
                <Text style={[styles.controlState, { color: theme.textSecondary }]}>
                  {CONTROL_STATE_LABELS[control]}
                </Text>
                {busy ? (
                  <View style={styles.busy}>
                    <ActivityIndicator size="small" color={theme.textSecondary} />
                    <Text style={[styles.controlState, { color: theme.textSecondary }]}>
                      Enviando…
                    </Text>
                  </View>
                ) : null}
              </View>
              <ActionButton
                variant="text"
                label="Diagnóstico"
                onPress={() => setDiagnosticsOpen(true)}
              />
            </View>
          </View>

          {belt === 'safetyKey' ? (
            <Text
              accessibilityRole="alert"
              style={[styles.safetyKey, { color: theme.noticeError, borderColor: theme.noticeError }]}>
              Lona parada pelo Emergency Stop ou pela chave de segurança. Libere o botão, recoloque
              a chave e inicie pelo painel da esteira.
            </Text>
          ) : null}
          <NoticeBanner />
          <StaleDataNotice />

          <View style={[styles.columns, { borderColor: theme.border }]}>
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
            <View style={[styles.columnDivider, { backgroundColor: theme.border }]} />
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
              accentColor={theme.text}
              meterColor={speedHeatColor(rangeFraction(metrics.speedKmh, speedRange))}
              hint={canControl && !beltMoving ? 'Inicie a lona para ajustar a velocidade.' : null}
              warning={canControl && targets?.speed === false ? UNDECLARED_CONTROL : null}
            />
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
            borderColor: theme.border,
            backgroundColor: theme.background,
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
    paddingVertical: Spacing.two,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
    paddingBottom: Spacing.three,
  },
  footnote: {
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    borderTopWidth: 1,
    paddingTop: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  footerContent: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  header: {
    gap: Spacing.half,
  },
  headerLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headerTitle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  deviceName: {
    flexShrink: 1,
    fontSize: 20,
    fontWeight: 700,
  },
  tag: {
    fontSize: 13,
    fontWeight: 600,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.half,
  },
  controlState: {
    fontSize: 15,
    fontWeight: 500,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  safetyKey: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 700,
    borderWidth: 2,
    borderRadius: 8,
    padding: Spacing.three,
  },
  columns: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  columnDivider: {
    width: 1,
  },
});
