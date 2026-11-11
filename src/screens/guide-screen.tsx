import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltFooter } from '@/components/belt-footer';
import { MaxContentWidth, MinTouchTarget, Spacing } from '@/constants/theme';
import { useGuide, useGuideActions } from '@/guide/guide-context';
import {
  ANSWER_WORDS,
  CHECK_STATE_WORDS,
  STOP_ANSWER_WORDS,
  emergencyResultWords,
} from '@/guide/guide-logic';
import type { GuideCheck, GuideStep } from '@/guide/types';
import { useTheme } from '@/hooks/use-theme';
import { useRecorder, useRecorderActions } from '@/logging/recorder-context';

/** Volta para a tela anterior; aberta por um link direto, vai para a principal. */
function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/** A tela principal (busca e painel) já está na pilha: fecha o que está por cima dela. */
function goToApp() {
  router.dismissTo('/');
}

/**
 * Roteiro do primeiro teste na esteira real. O dono está sozinho na academia,
 * com o celular na mão: o passo atual fica aberto, com letra grande, e os
 * outros recolhidos.
 */
export function GuideScreen() {
  // O roteiro é lido de longe, entre um passo e outro: a tela não pode apagar.
  useKeepAwake();

  const theme = useTheme();
  const active = useGuide((s) => s.active);
  const steps = useGuide((s) => s.steps);
  const finished = useGuide((s) => s.finished);
  const currentStepId = useGuide((s) => s.currentStepId);
  const stopQuestion = useGuide((s) => s.stopQuestion);
  const emergencyQuestion = useGuide((s) => s.emergencyQuestion);
  const { start, stop } = useGuideActions();

  const commandsDone = steps.find((step) => step.id === 'commands')?.state === 'done';
  // No passo 6 e no resumo final o botão de compartilhar já está na tela.
  const offerEarlyShare = active && !finished && currentStepId !== 'share';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.topBar, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          Primeiro teste na esteira
        </Text>
        <ActionButton variant="text" label="Voltar" onPress={goBack} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          {active ? null : (
            <View style={styles.intro}>
              <Text style={[styles.introText, { color: theme.textSecondary }]}>
                Seis passos para conectar, conferir os comandos e enviar o registro. Tudo o que
                acontecer fica salvo no registro.
              </Text>
              <ActionButton variant="primary" label="Começar o roteiro" onPress={start} />
            </View>
          )}

          {/* Com o passo 5 aberto, as perguntas já estão nas verificações dele. Fora dele (o
              Emergency Stop pode derrubar a conexão e devolver o roteiro ao passo 3), elas
              precisam aparecer aqui, ou não haveria onde responder. */}
          {active && stopQuestion !== null && currentStepId !== 'commands' ? (
            <View style={[styles.questionCard, { borderColor: theme.noticeWarning }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
                Parar
              </Text>
              <Text style={[styles.checkDetail, { color: theme.text }]}>{stopQuestion}</Text>
              <StopAnswerButtons />
            </View>
          ) : null}
          {active && emergencyQuestion !== null && currentStepId !== 'commands' ? (
            <View style={[styles.questionCard, { borderColor: theme.noticeWarning }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
                Emergency Stop
              </Text>
              <Text style={[styles.checkDetail, { color: theme.text }]}>{emergencyQuestion}</Text>
              <EmergencyStopButtons />
            </View>
          ) : null}

          <View style={[styles.steps, { borderColor: theme.border }]}>
            {steps.map((step) => (
              <StepItem key={step.id} step={step} active={active} />
            ))}
          </View>

          {commandsDone ? <Summary showShare={finished && active} /> : null}

          {/* Se um passo não anda (a esteira nem aparece na busca, por exemplo), o registro é
              justamente o que explica o motivo: dá para enviá-lo de qualquer passo. */}
          {offerEarlyShare ? (
            <View style={styles.field}>
              <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>
                Travou em algum passo? Envie o registro como está.
              </Text>
              <ShareButton early />
            </View>
          ) : null}

          {active ? (
            <ActionButton variant="outline" label="Encerrar o roteiro" onPress={stop} />
          ) : null}
        </View>
      </ScrollView>
      {/* Esta tela cobre o painel: com a lona girando, Parar tem que continuar à vista. */}
      <BeltFooter />
    </SafeAreaView>
  );
}

function StepItem({ step, active }: { step: GuideStep; active: boolean }) {
  const theme = useTheme();
  const open = active && step.state === 'current';

  const numberColor = step.state === 'pending' ? theme.textSecondary : theme.text;
  const titleColor = step.state === 'pending' ? theme.textSecondary : theme.text;

  return (
    <View style={[styles.step, { borderColor: theme.border }]}>
      <View style={styles.stepHeader}>
        <Text style={[styles.stepNumber, { color: numberColor }, open && styles.stepNumberOpen]}>
          {step.number}
        </Text>
        <Text
          style={[styles.stepTitle, { color: titleColor }, open && styles.stepTitleOpen]}
          accessibilityRole="header">
          {step.title}
        </Text>
        {step.state === 'done' ? (
          <Text style={[styles.doneMark, { color: theme.noticeSuccess }]}>feito</Text>
        ) : null}
      </View>

      {step.state === 'done' && step.detail ? (
        <Text style={[styles.collapsedDetail, { color: theme.textSecondary }]}>{step.detail}</Text>
      ) : null}

      {open ? (
        <View style={styles.stepBody}>
          <Text style={[styles.stepText, { color: theme.text }]}>{step.text}</Text>
          {step.warning ? (
            <Text style={[styles.warning, { color: theme.noticeWarning, borderColor: theme.noticeWarning }]}>
              {step.warning}
            </Text>
          ) : null}
          <StepControls step={step} />
        </View>
      ) : null}
    </View>
  );
}

function StepControls({ step }: { step: GuideStep }) {
  const { acknowledge } = useGuideActions();

  switch (step.id) {
    case 'safety':
      return <ActionButton variant="primary" label="Feito" onPress={() => acknowledge('safety')} />;
    case 'appMode':
      return (
        <>
          <PanelCodeField />
          <ActionButton variant="primary" label="Feito" onPress={() => acknowledge('appMode')} />
        </>
      );
    case 'connect':
      return <ActionButton variant="primary" label="Ir para o app" onPress={goToApp} />;
    case 'identity':
      return (
        <>
          <BluetoothQuestion />
          <ActionButton variant="primary" label="Ir para o app" onPress={goToApp} />
        </>
      );
    case 'commands':
      return (
        <>
          <View style={styles.checks}>
            {step.checks.map((check) => (
              <CheckItem key={check.id} check={check} />
            ))}
          </View>
          {/* Quem conectou já confirmada (modo demonstração) não passou pela pergunta. */}
          <BluetoothQuestion onlyIfUnanswered />
          <ActionButton variant="primary" label="Ir para o app" onPress={goToApp} />
        </>
      );
    case 'share':
      return (
        <>
          <NotesField />
          <ShareButton />
        </>
      );
  }
}

function PanelCodeField() {
  const theme = useTheme();
  const panelCode = useGuide((s) => s.panelCode);
  const { setPanelCode, commitText } = useGuideActions();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
        Código que apareceu no painel (opcional)
      </Text>
      <TextInput
        value={panelCode}
        onChangeText={setPanelCode}
        onBlur={() => commitText('panelCode')}
        keyboardType="number-pad"
        returnKeyType="done"
        accessibilityLabel="Código que apareceu no painel"
        style={[styles.input, { color: theme.text, borderColor: theme.border }]}
      />
    </View>
  );
}

function NotesField() {
  const theme = useTheme();
  const notes = useGuide((s) => s.notes);
  const { setNotes, commitText } = useGuideActions();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>Observações (opcional)</Text>
      <TextInput
        value={notes}
        onChangeText={setNotes}
        onBlur={() => commitText('notes')}
        multiline
        accessibilityLabel="Observações"
        style={[styles.input, styles.notes, { color: theme.text, borderColor: theme.border }]}
      />
    </View>
  );
}

function BluetoothQuestion({ onlyIfUnanswered = false }: { onlyIfUnanswered?: boolean }) {
  const theme = useTheme();
  const answer = useGuide((s) => s.bluetoothIndicator);
  const { answerBluetoothIndicator } = useGuideActions();

  if (onlyIfUnanswered && answer !== null) {
    return null;
  }

  return (
    <View style={styles.field}>
      <Text style={[styles.question, { color: theme.text }]}>
        O indicador Bluetooth do painel acendeu?
      </Text>
      <View style={styles.row}>
        <ActionButton
          variant={answer === 'yes' ? 'primary' : 'outline'}
          label="Sim"
          onPress={() => answerBluetoothIndicator('yes')}
          accessibilityLabel={answer === 'yes' ? 'Sim, escolhido' : 'Sim'}
          style={styles.rowButton}
        />
        <ActionButton
          variant={answer === 'no' ? 'primary' : 'outline'}
          label="Não"
          onPress={() => answerBluetoothIndicator('no')}
          accessibilityLabel={answer === 'no' ? 'Não, escolhido' : 'Não'}
          style={styles.rowButton}
        />
      </View>
    </View>
  );
}

function CheckItem({ check }: { check: GuideCheck }) {
  const theme = useTheme();
  const stopQuestion = useGuide((s) => s.stopQuestion);
  const stopAnswer = useGuide((s) => s.stopAnswer);
  const emergencyQuestion = useGuide((s) => s.emergencyQuestion);
  const stateColor = {
    pending: theme.textSecondary,
    current: theme.text,
    done: theme.noticeSuccess,
    unconfirmed: theme.noticeWarning,
    failed: theme.noticeError,
  }[check.state];
  const current = check.state === 'current';

  return (
    <View
      style={[
        styles.check,
        { borderColor: current ? theme.text : theme.border },
        current && styles.checkCurrent,
      ]}>
      <View style={styles.checkHeader}>
        <Text
          style={[
            styles.checkLabel,
            { color: check.state === 'pending' ? theme.textSecondary : theme.text },
            current && styles.checkLabelCurrent,
          ]}>
          {check.label}
        </Text>
        <Text style={[styles.checkState, { color: stateColor }]}>
          {CHECK_STATE_WORDS[check.state]}
        </Text>
      </View>
      {check.detail ? (
        <Text
          accessibilityRole={check.urgent ? 'alert' : undefined}
          style={
            check.urgent
              ? [styles.urgent, { color: theme.noticeError, borderColor: theme.noticeError }]
              : [styles.checkDetail, { color: check.state === 'failed' ? theme.noticeError : theme.textSecondary }]
          }>
          {check.detail}
        </Text>
      ) : null}
      <EarlierAttempts details={check.earlier} />
      {/* Os botões do Parar só aparecem com a pergunta feita, ou para corrigir a resposta. */}
      {check.id === 'stop' && (stopQuestion !== null || stopAnswer !== null) ? (
        <StopAnswerButtons />
      ) : null}
      {/* Antes da vez dela, os botões do Emergency Stop não aparecem: um toque adiantado
          fecharia a verificação sem o botão vermelho ter sido apertado. Com uma pergunta
          pendente, aparecem sempre: o texto acima manda responder aqui. */}
      {check.id === 'emergencyStop' && (check.state !== 'pending' || emergencyQuestion !== null) ? (
        <EmergencyStopButtons />
      ) : null}
    </View>
  );
}

/** O que deu errado nas tentativas anteriores: uma que funciona depois não as apaga. */
function EarlierAttempts({ details }: { details: readonly string[] }) {
  const theme = useTheme();
  if (details.length === 0) {
    return null;
  }
  return (
    <View style={styles.earlier}>
      <Text style={[styles.checkDetail, styles.earlierTitle, { color: theme.noticeError }]}>
        {details.length === 1 ? 'Tentativa anterior sem sucesso:' : 'Tentativas anteriores sem sucesso:'}
      </Text>
      {details.map((detail, index) => (
        // A mesma falha pode se repetir: a posição faz parte da identidade.
        <Text key={`${index}-${detail}`} style={[styles.checkDetail, { color: theme.noticeError }]}>
          {details.length === 1 ? detail : `${index + 1}. ${detail}`}
        </Text>
      ))}
    </View>
  );
}

/**
 * O app vê a esteira aceitar o Parar e a lona parar, mas não quem a parou: a verificação só
 * conclui com a resposta de quem está na frente da esteira. A pergunta vem no texto acima.
 */
function StopAnswerButtons() {
  const theme = useTheme();
  const { reportStop } = useGuideActions();
  const stopAnswer = useGuide((s) => s.stopAnswer);
  return (
    <View style={styles.field}>
      <ActionButton
        variant={stopAnswer === 'alone' ? 'primary' : 'outline'}
        label="Sim, parou sozinha"
        onPress={() => reportStop('alone')}
      />
      <ActionButton
        variant={stopAnswer === 'helped' ? 'solid' : 'outline'}
        color={theme.noticeError}
        onColor={theme.background}
        label="Não, eu a parei"
        onPress={() => reportStop('helped')}
      />
      {/* A esteira pode informar velocidade zero com a lona girando. */}
      <ActionButton
        variant={stopAnswer === 'notStopped' ? 'solid' : 'outline'}
        color={theme.noticeError}
        onColor={theme.background}
        label="A lona não parou"
        onPress={() => reportStop('notStopped')}
      />
    </View>
  );
}

/**
 * Quem vê a lona é o usuário: a resposta dele vale mais que o aviso da esteira, e é a única
 * conclusão possível quando a esteira não avisa a parada de emergência.
 */
function EmergencyStopButtons() {
  const theme = useTheme();
  const { reportEmergencyStop } = useGuideActions();
  const emergencyStop = useGuide((s) => s.emergencyStop);
  return (
    <View style={styles.field}>
      <Text style={[styles.question, { color: theme.text }]}>
        Você apertou o Emergency Stop com a lona girando. Ela parou?
      </Text>
      <ActionButton
        variant={emergencyStop === 'stopped' ? 'primary' : 'outline'}
        label="A lona parou"
        onPress={() => reportEmergencyStop('stopped')}
      />
      <ActionButton
        variant={emergencyStop === 'notStopped' ? 'solid' : 'outline'}
        color={theme.noticeError}
        onColor={theme.background}
        label="A lona não parou"
        onPress={() => reportEmergencyStop('notStopped')}
      />
    </View>
  );
}

/** `early`: o roteiro ainda está no meio; o envio não conclui o passo 6. */
function ShareButton({ early = false }: { early?: boolean }) {
  const theme = useTheme();
  const fileName = useRecorder((s) => s.currentFileName);
  const problem = useRecorder((s) => s.problem);
  const recorder = useRecorderActions();
  const { markShared, noteEarlyShare } = useGuideActions();
  const [tried, setTried] = useState(false);

  const share = () => {
    setTried(true);
    // Primeiro o roteiro escreve no registro (observações e o toque); o
    // gravador grava o pendente antes de abrir a folha de compartilhamento.
    // Sem arquivo, o toque conta do mesmo jeito: o passo não pode travar o roteiro.
    if (early) {
      noteEarlyShare();
    } else {
      markShared();
    }
    if (fileName !== null) {
      recorder.share(fileName);
    }
  };

  const message =
    problem ?? (fileName === null && tried ? 'O registro não pôde ser criado neste celular.' : null);

  return (
    <View style={styles.field}>
      <ActionButton
        variant={early ? 'outline' : 'primary'}
        label={early ? 'Compartilhar registro agora' : 'Compartilhar registro'}
        onPress={share}
      />
      {message ? (
        <Text
          accessibilityRole="alert"
          style={[styles.urgent, { color: theme.noticeError, borderColor: theme.noticeError }]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

/** O que foi aceito, recusado e respondido; aparece quando os comandos foram testados. */
function Summary({ showShare }: { showShare: boolean }) {
  const theme = useTheme();
  const active = useGuide((s) => s.active);
  const steps = useGuide((s) => s.steps);
  const panelCode = useGuide((s) => s.panelCode);
  const bluetoothIndicator = useGuide((s) => s.bluetoothIndicator);
  const stopAnswer = useGuide((s) => s.stopAnswer);
  const emergencyStop = useGuide((s) => s.emergencyStop);
  const emergencyCause = useGuide((s) => s.emergencyCause);
  const commands = steps.find((step) => step.id === 'commands');
  const hasEmergencyCheck = commands?.checks.some((check) => check.id === 'emergencyStop') ?? false;

  const rows: {
    label: string;
    value: string;
    detail: string | null;
    failed: boolean;
    earlier?: readonly string[];
  }[] = [];
  if (commands && commands.checks.length > 0) {
    for (const check of commands.checks) {
      rows.push({
        label: check.label,
        value: CHECK_STATE_WORDS[check.state],
        detail: check.detail,
        failed: check.state === 'failed',
        earlier: check.earlier,
      });
    }
    rows.push({
      label: 'No Parar, a lona parou sozinha',
      value: STOP_ANSWER_WORDS[stopAnswer ?? 'none'],
      detail: null,
      failed: stopAnswer === 'helped' || stopAnswer === 'notStopped',
    });
  } else if (commands?.detail) {
    rows.push({ label: 'Comandos', value: 'não testados', detail: commands.detail, failed: false });
  }
  rows.push(
    {
      label: 'Código do painel',
      value: panelCode === '' ? 'não informado' : panelCode,
      detail: null,
      failed: false,
    },
    {
      label: 'Indicador Bluetooth acendeu',
      value: ANSWER_WORDS[bluetoothIndicator ?? 'none'],
      detail: null,
      failed: bluetoothIndicator === 'no',
    },
    {
      label: 'Emergency Stop',
      value: emergencyResultWords(emergencyStop, emergencyCause),
      detail: null,
      failed: emergencyStop === 'notStopped',
    },
  );

  return (
    <View style={styles.summary}>
      <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
        Resumo
      </Text>
      {rows.map((row) => (
        <View key={row.label} style={[styles.summaryRow, { borderColor: theme.border }]}>
          <View style={styles.summaryLine}>
            <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>{row.label}</Text>
            <Text
              style={[styles.summaryValue, { color: row.failed ? theme.noticeError : theme.text }]}>
              {row.value}
            </Text>
          </View>
          {row.detail ? (
            <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>{row.detail}</Text>
          ) : null}
          {row.earlier ? <EarlierAttempts details={row.earlier} /> : null}
        </View>
      ))}
      {/* Com o passo 5 recolhido, é aqui que se corrige um toque errado na pergunta do Parar. */}
      {active && stopAnswer !== null ? (
        <View style={styles.field}>
          <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>
            Se a resposta sobre o Parar acima estiver errada, corrija aqui: a lona parou sozinha,
            sem você tocar no painel nem no Emergency Stop?
          </Text>
          <StopAnswerButtons />
        </View>
      ) : null}
      {/* Com o passo 5 recolhido, é aqui que se corrige o resultado do Emergency Stop. */}
      {active && hasEmergencyCheck ? (
        <View style={styles.field}>
          <Text style={[styles.checkDetail, { color: theme.textSecondary }]}>
            Se o resultado do Emergency Stop acima estiver errado, corrija aqui:
          </Text>
          <EmergencyStopButtons />
        </View>
      ) : null}
      {showShare ? <ShareButton /> : null}
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
    gap: Spacing.two,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    borderBottomWidth: 1,
  },
  title: {
    flexShrink: 1,
    fontSize: 20,
    fontWeight: 700,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
    paddingBottom: Spacing.five,
  },
  intro: {
    gap: Spacing.three,
  },
  introText: {
    fontSize: 16,
    lineHeight: 22,
  },
  steps: {
    borderTopWidth: 1,
  },
  step: {
    paddingVertical: Spacing.three,
    borderBottomWidth: 1,
    gap: Spacing.two,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.three,
  },
  stepNumber: {
    width: 24,
    fontSize: 17,
    fontWeight: 700,
  },
  stepNumberOpen: {
    fontSize: 24,
  },
  stepTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: 600,
  },
  stepTitleOpen: {
    fontSize: 24,
    fontWeight: 700,
  },
  doneMark: {
    fontSize: 15,
    fontWeight: 700,
  },
  collapsedDetail: {
    fontSize: 15,
    lineHeight: 21,
    paddingLeft: 24 + Spacing.three,
  },
  stepBody: {
    gap: Spacing.three,
    paddingTop: Spacing.one,
  },
  stepText: {
    fontSize: 22,
    lineHeight: 31,
    fontWeight: 500,
  },
  warning: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 600,
    borderLeftWidth: 4,
    paddingLeft: Spacing.three,
  },
  field: {
    gap: Spacing.two,
  },
  fieldLabel: {
    fontSize: 15,
  },
  input: {
    minHeight: MinTouchTarget,
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 20,
  },
  notes: {
    minHeight: MinTouchTarget * 2,
    fontSize: 17,
    textAlignVertical: 'top',
  },
  question: {
    fontSize: 18,
    lineHeight: 25,
    fontWeight: 600,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  rowButton: {
    flex: 1,
  },
  checks: {
    gap: Spacing.two,
  },
  check: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderWidth: 1,
    borderRadius: 12,
  },
  checkCurrent: {
    borderWidth: 2,
  },
  checkHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.three,
  },
  checkLabel: {
    flex: 1,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 600,
  },
  checkLabelCurrent: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: 700,
  },
  checkState: {
    fontSize: 15,
    fontWeight: 700,
  },
  checkDetail: {
    fontSize: 15,
    lineHeight: 21,
  },
  urgent: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 700,
    borderWidth: 2,
    borderRadius: 8,
    padding: Spacing.three,
  },
  earlier: {
    gap: Spacing.one,
  },
  earlierTitle: {
    fontWeight: 700,
  },
  questionCard: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderWidth: 2,
    borderRadius: 12,
  },
  summary: {
    gap: Spacing.one,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
    marginBottom: Spacing.one,
  },
  summaryRow: {
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  summaryLine: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  summaryLabel: {
    flex: 1,
    fontSize: 15,
  },
  summaryValue: {
    fontSize: 15,
    fontWeight: 600,
    textAlign: 'right',
  },
});
