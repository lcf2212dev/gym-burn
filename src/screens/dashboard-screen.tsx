import { useKeepAwake } from 'expo-keep-awake';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AmbientGlow } from '@/components/ambient-glow';
import { Card, Kicker } from '@/components/card';
import { ConsoleCard, DataFieldsCard, EquipmentCard } from '@/components/cockpit/info-cards';
import { LiveChart } from '@/components/cockpit/live-chart';
import { MetricGrid } from '@/components/cockpit/metric-grid';
import { SpeedHero } from '@/components/cockpit/speed-hero';
import { VitalsRow } from '@/components/cockpit/vitals-row';
import {
  BodyType,
  Fonts,
  LabelType,
  MaxContentWidth,
  Metric,
  Neon,
  Radius,
  Spacing,
  TitleType,
  withAlpha,
} from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { T600X_SPEED_RANGE, looksLikeMatrixConsole } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/** Depois disso sem pacote, a esteira "emudeceu" e a tela avisa. */
const STALE_AFTER_MS = 5000;

function StatusDot({ live }: { live: boolean }) {
  const color = live ? '#3DE8A0' : '#FFC24B';
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={[styles.statusText, { color }]}>{live ? 'conectado' : 'aguardando dados'}</Text>
    </View>
  );
}

function InlineNotice() {
  const notice = useTreadmill((state) => state.notice);
  const actions = useTreadmillActions();
  if (!notice) {
    return null;
  }
  const color =
    notice.kind === 'error'
      ? '#FF3B4E'
      : notice.kind === 'warning'
        ? '#FFC24B'
        : notice.kind === 'success'
          ? '#3DE8A0'
          : Metric.incline;

  return (
    <View
      style={[
        styles.notice,
        { borderColor: withAlpha(color, 0.4), backgroundColor: withAlpha(color, 0.1) },
      ]}
      accessibilityRole="alert">
      <Text style={[styles.noticeText, { color }]}>{notice.message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fechar aviso"
        onPress={actions.dismissNotice}
        hitSlop={10}
        style={styles.noticeClose}>
        <Text style={[styles.noticeCloseText, { color }]}>×</Text>
      </Pressable>
    </View>
  );
}

/**
 * O cockpit: tudo o que a esteira informa, em camadas — o número que se lê de
 * longe (velocidade), os dois que dizem como está o esforço (inclinação e
 * batimentos), o gráfico dos últimos 60 s, a grade do treino e, no fim, a
 * identidade do equipamento e a lista honesta do que o firmware manda ou não.
 *
 * O app não tem botão de comando: quem controla a lona é o painel da esteira.
 */
export function DashboardScreen() {
  // A pessoa está correndo com o celular apoiado no painel: a tela não pode apagar.
  useKeepAwake();

  const now = useNow(1000);
  const phase = useTreadmill((state) => state.phase);
  const deviceName = useTreadmill((state) => state.device?.name ?? null);
  const metrics = useTreadmill((state) => state.metrics);
  const samples = useTreadmill((state) => state.samples);
  const status = useTreadmill((state) => state.status);
  const equipment = useTreadmill((state) => state.equipment);
  const capabilities = useTreadmill((state) => state.capabilities);
  const link = useTreadmill((state) => state.link);
  const actions = useTreadmillActions();

  const speedRange = capabilities?.speedRange ?? T600X_SPEED_RANGE;
  const silentForMs =
    now !== null && link.lastPacketAt !== null ? Math.max(now - link.lastPacketAt, 0) : null;
  const stale = silentForMs !== null && silentForMs > STALE_AFTER_MS;
  const live = link.lastPacketAt !== null && !stale;

  const disconnecting = phase === 'disconnecting';
  const heartSamples = samples
    .map((sample) => sample.heartRateBpm)
    .filter((value): value is number => value !== null)
    .slice(-24);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safe, { backgroundColor: '#06080D' }]}>
      <AmbientGlow colors={[Neon.cyan, Neon.volt]} intensity={0.32} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic">
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Kicker color={Metric.speed}>Gym Burn</Kicker>
              <Text style={[styles.deviceName, TitleType]} numberOfLines={1} accessibilityRole="header">
                {deviceName ?? 'Esteira'}
              </Text>
              <StatusDot live={live} />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Desconectar da esteira"
              onPress={actions.disconnect}
              disabled={disconnecting}
              hitSlop={8}
              style={styles.disconnect}>
              <Text style={styles.disconnectText}>
                {disconnecting ? 'saindo…' : 'Desconectar'}
              </Text>
            </Pressable>
          </View>

          {status.stoppedBySafetyKey ? (
            <View style={[styles.safety, { borderColor: withAlpha('#FF3B4E', 0.5) }]}>
              <Text style={styles.safetyTitle}>Lona parada pela chave de segurança</Text>
              <Text style={styles.safetyText}>
                Recoloque a chave e inicie pelo painel da esteira. O app só lê os dados.
              </Text>
            </View>
          ) : null}

          <InlineNotice />

          {stale ? (
            <View style={styles.stale}>
              <Text style={styles.staleText}>
                A esteira parou de enviar dados
                {silentForMs !== null ? ` há ${Math.round(silentForMs / 1000)} s` : ''}. Fique
                perto do painel ou reconecte.
              </Text>
            </View>
          ) : null}

          <SpeedHero metrics={metrics} speedRange={speedRange} live={live} />

          <VitalsRow
            inclinationPercent={metrics.inclinationPercent}
            heartRateBpm={metrics.heartRateBpm}
            heartSamples={heartSamples}
          />

          <LiveChart samples={samples} metrics={metrics} />

          <MetricGrid metrics={metrics} />

          <ConsoleCard status={status} />
          <EquipmentCard equipment={equipment} capabilities={capabilities} />
          <DataFieldsCard metrics={metrics} />

          <Card style={styles.aboutCard}>
            <Text style={styles.aboutTitle}>Só leitura, por decisão</Text>
            <Text style={styles.aboutText}>
              Esta esteira não aceita comandos de velocidade ou inclinação por Bluetooth: ela
              informa os dados, e o painel continua sendo o controle. Para parar, use o botão
              vermelho (Emergency Stop) e a chave de segurança.
            </Text>
            {looksLikeMatrixConsole(deviceName) ? (
              <Text style={styles.aboutHint}>
                Painel na tela de APP: segure o botão Bluetooth por 5 s.
              </Text>
            ) : null}
          </Card>

          <Text style={styles.footer}>
            Gym Burn · monitor da esteira
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
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.six,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  headerText: {
    flexShrink: 1,
    gap: 2,
  },
  deviceName: {
    fontSize: 26,
    lineHeight: 30,
    color: '#F3F7FF',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    ...LabelType,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  disconnect: {
    minHeight: 48,
    justifyContent: 'center',
    paddingLeft: Spacing.two,
  },
  disconnectText: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: '#9AA7B8',
  },
  safety: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.three,
    backgroundColor: withAlpha('#FF3B4E', 0.1),
    gap: 2,
  },
  safetyTitle: {
    fontFamily: Fonts.body,
    fontSize: 14,
    lineHeight: 18,
    color: '#FF5B6B',
    fontWeight: '700',
  },
  safetyText: {
    ...BodyType,
    fontSize: 12,
    lineHeight: 17,
    color: '#FF9AA5',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.one,
    paddingVertical: Spacing.two,
  },
  noticeText: {
    flex: 1,
    ...BodyType,
    fontSize: 13,
    lineHeight: 18,
  },
  noticeClose: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeCloseText: {
    fontSize: 20,
    lineHeight: 22,
  },
  stale: {
    borderWidth: 1,
    borderColor: withAlpha('#FFC24B', 0.4),
    backgroundColor: withAlpha('#FFC24B', 0.1),
    borderRadius: Radius.md,
    padding: Spacing.three,
  },
  staleText: {
    ...BodyType,
    fontSize: 12,
    lineHeight: 17,
    color: '#FFC24B',
  },
  aboutCard: {
    gap: Spacing.one,
  },
  aboutTitle: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: '#F3F7FF',
    fontWeight: '700',
  },
  aboutText: {
    ...BodyType,
    fontSize: 12,
    lineHeight: 17,
    color: '#9AA7B8',
  },
  aboutHint: {
    ...BodyType,
    fontSize: 11,
    lineHeight: 16,
    color: Metric.speed,
    marginTop: 2,
  },
  footer: {
    ...LabelType,
    fontSize: 9,
    letterSpacing: 1.4,
    textAlign: 'center',
    color: '#5C687A',
    marginTop: Spacing.two,
  },
});
