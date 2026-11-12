import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { FlatList, Modal, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltFooter } from '@/components/belt-footer';
import { ScreenHeader } from '@/components/screen-header';
import { SectionLabel } from '@/components/section-label';
import { Fonts, MaxContentWidth, Neon, Spacing } from '@/constants/theme';
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

function Row({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  /** Última linha do grupo: sem o fio de baixo, para o grupo fechar limpo. */
  last?: boolean;
}) {
  const theme = useTheme();
  // "sim" e "não" são estados de recurso; vermelho fica só para erro de verdade.
  const valueColor = value === 'sim' ? Neon.mint : value === 'não' ? theme.textSecondary : theme.text;
  return (
    <View style={[styles.row, { borderColor: theme.border }, last && styles.rowLast]}>
      <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: valueColor }]} selectable>
        {value}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      {/* O SectionLabel não expõe accessibilityRole; o cabeçalho agrupa o rótulo. */}
      <View accessible accessibilityRole="header" accessibilityLabel={title}>
        <SectionLabel label={title} style={styles.sectionLabel} />
      </View>
      <View style={styles.sectionBody}>{children}</View>
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
  const { clearLog } = useTreadmillActions();

  // Cópia invertida: o log do snapshot não pode ser mutado.
  const newestFirst = [...log].reverse();
  const feature = capabilities?.feature ?? null;
  // As chaves ficam fora do JSX para a última linha de cada grupo saber que é a última.
  const targetKeys = Object.keys(TARGET_SETTING_LABELS) as (keyof typeof TARGET_SETTING_LABELS)[];
  const featureKeys = Object.keys(MACHINE_FEATURE_LABELS) as (keyof typeof MACHINE_FEATURE_LABELS)[];

  const share = () => {
    const message = buildDiagnosticsReport({ mode, device, capabilities, log });
    // Fechar a folha de compartilhamento sem escolher nada não é um erro.
    Share.share({ message, title: 'Registro do Gym Burn' }).catch(() => {});
  };

  // Os arquivos completos ficam numa tela própria, fora do modal.
  const openLogs = () => {
    onClose();
    router.push('/registros');
  };

  const header = (
    <View style={styles.sections}>
      <Section title="Esteira">
        <Row label="Nome" value={device?.name ?? 'Sem nome'} />
        <Row label="Identificador" value={device?.id ?? 'Nenhum'} />
        <Row label="Modo" value={MODE_LABELS[mode]} last />
      </Section>

      <Section title="O que ela aceita controlar">
        {feature ? (
          targetKeys.map((key, index) => (
            <Row
              key={key}
              label={TARGET_SETTING_LABELS[key]}
              value={feature.targets[key] ? 'sim' : 'não'}
              last={index === targetKeys.length - 1 && !capabilities}
            />
          ))
        ) : (
          <Paragraph>A esteira não informou seus recursos.</Paragraph>
        )}
        {capabilities ? (
          <Row label="Control Point" value={capabilities.hasControlPoint ? 'sim' : 'não'} last />
        ) : null}
      </Section>

      <Section title="O que ela mede">
        {feature ? (
          featureKeys.map((key, index) => (
            <Row
              key={key}
              label={MACHINE_FEATURE_LABELS[key]}
              value={feature.machine[key] ? 'sim' : 'não'}
              last={index === featureKeys.length - 1}
            />
          ))
        ) : (
          <Paragraph>A esteira não informou seus recursos.</Paragraph>
        )}
      </Section>

      <Section title="Faixas">
        {capabilities ? (
          <>
            <Row label="Velocidade" value={describeRange(capabilities.speedRange, 'km/h')} />
            <Row
              label="Inclinação"
              value={describeRange(capabilities.inclinationRange, '%')}
              last
            />
          </>
        ) : (
          <Paragraph>Sem esteira conectada.</Paragraph>
        )}
      </Section>

      <Section title="Características Bluetooth encontradas">
        {capabilities && capabilities.characteristics.length > 0 ? (
          <View style={styles.characteristics}>
            {capabilities.characteristics.map((uuid) => (
              <Text key={uuid} style={[styles.mono, { color: theme.text }]} selectable>
                {characteristicName(uuid)}
              </Text>
            ))}
          </View>
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
        <Row label="Lona" value={BELT_STATE_LABELS[belt]} last />
      </Section>

      <Section title="Coleta para engenharia reversa">
        <Paragraph>
          Uma página para deixar rodando na academia: inventário do GATT, leituras de todas as
          características legíveis, assinatura das notificações que o app ainda não escuta e
          marcações de eventos (andou, inclinou, parou) para correlacionar depois.
        </Paragraph>
        <ActionButton
          variant="outline"
          color={Neon.violet}
          label="Abrir coleta"
          onPress={() => {
            onClose();
            router.push('/coleta');
          }}
          style={styles.sectionAction}
        />
      </Section>

      <Section title="Sonda BLE">
        <Paragraph>
          Leitura e escrita manual das características fora do FTMS, em especial o serviço
          proprietário 0xFFF0 que a T600X expõe. Cada operação vai para o registro em arquivo.
        </Paragraph>
        <ActionButton
          variant="outline"
          color={Neon.violet}
          label="Abrir sonda 0xFFF0"
          onPress={() => {
            onClose();
            router.push('/sonda');
          }}
          style={styles.sectionAction}
        />
      </Section>

      <Section title="Registro">
        <View style={styles.logActions}>
          <ActionButton
            variant="primary"
            label="Compartilhar registro"
            onPress={share}
            disabled={log.length === 0}
            style={styles.logAction}
            labelStyle={styles.logActionLabel}
          />
          <ActionButton
            variant="outline"
            color={Neon.red}
            label="Limpar"
            onPress={clearLog}
            disabled={log.length === 0}
            labelStyle={styles.logActionLabel}
          />
        </View>
        {log.length === 0 ? <Paragraph>O registro está vazio.</Paragraph> : null}
        <ActionButton
          variant="outline"
          label="Registros salvos"
          onPress={openLogs}
          style={styles.sectionAction}
        />
      </Section>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <ScreenHeader
        title="Diagnóstico"
        right={<ActionButton variant="text" label="Fechar" onPress={onClose} />}
      />
      <FlatList
        data={newestFirst}
        keyExtractor={(entry) => String(entry.id)}
        ListHeaderComponent={header}
        renderItem={({ item }) => <LogLine entry={item} />}
        contentContainerStyle={styles.list}
        initialNumToRender={30}
      />
      {/* O modal cobre o rodapé do painel: Parar tem que continuar à vista aqui. */}
      <BeltFooter />
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
  list: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.five,
  },
  sections: {
    gap: 20,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.two,
  },
  section: {
    gap: Spacing.two,
  },
  sectionLabel: {
    marginBottom: Spacing.one,
  },
  sectionBody: {
    gap: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  rowValue: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: 600,
    textAlign: 'right',
  },
  paragraph: {
    paddingVertical: Spacing.one,
    fontSize: 15,
    lineHeight: 21,
  },
  sectionAction: {
    marginTop: Spacing.two,
  },
  characteristics: {
    gap: Spacing.one,
    paddingVertical: Spacing.one,
  },
  logActions: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginBottom: Spacing.two,
  },
  logAction: {
    flex: 1,
  },
  logActionLabel: {
    fontSize: 18,
    lineHeight: 22,
  },
  logLine: {
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
});
