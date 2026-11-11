/**
 * Roteiro do primeiro teste na esteira real: seis passos que o dono segue
 * sozinho, com o celular na mão. O estado é derivado da sessão da esteira e
 * das respostas do usuário, e tudo o que muda vai para o registro.
 */

export type GuideStepId = 'safety' | 'appMode' | 'connect' | 'identity' | 'commands' | 'share';

export type GuideStepState = 'done' | 'current' | 'pending';

/** As verificações do passo 5, na ordem em que o usuário as faz. */
export type GuideCheckId = 'start' | 'speed' | 'stop' | 'emergencyStop';

/**
 * `current`: é a próxima a fazer ("agora"). `done`: a esteira aceitou o comando e o efeito
 * apareceu. `unconfirmed`: a esteira não respondeu ao comando (o detalhe diz se o efeito
 * apareceu mesmo assim). `failed`: a esteira recusou, ou aceitou e o efeito não apareceu.
 */
export type GuideCheckState = 'pending' | 'current' | 'done' | 'unconfirmed' | 'failed';

export interface GuideCheck {
  id: GuideCheckId;
  /** O que o usuário faz, por exemplo "Toque em Iniciar". */
  label: string;
  state: GuideCheckState;
  /** Uma linha sobre o que aconteceu; `null` enquanto não há nada a dizer. */
  detail: string | null;
  /** O detalhe é um alerta de segurança e precisa de destaque. */
  urgent: boolean;
  /**
   * O que aconteceu nas tentativas anteriores que não deram certo, da mais antiga para a mais
   * nova. Uma tentativa que funciona depois não apaga as que falharam: um Parar aceito que não
   * parou a lona continua no resumo.
   */
  earlier: readonly string[];
}

export interface GuideStep {
  id: GuideStepId;
  /** De 1 a 6. */
  number: number;
  title: string;
  /** A instrução do passo, para ler à distância de um braço. */
  text: string;
  /** Aviso complementar; `null` quando o passo não tem. */
  warning: string | null;
  /** Desfecho do passo quando ele foi concluído de um jeito especial; `null` em geral. */
  detail: string | null;
  state: GuideStepState;
  /** Só o passo 5 tem verificações; nos outros a lista é vazia. */
  checks: GuideCheck[];
}

export type BluetoothIndicatorAnswer = 'yes' | 'no';

export type EmergencyStopResult = 'pending' | 'stopped' | 'notStopped';

/**
 * Resposta a "a lona parou sozinha depois do Parar?": `alone`, sim; `helped`, o usuário a parou
 * pelo painel ou pelo Emergency Stop; `notStopped`, a lona não parou (a esteira informou
 * velocidade zero com ela girando).
 */
export type StopAnswer = 'alone' | 'helped' | 'notStopped';

/**
 * De onde veio o resultado do Emergency Stop: da resposta do usuário (`manual`) ou do aviso de
 * parada de emergência da própria esteira, com a velocidade medida em zero (`safetyKey`).
 */
export type EmergencyStopCause = 'manual' | 'safetyKey';

/** Passos concluídos com o toque em "Feito". */
export type AcknowledgedStep = 'safety' | 'appMode';

/** Campos de texto que só vão para o registro quando o usuário termina de digitar. */
export type GuideTextField = 'panelCode' | 'notes';

/**
 * Estado do roteiro. É imutável: cada mudança gera um objeto novo, e as partes
 * que não mudaram mantêm a mesma referência.
 */
export interface GuideSnapshot {
  /** O roteiro está em andamento. */
  active: boolean;
  steps: GuideStep[];
  /** Passo a fazer agora; `null` quando todos foram concluídos. */
  currentStepId: GuideStepId | null;
  /** Número do passo atual (1 a 6); `null` quando todos foram concluídos. */
  currentStepNumber: number | null;
  /** Frase curta do que fazer agora, para a faixa no topo das telas; `null` fora do roteiro. */
  hint: string | null;
  /** Código que apareceu no painel ao entrar no modo APP; vazio se o usuário não informou. */
  panelCode: string;
  /** Resposta a "O indicador Bluetooth do painel acendeu?". */
  bluetoothIndicator: BluetoothIndicatorAnswer | null;
  /**
   * O app viu a esteira aceitar o Parar e a lona parar, e precisa que o usuário diga se ela
   * parou sozinha; o texto é a pergunta. `null` sem nada a perguntar. Vale em qualquer passo.
   */
  stopQuestion: string | null;
  /** A resposta à pergunta do Parar; `null` se ainda não houve. */
  stopAnswer: StopAnswer | null;
  emergencyStop: EmergencyStopResult;
  /** Quem deu o resultado do Emergency Stop; `null` enquanto ele está pendente. */
  emergencyCause: EmergencyStopCause | null;
  /**
   * O app viu algo que pode ter sido o Emergency Stop (a lona parou, a esteira avisou, a conexão
   * terminou) e precisa da resposta do usuário; o texto diz o que foi visto. `null` sem nada a
   * perguntar. Vale em qualquer passo: o Emergency Stop pode derrubar a conexão.
   */
  emergencyQuestion: string | null;
  /** Observações livres do usuário. */
  notes: string;
  /** O usuário tocou em "Compartilhar registro". */
  shared: boolean;
  /** Todos os passos foram concluídos. */
  finished: boolean;
}

/** Ações do roteiro. Nenhuma chama ações da sessão da esteira. */
export interface GuideActions {
  /** Zera as respostas e começa o roteiro do passo 1. */
  start(): void;
  /** Encerra o roteiro e mantém as respostas. */
  stop(): void;
  acknowledge(step: AcknowledgedStep): void;
  /** Atualiza o campo; só vai para o registro em `commitText('panelCode')`. */
  setPanelCode(code: string): void;
  answerBluetoothIndicator(answer: BluetoothIndicatorAnswer): void;
  /**
   * Resposta a "a lona parou sozinha depois do Parar?". É ela que conclui a verificação do
   * Parar: o app vê a lona parar, mas não quem a parou. Sem pergunta pendente nem resposta
   * anterior a corrigir, não faz nada.
   */
  reportStop(answer: StopAnswer): void;
  /**
   * Resposta do usuário a "a lona parou?"; vale mais que o aviso da esteira. É o único jeito de
   * concluir a verificação quando a esteira não avisa a parada de emergência.
   */
  reportEmergencyStop(result: Exclude<EmergencyStopResult, 'pending'>): void;
  /** Atualiza o campo; só vai para o registro em `commitText('notes')`. */
  setNotes(text: string): void;
  /** O usuário saiu do campo: o valor atual vai para o registro, se mudou. */
  commitText(field: GuideTextField): void;
  /** O usuário tocou em "Compartilhar registro"; grava as observações antes. */
  markShared(): void;
  /**
   * O usuário compartilhou o registro com o roteiro ainda no meio (travou num passo, por
   * exemplo). Vai para o registro, mas não conclui o passo 6.
   */
  noteEarlyShare(): void;
}
