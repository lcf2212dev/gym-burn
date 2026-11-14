import type { BeltState } from '@/treadmill/types';

/**
 * "Copiloto": a sequência de instruções que o app dá sozinho depois de
 * conectar na esteira. O usuário não toca em nada no app: ele faz o que o
 * copiloto pede no painel da esteira e o app percebe pelos dados que chegam.
 *
 * A ordem é a de um treino curto de reconhecimento: começar a andar, subir e
 * descer a velocidade, subir e descer a inclinação, conferir os batimentos e
 * parar. Cada passo avança sozinho quando o app vê o efeito acontecer.
 *
 * O texto é sempre em linguagem de academia, sem nomes técnicos de protocolo.
 */

export const COPILOT_STEP_COUNT = 7;

export type CopilotStage =
  | 'waiting' // conectado, ainda sem dados da esteira
  | 'start' // pede para começar a andar
  | 'speedUp'
  | 'speedDown'
  | 'inclineUp'
  | 'inclineDown'
  | 'heartRate'
  | 'stop'
  | 'done';

export interface CopilotInput {
  belt: BeltState;
  speedKmh: number | null;
  /** Inclinação já corrigida para a escala física da T600X. */
  inclinePercent: number | null;
  heartRateBpm: number | null;
  /** `Date.now()` da última atualização dos dados da esteira. */
  updatedAt: number | null;
  now: number;
}

export interface CopilotState {
  stage: CopilotStage;
  /** Velocidade no momento em que o passo de velocidade começou. */
  baselineSpeed: number | null;
  /** Inclinação no momento em que o passo de inclinação começou. */
  baselineIncline: number | null;
  /** `Date.now()` em que o passo atual começou. */
  since: number;
  /** `Date.now()` em que o copiloto terminou. */
  doneAt: number | null;
  /** O passo dos batimentos foi pulado por falta de leitura. */
  heartRateSkipped: boolean;
}

/** Quanto o número precisa mudar para contar como "um passo" de velocidade/inclinação. */
const SPEED_STEP = 0.4;
const INCLINE_STEP = 0.4;

/** Sem dados por esse tempo, o app avisa que a esteira parou de responder. */
const DATA_STALE_MS = 6_000;

/** Quanto tempo a mensagem de conclusão fica na tela. */
const DONE_VISIBLE_MS = 12_000;

/** Se os batimentos não aparecerem, o copiloto segue sem travar o usuário. */
const HEART_RATE_TIMEOUT_MS = 30_000;

/** Sem leitura de inclinação, também não adianta travar. */
const INCLINE_TIMEOUT_MS = 25_000;

const STAGE_STEP: Partial<Record<CopilotStage, number>> = {
  start: 1,
  speedUp: 2,
  speedDown: 3,
  inclineUp: 4,
  inclineDown: 5,
  heartRate: 6,
  stop: 7,
};

const STAGE_MESSAGE: Partial<Record<CopilotStage, string>> = {
  start: 'Pode começar a andar no painel. Eu acompanho daqui.',
  speedUp: 'Aumente a velocidade no painel em um passo.',
  speedDown: 'Agora diminua a velocidade um pouco.',
  inclineUp: 'Aumente a inclinação no painel.',
  inclineDown: 'Diminua a inclinação de volta.',
  heartRate: 'Segure as alças com sensor até os batimentos aparecerem.',
  stop: 'Para terminar, pare a esteira no painel.',
};

export function createCopilot(now: number): CopilotState {
  return {
    stage: 'waiting',
    baselineSpeed: null,
    baselineIncline: null,
    since: now,
    doneAt: null,
    heartRateSkipped: false,
  };
}

/** Os dados chegaram nos últimos segundos? */
export function hasFreshData(input: CopilotInput): boolean {
  return input.updatedAt !== null && input.now - input.updatedAt <= DATA_STALE_MS;
}

function isStopped(input: CopilotInput): boolean {
  return input.belt !== 'running' && (input.speedKmh === null || input.speedKmh <= 0.2);
}

function restarted(state: CopilotState, input: CopilotInput): CopilotState {
  return {
    ...state,
    stage: 'start',
    baselineSpeed: null,
    baselineIncline: null,
    since: input.now,
  };
}

/**
 * Calcula o próximo estado. Devolve o mesmo objeto quando nada mudou, para a
 * interface não renderizar à toa.
 */
export function advanceCopilot(state: CopilotState, input: CopilotInput): CopilotState {
  // Sem dados frescos não dá para perceber o efeito de nada: só espera.
  if (!hasFreshData(input)) {
    return state;
  }

  switch (state.stage) {
    case 'waiting':
      return { ...state, stage: 'start', since: input.now };

    case 'start': {
      const speed = input.speedKmh;
      if (speed !== null && speed > 0.5) {
        return {
          ...state,
          stage: 'speedUp',
          baselineSpeed: speed,
          baselineIncline: input.inclinePercent,
          since: input.now,
        };
      }
      return state;
    }

    case 'speedUp': {
      if (isStopped(input)) {
        return restarted(state, input);
      }
      const speed = input.speedKmh;
      if (speed === null || state.baselineSpeed === null) {
        return state;
      }
      if (speed >= state.baselineSpeed + SPEED_STEP) {
        return {
          ...state,
          stage: 'speedDown',
          baselineSpeed: speed,
          baselineIncline: input.inclinePercent,
          since: input.now,
        };
      }
      return state;
    }

    case 'speedDown': {
      if (isStopped(input)) {
        return restarted(state, input);
      }
      const speed = input.speedKmh;
      if (speed === null || state.baselineSpeed === null) {
        return state;
      }
      if (speed <= state.baselineSpeed - SPEED_STEP) {
        return {
          ...state,
          stage: 'inclineUp',
          baselineIncline: input.inclinePercent,
          since: input.now,
        };
      }
      return state;
    }

    case 'inclineUp': {
      if (isStopped(input)) {
        return restarted(state, input);
      }
      const incline = input.inclinePercent;
      if (incline === null) {
        return input.now - state.since > INCLINE_TIMEOUT_MS
          ? { ...state, stage: 'heartRate', since: input.now }
          : state;
      }
      if (state.baselineIncline === null) {
        // Primeira leitura: ela vira a referência e o pedido continua valendo.
        return { ...state, baselineIncline: incline };
      }
      if (incline >= state.baselineIncline + INCLINE_STEP) {
        return {
          ...state,
          stage: 'inclineDown',
          baselineIncline: incline,
          since: input.now,
        };
      }
      return state;
    }

    case 'inclineDown': {
      if (isStopped(input)) {
        return restarted(state, input);
      }
      const incline = input.inclinePercent;
      if (incline === null) {
        return input.now - state.since > INCLINE_TIMEOUT_MS
          ? { ...state, stage: 'heartRate', since: input.now }
          : state;
      }
      if (state.baselineIncline === null) {
        return { ...state, baselineIncline: incline };
      }
      if (incline <= state.baselineIncline - INCLINE_STEP) {
        return { ...state, stage: 'heartRate', since: input.now };
      }
      return state;
    }

    case 'heartRate': {
      if (isStopped(input)) {
        return restarted(state, input);
      }
      const heartRate = input.heartRateBpm;
      if (heartRate !== null && heartRate > 0) {
        return { ...state, stage: 'stop', since: input.now };
      }
      if (input.now - state.since > HEART_RATE_TIMEOUT_MS) {
        return { ...state, stage: 'stop', since: input.now, heartRateSkipped: true };
      }
      return state;
    }

    case 'stop': {
      if (isStopped(input)) {
        return { ...state, stage: 'done', doneAt: input.now, since: input.now };
      }
      return state;
    }

    case 'done':
      return state;

    default:
      return state;
  }
}

export interface CopilotView {
  /** O que mostrar no topo da tela; `null` quando não há mais nada a pedir. */
  message: string | null;
  /** Passo atual (1 a 7); `null` enquanto espera dados ou depois de concluir. */
  step: number | null;
  tone: 'info' | 'waiting' | 'success';
}

/**
 * A mensagem do momento. Também cobre a esteira que parou de mandar dados:
 * nesse caso o pedido atual não faz sentido, e o app avisa em vez de mandar o
 * usuário fazer algo que não será percebido.
 */
export function copilotView(state: CopilotState, input: CopilotInput): CopilotView {
  if (state.stage === 'done') {
    const visible = state.doneAt === null || input.now - state.doneAt <= DONE_VISIBLE_MS;
    return {
      message: visible ? 'Tudo certo! Pode treinar — eu acompanho os números.' : null,
      step: null,
      tone: 'success',
    };
  }

  if (!hasFreshData(input)) {
    const staleFor = input.updatedAt === null ? null : input.now - input.updatedAt;
    // Muito tempo sem nada: além de conferir o painel, vale reabrir o app.
    const message =
      staleFor !== null && staleFor > 20_000
        ? 'Ainda não recebo os dados. Confira o modo APP no painel e, se não voltar, feche o app e abra de novo.'
        : 'Conectado! Ainda não recebo os dados da esteira. Confira se o painel está no modo APP.';
    return { message, step: null, tone: 'waiting' };
  }

  const message = STAGE_MESSAGE[state.stage] ?? null;
  return {
    message,
    step: STAGE_STEP[state.stage] ?? null,
    tone: 'info',
  };
}
