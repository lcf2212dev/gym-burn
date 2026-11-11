import type { ReactNode } from 'react';
import { FlatList, Modal, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltControls } from '@/components/belt-controls';
import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { characteristicName } from '@/ftms';
import { useTheme } from '@/hooks/use-theme';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import type { LogEntry } from '@/treadmill/types';
import { buildDiagnosticsReport, describeRange } from '@/utils/diagnostics-report';
import { formatClock } from '@/utils/format';
import {
  BELT_STATE_LABELS,
  LOG_KIND_LABELS,
  MACHINE_FEATURE_LABELS,
  MODE_LABELS,
  TARGET_SETTING_LABELS,
  TRAINING_STATUS_LABELS,
} from '@/utils/labels';

export interface DiagnosticsModalProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * O que a esteira informou sobre si e o registro de pacotes. É como o dono
 * descobre o que a esteira dele realmente suporta.
 */
export function DiagnosticsModal({ visible, onClose }: DiagnosticsModalProps) {
  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
      animationType="slide"
      presentationStyle="pageSheet">
      {/* O Modal abre outra janela no Android; as áreas seguras precisam ser medidas de novo. */}
      <SafeAreaProvider>
        <DiagnosticsContent onClose={onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Paragraph({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.paragraph, { color: theme.textSecondary }]}>{children}</Text>;
}

/** Montado só enquanto o modal está aberto: as assinaturas do estado vivem aqui. */
function DiagnosticsContent({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const mode = useTreadmill((s) => s.mode);
  const device = useTreadmill((s) => s.device);
  const capabilities = useTreadmill((s) => s.capabilities);
  const trainingStatus = useTreadmill((s) => s.trainingStatus);
  const belt = useTreadmill((s) => s.belt);
  const log = useTreadmill((s) => s.log);
  const canCommandBelt = useTreadmill(
    (s) => s.phase === 'connected' && s.control !== 'unavailable' && s.identityConfirmed,
  );
  const { clearLog } = useTreadmillActions();

  // Cópia invertida: o log do snapshot não pode ser mutado.
  const newestFirst = [...log].reverse();
  const feature = capabilities?.feature ?? null;

  const share = () => {
    const message = buildDiagnosticsReport({ mode, device, capabilities, log });
    // Fechar a folha de compartilhamento sem escolher nada não é um erro.
    Share.share({ message, title: 'Registro do Gym Burn' }).catch(() => {});
  };

  const header = (
    <View style={styles.sections}>
      <Section title="Esteira">
        <Row label="Nome" value={device?.name ?? 'Sem nome'} />
        <Row label="Identificador" value={device?.id ?? 'Nenhum'} />
        <Row label="Modo" value={MODE_LABELS[mode]} />
      </Section>

      <Section title="O que ela aceita controlar">
        {feature ? (
          (Object.keys(TARGET_SETTING_LABELS) as (keyof typeof TARGET_SETTING_LABELS)[]).map(
            (key) => (
              <Row
                key={key}
                label={TARGET_SETTING_LABELS[key]}
                value={feature.targets[key] ? 'sim' : 'não'}
              />
            ),
          )
        ) : (
          <Paragraph>A esteira não informou seus recursos.</Paragraph>
        )}
        {capabilities ? (
          <Row label="Control Point" value={capabilities.hasControlPoint ? 'sim' : 'não'} />
        ) : null}
      </Section>

      <Section title="O que ela mede">
        {feature ? (
          (Object.keys(MACHINE_FEATURE_LABELS) as (keyof typeof MACHINE_FEATURE_LABELS)[]).map(
            (key) => (
              <Row
                key={key}
                label={MACHINE_FEATURE_LABELS[key]}
                value={feature.machine[key] ? 'sim' : 'não'}
              />
            ),
          )
        ) : (
          <Paragraph>A esteira não informou seus recursos.</Paragraph>
        )}
      </Section>

      <Section title="Faixas">
        {capabilities ? (
          <>
            <Row label="Velocidade" value={describeRange(capabilities.speedRange, 'km/h')} />
            <Row label="Inclinação" value={describeRange(capabilities.inclinationRange, '%')} />
          </>
        ) : (
          <Paragraph>Sem esteira conectada.</Paragraph>
        )}
      </Section>

      <Section title="Características Bluetooth encontradas">
        {capabilities && capabilities.characteristics.length > 0 ? (
          capabilities.characteristics.map((uuid) => (
            <Text key={uuid} style={[styles.mono, { color: theme.text }]} selectable>
              {characteristicName(uuid)}
            </Text>
          ))
        ) : (
          <Paragraph>Nenhuma característica encontrada.</Paragraph>
        )}
      </Section>

      <Section title="Estado do treino">
        <Row
          label="Treino"
          value={
            trainingStatus
              ? [TRAINING_STATUS_LABELS[trainingStatus.name], trainingStatus.text]
                  .filter(Boolean)
                  .join(': ')
              : 'Não informado'
          }
        />
        <Row label="Lona" value={BELT_STATE_LABELS[belt]} />
      </Section>

      <Section title="Registro">
        <View style={styles.logActions}>
          <ActionButton
            variant="primary"
            label="Compartilhar registro"
            onPress={share}
            disabled={log.length === 0}
            style={styles.logAction}
          />
          <ActionButton
            variant="outline"
            label="Limpar"
            onPress={clearLog}
            disabled={log.length === 0}
          />
        </View>
        {log.length === 0 ? <Paragraph>O registro está vazio.</Paragraph> : null}
      </Section>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.topBar, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          Diagnóstico
        </Text>
        <ActionButton variant="text" label="Fechar" onPress={onClose} />
      </View>
      <FlatList
        data={newestFirst}
        keyExtractor={(entry) => String(entry.id)}
        ListHeaderComponent={header}
        renderItem={({ item }) => <LogLine entry={item} />}
        contentContainerStyle={styles.list}
        initialNumToRender={30}
      />
      {/* O modal cobre o rodapé do painel: Parar tem que continuar à vista aqui. */}
      {canCommandBelt ? (
        <View style={[styles.footer, { borderColor: theme.border }]}>
          <View style={styles.footerContent}>
            <BeltControls />
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const theme = useTheme();
  const color = entry.kind === 'error' ? theme.noticeError : theme.text;
  return (
    <View style={[styles.logLine, { borderColor: theme.border }]}>
      <Text style={[styles.mono, { color }]} selectable>
        {formatClock(entry.at)} {LOG_KIND_LABELS[entry.kind]} {entry.label}
      </Text>
      {entry.hex ? (
        <Text style={[styles.mono, { color: theme.textSecondary }]} selectable>
          {entry.hex}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
  },
  list: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.five,
  },
  footer: {
    borderTopWidth: 1,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  footerContent: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  sections: {
    gap: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  section: {
    gap: Spacing.one,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
    marginBottom: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
  },
  rowValue: {
    flex: 1,
    fontSize: 15,
    fontWeight: 600,
    textAlign: 'right',
  },
  paragraph: {
    fontSize: 15,
    lineHeight: 21,
  },
  logActions: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginBottom: Spacing.two,
  },
  logAction: {
    flex: 1,
  },
  logLine: {
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 18,
  },
});
