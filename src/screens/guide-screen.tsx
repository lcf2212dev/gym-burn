import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BeltFooter } from '@/components/belt-footer';
import { Pill, type PillTone } from '@/components/pill';
import { ScreenHeader } from '@/components/screen-header';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import {
  LabelType,
  MaxContentWidth,
  MinTouchTarget,
  Neon,
  NumeralType,
  Radius,
  Spacing,
  TitleType,
  neonGlow,
  withAlpha,
} from '@/constants/theme';
import { useGuide, useGuideActions } from '@/guide/guide-context';
import {
  ANSWER_WORDS,
  CHECK_STATE_WORDS,
  STOP_ANSWER_WORDS,
  emergencyResultWords,
} from '@/guide/guide-logic';
import type { GuideCheck, GuideCheckState, GuideStep } from '@/guide/types';
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

/** Cor da pill de cada estado da verificação; o significado é o mesmo do resto do app. */
const CHECK_TONES: Record<GuideCheckState, PillTone> = {
  pending: 'neutral',
  current: 'cyan',
  done: 'mint',
  unconfirmed: 'amber',
  failed: 'red',
};

/** Cor do fio de destaque da verificação; `null` não acende nada. */
function checkAccent(check: GuideCheck): string | null {
  switch (check.state) {
    case 'current':
      return Neon.cyan;
    case 'done':
      return Neon.mint;
    case 'unconfirmed':
      return Neon.amber;
    case 'failed':
      return Neon.red;
    case 'pending':
      return null;
  }
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
      {/* Halo ciano único: profundidade no carbono sem uma segunda temperatura de cor. */}
      <AmbientGlow intensity={0.5} />

      <ScreenHeader
        title="Primeiro teste na esteira"
        right={<ActionButton variant="text" label="Voltar" onPress={goBack} />}
        accent={Neon.violet}
      />

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          {active ? null : (
            <Surface tone="raised" accent={Neon.violet} style={styles.introCard}>
              <Text style={[styles.introText, { color: theme.textSecondary }]}>
                Seis passos para conectar, conferir os comandos e enviar o registro. Tudo o que
                acontecer fica salvo no registro.
              </Text>
              <ActionButton variant="primary" label="Começar o roteiro" onPress={start} />
            </Surface>
          )}

          {/* Com o passo 5 aberto, as perguntas já estão nas verificações dele. Fora dele (o
              Emergency Stop pode derrubar a conexão e devolver o roteiro ao passo 3), elas
              precisam aparecer aqui, ou não haveria onde responder. */}
          {active && stopQuestion !== null && currentStepId !== 'commands' ? (
            <Surface accent={Neon.amber} style={styles.questionCard}>
              <Text style={[styles.questionTitle, TitleType, { color: theme.text }]} accessibilityRole="header">
                Parar
              </Text>
              <Text style={[styles.questionText, { color: theme.text }]}>{stopQuestion}</Text>
              <StopAnswerButtons />
            </Surface>
          ) : null}
          {active && emergencyQuestion !== null && currentStepId !== 'commands' ? (
            <Surface accent={Neon.amber} style={styles.questionCard}>
              <Text style={[styles.questionTitle, TitleType, { color: theme.text }]} accessibilityRole="header">
                Emergency Stop
              </Text>
              <Text style={[styles.questionText, { color: theme.text }]}>{emergencyQuestion}</Text>
              <EmergencyStopButtons />
            </Surface>
          ) : null}

          <View style={styles.timeline}>
            {steps.map((step, index) => (
              <StepItem
                key={step.id}
                step={step}
                active={active}
                last={index === steps.length - 1}
              />
            ))}
          </View>

          {commandsDone ? <Summary showShare={finished && active} /> : null}

          {/* Se um passo não anda (a esteira nem aparece na busca, por exemplo), o registro é
              justamente o que explica o motivo: dá para enviá-lo de qualquer passo. */}
          {offerEarlyShare ? (
            <Surface style={styles.earlyShare}>
              <Text style={[styles.helpText, { color: theme.textSecondary }]}>
                Travou em algum passo? Envie o registro como está.
              </Text>
              <ShareButton early />
            </Surface>
          ) : null}

          {active ? (
            <ActionButton
              variant="outline"
              label="Encerrar o roteiro"
              onPress={stop}
              color={Neon.amber}
            />
          ) : null}
        </View>
      </ScrollView>
      {/* Esta tela cobre o painel: com a lona girando, Parar tem que continuar à vista. */}
      <BeltFooter />
    </SafeAreaView>
  );
}

function StepItem({ step, active, last }: { step: GuideStep; active: boolean; last: boolean }) {
  const theme = useTheme();
  const open = active && step.state === 'current';
  const done = step.state === 'done';

  const badgeColor = open ? Neon.volt : done ? theme.background : theme.textSecondary;
  const badgeBorder = open ? Neon.volt : done ? Neon.mint : theme.border;
  const badgeBackground = open ? withAlpha(Neon.volt, 0.14) : done ? Neon.mint : 'transparent';

  return (
    <View style={[styles.stepRow, last && styles.stepRowLast]}>
      {/* Trilho da linha do tempo: um segmento absoluto por passo, do badge deste até o
          topo do próximo. Concluído em menta; futuro no contorno do tema. */}
      {last ? null : (
        <View
          pointerEvents="none"
          style={[
            styles.track,
            { backgroundColor: done ? Neon.mint : withAlpha(theme.border, 0.8) },
          ]}
        />
      )}

      <View style={styles.rail}>
        <View style={[styles.badge, { borderColor: badgeBorder, backgroundColor: badgeBackground }]}>
          <Text
            style={[
              styles.badgeNumber,
              NumeralType,
              { color: badgeColor },
              open && neonGlow(Neon.volt, 12, 0.6),
            ]}>
            {step.number}
          </Text>
        </View>
      </View>

      <View style={[styles.stepMain, open ? null : styles.stepMainCollapsed]}>
        {open ? (
          <Surface tone="raised" accent={Neon.volt} style={styles.openCard}>
            <Text
              style={[styles.stepTitleOpen, TitleType, { color: theme.text }]}
              accessibilityRole="header">
              {step.title}
            </Text>
            <Text style={[styles.stepText, { color: theme.text }]}>{step.text}</Text>
            {step.warning ? (
              <Surface tone="sunken" accent={Neon.amber}>
                <Text style={[styles.warning, { color: theme.text }]}>{step.warning}</Text>
              </Surface>
            ) : null}
            <View style={styles.stepControls}>
              <StepControls step={step} />
            </View>
          </Surface>
        ) : (
          <View style={styles.collapsed}>
            <View style={styles.collapsedHeader}>
              <Text
                style={[styles.stepTitle, TitleType, { color: theme.textSecondary }]}
                accessibilityRole="header">
                {step.title}
              </Text>
              {done ? <Pill label="feito" tone="mint" /> : null}
            </View>
            {step.state === 'done' && step.detail ? (
              <Text style={[styles.collapsedDetail, { color: theme.textSecondary }]}>
                {step.detail}
              </Text>
            ) : null}
          </View>
        )}
      </View>
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
      <Text style={[LabelType, { color: theme.textSecondary }]}>
        Código que apareceu no painel (opcional)
      </Text>
      <TextInput
        value={panelCode}
        onChangeText={setPanelCode}
        onBlur={() => commitText('panelCode')}
        keyboardType="number-pad"
        returnKeyType="done"
        accessibilityLabel="Código que apareceu no painel"
        style={[
          styles.input,
          {
            color: theme.text,
            borderColor: theme.border,
            backgroundColor: theme.backgroundElement,
          },
        ]}
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
      <Text style={[LabelType, { color: theme.textSecondary }]}>Observações (opcional)</Text>
      <TextInput
        value={notes}
        onChangeText={setNotes}
        onBlur={() => commitText('notes')}
        multiline
        accessibilityLabel="Observações"
        style={[
          styles.input,
          styles.notes,
          {
            color: theme.text,
            borderColor: theme.border,
            backgroundColor: theme.backgroundElement,
          },
        ]}
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
  const current = check.state === 'current';

  return (
    <Surface
      tone="default"
      accent={check.urgent ? Neon.red : checkAccent(check)}
      style={styles.check}>
      <View style={styles.checkHeader}>
        <Text
          style={[
            styles.checkLabel,
            current && styles.checkLabelCurrent,
            { color: check.state === 'pending' ? theme.textSecondary : theme.text },
          ]}>
          {check.label}
        </Text>
        <Pill label={CHECK_STATE_WORDS[check.state]} tone={CHECK_TONES[check.state]} />
      </View>
      {check.detail ? (
        check.urgent ? (
          <Surface tone="sunken" accent={Neon.red}>
            <Text accessibilityRole="alert" style={[styles.checkDetail, { color: theme.text }]}>
              {check.detail}
            </Text>
          </Surface>
        ) : (
          <Text
            style={[
              styles.checkDetail,
              { color: check.state === 'failed' ? theme.text : theme.textSecondary },
            ]}>
            {check.detail}
          </Text>
        )
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
    </Surface>
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
      <Text style={[styles.earlierTitle, { color: theme.noticeError }]}>
        {details.length === 1 ? 'Tentativa anterior sem sucesso:' : 'Tentativas anteriores sem sucesso:'}
      </Text>
      {details.map((detail, index) => (
        // A mesma falha pode se repetir: a posição faz parte da identidade.
        <Text key={`${index}-${detail}`} style={[styles.earlierLine, { color: theme.textSecondary }]}>
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
        color={Neon.red}
        onColor={theme.background}
        label="Não, eu a parei"
        onPress={() => reportStop('helped')}
      />
      {/* A esteira pode informar velocidade zero com a lona girando. */}
      <ActionButton
        variant={stopAnswer === 'notStopped' ? 'solid' : 'outline'}
        color={Neon.red}
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
        color={Neon.red}
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
        <Surface tone="sunken" accent={Neon.red}>
          <Text accessibilityRole="alert" style={[styles.checkDetail, { color: theme.text }]}>
            {message}
          </Text>
        </Surface>
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
      {/* O SectionLabel não recebe role; o wrapper mantém o cabeçalho para o leitor de tela. */}
      <View accessible accessibilityRole="header" accessibilityLabel="Resumo">
        <SectionLabel label="Resumo" accent={Neon.violet} />
      </View>
      <View>
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
              <Text style={[styles.summaryDetail, { color: theme.textSecondary }]}>{row.detail}</Text>
            ) : null}
            {row.earlier ? <EarlierAttempts details={row.earlier} /> : null}
          </View>
        ))}
      </View>
      {/* Com o passo 5 recolhido, é aqui que se corrige um toque errado na pergunta do Parar. */}
      {active && stopAnswer !== null ? (
        <Surface accent={Neon.amber} style={styles.correctionCard}>
          <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
            Se a resposta sobre o Parar acima estiver errada, corrija aqui: a lona parou sozinha,
            sem você tocar no painel nem no Emergency Stop?
          </Text>
          <StopAnswerButtons />
        </Surface>
      ) : null}
      {/* Com o passo 5 recolhido, é aqui que se corrige o resultado do Emergency Stop. */}
      {active && hasEmergencyCheck ? (
        <Surface accent={Neon.amber} style={styles.correctionCard}>
          <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
            Se o resultado do Emergency Stop acima estiver errado, corrija aqui:
          </Text>
          <EmergencyStopButtons />
        </Surface>
      ) : null}
      {showShare ? <ShareButton /> : null}
    </View>
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
    // O último cartão não pode encostar no BeltFooter fixo.
    paddingBottom: Spacing.five,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  introCard: {
    gap: Spacing.three,
    padding: Spacing.four,
  },
  introText: {
    fontSize: 18,
    lineHeight: 27,
    fontWeight: '500',
  },
  questionCard: {
    gap: Spacing.three,
  },
  questionTitle: {
    fontSize: 22,
    lineHeight: 26,
  },
  questionText: {
    fontSize: 20,
    lineHeight: 29,
    fontWeight: '500',
  },
  timeline: {
    gap: 0,
  },
  stepRow: {
    flexDirection: 'row',
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  stepRowLast: {
    paddingBottom: 0,
  },
  rail: {
    width: 34,
    alignItems: 'center',
  },
  badge: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeNumber: {
    fontSize: 19,
    lineHeight: 22,
  },
  track: {
    position: 'absolute',
    left: 16,
    top: 34,
    bottom: 0,
    width: 2,
    borderRadius: 1,
  },
  stepMain: {
    flex: 1,
  },
  // Recolhidos: o título alinha com o centro do badge.
  stepMainCollapsed: {
    paddingTop: 5,
  },
  openCard: {
    gap: Spacing.three,
  },
  stepTitleOpen: {
    fontSize: 24,
    lineHeight: 28,
  },
  stepText: {
    fontSize: 20,
    lineHeight: 29,
  },
  warning: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '600',
  },
  stepControls: {
    gap: Spacing.three,
  },
  collapsed: {
    gap: Spacing.one,
  },
  collapsedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  stepTitle: {
    flex: 1,
    fontSize: 20,
    lineHeight: 24,
  },
  collapsedDetail: {
    fontSize: 16,
    lineHeight: 24,
  },
  field: {
    gap: Spacing.two,
  },
  input: {
    minHeight: MinTouchTarget,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 20,
    lineHeight: 26,
  },
  notes: {
    minHeight: MinTouchTarget * 2,
    fontSize: 18,
    lineHeight: 26,
    paddingTop: Spacing.three,
    textAlignVertical: 'top',
  },
  question: {
    fontSize: 19,
    lineHeight: 27,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  rowButton: {
    flex: 1,
  },
  checks: {
    gap: 12,
  },
  check: {
    gap: 10,
  },
  checkHeader: {
    gap: Spacing.two,
    alignItems: 'flex-start',
  },
  checkLabel: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '500',
  },
  checkLabelCurrent: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
  },
  checkDetail: {
    fontSize: 16,
    lineHeight: 24,
  },
  earlier: {
    gap: Spacing.one,
  },
  earlierTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  earlierLine: {
    fontSize: 14,
    lineHeight: 21,
  },
  summary: {
    gap: Spacing.two,
  },
  summaryRow: {
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
  },
  summaryLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
  },
  summaryLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  summaryValue: {
    flexShrink: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    textAlign: 'right',
  },
  summaryDetail: {
    fontSize: 14,
    lineHeight: 20,
  },
  correctionCard: {
    gap: Spacing.two,
  },
  paragraph: {
    fontSize: 16,
    lineHeight: 24,
  },
  helpText: {
    fontSize: 14,
    lineHeight: 20,
  },
  earlyShare: {
    gap: Spacing.two,
  },
});
