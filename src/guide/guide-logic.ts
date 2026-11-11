import type { CommandKind, CommandTally, TreadmillSnapshot } from '@/treadmill/types';
import { isBeltMoving } from '@/utils/controls';
import { formatDecimal } from '@/utils/format';

import type {
  AcknowledgedStep,
  BluetoothIndicatorAnswer,
  EmergencyStopCause,
  EmergencyStopResult,
  GuideCheck,
  GuideCheckId,
  GuideCheckState,
  GuideStep,
  GuideStepId,
  GuideStepState,
  GuideSnapshot,
  StopAnswer,
} from './types';

/**
 * Lógica pura do roteiro do primeiro teste: o que a sessão da esteira mostra
 * vira estado do roteiro (`observeSession`), e o estado vira o snapshot que a
 * interface lê (`buildGuideSnapshot`). Nada aqui tem efeito colateral.
 */

export const GUIDE_STEP_COUNT = 6;

/**
 * Prazo para o efeito de um comando aparecer na velocidade medida: a lona andar depois de um
 * Iniciar aceito, parar depois de um Parar aceito. Passado o prazo, o que a lona fizer já não é
 * atribuído àquele comando.
 */
export const EFFECT_WINDOW_MS = 15_000;
/**
 * Tempo com a velocidade medida em zero para a lona valer como parada. Passa do intervalo entre
 * duas leituras (uma por segundo): uma leitura solta de 0 km/h não conta.
 */
export const STILL_HOLD_MS = 1_500;
/**
 * Numa esteira que manda leituras mais espaçadas, o tempo em zero acompanha o intervalo entre
 * elas (uma vez e meia), até este teto.
 */
const STILL_HOLD_MAX_MS = 8_000;
/**
 * Queda de velocidade, de uma leitura para a outra, que conta como "freando". Fica acima da
 * oscilação de uma esteira que mede a lona em vez de informar a velocidade pedida.
 */
const BRAKING_DROP_KMH = 0.2;
/**
 * A lona para e só depois chega o aviso de parada de emergência: até este intervalo, os dois são
 * o mesmo acontecimento (a esteira mandou a leitura antes do aviso).
 */
const LATE_REPORT_MS = 3_000;
/**
 * Atualizações com a mesma velocidade dentro deste intervalo são pedaços do mesmo registro (a
 * esteira pode dividi-lo em duas notificações), não uma leitura nova.
 */
const SAME_READING_MS = 500;
/**
 * Espera máxima pela resposta da esteira a um pedido. A sessão sempre dá um desfecho antes
 * disso, a não ser que o comando tenha sido cancelado por um Parar; aí a tentativa é abandonada.
 */
const RESPONSE_WAIT_MAX_MS = 30_000;
const EFFECT_WINDOW_TEXT = `${EFFECT_WINDOW_MS / 1000} segundos`;

/** Desfecho guardado de uma verificação de comando. Concluída, não volta atrás. */
export interface CheckRecord {
  outcome: 'pending' | 'done' | 'unconfirmed' | 'failed';
  detail: string | null;
}

/**
 * Vigia do Emergency Stop, que só começa depois da verificação do Parar:
 * - `waitStill`: espera a lona parar (um Parar ou Pausar do app pode estar freando);
 * - `waitSpin`: lona parada, espera ela girar de novo;
 * - `spinning`: lona girando livre, sem freio do app nem aviso da esteira: é aqui que o
 *   Emergency Stop é esperado;
 * - `emergencyBraking`: a esteira avisou a parada de emergência com a lona girando livre, e a
 *   velocidade ainda não zerou;
 * - `otherBraking`: a esteira avisou outra parada (o Stop ou o Pause do painel) com a lona
 *   girando livre.
 */
export type EmergencyWatch = 'waitStill' | 'waitSpin' | 'spinning' | 'emergencyBraking' | 'otherBraking';

/**
 * O que o app viu enquanto esperava o Emergency Stop e que não basta para concluir sozinho: o
 * aviso de parada de emergência da esteira (`safetyKey`), a lona parada sem esse aviso (`belt`)
 * ou a conexão terminando com a lona girando (`link`). Nesses, quem responde é o usuário. `idle`
 * é o botão acionado com a lona já parada: não testa nada, e vira orientação, não pergunta.
 */
export type EmergencyObservation = 'safetyKey' | 'belt' | 'link' | 'idle';

/**
 * Uma tentativa de Iniciar ou de Parar, do toque ao veredito. O comando só é posto à prova
 * quando pedido na condição certa: Iniciar com a lona parada, Parar com ela girando livre.
 */
export interface CommandFacts {
  /** Pedidos já vistos, para notar um novo. */
  requestedSeen: number;
  /**
   * Desfechos já contados quando a tentativa começou; só os que vêm depois são dela. `null`:
   * não há tentativa (nenhum pedido ainda, ou o último veio fora da condição).
   */
  base: CommandTally | null;
  /** O último pedido veio fora da condição: não testa nada, mas merece uma orientação. */
  misplaced: boolean;
  requestedAt: number | null;
  /** A primeira resposta da esteira à tentativa (ou a falta dela). */
  outcome: 'accepted' | 'unconfirmed' | 'refused' | null;
  outcomeAt: number | null;
  /** Quando o efeito apareceu: lona girando (Iniciar) ou parada (Parar). */
  effectAt: number | null;
  /**
   * Só no Parar: a esteira avisou a parada de emergência com a lona ainda girando. A parada que
   * vier depois não vale como efeito do Parar.
   */
  interrupted: boolean;
}

const NO_FACTS: CommandFacts = {
  requestedSeen: 0,
  base: null,
  misplaced: false,
  requestedAt: null,
  outcome: null,
  outcomeAt: null,
  effectAt: null,
  interrupted: false,
};

/** Tudo o que o roteiro guarda; o resto é derivado da sessão a cada mudança. */
export interface GuideState {
  active: boolean;
  acknowledged: Record<AcknowledgedStep, boolean>;
  panelCode: string;
  bluetoothIndicator: BluetoothIndicatorAnswer | null;
  emergencyStop: EmergencyStopResult;
  emergencyCause: EmergencyStopCause | null;
  notes: string;
  shared: boolean;
  /**
   * A esteira conectada não tem Control Point: não há comandos a testar. Vale
   * até uma conexão com Control Point; desconectado, fica como estava.
   */
  dataOnly: boolean;
  /**
   * Contagem de comandos da conexão no instante em que o roteiro começou, para
   * não contar comandos de antes dele; `null` depois de uma reconexão (a
   * contagem da sessão recomeça do zero).
   */
  commandBase: Record<CommandKind, CommandTally> | null;
  start: CheckRecord;
  speed: CheckRecord;
  stop: CheckRecord;
  /**
   * O app viu a esteira aceitar o Parar e a lona parar. Se ela parou sozinha ou se o usuário a
   * parou pelo painel ou pelo Emergency Stop, só ele sabe: a verificação espera a resposta.
   */
  stopAwaitingAnswer: boolean;
  /** A resposta dele; volta a `null` quando um novo Parar é posto à prova depois de um "não". */
  stopAnswer: StopAnswer | null;
  /**
   * O detalhe de cada tentativa anterior que não deu certo, por verificação. Uma tentativa que
   * funciona depois não apaga as que falharam.
   */
  earlier: Record<CommandCheckId, readonly string[]>;
  /** Zerados quando a conexão cai: a contagem da sessão recomeça com a conexão. */
  startFacts: CommandFacts;
  stopFacts: CommandFacts;
  /** Velocidade medida quando ela alcançou o alvo, depois de um ajuste aceito. */
  speedReachedKmh: number | null;
  /** `metrics.updatedAt` da última atualização de dados vista. */
  speedSampleAt: number | null;
  /** A última leitura de velocidade e quando ela foi vista. */
  speedSampleKmh: number | null;
  speedSampleTime: number | null;
  /** Intervalo entre as duas últimas leituras; `null` antes da segunda. */
  readingIntervalMs: number | null;
  /** A última leitura veio abaixo da anterior: a lona está freando ou desacelerando. */
  speedDropping: boolean;
  /** Desde quando a velocidade medida está em zero; `null` se não está. */
  zeroSince: number | null;
  emergencyWatch: EmergencyWatch;
  emergencyObservation: EmergencyObservation | null;
  /**
   * Como estava a lona quando a esteira avisou a parada de emergência que está valendo: girando
   * (`moving`) ou parada (`still`); `null` sem aviso. É guardado mesmo com a vigia ainda fora de
   * cena, para ela saber depois se o botão foi apertado com a lona girando.
   */
  emergencyReport: 'moving' | 'still' | null;
  /** Parar e Pausar pedidos pelo app já vistos nesta conexão; `null` sem conexão. */
  brakeRequests: number | null;
  /** Parar e Pausar que a esteira recusou, já vistos nesta conexão. */
  brakeRefusals: number;
  /**
   * Quando o app pediu o último Parar ou Pausar que pode estar freando a lona; `null` se não
   * houve, ou se a esteira o recusou.
   */
  lastBrakeAt: number | null;
}

const PENDING: CheckRecord = { outcome: 'pending', detail: null };

/** As verificações que são comandos do app (o Emergency Stop é do usuário). */
type CommandCheckId = Exclude<GuideCheckId, 'emergencyStop'>;

const NO_EARLIER: readonly string[] = [];

export function initialGuideState(): GuideState {
  return {
    active: false,
    acknowledged: { safety: false, appMode: false },
    panelCode: '',
    bluetoothIndicator: null,
    emergencyStop: 'pending',
    emergencyCause: null,
    notes: '',
    shared: false,
    dataOnly: false,
    commandBase: null,
    start: PENDING,
    speed: PENDING,
    stop: PENDING,
    stopAwaitingAnswer: false,
    stopAnswer: null,
    earlier: { start: NO_EARLIER, speed: NO_EARLIER, stop: NO_EARLIER },
    startFacts: NO_FACTS,
    stopFacts: NO_FACTS,
    speedReachedKmh: null,
    speedSampleAt: null,
    speedSampleKmh: null,
    speedSampleTime: null,
    readingIntervalMs: null,
    speedDropping: false,
    zeroSince: null,
    emergencyWatch: 'waitStill',
    emergencyObservation: null,
    emergencyReport: null,
    brakeRequests: null,
    brakeRefusals: 0,
    lastBrakeAt: null,
  };
}

// --- Textos -----------------------------------------------------------------

interface StepDefinition {
  id: GuideStepId;
  title: string;
  text: string;
  warning: string | null;
}

export const GUIDE_STEPS: readonly StepDefinition[] = [
  {
    id: 'safety',
    title: 'Segurança',
    text: 'Fique fora da lona, com o botão vermelho Emergency Stop ao alcance.',
    warning: null,
  },
  {
    id: 'appMode',
    title: 'Modo APP',
    text: 'Segure a tecla ✓/BT do teclado numérico por 5 segundos, até o painel entrar no modo APP.',
    warning: null,
  },
  {
    id: 'connect',
    title: 'Conectar',
    text: 'No app, toque em Procurar esteiras e conecte na do topo da lista. Se nenhuma aparecer, ligue Mostrar outros aparelhos Bluetooth.',
    warning: null,
  },
  {
    id: 'identity',
    title: 'Confirmar a esteira',
    text: 'Confira no painel que o indicador Bluetooth acendeu e que os números batem com os do app; só então toque em É esta esteira.',
    warning: 'Antes disso o app não envia nenhum comando, nem o Parar.',
  },
  {
    id: 'commands',
    title: 'Comandos',
    text: 'Teste os comandos pelo app, um de cada vez, olhando a lona.',
    warning: 'Depois de Pausar ou Parar, o botão Iniciar fica desabilitado até a lona parar de girar.',
  },
  {
    id: 'share',
    title: 'Enviar o registro',
    text: 'Compartilhe o registro: é ele que mostra o que a esteira suporta e o que ajustar.',
    warning: null,
  },
];

export const CHECK_LABELS: Record<GuideCheckId, string> = {
  start: 'Toque em Iniciar',
  speed: 'Toque em +0,1 na velocidade',
  stop: 'Toque em Parar, com a lona girando',
  emergencyStop:
    'Toque em Iniciar de novo e, com a lona girando, aperte o botão vermelho Emergency Stop',
};

const CHECK_ORDER: readonly GuideCheckId[] = ['start', 'speed', 'stop', 'emergencyStop'];

export const DATA_ONLY_DETAIL = 'Esta esteira só transmite dados: não há comandos para testar.';
export const START_DONE_DETAIL = 'A esteira aceitou o Iniciar e a lona andou.';
export const START_WAITING_DETAIL =
  'A esteira aceitou o Iniciar; esperando a lona andar. Não toque no painel.';
export const START_NO_MOVEMENT_DETAIL = `A esteira aceitou o Iniciar, mas o app não viu a lona andar em ${EFFECT_WINDOW_TEXT}. Inicie pelo botão verde do painel e siga em frente.`;
export const START_FAILED_DETAIL =
  'A esteira não aceitou o Iniciar pelo app. Inicie pelo botão verde do painel e siga em frente.';
export const STARTED_BY_PANEL_DETAIL =
  'A esteira não aceitou o Iniciar pelo app; a lona foi iniciada pelo painel.';
export const START_UNCONFIRMED_DETAIL = 'A esteira não respondeu ao Iniciar.';
export const START_UNCONFIRMED_MOVED_DETAIL = 'A esteira não respondeu ao Iniciar, mas a lona andou.';
export const START_UNCONFIRMED_STILL_DETAIL =
  'A esteira não respondeu ao Iniciar e o app não viu a lona andar. Inicie pelo botão verde do painel e siga em frente.';
export const START_MISPLACED_DETAIL =
  'A lona já girava quando você tocou em Iniciar. Pare a lona e toque em Iniciar com ela parada.';
export const SPEED_REFUSED_DETAIL = 'A esteira recusou o ajuste de velocidade';
export const SPEED_UNCONFIRMED_DETAIL = 'A esteira não confirmou o ajuste';
export const STOP_WAITING_DETAIL =
  'A esteira aceitou o Parar; esperando a lona parar. Não toque no painel nem no Emergency Stop.';
export const STOP_CONFIRM_DETAIL =
  'A esteira aceitou o Parar e a velocidade foi a zero. A lona parou sozinha, sem você tocar no painel nem no Emergency Stop?';
export const STOP_DONE_DETAIL =
  'A esteira aceitou o Parar e a lona parou. Você confirmou que não tocou no painel nem no Emergency Stop.';
export const STOP_HELPED_DETAIL =
  'A esteira aceitou o Parar, mas você informou que parou a lona pelo painel ou pelo Emergency Stop.';
export const STOP_NOT_STOPPED_DETAIL =
  'A esteira aceitou o Parar e informou velocidade zero, mas você informou que a lona não parou. Pare a lona pelo painel ou pelo Emergency Stop e não use o app com alguém na esteira.';
export const STOP_NOT_SEEN_DETAIL = `A esteira aceitou o Parar, mas o app não viu a velocidade chegar a zero em ${EFFECT_WINDOW_TEXT}. Se a lona ainda gira, use o painel ou o Emergency Stop.`;
export const STOP_INTERRUPTED_DETAIL =
  'O Emergency Stop foi apertado antes de o app ver a lona parar pelo Parar. Repita: inicie a lona e toque em Parar, sem usar o Emergency Stop.';
export const STOP_MISPLACED_DETAIL =
  'O Parar não foi testado: a lona estava parada ou já freando. Inicie a lona, espere ela girar firme e toque em Parar.';
export const STOP_REFUSED_DETAIL =
  'A esteira recusou o Parar pelo app. Para parar a lona, use o painel ou o Emergency Stop.';
export const STOP_UNCONFIRMED_DETAIL =
  'A esteira não respondeu ao Parar. Se a lona não parar, use o painel ou o Emergency Stop.';
export const STOP_UNCONFIRMED_STOPPED_DETAIL = 'A esteira não respondeu ao Parar, mas a lona parou.';
export const STOP_UNCONFIRMED_MOVING_DETAIL =
  'A esteira não respondeu ao Parar e o app não viu a lona parar em seguida. Se ela ainda gira, use o painel ou o Emergency Stop.';
export const STOP_UNCONFIRMED_EMERGENCY_DETAIL =
  'A esteira não respondeu ao Parar, e o Emergency Stop foi apertado antes de a lona parar.';
export const STOP_QUESTION_HINT = 'A lona parou sozinha? Responda no roteiro.';
export const NOT_STOPPED_DETAIL =
  'Pare a lona pelo painel ou puxando a chave de segurança. Não use o app com alguém na esteira e avise a academia: o Emergency Stop tem que parar a lona sempre.';
export const EMERGENCY_SPINNING_DETAIL = 'Lona girando: aperte o Emergency Stop.';
export const EMERGENCY_QUESTION_HINT = 'A lona parou com o Emergency Stop? Responda no roteiro.';

export const EMERGENCY_DONE_DETAILS: Record<EmergencyStopCause, string> = {
  manual: 'Você informou que a lona parou.',
  safetyKey: 'A esteira avisou a parada de emergência e a velocidade foi a zero.',
};

export const EMERGENCY_IDLE_HINT =
  'Libere o Emergency Stop, inicie a lona pelo painel e aperte o Emergency Stop com ela girando.';

export const EMERGENCY_OBSERVATION_DETAILS: Record<EmergencyObservation, string> = {
  idle: 'O Emergency Stop foi acionado com a lona parada, e isso não testa o botão. Libere-o, inicie a lona pelo painel e aperte de novo com ela girando.',
  safetyKey: 'A esteira avisou a parada de emergência. Olhe a lona e responda abaixo.',
  belt: 'A lona parou, mas a esteira não avisou que foi pelo Emergency Stop. Se foi ele, responda abaixo; se não foi, inicie de novo e aperte o Emergency Stop.',
  link: 'A conexão terminou com a lona girando. Olhe a lona e responda abaixo.',
};

export function speedReachedDetail(kmh: number): string {
  return `A esteira foi a ${formatDecimal(kmh, 1)} km/h`;
}

// --- Observação da sessão -----------------------------------------------------

function sameRecord(a: CheckRecord, b: CheckRecord): boolean {
  return a.outcome === b.outcome && a.detail === b.detail;
}

/** Concluída fica travada; quem já teve desfecho não volta a pendente. */
function nextRecord(previous: CheckRecord, candidate: CheckRecord): CheckRecord {
  if (previous.outcome === 'done') {
    return previous;
  }
  if (previous.outcome !== 'pending' && candidate.outcome === 'pending') {
    return previous;
  }
  return sameRecord(previous, candidate) ? previous : candidate;
}

function moving(session: TreadmillSnapshot): boolean {
  return isBeltMoving(session.metrics.speedKmh);
}

/** A velocidade medida é zero. Sem medida, não se sabe: não vale como parada. */
function still(session: TreadmillSnapshot): boolean {
  return session.metrics.speedKmh !== null && !moving(session);
}

function done(detail: string): CheckRecord {
  return { outcome: 'done', detail };
}

function failed(detail: string): CheckRecord {
  return { outcome: 'failed', detail };
}

function unconfirmed(detail: string): CheckRecord {
  return { outcome: 'unconfirmed', detail };
}

function waiting(detail: string): CheckRecord {
  return { outcome: 'pending', detail };
}

/** O prazo para o efeito do comando aparecer já passou (só corre depois da resposta). */
function effectExpired(facts: CommandFacts, now: number): boolean {
  return facts.outcomeAt !== null && now - facts.outcomeAt > EFFECT_WINDOW_MS;
}

/** A tentativa tem veredito, ou foi abandonada: um novo toque começa outra. */
function attemptSettled(facts: CommandFacts, now: number): boolean {
  if (facts.base === null || facts.interrupted) {
    return true;
  }
  if (facts.outcome === null) {
    return facts.requestedAt === null || now - facts.requestedAt > RESPONSE_WAIT_MAX_MS;
  }
  return facts.outcome === 'refused' || facts.effectAt !== null || effectExpired(facts, now);
}

/** Há uma tentativa em andamento: o comando foi pedido e ainda não tem veredito. */
function attemptRunning(facts: CommandFacts, now: number): boolean {
  return facts.base !== null && !attemptSettled(facts, now);
}

interface AttemptContext {
  /** A lona está na condição que põe o comando à prova. */
  testable: boolean;
  /**
   * A lona ainda está como antes do comando (parada, no Iniciar; girando, no Parar). Enquanto a
   * esteira não responde, só assim um segundo toque é a mesma tentativa.
   */
  unchanged: boolean;
  /** O efeito esperado do comando aparece na velocidade medida. */
  effect: boolean;
  /** Só no Parar: a esteira avisa parada de emergência e a lona ainda gira. */
  emergency: boolean;
}

/** Atualiza a tentativa de um comando com o que a sessão mostra agora. */
function factsFor(
  facts: CommandFacts,
  raw: CommandTally,
  context: AttemptContext,
  now: number,
): CommandFacts {
  let next = facts;
  if (raw.requested > facts.requestedSeen) {
    const sameAttempt = !attemptSettled(facts, now) && (facts.outcome !== null || context.unchanged);
    if (sameAttempt) {
      next = { ...facts, requestedSeen: raw.requested };
    } else if (context.testable) {
      // O toque é contado antes de qualquer efeito: a lona ainda está como no instante dele.
      next = {
        ...NO_FACTS,
        requestedSeen: raw.requested,
        base: { ...raw, requested: raw.requested - 1 },
        requestedAt: now,
      };
    } else {
      // Um aceito que chegue deste pedido não prova nada.
      next = { ...NO_FACTS, requestedSeen: raw.requested, misplaced: true };
    }
  }
  if (next.base === null || next.interrupted) {
    return next;
  }
  if (next.outcome === null) {
    const tally = subtractTally(raw, next.base);
    const outcome =
      tally.accepted >= 1
        ? 'accepted'
        : tally.unconfirmed >= 1
          ? 'unconfirmed'
          : tally.refused >= 1
            ? 'refused'
            : null;
    if (outcome !== null) {
      next = { ...next, outcome, outcomeAt: now };
    }
  }
  // O efeito pode aparecer antes da resposta (esteira que demora a responder), mas não depois
  // do prazo dela.
  if (next.outcome === 'refused' || next.effectAt !== null || effectExpired(next, now)) {
    return next;
  }
  if (context.emergency) {
    return { ...next, interrupted: true };
  }
  return context.effect ? { ...next, effectAt: now } : next;
}

/**
 * Só conclui quando a esteira aceitou um Iniciar pedido com a lona parada e a lona andou dentro
 * do prazo. Sem resposta da esteira, fica "sem confirmação", com o que a lona fez. A lona que
 * anda depois do prazo pode ter sido iniciada pelo painel, e não conta.
 */
function startCandidate(session: TreadmillSnapshot, facts: CommandFacts, now: number): CheckRecord {
  if (facts.base === null) {
    return facts.misplaced ? waiting(START_MISPLACED_DETAIL) : PENDING;
  }
  if (facts.outcome === null) {
    return PENDING;
  }
  const expired = effectExpired(facts, now);
  switch (facts.outcome) {
    case 'refused': {
      const running = session.belt === 'running' && moving(session);
      return failed(running ? STARTED_BY_PANEL_DETAIL : START_FAILED_DETAIL);
    }
    case 'accepted':
      if (facts.effectAt !== null) {
        return done(START_DONE_DETAIL);
      }
      return expired ? failed(START_NO_MOVEMENT_DETAIL) : waiting(START_WAITING_DETAIL);
    case 'unconfirmed':
      if (facts.effectAt !== null) {
        return unconfirmed(START_UNCONFIRMED_MOVED_DETAIL);
      }
      return unconfirmed(expired ? START_UNCONFIRMED_STILL_DETAIL : START_UNCONFIRMED_DETAIL);
  }
}

function speedCandidate(session: TreadmillSnapshot, reachedKmh: number | null): CheckRecord {
  const tally = session.commands.speed;
  if (tally.accepted >= 1) {
    return done(reachedKmh !== null ? speedReachedDetail(reachedKmh) : 'A esteira aceitou o ajuste.');
  }
  if (tally.refused >= 1) {
    return failed(SPEED_REFUSED_DETAIL);
  }
  if (tally.unconfirmed >= 1) {
    return unconfirmed(SPEED_UNCONFIRMED_DETAIL);
  }
  return PENDING;
}

function subtractTally(a: CommandTally, b: CommandTally): CommandTally {
  return {
    requested: Math.max(a.requested - b.requested, 0),
    accepted: Math.max(a.accepted - b.accepted, 0),
    refused: Math.max(a.refused - b.refused, 0),
    unconfirmed: Math.max(a.unconfirmed - b.unconfirmed, 0),
  };
}

/**
 * O que o app viu de um Parar pedido com a lona girando livre. `done` aqui quer dizer só isso: a
 * esteira aceitou, a velocidade medida ficou em zero dentro do prazo e não houve aviso de parada
 * de emergência antes. Quem parou a lona, o app não tem como saber; por isso a verificação só
 * conclui com a resposta do usuário (`resolveStop`).
 */
function stopCandidate(facts: CommandFacts, now: number): CheckRecord {
  if (facts.base === null) {
    return facts.misplaced ? waiting(STOP_MISPLACED_DETAIL) : PENDING;
  }
  if (facts.interrupted) {
    return facts.outcome === 'unconfirmed'
      ? unconfirmed(STOP_UNCONFIRMED_EMERGENCY_DETAIL)
      : waiting(STOP_INTERRUPTED_DETAIL);
  }
  if (facts.outcome === null) {
    return PENDING;
  }
  const expired = effectExpired(facts, now);
  switch (facts.outcome) {
    case 'refused':
      return failed(STOP_REFUSED_DETAIL);
    case 'accepted':
      if (facts.effectAt !== null) {
        return done(STOP_DONE_DETAIL);
      }
      return expired ? failed(STOP_NOT_SEEN_DETAIL) : waiting(STOP_WAITING_DETAIL);
    case 'unconfirmed':
      if (facts.effectAt !== null) {
        return unconfirmed(STOP_UNCONFIRMED_STOPPED_DETAIL);
      }
      return unconfirmed(expired ? STOP_UNCONFIRMED_MOVING_DETAIL : STOP_UNCONFIRMED_DETAIL);
  }
}

/** O desfecho que cada resposta do usuário dá à verificação do Parar. */
export const STOP_ANSWER_DETAILS: Record<StopAnswer, string> = {
  alone: STOP_DONE_DETAIL,
  helped: STOP_HELPED_DETAIL,
  notStopped: STOP_NOT_STOPPED_DETAIL,
};

export function stopRecordFor(answer: StopAnswer): CheckRecord {
  return answer === 'alone' ? done(STOP_DONE_DETAIL) : failed(STOP_ANSWER_DETAILS[answer]);
}

/**
 * A verificação do Parar a partir do que o app viu e do que o usuário respondeu. Devolve também
 * se ela passa a esperar a resposta.
 */
function resolveStop(state: GuideState, observed: CheckRecord): { stop: CheckRecord; awaiting: boolean } {
  if (state.stop.outcome === 'done') {
    return { stop: state.stop, awaiting: false };
  }
  if (observed.outcome !== 'done') {
    return { stop: nextRecord(state.stop, observed), awaiting: state.stopAwaitingAnswer };
  }
  if (state.stopAnswer === 'helped' || state.stopAnswer === 'notStopped') {
    return { stop: failed(STOP_ANSWER_DETAILS[state.stopAnswer]), awaiting: false };
  }
  // Uma tentativa nova, posta à prova e vista pelo app, vale mais que o desfecho da anterior.
  const asking = waiting(STOP_CONFIRM_DETAIL);
  return { stop: sameRecord(state.stop, asking) ? state.stop : asking, awaiting: true };
}

/** A velocidade medida chegou ao alvo (meio passo de 0,1 km/h de tolerância). */
function reachedTarget(session: TreadmillSnapshot): number | null {
  const { speedKmh } = session.metrics;
  const target = session.targetSpeedKmh;
  if (speedKmh === null || target === null || !isBeltMoving(speedKmh)) {
    return null;
  }
  return Math.abs(speedKmh - target) < 0.05 ? speedKmh : null;
}

/** A sessão com a contagem de comandos a partir do início do roteiro. */
function sinceGuideStart(
  session: TreadmillSnapshot,
  base: Record<CommandKind, CommandTally> | null,
): TreadmillSnapshot {
  if (base === null) {
    return session;
  }
  const commands = { ...session.commands };
  for (const kind of Object.keys(commands) as CommandKind[]) {
    commands[kind] = subtractTally(session.commands[kind], base[kind]);
  }
  return { ...session, commands };
}

/** Contagem de comandos da conexão atual, para `GuideState.commandBase` ao começar o roteiro. */
export function commandBaseFor(session: TreadmillSnapshot): Record<CommandKind, CommandTally> | null {
  return session.phase === 'connected' ? session.commands : null;
}

/**
 * Acompanha os Parar e Pausar pedidos pelo app. O pedido conta na hora do toque, antes de a
 * esteira responder: a lona que para em seguida parou (ou pode ter parado) por ele, não pelo
 * Emergency Stop.
 */
function trackBrakes(
  state: GuideState,
  session: TreadmillSnapshot,
  connected: boolean,
  now: number,
): Partial<GuideState> | null {
  if (!connected) {
    return state.brakeRequests === null && state.lastBrakeAt === null
      ? null
      : { brakeRequests: null, brakeRefusals: 0, lastBrakeAt: null };
  }
  const { stop, pause } = session.commands;
  const requests = stop.requested + pause.requested;
  const refusals = stop.refused + pause.refused;
  if (state.brakeRequests === null) {
    return { brakeRequests: requests, brakeRefusals: refusals };
  }
  let patch: Partial<GuideState> | null = null;
  if (requests > state.brakeRequests) {
    patch = { brakeRequests: requests, lastBrakeAt: now, emergencyWatch: 'waitStill' };
  }
  if (refusals > state.brakeRefusals) {
    // Recusado, o comando não freia a lona.
    patch = { ...patch, brakeRefusals: refusals, lastBrakeAt: null };
  }
  if (patch === null && state.lastBrakeAt !== null && still(session)) {
    // A lona parou: o freio do app já fez o que tinha de fazer.
    patch = { lastBrakeAt: null };
  }
  return patch;
}

/** Um Parar ou Pausar do app ainda pode estar freando a lona. */
function recentAppBrake(state: GuideState, now: number): boolean {
  return state.lastBrakeAt !== null && now - state.lastBrakeAt < EFFECT_WINDOW_MS;
}

/**
 * Tempo em zero que faz a lona valer como parada: mais que o intervalo entre duas leituras,
 * para uma leitura solta de 0 km/h ser desmentida pela seguinte antes de contar.
 */
function stillHoldMs(state: GuideState): number {
  const interval = state.readingIntervalMs ?? 0;
  return Math.min(Math.max(STILL_HOLD_MS, interval * 1.5), STILL_HOLD_MAX_MS);
}

/** A velocidade medida está em zero há tempo bastante para a lona valer como parada. */
function settledStill(state: GuideState, now: number): boolean {
  return state.zeroSince !== null && now - state.zeroSince >= stillHoldMs(state);
}

/** Guarda o detalhe de uma tentativa que não deu certo, antes de outra tomar o lugar dela. */
function archiveAttempt(state: GuideState, id: CommandCheckId, record: CheckRecord): Partial<GuideState> | null {
  if ((record.outcome !== 'failed' && record.outcome !== 'unconfirmed') || record.detail === null) {
    return null;
  }
  return { earlier: { ...state.earlier, [id]: [...state.earlier[id], record.detail] } };
}

/**
 * Um passo da vigia do Emergency Stop. Só conclui sozinha num caso: a lona girava livre (sem
 * Parar ou Pausar do app, sem aviso de parada da esteira), a esteira avisou a parada de
 * emergência e, sem mais nada no meio, a velocidade medida foi a zero. Lona que para sem esse
 * aviso (o Stop do painel faz isso), aviso que chega com a lona já freando ou parada e conexão
 * que termina viram uma observação, e a resposta fica com o usuário.
 */
function emergencyStep(
  state: GuideState,
  session: TreadmillSnapshot,
  connected: boolean,
  now: number,
): Partial<GuideState> | null {
  const beltStill = connected && still(session);
  const settled = connected && settledStill(state, now);
  const spinning = connected && moving(session) && session.belt === 'running';
  const reported = connected && session.belt === 'safetyKey';
  switch (state.emergencyWatch) {
    case 'waitStill':
      if (beltStill) {
        return { emergencyWatch: 'waitSpin' };
      }
      if (spinning && !recentAppBrake(state, now)) {
        return { emergencyWatch: 'spinning', emergencyObservation: null };
      }
      break;
    case 'waitSpin':
      if (spinning) {
        return { emergencyWatch: 'spinning', emergencyObservation: null };
      }
      break;
    case 'spinning':
      if (!connected) {
        return { emergencyWatch: 'waitStill', emergencyObservation: 'link' };
      }
      if (reported) {
        if (settled) {
          return { emergencyStop: 'stopped', emergencyCause: 'safetyKey', emergencyObservation: null };
        }
        // Se a velocidade já caía antes do aviso, outra coisa freava a lona (o painel, numa
        // esteira que não avisa a parada dele): o aviso fica só como observação.
        return {
          emergencyWatch: state.speedDropping ? 'otherBraking' : 'emergencyBraking',
          emergencyObservation: 'safetyKey',
        };
      }
      if (beltStill) {
        return { emergencyWatch: 'waitSpin', emergencyObservation: 'belt' };
      }
      if (session.belt !== 'running') {
        // A esteira avisou uma parada que não é a de emergência: o Stop ou o Pause do painel.
        return { emergencyWatch: 'otherBraking' };
      }
      break;
    case 'emergencyBraking':
      if (reported && settled) {
        return { emergencyStop: 'stopped', emergencyCause: 'safetyKey', emergencyObservation: null };
      }
      if (!reported) {
        // A conexão terminou, ou a esteira já diz outra coisa: fica a observação do aviso.
        return { emergencyWatch: 'waitStill' };
      }
      break;
    case 'otherBraking':
      if (!connected) {
        return { emergencyWatch: 'waitStill', emergencyObservation: state.emergencyObservation ?? 'link' };
      }
      if (beltStill) {
        return { emergencyWatch: 'waitSpin', emergencyObservation: state.emergencyObservation ?? 'belt' };
      }
      if (spinning) {
        return { emergencyWatch: 'spinning', emergencyObservation: null };
      }
      break;
  }
  // O aviso que não chegou com a lona girando livre não prova que foi o Emergency Stop que a
  // parou: fica como observação.
  const current = state.emergencyObservation;
  if (!reported || current === 'safetyKey') {
    return null;
  }
  if (state.emergencyReport === 'moving') {
    // A lona girava (freando por outro motivo, talvez): a resposta é do usuário.
    return { emergencyObservation: 'safetyKey' };
  }
  if (current === 'belt') {
    // A lona parou e o aviso veio logo depois: é a mesma parada, vista em duas partes.
    const justStopped = state.zeroSince !== null && now - state.zeroSince <= LATE_REPORT_MS;
    return justStopped ? { emergencyObservation: 'safetyKey' } : null;
  }
  // O botão foi acionado com a lona já parada: não há o que perguntar.
  return current === null ? { emergencyObservation: 'idle' } : null;
}

/**
 * Atualiza o que o roteiro guarda a partir do snapshot da sessão. Devolve o
 * mesmo objeto quando nada mudou. Fora do roteiro, não observa nada.
 */
export function observeSession(state: GuideState, rawSession: TreadmillSnapshot, now: number): GuideState {
  if (!state.active) {
    return state;
  }
  const connected = rawSession.phase === 'connected';
  let next = state;
  const apply = (patch: Partial<GuideState>) => {
    next = { ...next, ...patch };
  };
  if (!connected) {
    if (next.commandBase !== null) {
      apply({ commandBase: null });
    }
    if (
      next.startFacts !== NO_FACTS ||
      next.stopFacts !== NO_FACTS ||
      next.speedSampleAt !== null ||
      next.zeroSince !== null ||
      next.emergencyReport !== null
    ) {
      apply({
        emergencyReport: null,
        startFacts: NO_FACTS,
        stopFacts: NO_FACTS,
        speedSampleAt: null,
        speedSampleKmh: null,
        speedSampleTime: null,
        speedDropping: false,
        zeroSince: null,
      });
    }
  }
  const session = sinceGuideStart(rawSession, next.commandBase);

  if (connected) {
    const dataOnly = session.control === 'unavailable';
    if (dataOnly !== next.dataOnly) {
      apply({ dataOnly });
    }

    const { speedKmh, updatedAt } = session.metrics;
    // Um registro dividido em duas notificações traz a velocidade só numa delas, e as duas
    // podem chegar no mesmo milissegundo: é leitura nova o que muda a velocidade, ou o que
    // chega depois do intervalo de um registro.
    const speedChanged = speedKmh !== next.speedSampleKmh;
    if (speedChanged || updatedAt !== next.speedSampleAt) {
      const otherHalf =
        !speedChanged && next.speedSampleTime !== null && now - next.speedSampleTime < SAME_READING_MS;
      if (otherHalf) {
        apply({ speedSampleAt: updatedAt });
      } else {
        const previous = next.speedSampleKmh;
        apply({
          speedSampleAt: updatedAt,
          speedSampleKmh: speedKmh,
          speedSampleTime: now,
          readingIntervalMs: next.speedSampleTime === null ? null : now - next.speedSampleTime,
          speedDropping:
            previous !== null && speedKmh !== null && previous - speedKmh >= BRAKING_DROP_KMH,
        });
      }
    }
    const beltMoving = moving(session);
    const beltStill = still(session);
    // O aviso chega numa atualização só dele: a velocidade ainda é a de antes do botão.
    const reported = session.belt === 'safetyKey';
    if (reported !== (next.emergencyReport !== null)) {
      apply({ emergencyReport: reported ? (beltMoving ? 'moving' : 'still') : null });
    }
    if (beltStill !== (next.zeroSince !== null)) {
      apply({ zeroSince: beltStill ? now : null });
    }

    const startFacts = factsFor(
      next.startFacts,
      session.commands.start,
      { testable: !beltMoving, unchanged: !beltMoving, effect: beltMoving, emergency: false },
      now,
    );
    if (startFacts !== next.startFacts) {
      if (startFacts.requestedAt !== null && startFacts.requestedAt !== next.startFacts.requestedAt) {
        // A tentativa nova começa do zero; o que a anterior teve de errado fica guardado.
        const archived = archiveAttempt(next, 'start', next.start);
        if (archived) {
          apply({ ...archived, start: PENDING });
        }
      }
      apply({ startFacts });
    }
    const stopFacts = factsFor(
      next.stopFacts,
      session.commands.stop,
      {
        // Girando livre: a esteira não avisou parada e nenhum Parar ou Pausar do app pode estar
        // freando.
        testable: beltMoving && session.belt === 'running' && !recentAppBrake(next, now),
        unchanged: beltMoving,
        effect: settledStill(next, now),
        emergency: session.belt === 'safetyKey' && !beltStill,
      },
      now,
    );
    if (stopFacts !== next.stopFacts) {
      // Um novo Parar posto à prova vale no lugar do anterior, e da resposta dada a ele; o que
      // o anterior teve de errado fica guardado.
      if (
        stopFacts.requestedAt !== null &&
        stopFacts.requestedAt !== next.stopFacts.requestedAt &&
        next.stop.outcome !== 'done'
      ) {
        const archived = archiveAttempt(next, 'stop', next.stop);
        if (archived) {
          apply({ ...archived, stop: PENDING });
        }
        apply({ stopAwaitingAnswer: false, stopAnswer: null });
      }
      apply({ stopFacts });
    }

    if (next.speedReachedKmh === null && session.commands.speed.accepted >= 1) {
      const reached = reachedTarget(session);
      if (reached !== null) {
        apply({ speedReachedKmh: reached });
      }
    }

    const start = nextRecord(next.start, startCandidate(session, next.startFacts, now));
    if (start !== next.start) {
      apply({ start });
    }
    const speedCand = speedCandidate(session, next.speedReachedKmh);
    // O detalhe do ajuste aceito ganha a velocidade alcançada mesmo depois de travado.
    const speed =
      next.speed.outcome === 'done' && next.speedReachedKmh !== null
        ? { outcome: 'done' as const, detail: speedReachedDetail(next.speedReachedKmh) }
        : nextRecord(next.speed, speedCand);
    if (!sameRecord(speed, next.speed)) {
      if (speed.outcome === 'done') {
        const archived = archiveAttempt(next, 'speed', next.speed);
        if (archived) {
          apply(archived);
        }
      }
      apply({ speed });
    }
    const { stop, awaiting } = resolveStop(next, stopCandidate(next.stopFacts, now));
    if (stop !== next.stop || awaiting !== next.stopAwaitingAnswer) {
      apply({ stop, stopAwaitingAnswer: awaiting });
    }
  }

  const brakes = trackBrakes(next, session, connected, now);
  if (brakes) {
    apply(brakes);
  }
  // Um passo pode abrir caminho para o seguinte na mesma observação (a lona parada leva a
  // `waitSpin`, e só então o aviso de emergência que já estava lá vira pergunta).
  for (let step = 0; step < 3 && next.stop.outcome !== 'pending' && next.emergencyStop === 'pending'; step++) {
    const patch = emergencyStep(next, session, connected, now);
    if (!patch) {
      break;
    }
    apply(patch);
  }

  return next;
}

/**
 * O próximo instante em que o tempo, sozinho, muda o roteiro (um prazo vence), para quem o
 * hospeda agendar uma nova observação; `null` se nenhum prazo está correndo. Só devolve
 * instantes depois de `now`: um prazo já vencido não muda mais nada.
 */
export function nextGuideDeadline(state: GuideState, now: number): number | null {
  if (!state.active) {
    return null;
  }
  const deadlines: number[] = [];
  let awaitingEffect = false;
  for (const facts of [state.startFacts, state.stopFacts]) {
    // Só a tentativa que ainda espera o efeito do comando tem prazo correndo.
    if (
      facts.outcomeAt !== null &&
      facts.outcome !== 'refused' &&
      facts.effectAt === null &&
      !facts.interrupted &&
      !effectExpired(facts, now)
    ) {
      deadlines.push(facts.outcomeAt + EFFECT_WINDOW_MS + 1);
      awaitingEffect = true;
    }
  }
  const awaitingResponse = state.stopFacts.base !== null && state.stopFacts.outcome === null;
  if (state.zeroSince !== null && (awaitingEffect || awaitingResponse || state.emergencyStop === 'pending')) {
    // A lona só vale como parada depois de um tempo em zero, venha ou não outra leitura.
    deadlines.push(state.zeroSince + stillHoldMs(state));
  }
  if (state.lastBrakeAt !== null) {
    // Passado o prazo, a lona que ainda gira já não está freando por causa do app.
    deadlines.push(state.lastBrakeAt + EFFECT_WINDOW_MS);
  }
  const upcoming = deadlines.filter((deadline) => deadline > now);
  return upcoming.length > 0 ? Math.min(...upcoming) : null;
}

// --- Snapshot -----------------------------------------------------------------

/** Todas as verificações têm desfecho, ou não há comandos a testar. */
export function commandsComplete(state: GuideState): boolean {
  return (
    state.dataOnly ||
    (state.start.outcome !== 'pending' &&
      state.speed.outcome !== 'pending' &&
      state.stop.outcome !== 'pending' &&
      state.emergencyStop !== 'pending')
  );
}

function stepDone(id: GuideStepId, state: GuideState, session: TreadmillSnapshot): boolean {
  const connected = session.phase === 'connected';
  // Com os comandos testados, a conexão não importa mais: o Emergency Stop pode
  // derrubá-la, e o registro se compartilha sem esteira.
  const complete = commandsComplete(state);
  switch (id) {
    case 'safety':
      return state.acknowledged.safety;
    case 'appMode':
      return state.acknowledged.appMode;
    case 'connect':
      return connected || complete;
    case 'identity':
      return (connected && session.identityConfirmed) || complete;
    case 'commands':
      return complete;
    case 'share':
      return state.shared;
  }
}

function recordState(record: CheckRecord): GuideCheckState {
  return record.outcome === 'pending' ? 'pending' : record.outcome;
}

function emergencyCheck(state: GuideState): { state: GuideCheckState; detail: string | null } {
  if (state.emergencyStop === 'notStopped') {
    return { state: 'failed', detail: NOT_STOPPED_DETAIL };
  }
  if (state.emergencyStop === 'stopped') {
    return { state: 'done', detail: EMERGENCY_DONE_DETAILS[state.emergencyCause ?? 'manual'] };
  }
  if (state.stop.outcome === 'pending') {
    return { state: 'pending', detail: null };
  }
  // Pergunta ou orientação: o que o app viu vai no detalhe.
  if (state.emergencyObservation !== null) {
    return { state: 'pending', detail: EMERGENCY_OBSERVATION_DETAILS[state.emergencyObservation] };
  }
  return {
    state: 'pending',
    detail: state.emergencyWatch === 'spinning' ? EMERGENCY_SPINNING_DETAIL : null,
  };
}

/** A pergunta do Parar, enquanto o roteiro espera a resposta. */
function stopQuestion(state: GuideState): string | null {
  return state.active && state.stopAwaitingAnswer ? STOP_CONFIRM_DETAIL : null;
}

/** O que o app viu e precisa que o usuário confirme; `null` sem nada a perguntar. */
function emergencyQuestion(state: GuideState): string | null {
  if (
    !state.active ||
    state.emergencyStop !== 'pending' ||
    state.stop.outcome === 'pending' ||
    state.emergencyObservation === null ||
    state.emergencyObservation === 'idle'
  ) {
    return null;
  }
  return EMERGENCY_OBSERVATION_DETAILS[state.emergencyObservation];
}

function buildChecks(state: GuideState, isCurrentStep: boolean): GuideCheck[] {
  if (state.dataOnly) {
    return [];
  }
  const raw: Record<GuideCheckId, { state: GuideCheckState; detail: string | null }> = {
    start: { state: recordState(state.start), detail: state.start.detail },
    speed: { state: recordState(state.speed), detail: state.speed.detail },
    // Esperando a resposta do usuário, a pergunta vale mais que qualquer detalhe anterior.
    stop: state.stopAwaitingAnswer
      ? { state: 'pending', detail: STOP_CONFIRM_DETAIL }
      : { state: recordState(state.stop), detail: state.stop.detail },
    emergencyStop: emergencyCheck(state),
  };
  let currentMarked = !isCurrentStep;
  return CHECK_ORDER.map((id) => {
    let checkState = raw[id].state;
    if (!currentMarked && checkState === 'pending') {
      checkState = 'current';
      currentMarked = true;
    }
    return {
      id,
      label: CHECK_LABELS[id],
      state: checkState,
      detail: raw[id].detail,
      urgent: id === 'emergencyStop' && state.emergencyStop === 'notStopped',
      earlier: id === 'emergencyStop' ? NO_EARLIER : state.earlier[id],
    };
  });
}

function sameCheck(a: GuideCheck, b: GuideCheck): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.state === b.state &&
    a.detail === b.detail &&
    a.urgent === b.urgent &&
    a.earlier === b.earlier
  );
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameStep(a: GuideStep, b: GuideStep): boolean {
  return (
    a.id === b.id &&
    a.number === b.number &&
    a.title === b.title &&
    a.text === b.text &&
    a.warning === b.warning &&
    a.detail === b.detail &&
    a.state === b.state &&
    sameArray(a.checks, b.checks)
  );
}

function buildHint(
  state: GuideState,
  session: TreadmillSnapshot,
  currentStepId: GuideStepId | null,
  checks: GuideCheck[],
  now: number,
): string | null {
  if (!state.active) {
    return null;
  }
  // As perguntas valem em qualquer passo: se o Emergency Stop derrubou a conexão, o passo atual
  // volta ao 3, e a resposta continua fazendo falta.
  if (stopQuestion(state) !== null) {
    return STOP_QUESTION_HINT;
  }
  if (emergencyQuestion(state) !== null) {
    return EMERGENCY_QUESTION_HINT;
  }
  switch (currentStepId) {
    case null:
      return 'Encerre o roteiro quando quiser, na tela dele.';
    case 'safety':
      return 'Fique fora da lona, com o Emergency Stop ao alcance.';
    case 'appMode':
      return 'Segure a tecla ✓/BT por 5 segundos, até o modo APP.';
    case 'connect': {
      const progressed = checks.some((check) => check.state !== 'pending' && check.state !== 'current');
      return progressed
        ? 'A conexão caiu: conecte de novo na esteira.'
        : 'Toque em Procurar esteiras e conecte na do topo da lista.';
    }
    case 'identity':
      return 'Confira o painel e toque em É esta esteira.';
    case 'commands': {
      const current = checks.find((check) => check.state === 'current')?.id;
      switch (current) {
        case 'start':
          if (attemptRunning(state.startFacts, now)) {
            return 'Iniciar enviado: espere a lona andar, sem tocar no painel.';
          }
          return moving(session)
            ? 'Pare a lona e toque em Iniciar com ela parada.'
            : 'Toque em Iniciar.';
        case 'speed':
          if (moving(session)) {
            return 'Toque em +0,1 na velocidade.';
          }
          return state.start.outcome === 'failed'
            ? 'Inicie pelo botão verde do painel e toque em +0,1.'
            : 'Inicie a lona e toque em +0,1 na velocidade.';
        case 'stop':
          if (attemptRunning(state.stopFacts, now)) {
            return 'Parar enviado: espere a lona parar, sem tocar no painel.';
          }
          if (!moving(session)) {
            return session.belt === 'safetyKey'
              ? 'Libere o Emergency Stop, inicie a lona pelo painel e toque em Parar com ela girando.'
              : 'Inicie a lona e toque em Parar com ela girando.';
          }
          // Girando, mas freando (ou podendo estar): o toque agora não testaria o Parar.
          return session.belt === 'running' && !recentAppBrake(state, now)
            ? 'Toque em Parar.'
            : 'Espere a lona girar firme e toque em Parar.';
        case 'emergencyStop':
          if (state.emergencyObservation === 'idle') {
            return EMERGENCY_IDLE_HINT;
          }
          if (state.emergencyWatch === 'spinning') {
            return 'Aperte o botão vermelho Emergency Stop.';
          }
          // Lona ainda freando depois de um Parar ou Pausar do app.
          return state.emergencyWatch === 'waitStill' && moving(session)
            ? 'Espere a lona parar; se ela não parar, aperte o Emergency Stop.'
            : 'Toque em Iniciar de novo; com a lona girando, aperte o Emergency Stop.';
        default:
          return 'Teste os comandos pelo app.';
      }
    }
    case 'share':
      return 'Toque em Compartilhar registro, na tela do roteiro.';
  }
}

/**
 * Monta o snapshot do roteiro. Reaproveita de `previous` tudo o que não mudou
 * (passos, verificações e o próprio snapshot), para os seletores da interface.
 */
export function buildGuideSnapshot(
  state: GuideState,
  session: TreadmillSnapshot,
  previous: GuideSnapshot | null,
  now: number,
): GuideSnapshot {
  const done = GUIDE_STEPS.map((step) => stepDone(step.id, state, session));
  const currentIndex = done.indexOf(false);
  const currentStepId = currentIndex === -1 ? null : GUIDE_STEPS[currentIndex].id;

  const steps = GUIDE_STEPS.map((definition, index): GuideStep => {
    const stepState: GuideStepState = done[index]
      ? 'done'
      : index === currentIndex
        ? 'current'
        : 'pending';
    const isCommands = definition.id === 'commands';
    const checks = isCommands ? buildChecks(state, stepState === 'current') : [];
    const prevStep = previous?.steps[index];
    const reusedChecks =
      prevStep && checks.length === prevStep.checks.length
        ? checks.map((check, i) => (sameCheck(check, prevStep.checks[i]) ? prevStep.checks[i] : check))
        : checks;
    const step: GuideStep = {
      id: definition.id,
      number: index + 1,
      title: definition.title,
      text: definition.text,
      warning: definition.warning,
      detail: isCommands && state.dataOnly ? DATA_ONLY_DETAIL : null,
      state: stepState,
      checks: prevStep && sameArray(reusedChecks, prevStep.checks) ? prevStep.checks : reusedChecks,
    };
    return prevStep && sameStep(step, prevStep) ? prevStep : step;
  });

  const commandsStep = steps.find((step) => step.id === 'commands');
  const next: GuideSnapshot = {
    active: state.active,
    steps: previous && sameArray(steps, previous.steps) ? previous.steps : steps,
    currentStepId,
    currentStepNumber: currentIndex === -1 ? null : currentIndex + 1,
    hint: buildHint(state, session, currentStepId, commandsStep?.checks ?? [], now),
    panelCode: state.panelCode,
    bluetoothIndicator: state.bluetoothIndicator,
    stopQuestion: stopQuestion(state),
    stopAnswer: state.stopAnswer,
    emergencyStop: state.emergencyStop,
    emergencyCause: state.emergencyStop === 'pending' ? null : (state.emergencyCause ?? 'manual'),
    emergencyQuestion: emergencyQuestion(state),
    notes: state.notes,
    shared: state.shared,
    finished: currentIndex === -1,
  };

  if (
    previous &&
    (Object.keys(next) as (keyof GuideSnapshot)[]).every((key) => next[key] === previous[key])
  ) {
    return previous;
  }
  return next;
}

// --- Registro -----------------------------------------------------------------

const STEP_STATE_WORDS: Record<GuideStepState, string> = {
  done: 'feito',
  current: 'atual',
  pending: 'pendente',
};

export const CHECK_STATE_WORDS: Record<GuideCheckState, string> = {
  pending: 'pendente',
  current: 'agora',
  done: 'concluída',
  unconfirmed: 'sem confirmação',
  failed: 'falhou',
};

const CHECK_COMMAND: Record<Exclude<GuideCheckId, 'emergencyStop'>, keyof TreadmillSnapshot['commands']> = {
  start: 'start',
  speed: 'speed',
  stop: 'stop',
};

function formatTally(tally: CommandTally): string {
  return `pedidos ${tally.requested}, aceitos ${tally.accepted}, recusados ${tally.refused}, sem resposta ${tally.unconfirmed}`;
}

/** O que a sessão mostrava quando a verificação mudou, para reconstruir depois. */
function checkContext(id: GuideCheckId, session: TreadmillSnapshot): string {
  const speed = `velocidade ${formatDecimal(session.metrics.speedKmh, 1)} km/h`;
  const belt = `lona ${session.belt}, conexão ${session.phase}`;
  if (id === 'emergencyStop') {
    return `${belt}, ${speed}, Parar: ${formatTally(session.commands.stop)}; Pausar: ${formatTally(session.commands.pause)}`;
  }
  return `${formatTally(session.commands[CHECK_COMMAND[id]])}; ${belt}, ${speed}`;
}

/**
 * Linhas de registro para o que mudou de `previous` para `next`: estado dos
 * passos e das verificações e a frase da faixa. Com `previous` nulo, descreve
 * tudo o que não está pendente.
 */
export function describeGuideChanges(
  previous: GuideSnapshot | null,
  next: GuideSnapshot,
  session: TreadmillSnapshot,
): string[] {
  const lines: string[] = [];
  next.steps.forEach((step, index) => {
    const prevStep = previous?.steps[index];
    const prevState = prevStep?.state ?? 'pending';
    const prevDetail = prevStep?.detail ?? null;
    if (step.state !== prevState || step.detail !== prevDetail) {
      lines.push(
        `Passo ${step.number}, ${step.title}: ${STEP_STATE_WORDS[step.state]}` +
          (step.detail ? `. ${step.detail}` : ''),
      );
    }
    for (const check of step.checks) {
      const prevCheck = prevStep?.checks.find((c) => c.id === check.id);
      const prevCheckState = prevCheck?.state ?? 'pending';
      const prevCheckDetail = prevCheck?.detail ?? null;
      if (check.state !== prevCheckState || check.detail !== prevCheckDetail) {
        lines.push(
          `Verificação "${check.label}": ${CHECK_STATE_WORDS[check.state]}` +
            (check.detail ? `. ${check.detail}` : '') +
            ` (${checkContext(check.id, session)})`,
        );
      }
      for (const detail of check.earlier.slice(prevCheck?.earlier.length ?? 0)) {
        lines.push(`Verificação "${check.label}": tentativa anterior sem sucesso guardada. ${detail}`);
      }
    }
  });
  if (next.hint !== null && next.hint !== (previous?.hint ?? null)) {
    lines.push(`Faixa: ${next.hint}`);
  }
  return lines;
}

/** Resumo do roteiro em linhas de texto, para o registro ao encerrar. */
export function summarizeGuide(snapshot: GuideSnapshot): string[] {
  const lines = snapshot.steps.map(
    (step) =>
      `Passo ${step.number}, ${step.title}: ${STEP_STATE_WORDS[step.state]}` +
      (step.detail ? `. ${step.detail}` : ''),
  );
  for (const check of snapshot.steps.find((step) => step.id === 'commands')?.checks ?? []) {
    lines.push(
      `Verificação "${check.label}": ${CHECK_STATE_WORDS[check.state]}` +
        (check.detail ? `. ${check.detail}` : ''),
    );
    check.earlier.forEach((detail, index) => {
      lines.push(`Verificação "${check.label}", tentativa ${index + 1} sem sucesso: ${detail}`);
    });
  }
  lines.push(
    `Código do painel: ${snapshot.panelCode === '' ? 'não informado' : snapshot.panelCode}`,
    `Indicador Bluetooth acendeu: ${ANSWER_WORDS[snapshot.bluetoothIndicator ?? 'none']}`,
    `Parar, a lona parou sozinha: ${STOP_ANSWER_WORDS[snapshot.stopAnswer ?? 'none']}`,
    `Emergency Stop: ${emergencyResultWords(snapshot.emergencyStop, snapshot.emergencyCause)}`,
  );
  return lines;
}

export const ANSWER_WORDS: Record<BluetoothIndicatorAnswer | 'none', string> = {
  yes: 'sim',
  no: 'não',
  none: 'sem resposta',
};

export const STOP_ANSWER_WORDS: Record<StopAnswer | 'none', string> = {
  alone: 'sim',
  helped: 'não, você a parou',
  notStopped: 'não, a lona não parou',
  none: 'sem resposta',
};

export const EMERGENCY_WORDS: Record<EmergencyStopResult, string> = {
  pending: 'sem resposta',
  stopped: 'a lona parou',
  notStopped: 'a lona não parou',
};

const EMERGENCY_CAUSE_WORDS: Record<EmergencyStopCause, string> = {
  manual: 'resposta sua',
  safetyKey: 'aviso da esteira',
};

/** O resultado do Emergency Stop com a origem dele: quem disse que a lona parou. */
export function emergencyResultWords(
  result: EmergencyStopResult,
  cause: EmergencyStopCause | null,
): string {
  const words = EMERGENCY_WORDS[result];
  return result === 'pending' || cause === null ? words : `${words} (${EMERGENCY_CAUSE_WORDS[cause]})`;
}
