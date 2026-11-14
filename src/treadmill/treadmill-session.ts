import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
  ServiceInfo,
} from '@/ble/transport';
import {
  ControlPointOp,
  ControlPointResult,
  DEVICE_INFORMATION_FIELDS,
  DEVICE_INFORMATION_SERVICE,
  FTMS,
  bytesToHex,
  hexToBytes,
  controlPointOpName,
  controlPointResultName,
  decodeDeviceInformationText,
  encodePause,
  encodeRequestControl,
  encodeSetTargetInclination,
  encodeSetTargetSpeed,
  encodeStartOrResume,
  encodeStop,
  encodeVendorControlOpcode,
  isVendorControlOpcode,
  parseControlPointResponse,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedInclinationRange,
  parseSupportedSpeedRange,
  parseTrainingStatus,
  parseTreadmillData,
  sameUuid,
  shortUuid,
  uuid16,
  vendorControlOpcodeInfo,
  type FitnessMachineFeature,
  type VendorControlOpCode,
  type SupportedRange,
} from '@/ftms';
import {
  GIZWITS_COMMANDS,
  GIZWITS_LINGO,
  GIZWITS_MACHINE_INFO_REQUEST,
  encodeGizwitsFrame,
  encodeGizwitsPause,
  encodeGizwitsSetIncline,
  encodeGizwitsSetSpeed,
  encodeGizwitsStartWorkout,
  encodeGizwitsStop,
  gizwitsCommandName,
  parseGizwitsFrame,
} from '@/gizwits/frame';
import { VENDOR_DISCOVERY_CANDIDATES, type VendorDiscoveryCandidate } from '@/vendor/discovery';
import { formatDecimal } from '@/utils/format';
import type { VendorMappingStorage } from '@/vendor/mapping-storage';
import { buildLiteralPayload, buildVendorPayload } from '@/vendor/payload';
import {
  emptyVendorState,
  VENDOR_ACTION_LABELS,
  type VendorAction,
  type VendorDiscoveryObservation,
  type VendorMapping,
  type VendorTarget,
} from '@/vendor/types';

import {
  plausibleInclinationRange,
  T600X_INCLINATION_RANGE,
  T600X_INCLINATION_READING_FACTOR,
  T600X_SPEED_RANGE,
} from './t600x';
import type { TreadmillStore } from './treadmill-context';
import type {
  BeltState,
  CommandKind,
  CommandTally,
  LogEntry,
  Notice,
  ProbeApi,
  RangeInfo,
  SessionMode,
  TreadmillActions,
  TraceLine,
  TraceSink,
  TreadmillCapabilities,
  TreadmillMetrics,
  TreadmillSnapshot,
  GizwitsAttempt,
  GizwitsProbeSnapshot,
  VendorOpcodeProbe,
} from './types';

/**
 * Quanto esperar por uma característica do Device Information antes de desistir
 * das demais. Elas só alimentam o registro. Vale para o JavaScript; a fila do
 * rádio no Android segue presa até o aparelho responder (veja `logDeviceInformation`).
 */
const DEVICE_INFORMATION_READ_TIMEOUT_MS = 2000;

// Serviço proprietário do fabricante (o FTMS desta esteira é somente leitura para
// velocidade/inclinação; o 0xFFF0 é a única porta conhecida para comandos).
const VENDOR_SERVICE = uuid16(0xfff0);
const VENDOR_CHANNELS = {
  fff1: uuid16(0xfff1),
  fff2: uuid16(0xfff2),
  fff3: uuid16(0xfff3),
  fff4: uuid16(0xfff4),
  fff5: uuid16(0xfff5),
} as const;
// Varredura da Sonda: o perfil de demonstração da TI notifica até ~5 s depois da
// escrita, então a janela de observação é larga e o próximo byte espera mais um pouco.
const VENDOR_DISCOVERY_SETTLE_MS = 6000;
const VENDOR_DISCOVERY_PAUSE_MS = 800;
const VENDOR_DISCOVERY_READ_TIMEOUT_MS = 1500;

// Teste automático do protocolo Gizwits (AFG Pro) no 0xFFF0: pede machine info e
// espera uma notificação no FFF4. Janela curta; a resposta vem em <1 s quando vem.
const GIZWITS_PROBE_POLL_MS = 100;
const GIZWITS_PROBE_REPLY_LIMIT = 512;

// Constante compartilhada: resetar para o mesmo objeto não dispara update (o que
// manteria a lista de mudanças do modo de conexão idêntica à de antes).
const EMPTY_GIZWITS_PROBE: GizwitsProbeSnapshot = {
  status: 'idle',
  stage: null,
  startedAt: null,
  finishedAt: null,
  replyHex: null,
  replyBytes: 0,
  replyCommand: null,
  compatible: null,
  attempts: [],
  hint: null,
  detail: null,
};

type GizwitsTarget = 'fff3' | 'fff1';
type GizwitsVariant = {
  name: string;
  label: string;
  target: GizwitsTarget;
  frame: Uint8Array;
  timeoutMs: number;
};
type GizwitsSafeStep = {
  name: string;
  label: string;
  frame: Uint8Array;
  timeoutMs: number;
};

function reverseSync(frame: Uint8Array): Uint8Array {
  const copy = frame.slice();
  copy[0] = 0xaa;
  copy[1] = 0x55;
  return copy;
}

/** Aceita 55 AA e também AA 55 (variante testada contra o módulo). */
function looksLikeGizwitsFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 10 &&
    ((bytes[0] === 0x55 && bytes[1] === 0xaa) || (bytes[0] === 0xaa && bytes[1] === 0x55))
  );
}

function reverseCrc(frame: Uint8Array): Uint8Array {
  const copy = frame.slice();
  const low = copy[8];
  copy[8] = copy[9];
  copy[9] = low;
  return copy;
}



function vendorTargetUuid(target: VendorTarget): string {
  return target === 'fff1' ? VENDOR_CHANNELS.fff1 : VENDOR_CHANNELS.fff3;
}

// Espera da varredura, separada de `sleep()` para não acordar o motor de comandos do FTMS.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandKindOfVendorAction(action: VendorAction): CommandKind {
  switch (action) {
    case 'start':
      return 'start';
    case 'pause':
      return 'pause';
    case 'stop':
      return 'stop';
    case 'speedUp':
    case 'speedDown':
      return 'speed';
    case 'inclineUp':
    case 'inclineDown':
      return 'inclination';
  }
}

/** `promise` com prazo; a promessa que perde a corrida é abandonada. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Sem armazenamento injetado, o mapeamento do 0xFFF0 fica só na memória. */
const NO_VENDOR_STORAGE: VendorMappingStorage = {
  load: async () => null,
  save: async () => undefined,
};

class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`sem resposta em ${ms} ms`);
    this.name = 'ReadTimeoutError';
  }
}

/** `connection.read` com prazo; a leitura que perde a corrida é ignorada. */
async function readWithTimeout(
  connection: BleConnection,
  serviceUuid: string,
  characteristicUuid: string,
  ms: number,
): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([connection.read(serviceUuid, characteristicUuid), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface TreadmillSessionOptions {
  /** O rádio de verdade. */
  ble: BleTransport;
  /** A esteira simulada do modo demonstração. */
  demo: { transport: BleTransport; deviceId: string };
  /**
   * Espera máxima pela indication de resposta do Control Point. A especificação
   * fixa o teto em 30 s (FTMP 1.0, seção 4.4.14.3); esteiras respondem em bem
   * menos de 1 s, então 10 s já cobre uma contagem regressiva de partida.
   */
  responseTimeoutMs?: number;
  /** Espera pela indication depois que a esteira já deixou um comando sem resposta. */
  unconfirmedGraceMs?: number;
  /** A busca para sozinha depois deste tempo, para não gastar bateria. */
  scanTimeoutMs?: number;
  /** Pausa antes de repetir um Request Control cuja escrita falhou. */
  controlRetryDelayMs?: number;
  /** Pausa antes de repetir um Stop que a esteira ainda não aceitou. */
  stopRetryDelayMs?: number;
  /** Por quanto tempo, a partir do toque, o app insiste num Stop que a esteira não aceita. */
  stopDeadlineMs?: number;
  /** Prazo para a esteira confirmar o recebimento de uma escrita no Control Point. */
  writeTimeoutMs?: number;
  /** Depois de um Pausar ou Parar, o tempo mínimo em que um Iniciar é ignorado (toque duplo). */
  startLockoutMs?: number;
  /** Tempo com a lona parada antes de liberar o Iniciar de novo. */
  startSettleMs?: number;
  /** Teto do bloqueio do Iniciar, para uma esteira cuja velocidade medida nunca chega a zero. */
  startMaxLockoutMs?: number;
  /** Por quanto tempo um alvo de velocidade recém-definido é aceito sem outro indício. */
  targetTrustMs?: number;
  /**
   * Quanto um Parar espera a resposta do comando em andamento antes de passar
   * por cima dele. Uma esteira que responde no tempo normal (dezenas de ms)
   * termina antes disso, e o Parar sai sem disputar o Control Point.
   */
  stopPreemptDelayMs?: number;
  maxLogEntries?: number;
  /**
   * Recebe o registro completo da sessão (todos os pacotes, mudanças de estado
   * e ações), para gravar em arquivo. Uma falha aqui nunca interrompe a sessão.
   */
  trace?: TraceSink;
  now?: () => number;
  /**
   * Onde o mapeamento do controle experimental (0xFFF0) é guardado. Sem isso, o
   * mapeamento vale só durante a execução atual.
   */
  vendorStorage?: VendorMappingStorage;
}

type BeltCommand = 'start' | 'pause';

type Command =
  | { kind: 'belt'; action: BeltCommand }
  | { kind: 'speed'; kmh: number }
  | { kind: 'inclination'; percent: number }
  | { kind: 'stop' };

/** Os comandos que esperam a vez; o Parar tem caminho próprio. */
type QueuedCommand = Exclude<Command, { kind: 'stop' }>;

type ProcedureOutcome =
  | { type: 'result'; resultCode: number; parameter: Uint8Array }
  | { type: 'writeError'; error: Error }
  | { type: 'timeout' }
  // Um Parar passou na frente e não esperou esta resposta.
  | { type: 'preempted' }
  | { type: 'linkLost' };

type ControlOutcome =
  | { status: 'granted' }
  | { status: 'preempted' }
  | { status: 'linkLost' }
  | { status: 'writeFailed'; error: Error }
  | { status: 'refused'; resultCode: number };

const NO_TALLY: CommandTally = { requested: 0, accepted: 0, refused: 0, unconfirmed: 0 };
const NO_COMMANDS: Record<CommandKind, CommandTally> = {
  start: NO_TALLY,
  pause: NO_TALLY,
  stop: NO_TALLY,
  speed: NO_TALLY,
  inclination: NO_TALLY,
};

const EMPTY_METRICS: TreadmillMetrics = {
  speedKmh: null,
  averageSpeedKmh: null,
  inclinationPercent: null,
  rampAngleDeg: null,
  distanceM: null,
  elapsedTimeS: null,
  remainingTimeS: null,
  energyKcal: null,
  energyPerHourKcal: null,
  heartRateBpm: null,
  metabolicEquivalent: null,
  positiveElevationGainM: null,
  negativeElevationGainM: null,
  updatedAt: null,
};

// Amostras seguidas (uma por segundo) com o valor parado para considerar que a
// esteira assentou. O motor de inclinação é lento e anda aos degraus, então
// espera bem mais antes de concluir que parou.
const SETTLED_SPEED_SAMPLES = 4;
// Amostras seguidas sem variação, longe do alvo, para concluir que a lona não o
// está seguindo.
const STALLED_SPEED_SAMPLES = 2;
const SETTLED_INCLINATION_SAMPLES = 10;
// Tempo mínimo que precisa restar do prazo para valer outra tentativa de Parar.
// Uma tentativa cortada pelo prazo vira "não foi possível parar" mesmo que a
// escrita ainda chegue à esteira.
const STOP_MIN_ATTEMPT_MS = 500;
// Campos do snapshot cuja mudança entra no registro completo.
const TRACED_STATE = [
  'mode',
  'scan',
  'phase',
  'control',
  'identityConfirmed',
  'belt',
  'targetSpeedKmh',
  'targetInclinationPercent',
  'startBlocked',
  'busy',
] as const satisfies readonly (keyof TreadmillSnapshot)[];
// Variação de RSSI abaixo da qual a lista de aparelhos não é redesenhada.
const RSSI_NOISE_DB = 6;
// Anúncios diferentes do mesmo aparelho que entram no registro numa busca. O teto segura o
// aparelho que muda o anúncio a cada pacote (um contador nos dados do fabricante, por exemplo).
const MAX_TRACED_ADVERTISEMENTS = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Encaixa o valor na grade de passos da esteira, contada a partir do mínimo da faixa. */
function quantize(value: number, range: SupportedRange): number {
  const steps = Math.round((clamp(value, range.min, range.max) - range.min) / range.step);
  const snapped = clamp(range.min + steps * range.step, range.min, range.max);
  // Tira o ruído de ponto flutuante (0,8 + 3 × 0,1 = 1,1000000000000001).
  return Math.round(snapped * 100) / 100;
}

/** Usa a faixa lida da esteira quando ela faz sentido; senão, a da ficha técnica. */
function resolveRange(read: SupportedRange | null, fallback: RangeInfo): RangeInfo {
  if (!read || !(read.max > read.min)) {
    return fallback;
  }
  return {
    min: read.min,
    max: read.max,
    // Há esteiras que informam passo 0; a faixa ainda vale.
    step: read.step > 0 ? read.step : fallback.step,
    source: 'device',
  };
}

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

function formatSignedNumber(value: number, digits: number): string {
  return `${value < 0 ? '−' : '+'}${formatNumber(Math.abs(value), digits)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandVerb(command: Command): string {
  switch (command.kind) {
    case 'speed':
      return 'ajustar a velocidade';
    case 'inclination':
      return 'ajustar a inclinação';
    case 'belt':
      return command.action === 'start' ? 'iniciar a lona' : 'pausar a lona';
    case 'stop':
      return 'parar a lona';
  }
}

function commandKind(command: Command): CommandKind {
  switch (command.kind) {
    case 'speed':
      return 'speed';
    case 'inclination':
      return 'inclination';
    case 'belt':
      return command.action;
    case 'stop':
      return 'stop';
  }
}

function commandBytes(command: Command): Uint8Array {
  switch (command.kind) {
    case 'speed':
      return encodeSetTargetSpeed(command.kmh);
    case 'inclination':
      return encodeSetTargetInclination(command.percent);
    case 'belt':
      return command.action === 'start' ? encodeStartOrResume() : encodePause();
    case 'stop':
      return encodeStop();
  }
}

function commandLabel(command: Command): string {
  switch (command.kind) {
    case 'speed':
      return `Set Target Speed ${formatNumber(command.kmh, 2)} km/h`;
    case 'inclination':
      return `Set Target Inclination ${formatNumber(command.percent, 1)} %`;
    case 'belt':
      return command.action === 'start' ? 'Start or Resume' : 'Stop or Pause (pause)';
    case 'stop':
      return 'Stop or Pause (stop)';
  }
}

// O painel da T600X tem um botão Emergency Stop vermelho no centro, com a
// chave de segurança presa a ele.
const STOP_FALLBACK =
  'Se a lona continuar em movimento, aperte o botão vermelho Emergency Stop da esteira ou puxe a chave de segurança.';

/**
 * Uma sessão com a esteira: busca, conexão, leitura dos dados e comandos pelo
 * Fitness Machine Control Point. Não depende de React nem da biblioteca de
 * Bluetooth — só do contrato `BleTransport`.
 *
 * Decisões de segurança que valem para qualquer interface que use a sessão:
 * - nenhum comando é aceito antes de o usuário confirmar que a esteira
 *   conectada é a dele (numa academia há várias iguais lado a lado);
 * - o controle só é pedido no primeiro comando (há consoles que travam os
 *   botões físicos enquanto um app detém o controle);
 * - Start or Resume só sai por `start()`; ajustar velocidade nunca põe a lona
 *   em movimento;
 * - enquanto houver um Parar a executar, nenhum outro comando é escrito; ele
 *   esvazia a fila, não espera o comando em andamento e insiste até a esteira
 *   aceitar ou o prazo acabar.
 */
export class TreadmillSession implements TreadmillStore {
  readonly actions: TreadmillActions;
  readonly probe: ProbeApi;

  private readonly options: Required<TreadmillSessionOptions>;
  private readonly listeners = new Set<() => void>();
  private snapshot: TreadmillSnapshot;
  private nextId = 1;

  private scanSubscription: BleSubscription | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  // Incrementados a cada busca / conexão: continuações assíncronas de uma
  // operação anterior comparam o valor e desistem.
  private scanEpoch = 0;
  /** Anúncios de cada aparelho que já entraram no registro nesta busca. */
  private readonly tracedAdvertisements = new Map<string, Set<string>>();
  private linkEpoch = 0;

  private connection: BleConnection | null = null;
  private subscriptions: BleSubscription[] = [];

  private pendingResponse: {
    opCode: number;
    urgent: boolean;
    settle: (outcome: ProcedureOutcome) => void;
  } | null = null;
  private beltQueue: BeltCommand[] = [];
  // Há um Parar a executar; `stopRequestedAt` é o instante do toque.
  private stopRequested = false;
  private stopRequestedAt = 0;
  // Instante do último Pausar ou Parar, do app ou da esteira.
  private brakedAt = Number.NEGATIVE_INFINITY;
  // Desde quando a velocidade medida está em zero; `null` enquanto a lona gira.
  private zeroSpeedSince: number | null = null;
  private startBlockTimer: ReturnType<typeof setTimeout> | null = null;
  // Escritas no Control Point que estouraram o prazo e ainda não terminaram.
  private hungWrites = 0;
  // Acorda quem está em `sleep()`.
  private wakeSleep: (() => void) | null = null;
  private pendingSpeed: number | null = null;
  private pendingInclination: number | null = null;
  // Época do link cuja fila está sendo executada; `null` = fila parada.
  private pumpingEpoch: number | null = null;
  // Último alvo que a esteira aceitou (ou avisou); a base para reverter um pedido recusado.
  private confirmedSpeed: number | null = null;
  private confirmedInclination: number | null = null;
  // Mudam quando a esteira invalida um alvo (parada, chave de segurança, reset):
  // o resultado de um ajuste que estava em andamento nesse instante não vale mais.
  private speedTargetEpoch = 0;
  private inclinationTargetEpoch = 0;
  // Comando da lona cujo procedimento está em andamento.
  private inFlightBelt: BeltCommand | null = null;
  // Há um Set Target Speed em andamento.
  private speedInFlight = false;
  // A esteira já deixou um comando sem indication e desde então não mandou nenhuma.
  private controlPointSilent = false;

  // Instante em que o alvo de velocidade foi definido ou confirmado pela última vez.
  private speedTargetSetAt = Number.NEGATIVE_INFINITY;
  private lastSpeedSample: number | null = null;
  private settledSpeedSamples = 0;
  private lastInclinationSample: number | null = null;
  private settledInclinationSamples = 0;
  private loggedDataShapes = new Set<string>();

  // --- Controle pelo canal alternativo (Gizwits / AFG Pro) ------------------
  //
  // Ativado quando o plano automático confirma que o canal 0xFFF0 responde ao
  // protocolo Gizwits. O canal não tem ACK por comando: a confirmação é feita
  // pela telemetria (0x2ACD), e cada comando tem uma janela de espera. Se a
  // esteira não reagir, o app avisa e manda usar o painel/emergência.

  private gizwitsControlEnabled(): boolean {
    return (
      this.snapshot.gizwitsProbe.compatible === true &&
      this.snapshot.gizwitsProbe.status === 'compatible' &&
      this.snapshot.phase === 'connected' &&
      this.snapshot.identityConfirmed &&
      this.connection !== null
    );
  }

  private writeGizwitsControlFrame(frame: Uint8Array, label: string): Promise<void> {
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error('sem conexão com a esteira'));
    this.trace('tx', `Canal alternativo: ${label}`, frame);
    return connection.write(VENDOR_SERVICE, VENDOR_CHANNELS.fff3, frame);
  }

  private sendGizwitsControl(frame: Uint8Array, label: string): void {
    this.gizwitsLastActionAt = this.options.now();
    void this.writeGizwitsControlFrame(frame, label).catch((error) => {
      this.log('error', `Canal alternativo: falha ao enviar ${label}: ${errorMessage(error)}`);
      this.notify('error', `Não consegui enviar o comando pelo canal alternativo (${label}).`);
    });
  }

  /** Avisa se o efeito esperado não aparecer na telemetria dentro da janela. */
  private confirmGizwitsEffect(
    label: string,
    timeoutMs: number,
    expected: () => boolean,
    onFail?: () => void,
  ): void {
    const token = ++this.gizwitsCommandToken;
    setTimeout(() => {
      if (token !== this.gizwitsCommandToken) return;
      if (this.snapshot.phase !== 'connected') return;
      if (expected()) return;
      onFail?.();
      this.notify(
        'warning',
        `A esteira não confirmou ${label}. Confira o painel e, se precisar parar, use o Emergency Stop.`,
      );
    }, timeoutMs);
  }

  private requestBeltGizwits(action: BeltCommand | 'stop'): void {
    if (action === 'stop') {
      this.countRequest('stop');
      this.update({ targetSpeedKmh: null, targetInclinationPercent: null });
      this.sendGizwitsControl(encodeGizwitsStop(), 'parar');
      this.confirmGizwitsEffect(
        'a parada',
        8000,
        () => this.snapshot.belt !== 'running' || (this.snapshot.metrics.speedKmh ?? 0) <= 0.2,
      );
      return;
    }
    if (action === 'pause') {
      this.countRequest('pause');
      this.markBraked();
      this.dropPendingSpeed();
      this.sendGizwitsControl(encodeGizwitsPause(false), 'pausar');
      this.confirmGizwitsEffect(
        'a pausa',
        6000,
        () => (this.snapshot.metrics.speedKmh ?? 0) <= 0.2,
      );
      return;
    }
    // start/continuar
    if (this.snapshot.belt === 'running') return;
    if (this.isStartBlocked()) {
      this.notify('info', 'Aguarde a lona parar antes de iniciar.');
      return;
    }
    this.countRequest('start');
    if (this.snapshot.belt === 'paused') {
      this.sendGizwitsControl(encodeGizwitsPause(true), 'continuar');
      this.confirmGizwitsEffect(
        'a retomada',
        6000,
        () => (this.snapshot.metrics.speedKmh ?? 0) > 0.1,
      );
      return;
    }
    const range = this.snapshot.capabilities?.speedRange;
    const startSpeed = range ? clamp(0.8, range.min, range.max) : 0.8;
    this.sendGizwitsControl(
      encodeGizwitsStartWorkout({ speedKmh: startSpeed, inclinePercent: 0 }),
      `iniciar (${formatDecimal(startSpeed, 1)} km/h)`,
    );
    this.confirmGizwitsEffect(
      'o início',
      8000,
      () => this.snapshot.belt === 'running' || (this.snapshot.metrics.speedKmh ?? 0) > 0.1,
    );
  }

  private changeSpeedGizwits(deltaKmh: number): void {
    const capabilities = this.snapshot.capabilities;
    if (!capabilities) return;
    if (this.options.now() - this.gizwitsLastActionAt < 250) return;
    const measured = this.snapshot.metrics.speedKmh;
    if (this.snapshot.belt !== 'running' || measured === null || measured <= 0) {
      this.notify('info', 'Inicie a lona para ajustar a velocidade.');
      return;
    }
    const target = quantize(measured + deltaKmh, capabilities.speedRange);
    if (target === this.snapshot.targetSpeedKmh) return;
    this.countRequest('speed');
    this.speedTargetSetAt = this.options.now();
    this.update({ targetSpeedKmh: target });
    this.sendGizwitsControl(
      encodeGizwitsSetSpeed(target),
      `velocidade ${formatDecimal(target, 1)} km/h`,
    );
    this.confirmGizwitsEffect(
      'o ajuste de velocidade',
      4000,
      () => {
        const speed = this.snapshot.metrics.speedKmh;
        return speed !== null && Math.abs(speed - target) <= 0.3;
      },
      () => this.invalidateSpeedTarget(),
    );
  }

  private changeInclinationGizwits(deltaPercent: number): void {
    const capabilities = this.snapshot.capabilities;
    if (!capabilities) return;
    if (this.options.now() - this.gizwitsLastActionAt < 250) return;
    const measured = this.snapshot.metrics.inclinationPercent;
    const base =
      this.snapshot.targetInclinationPercent ??
      (measured === null ? 0 : this.correctedInclinationReading(measured));
    const target = quantize(base + deltaPercent, capabilities.inclinationRange);
    if (target === this.snapshot.targetInclinationPercent) return;
    this.countRequest('inclination');
    this.update({ targetInclinationPercent: target });
    this.sendGizwitsControl(
      encodeGizwitsSetIncline(target),
      `inclinação ${formatDecimal(target, 1)} %`,
    );
    this.confirmGizwitsEffect(
      'o ajuste de inclinação',
      6000,
      () => {
        const incline = this.snapshot.metrics.inclinationPercent;
        if (incline === null) return false;
        return Math.abs(this.correctedInclinationReading(incline) - target) <= 0.7;
      },
      () => this.update({ targetInclinationPercent: null }),
    );
  }

  // --- Controle experimental (0xFFF0) ---------------------------------------
  private vendorSubscription: BleSubscription | null = null;
  /** Habilitação do FFF4 em andamento (evita assinatura dupla). */
  private vendorSubscriptionPending: Promise<void> | null = null;
  /** Enquanto a varredura roda, guarda as respostas do FFF4 que chegarem. */
  private vendorReplyCollector: string[] | null = null;
  /** Incrementado para interromper uma varredura em andamento. */
  private vendorDiscoveryEpoch = 0;
  /** Há uma varredura executando (protege contra duas ao mesmo tempo). */
  private vendorDiscoveryActive = false;
  // Identifica o pedido de opcode vendor atual: uma resposta antiga não pode sobrescrever um pedido novo.
  private vendorOpcodeProbeToken = 0;
  // Teste Gizwits: assinatura temporária do FFF4 e guarda contra dois testes.
  private gizwitsProbeSubscription: BleSubscription | null = null;
  private gizwitsProbeInFlight = false;
  private gizwitsProbeToken = 0;
  private gizwitsProbeObservations: Uint8Array[] | null = null;
  // Controle pelo canal alternativo depois que o plano confirma o protocolo.
  private gizwitsCommandToken = 0;
  private gizwitsLastActionAt = Number.NEGATIVE_INFINITY;

  constructor(options: TreadmillSessionOptions) {
    this.options = {
      responseTimeoutMs: 10_000,
      unconfirmedGraceMs: 1_500,
      scanTimeoutMs: 30_000,
      controlRetryDelayMs: 1_500,
      stopRetryDelayMs: 300,
      stopDeadlineMs: 10_000,
      writeTimeoutMs: 4_000,
      startLockoutMs: 1_500,
      startSettleMs: 1_000,
      startMaxLockoutMs: 15_000,
      targetTrustMs: 3_000,
      stopPreemptDelayMs: 250,
      maxLogEntries: 300,
      trace: () => undefined,
      now: Date.now,
      vendorStorage: NO_VENDOR_STORAGE,
      ...options,
    };
    this.snapshot = {
      mode: 'ble',
      scan: 'idle',
      devices: [],
      phase: 'idle',
      device: null,
      capabilities: null,
      control: 'idle',
      identityConfirmed: false,
      belt: 'unknown',
      trainingStatus: null,
      metrics: EMPTY_METRICS,
      targetSpeedKmh: null,
      targetInclinationPercent: null,
      startBlocked: false,
      commands: NO_COMMANDS,
      busy: false,
      notice: null,
      log: [],
      vendor: emptyVendorState(),
      vendorOpcodeProbe: null,
      gizwitsProbe: EMPTY_GIZWITS_PROBE,
    };
    // Cada toque entra no registro completo, antes de qualquer efeito: é o que
    // permite depois comparar o que o usuário pediu com o que a esteira fez.
    const traced = (name: string, run: () => void) => () => {
      this.trace('action', name);
      run();
    };
    this.actions = {
      startScan: traced('Procurar esteiras', () => void this.startScan()),
      stopScan: traced('Parar busca', () => this.stopScan()),
      connect: (deviceId) => {
        this.trace('action', `Conectar em ${deviceId}`);
        void this.connect(deviceId, 'ble');
      },
      openDemo: traced('Abrir modo demonstração', () =>
        void this.connect(this.options.demo.deviceId, 'demo'),
      ),
      disconnect: traced('Desconectar', () => void this.disconnect()),
      confirmIdentity: traced('É esta esteira', () => this.confirmIdentity()),
      changeSpeed: (deltaKmh) => {
        this.trace('action', `Velocidade ${formatSignedNumber(deltaKmh, 2)} km/h`);
        this.changeSpeed(deltaKmh);
      },
      changeInclination: (deltaPercent) => {
        this.trace('action', `Inclinação ${formatSignedNumber(deltaPercent, 1)} %`);
        this.changeInclination(deltaPercent);
      },
      start: traced('Iniciar', () => this.requestBelt('start')),
      pause: traced('Pausar', () => this.requestBelt('pause')),
      stop: traced('Parar', () => this.requestBelt('stop')),
      dismissNotice: () => this.update({ notice: null }),
      clearLog: () => this.update({ log: [] }),
      setVendorMode: (enabled) => {
        this.trace('action', enabled ? 'Ativar controle 0xFFF0' : 'Desativar controle 0xFFF0');
        void this.setVendorMode(enabled);
      },
      setVendorMapping: (mapping) => {
        this.trace('action', `Mapeamento do 0xFFF0: ${mapping.name}`);
        void this.setVendorMapping(mapping);
      },
      runVendorDiscovery: () => {
        this.trace('action', 'Iniciar varredura do 0xFFF0');
        void this.runVendorDiscovery();
      },
      cancelVendorDiscovery: () => this.cancelVendorDiscovery(),
      sendVendorOpcode: (opCode) => {
        this.trace('action', `Sonda FTMS: opcode vendor 0x${opCode.toString(16).toUpperCase()}`);
        this.sendVendorOpcode(opCode);
      },
      runGizwitsProbe: () => {
        this.trace('action', 'Teste do canal alternativo (Gizwits)');
        void this.runGizwitsProbe();
      },
    };
    this.probe = {
      available: () => this.snapshot.phase === 'connected' && this.connection !== null,
      services: () => this.probeServices(),
      read: (serviceUuid, characteristicUuid) => this.probeRead(serviceUuid, characteristicUuid),
      write: (serviceUuid, characteristicUuid, hex) =>
        this.probeWrite(serviceUuid, characteristicUuid, hex),
      subscribe: (serviceUuid, characteristicUuid, onValue) =>
        this.probeSubscribe(serviceUuid, characteristicUuid, onValue),
    };
  }

  /**
   * Carrega o mapeamento do controle experimental salvo em disco. Chamado uma vez
   * na abertura do app; sem arquivo, o controle experimental começa desligado e
   * sem protocolo (a Sonda oferece os presets).
   */
  async restoreVendorMapping(): Promise<void> {
    const mapping = await this.options.vendorStorage.load();
    if (mapping && !this.snapshot.vendor.mapping) {
      this.update({ vendor: { ...this.snapshot.vendor, mapping } });
    }
  }

  // Funções-flecha: `useSyncExternalStore` chama sem `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TreadmillSnapshot => this.snapshot;

  // --- Busca ---------------------------------------------------------------

  async startScan(): Promise<void> {
    if (this.snapshot.scan !== 'idle' || this.snapshot.phase !== 'idle') {
      return;
    }
    const epoch = ++this.scanEpoch;
    this.tracedAdvertisements.clear();
    this.update({ mode: 'ble', scan: 'starting', devices: [], notice: null });
    try {
      await this.options.ble.prepare();
    } catch (error) {
      if (epoch === this.scanEpoch) {
        this.update({ scan: 'idle' });
        this.notify('error', errorMessage(error));
      }
      return;
    }
    if (epoch !== this.scanEpoch) {
      return;
    }
    this.scanSubscription = this.options.ble.scan(
      (device) => {
        if (epoch === this.scanEpoch) this.handleScanResult(device);
      },
      (error) => {
        if (epoch !== this.scanEpoch) return;
        this.stopScan();
        this.notify('error', `A busca por esteiras falhou: ${errorMessage(error)}`);
      },
    );
    this.scanTimer = setTimeout(() => this.handleScanTimeout(), this.options.scanTimeoutMs);
    this.update({ scan: 'scanning' });
    this.log('info', 'Busca iniciada');
  }

  private handleScanTimeout(): void {
    this.stopScan();
    if (!this.snapshot.devices.some((device) => device.advertisesFtms)) {
      this.notify(
        'info',
        'Nenhuma esteira encontrada. Confira se o painel está no modo APP e toque em Procurar de novo.',
      );
    }
  }

  stopScan(): void {
    this.scanEpoch++;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.scanSubscription) {
      this.scanSubscription.remove();
      this.scanSubscription = null;
    }
    if (this.snapshot.scan !== 'idle') {
      const devices = this.snapshot.devices;
      const withFtms = devices.filter((device) => device.advertisesFtms).length;
      this.update({ scan: 'idle' });
      this.log('info', `Busca encerrada: ${devices.length} aparelho(s), ${withFtms} com FTMS`);
    }
  }

  private handleScanResult(found: ScannedDevice): void {
    const devices = this.snapshot.devices;
    const index = devices.findIndex((device) => device.id === found.id);
    if (index === -1) {
      this.update({ devices: sortDevices([...devices, found]) });
      if (found.advertisesFtms) {
        this.logFtmsDeviceFound(found);
      }
      // Todo aparelho novo entra no registro completo, com o que anunciou: se
      // a esteira não for reconhecida, é por estas linhas que se descobre com
      // que nome (ou sem nome) e com que serviços ela aparece.
      this.traceScannedDevice(found, false);
      return;
    }
    // Anúncio e scan response chegam separados: um traz o nome, o outro os
    // serviços. O que já foi visto não se perde.
    const known = devices[index];
    const merged: ScannedDevice = {
      id: found.id,
      name: found.name ?? known.name,
      rssi: found.rssi ?? known.rssi,
      advertisesFtms: found.advertisesFtms || known.advertisesFtms,
      ftms: found.ftms ?? known.ftms,
      advertisement: found.advertisement ?? known.advertisement,
    };
    // O nome ou os serviços que só chegam no segundo pacote também vão para o registro.
    if (merged.name !== known.name || this.isNewAdvertisement(found)) {
      this.traceScannedDevice(merged, true);
    }
    const rssiMoved =
      merged.rssi !== null &&
      (known.rssi === null || Math.abs(merged.rssi - known.rssi) >= RSSI_NOISE_DB);
    const changed =
      merged.name !== known.name ||
      merged.advertisesFtms !== known.advertisesFtms ||
      merged.ftms?.available !== known.ftms?.available ||
      (merged.ftms === null) !== (known.ftms === null) ||
      rssiMoved;
    if (!changed) {
      return;
    }
    const next = devices.slice();
    next[index] = rssiMoved ? merged : { ...merged, rssi: known.rssi };
    this.update({ devices: sortDevices(next) });
    if (merged.advertisesFtms && !known.advertisesFtms) this.logFtmsDeviceFound(merged);
  }

  /** O anúncio deste pacote ainda não entrou no registro (e o aparelho não estourou o teto). */
  private isNewAdvertisement(found: ScannedDevice): boolean {
    if (!found.advertisement) {
      return false;
    }
    const seen = this.tracedAdvertisements.get(found.id);
    return !seen || (!seen.has(found.advertisement) && seen.size < MAX_TRACED_ADVERTISEMENTS);
  }

  private traceScannedDevice(device: ScannedDevice, update: boolean): void {
    if (device.advertisement) {
      const seen = this.tracedAdvertisements.get(device.id) ?? new Set<string>();
      seen.add(device.advertisement);
      this.tracedAdvertisements.set(device.id, seen);
    }
    this.trace(
      'info',
      `Aparelho na busca${update ? ' (atualização)' : ''}: ${device.name ?? 'sem nome'} (${device.id}), RSSI ${device.rssi ?? '?'}` +
        (device.advertisement ? `, anúncio: ${device.advertisement}` : ''),
    );
  }

  private logFtmsDeviceFound(device: ScannedDevice): void {
    const type = device.ftms
      ? device.ftms.machineTypes.treadmill
        ? ', esteira'
        : ', outro tipo de equipamento'
      : '';
    this.log('info', `Encontrado com FTMS: ${device.name ?? 'sem nome'} (${device.id}${type})`);
  }

  // --- Conexão -------------------------------------------------------------

  async connect(deviceId: string, mode: SessionMode): Promise<void> {
    if (this.snapshot.phase !== 'idle') {
      return;
    }
    this.stopScan();
    const epoch = ++this.linkEpoch;
    const transport = mode === 'demo' ? this.options.demo.transport : this.options.ble;
    const known = this.snapshot.devices.find((device) => device.id === deviceId);
    this.resetLinkState();
    this.update({
      mode,
      phase: 'connecting',
      device: { id: deviceId, name: known?.name ?? null },
      notice: null,
      vendorOpcodeProbe: null,
      gizwitsProbe: EMPTY_GIZWITS_PROBE,
    });
    this.log('info', `Conectando a ${known?.name ?? deviceId}`);

    let connection: BleConnection | null = null;
    try {
      await transport.prepare();
      connection = await transport.connect(deviceId);
      if (epoch !== this.linkEpoch) {
        // O usuário desistiu enquanto conectava.
        await connection.disconnect().catch(() => undefined);
        return;
      }
      this.connection = connection;
      this.subscriptions.push(connection.onDisconnect(() => this.handleLinkLost(epoch)));
      this.update({ device: { id: deviceId, name: connection.name ?? known?.name ?? null } });

      await this.logGatt(connection);
      await this.logDeviceInformation(connection, epoch);
      if (epoch !== this.linkEpoch) {
        // O link acabou durante as leituras: quem o encerrou já cuidou de tudo, e seguir
        // com `setUpTreadmill` falaria (por deviceId) com uma conexão que já não é esta.
        return;
      }
      const { capabilities, vendorAvailable } = await this.setUpTreadmill(connection, epoch);
      if (epoch !== this.linkEpoch) {
        return;
      }
      this.update({
        phase: 'connected',
        capabilities,
        control: capabilities.hasControlPoint ? 'idle' : 'unavailable',
        // Na demonstração não há outra esteira; sem Control Point não há comando.
        // Sem Control Point e sem 0xFFF0 não há comando possível, e a confirmação
        // não é necessária; com o canal proprietário, ela continua valendo.
        identityConfirmed: mode === 'demo' || (!capabilities.hasControlPoint && !vendorAvailable),
        vendor: {
          available: vendorAvailable,
          enabled: false,
          mapping: this.snapshot.vendor.mapping,
          lastReply: null,
          lastSend: null,
          discovery: null,
        },
      });
      this.log('info', 'Esteira pronta');
    } catch (error) {
      if (epoch !== this.linkEpoch) {
        return;
      }
      this.log('error', `Falha ao conectar: ${errorMessage(error)}`);
      await this.teardown(connection);
      this.update({ mode: 'ble' });
      this.notify('error', errorMessage(error));
    }
  }

  /** Lê as capacidades e assina as características. Lança se o aparelho não serve como esteira. */
  private async setUpTreadmill(
    connection: BleConnection,
    epoch: number,
  ): Promise<{ capabilities: TreadmillCapabilities; vendorAvailable: boolean }> {
    const characteristics = await connection.getCharacteristics(FTMS.service);
    if (characteristics.length === 0) {
      throw new Error(
        'Este aparelho não oferece o serviço de equipamento fitness (FTMS). Na esteira, confira se o painel está no modo APP.',
      );
    }
    const find = (uuid: string): CharacteristicInfo | undefined =>
      characteristics.find((characteristic) => sameUuid(characteristic.uuid, uuid));

    const treadmillData = find(FTMS.treadmillData);
    if (!treadmillData || !treadmillData.canNotify) {
      throw new Error(
        'Este aparelho fala FTMS, mas não envia dados de esteira (Treadmill Data). Ele pode ser outro tipo de equipamento.',
      );
    }

    let feature: FitnessMachineFeature | null = null;
    if (find(FTMS.feature)?.canRead) {
      feature = await this.readValue(connection, FTMS.feature, 'Fitness Machine Feature', (bytes) =>
        parseFitnessMachineFeature(bytes),
      );
    }
    let speedRange: SupportedRange | null = null;
    if (find(FTMS.supportedSpeedRange)?.canRead) {
      speedRange = await this.readValue(
        connection,
        FTMS.supportedSpeedRange,
        'Supported Speed Range',
        (bytes) => parseSupportedSpeedRange(bytes),
      );
    }
    let inclinationRange: SupportedRange | null = null;
    if (find(FTMS.supportedInclinationRange)?.canRead) {
      inclinationRange = await this.readValue(
        connection,
        FTMS.supportedInclinationRange,
        'Supported Inclination Range',
        (bytes) => parseSupportedInclinationRange(bytes),
      );
    }

    // O Control Point vem primeiro: a esteira recusa comandos enquanto as
    // indications dele não estiverem habilitadas.
    const controlPoint = find(FTMS.controlPoint);
    let hasControlPoint = false;
    if (controlPoint?.canWrite && controlPoint.canIndicate) {
      try {
        this.subscriptions.push(
          await connection.subscribe(FTMS.service, FTMS.controlPoint, (bytes) =>
            this.handleControlPointIndication(bytes, epoch),
          ),
        );
        hasControlPoint = true;
      } catch (error) {
        this.log('error', `Control Point indisponível: ${errorMessage(error)}`);
      }
    }
    if (find(FTMS.machineStatus)?.canNotify) {
      await this.subscribeOptional(connection, FTMS.machineStatus, 'Fitness Machine Status', (bytes) =>
        this.handleMachineStatus(bytes, epoch),
      );
    }
    const trainingStatus = find(FTMS.trainingStatus);
    if (trainingStatus?.canNotify) {
      await this.subscribeOptional(connection, FTMS.trainingStatus, 'Training Status', (bytes) =>
        this.handleTrainingStatus(bytes, epoch),
      );
    }
    if (trainingStatus?.canRead) {
      const status = await this.readValue(
        connection,
        FTMS.trainingStatus,
        'Training Status',
        (bytes) => parseTrainingStatus(bytes),
      );
      if (status && epoch === this.linkEpoch) {
        this.update({ trainingStatus: status });
      }
    }
    this.subscriptions.push(
      await connection.subscribe(FTMS.service, FTMS.treadmillData, (bytes) =>
        this.handleTreadmillData(bytes, epoch),
      ),
    );

    // O serviço proprietário 0xFFF0 não faz parte do FTMS: se existir, é a única
    // porta conhecida para comandos de velocidade/inclinação nesta esteira.
    let vendorAvailable = false;
    try {
      const vendorCharacteristics = await connection.getCharacteristics(VENDOR_SERVICE);
      const has = (uuid: string) =>
        vendorCharacteristics.some(
          (characteristic) =>
            sameUuid(characteristic.uuid, uuid) &&
            (sameUuid(uuid, VENDOR_CHANNELS.fff4)
              ? characteristic.canNotify || characteristic.canIndicate
              : characteristic.canWrite || characteristic.canRead),
        );
      vendorAvailable =
        has(VENDOR_CHANNELS.fff1) && has(VENDOR_CHANNELS.fff3) && has(VENDOR_CHANNELS.fff4);
    } catch {
      // Aparelho sem o serviço proprietário: o controle experimental fica indisponível.
    }

    return {
      capabilities: {
        feature,
        hasControlPoint,
        speedRange: resolveRange(speedRange, T600X_SPEED_RANGE),
        inclinationRange: resolveRange(inclinationRange, T600X_INCLINATION_RANGE),
        characteristics: characteristics.map((characteristic) => characteristic.uuid),
      },
      vendorAvailable,
    };
  }

  /**
   * Registra tudo o que o aparelho expõe. Se a esteira não aceitar controle por
   * FTMS, é aqui que aparece um eventual serviço proprietário do fabricante.
   */
  private async logGatt(connection: BleConnection): Promise<void> {
    try {
      for (const service of await connection.getServices()) {
        const characteristics = service.characteristics.map((characteristic) => {
          const properties = [
            characteristic.canRead && 'read',
            characteristic.canWrite && 'write',
            characteristic.canNotify && 'notify',
            characteristic.canIndicate && 'indicate',
          ].filter(Boolean);
          return `${shortUuid(characteristic.uuid)} [${properties.join(' ')}]`;
        });
        this.log(
          'info',
          `Serviço ${shortUuid(service.uuid)}: ${characteristics.join(', ') || 'sem características'}`,
        );
      }
    } catch (error) {
      this.log('error', `Não foi possível listar os serviços: ${errorMessage(error)}`);
    }
  }

  /**
   * Lê o Device Information (modelo, fabricante, série, versões) e registra: é a
   * única fonte do modelo exato, que o anúncio não traz. Uma leitura que falha
   * vira linha de erro e as outras seguem; uma que não responde no prazo encerra
   * as demais, porque se a fila do rádio travou, as próximas também travariam.
   *
   * O prazo só faz o JavaScript parar de esperar. No Android o rádio atende uma
   * operação por vez, então uma leitura que o aparelho nunca responde também
   * prende o `setUpTreadmill` seguinte, até o timeout do próprio Bluetooth
   * (cerca de 30 s), e a conexão cai. Por isso o modelo é lido primeiro e o
   * resto é bônus.
   */
  private async logDeviceInformation(connection: BleConnection, epoch: number): Promise<void> {
    let available: CharacteristicInfo[];
    try {
      available = await connection.getCharacteristics(DEVICE_INFORMATION_SERVICE);
    } catch (error) {
      this.log('error', `Device Information indisponível: ${errorMessage(error)}`);
      return;
    }
    for (const field of DEVICE_INFORMATION_FIELDS) {
      const readable = available.some(
        (characteristic) => characteristic.canRead && sameUuid(characteristic.uuid, field.uuid),
      );
      if (!readable) {
        continue;
      }
      const label = `Device Information, ${field.name}`;
      try {
        const bytes = await readWithTimeout(
          connection,
          DEVICE_INFORMATION_SERVICE,
          field.uuid,
          DEVICE_INFORMATION_READ_TIMEOUT_MS,
        );
        if (epoch !== this.linkEpoch) {
          return;
        }
        const text = field.text ? `${label}: "${decodeDeviceInformationText(bytes)}"` : label;
        this.log('rx', text, bytes);
      } catch (error) {
        if (epoch !== this.linkEpoch) {
          return;
        }
        this.log('error', `${label}: ${errorMessage(error)}`);
        if (error instanceof ReadTimeoutError) {
          return;
        }
      }
    }
  }

  /** Leitura que não derruba a conexão: se falhar, registra e devolve `null`. */
  private async readValue<T>(
    connection: BleConnection,
    uuid: string,
    name: string,
    parse: (bytes: Uint8Array) => T,
  ): Promise<T | null> {
    try {
      const bytes = await connection.read(FTMS.service, uuid);
      this.log('rx', name, bytes);
      return parse(bytes);
    } catch (error) {
      this.log('error', `${name}: ${errorMessage(error)}`);
      return null;
    }
  }

  private async subscribeOptional(
    connection: BleConnection,
    uuid: string,
    name: string,
    onValue: (bytes: Uint8Array) => void,
  ): Promise<void> {
    try {
      this.subscriptions.push(await connection.subscribe(FTMS.service, uuid, onValue));
    } catch (error) {
      this.log('error', `${name} indisponível: ${errorMessage(error)}`);
    }
  }

  /**
   * Sonda GATT: lê, escreve e assina características fora do FTMS, para
   * descobrir o serviço proprietário 0xFFF0 que a T600X expõe. Não mexe na
   * sessão normal: cada operação vai para o registro e as assinaturas são
   * removidas junto com a conexão.
   */
  private probeConnection(): BleConnection {
    const connection = this.connection;
    if (!connection || this.snapshot.phase !== 'connected') {
      throw new Error('Conecte na esteira para usar a sonda.');
    }
    if (!this.snapshot.identityConfirmed) {
      throw new Error('Confirme que esta é a sua esteira antes de usar a sonda.');
    }
    return connection;
  }

  private probeLabel(serviceUuid: string, characteristicUuid: string): string {
    return shortUuid(serviceUuid) + '/' + shortUuid(characteristicUuid);
  }

  private async probeServices(): Promise<ServiceInfo[]> {
    return this.probeConnection().getServices();
  }

  private async probeRead(serviceUuid: string, characteristicUuid: string): Promise<string> {
    const connection = this.probeConnection();
    const label = this.probeLabel(serviceUuid, characteristicUuid);
    this.trace('info', 'Sonda: lendo ' + label);
    try {
      const bytes = await connection.read(serviceUuid, characteristicUuid);
      this.trace('rx', 'Sonda: leitura ' + label, bytes);
      return bytesToHex(bytes);
    } catch (error) {
      this.trace('error', 'Sonda: falha ao ler ' + label + ': ' + errorMessage(error));
      throw error;
    }
  }

  private async probeWrite(
    serviceUuid: string,
    characteristicUuid: string,
    hex: string,
  ): Promise<void> {
    const connection = this.probeConnection();
    const data = hexToBytes(hex);
    const label = this.probeLabel(serviceUuid, characteristicUuid);
    this.trace('info', 'Sonda: escrevendo ' + label + ' (' + bytesToHex(data) + ')');
    try {
      await connection.write(serviceUuid, characteristicUuid, data);
      this.trace('tx', 'Sonda: escrita ' + label, data);
    } catch (error) {
      this.trace('error', 'Sonda: falha ao escrever ' + label + ': ' + errorMessage(error));
      throw error;
    }
  }

  private async probeSubscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (hex: string) => void,
  ): Promise<() => void> {
    const connection = this.probeConnection();
    const label = this.probeLabel(serviceUuid, characteristicUuid);
    const subscription = await connection.subscribe(
      serviceUuid,
      characteristicUuid,
      (data) => {
        this.trace('rx', 'Sonda: notificação ' + label, data);
        try {
          onValue(bytesToHex(data));
        } catch {
          // A interface não pode derrubar a assinatura.
        }
      },
    );
    this.subscriptions.push(subscription);
    this.trace('info', 'Sonda: assinatura ' + label + ' ativa');
    return () => {
      subscription.remove();
      this.subscriptions = this.subscriptions.filter((item) => item !== subscription);
      this.trace('info', 'Sonda: assinatura ' + label + ' cancelada');
    };
  }

  async disconnect(): Promise<void> {
    if (this.snapshot.phase === 'idle' || this.snapshot.phase === 'disconnecting') {
      return;
    }
    this.linkEpoch++;
    const connection = this.connection;
    this.update({ phase: 'disconnecting' });
    this.log('info', 'Desconectando');
    await this.teardown(connection);
    this.update({ mode: 'ble' });
  }

  private handleLinkLost(epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    this.linkEpoch++;
    this.log('error', 'Conexão perdida');
    void this.teardown(this.connection).then(() => {
      this.update({ mode: 'ble' });
      this.notify(
        'error',
        'A conexão com a esteira caiu. A lona continua como estava: use o painel da esteira e conecte de novo quando quiser.',
      );
    });
  }

  /** Solta tudo o que pertence à conexão atual e volta ao estado sem esteira. */
  private async teardown(connection: BleConnection | null): Promise<void> {
    this.settlePendingResponse({ type: 'linkLost' });
    this.vendorDiscoveryEpoch++;
    this.vendorDiscoveryActive = false;
    this.vendorReplyCollector = null;
    this.vendorSubscription = null;
    this.vendorSubscriptionPending = null;
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];
    this.connection = null;
    if (connection) {
      await connection.disconnect().catch(() => undefined);
    }
    // Num passo só: quem observa a sessão nunca vê "conectado" com o estado da conexão já zerado.
    // A lista de aparelhos fica: reconectar depois de uma queda é um toque só.
    // O mapeamento do 0xFFF0 é configuração e sobrevive; o resto do estado do canal é do link.
    this.resetLinkState({
      phase: 'idle',
      device: null,
      vendor: { ...emptyVendorState(), mapping: this.snapshot.vendor.mapping },
    });
  }

  private resetLinkState(extra: Partial<TreadmillSnapshot> = {}): void {
    this.beltQueue = [];
    this.pendingSpeed = null;
    this.pendingInclination = null;
    this.confirmedSpeed = null;
    this.confirmedInclination = null;
    this.controlPointSilent = false;
    this.pumpingEpoch = null;
    this.inFlightBelt = null;
    this.speedInFlight = false;
    this.stopRequested = false;
    this.brakedAt = Number.NEGATIVE_INFINITY;
    this.zeroSpeedSince = null;
    if (this.startBlockTimer) {
      clearTimeout(this.startBlockTimer);
      this.startBlockTimer = null;
    }
    this.hungWrites = 0;
    this.speedTargetSetAt = Number.NEGATIVE_INFINITY;
    this.wakeSleep?.();
    this.lastSpeedSample = null;
    this.settledSpeedSamples = 0;
    this.lastInclinationSample = null;
    this.settledInclinationSamples = 0;
    this.loggedDataShapes = new Set();
    this.vendorDiscoveryEpoch++;
    this.vendorReplyCollector = null;
    this.gizwitsProbeToken++;
    this.gizwitsProbeInFlight = false;
    this.removeGizwitsProbeSubscription();
    if (this.vendorSubscription) {
      this.vendorSubscription.remove();
      this.subscriptions = this.subscriptions.filter(
        (subscription) => subscription !== this.vendorSubscription,
      );
      this.vendorSubscription = null;
    }
    this.update({
      capabilities: null,
      control: 'idle',
      identityConfirmed: false,
      belt: 'unknown',
      trainingStatus: null,
      metrics: EMPTY_METRICS,
      targetSpeedKmh: null,
      targetInclinationPercent: null,
      startBlocked: false,
      commands: NO_COMMANDS,
      busy: false,
      gizwitsProbe: EMPTY_GIZWITS_PROBE,
      ...extra,
    });
  }

  // --- Dados recebidos -----------------------------------------------------

  private handleTreadmillData(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    let data;
    try {
      data = parseTreadmillData(bytes);
    } catch (error) {
      this.log('error', `Treadmill Data ilegível: ${errorMessage(error)}`, bytes);
      return;
    }
    // Um pacote por segundo encheria o log; fica o primeiro de cada formato.
    const shape = `${data.flags}:${bytes.length}`;
    if (!this.loggedDataShapes.has(shape)) {
      this.loggedDataShapes.add(shape);
      const anomaly = data.truncated
        ? ' — pacote menor que o anunciado nas flags'
        : data.trailingBytes > 0
          ? ` — ${data.trailingBytes} byte(s) além do esperado`
          : '';
      this.log(
        data.truncated || data.trailingBytes > 0 ? 'error' : 'rx',
        `Treadmill Data (flags 0x${data.flags.toString(16).toUpperCase().padStart(4, '0')})${anomaly}`,
        bytes,
      );
    } else {
      this.trace('rx', 'Treadmill Data', bytes);
    }

    const previous = this.snapshot.metrics;
    const metrics: TreadmillMetrics = {
      speedKmh: data.instantaneousSpeedKmh ?? previous.speedKmh,
      averageSpeedKmh: data.averageSpeedKmh ?? previous.averageSpeedKmh,
      inclinationPercent: data.inclinationPercent ?? previous.inclinationPercent,
      rampAngleDeg: data.rampAngleDeg ?? previous.rampAngleDeg,
      distanceM: data.totalDistanceM ?? previous.distanceM,
      elapsedTimeS: data.elapsedTimeS ?? previous.elapsedTimeS,
      remainingTimeS: data.remainingTimeS ?? previous.remainingTimeS,
      energyKcal: data.totalEnergyKcal ?? previous.energyKcal,
      energyPerHourKcal: data.energyPerHourKcal ?? previous.energyPerHourKcal,
      heartRateBpm: data.heartRateBpm ?? previous.heartRateBpm,
      metabolicEquivalent: data.metabolicEquivalent ?? previous.metabolicEquivalent,
      positiveElevationGainM: data.positiveElevationGainM ?? previous.positiveElevationGainM,
      negativeElevationGainM: data.negativeElevationGainM ?? previous.negativeElevationGainM,
      updatedAt: this.options.now(),
    };
    const patch: Partial<TreadmillSnapshot> = { metrics };

    if (data.instantaneousSpeedKmh !== undefined) {
      const speed = data.instantaneousSpeedKmh;
      const steady =
        this.lastSpeedSample !== null && Math.abs(speed - this.lastSpeedSample) < 0.05;
      this.settledSpeedSamples = steady ? this.settledSpeedSamples + 1 : 0;
      const belt = inferBelt(
        this.snapshot.belt,
        speed,
        this.lastSpeedSample,
        this.settledSpeedSamples >= SETTLED_SPEED_SAMPLES,
      );
      if (belt !== this.snapshot.belt) patch.belt = belt;
      if (this.speedTargetLostTrack(speed)) {
        this.confirmedSpeed = null;
        patch.targetSpeedKmh = null;
      }
      if (speed > 0) {
        this.zeroSpeedSince = null;
      } else if (this.zeroSpeedSince === null) {
        this.zeroSpeedSince = this.options.now();
      }
      this.lastSpeedSample = speed;
    }
    if (data.inclinationPercent !== undefined) {
      const inclination = data.inclinationPercent;
      const steady =
        this.lastInclinationSample !== null &&
        Math.abs(inclination - this.lastInclinationSample) < 0.05;
      this.settledInclinationSamples = steady ? this.settledInclinationSamples + 1 : 0;
      if (this.inclinationTargetIsStale(inclination)) {
        this.confirmedInclination = null;
        patch.targetInclinationPercent = null;
      }
      this.lastInclinationSample = inclination;
    }
    this.update(patch);
    if (this.snapshot.startBlocked) this.refreshStartBlock();
  }

  /**
   * Nem toda esteira avisa por Fitness Machine Status quando alguém muda a
   * velocidade no console. Somar "+0,1" a um alvo que já não vale mandaria a
   * lona para uma velocidade que ninguém pediu, então o alvo só é mantido
   * enquanto a lona o segue: está nele ou vem se aproximando dele, sem parar no
   * caminho. Ao primeiro sinal contrário ele é descartado, e o próximo ajuste
   * parte da velocidade medida — o erro possível é para menos.
   *
   * Chamado antes de `lastSpeedSample` receber a amostra nova.
   */
  private speedTargetLostTrack(speed: number): boolean {
    const target = this.snapshot.targetSpeedKmh;
    if (target === null || this.pendingSpeed !== null || this.speedInFlight) {
      return false;
    }
    // Pausada, a lona freia de propósito; o alvo vale para a retomada.
    if (this.snapshot.belt !== 'running') {
      return false;
    }
    // A esteira leva um instante para começar a reagir a um alvo novo.
    if (this.options.now() - this.speedTargetSetAt <= this.options.targetTrustMs) {
      return false;
    }
    const step = this.snapshot.capabilities?.speedRange.step ?? 0.1;
    // Folga de mais de um passo: console em milhas arredonda o alvo em km/h
    // para o décimo de milha mais próximo, e isso não é "alguém mexeu".
    const distance = Math.abs(speed - target);
    if (distance <= Math.max(step * 1.5, 0.2)) {
      return false;
    }
    const previous = this.lastSpeedSample;
    if (previous === null) {
      return false;
    }
    const movingAway = distance - Math.abs(previous - target) >= 0.05;
    const stalled = this.settledSpeedSamples >= STALLED_SPEED_SAMPLES;
    return movingAway || stalled;
  }

  private inclinationTargetIsStale(inclination: number): boolean {
    const target = this.snapshot.targetInclinationPercent;
    const step = this.snapshot.capabilities?.inclinationRange.step ?? 0.5;
    const corrected = this.correctedInclinationReading(inclination);
    return (
      target !== null &&
      this.pendingInclination === null &&
      this.pumpingEpoch === null &&
      this.settledInclinationSamples >= SETTLED_INCLINATION_SAMPLES &&
      Math.abs(corrected - target) > Math.max(step, 0.5)
    );
  }

  /**
   * Alguns consoles declaram o alvo de velocidade em outra escala: esta T600X
   * manda raw/100 = 80 km/h para uma lona a 5,0 (fator 16, dossiê §7.1). Se o
   * valor cru cai fora da faixa, tenta a escala real (÷16); se nem ela é
   * plausível, o aviso é ignorado em vez de envenenar o alvo (que serve de base
   * para os próximos ajustes).
   */
  /**
   * A família de firmware desta esteira é reconhecida pela faixa de inclinação
   * declarada (0–50 %/3 %, template do FTMS). Só nela o alvo de velocidade do
   * 0x2ADA vem em ×16; numa esteira conforme a escala é a da especificação.
   */
  private usesVendorTemplateFingerprint(): boolean {
    const range = this.snapshot.capabilities?.inclinationRange;
    return Boolean(range && plausibleInclinationRange(range) !== range);
  }

  private normalizeReportedSpeed(kmh: number): number | null {
    if (!Number.isFinite(kmh) || kmh < 0) return null;
    const range = this.snapshot.capabilities?.speedRange;
    if (!range) return kmh;
    const scaled = kmh / 16;
    if (this.usesVendorTemplateFingerprint()) {
      // Nesta família o aviso vem em ×16 (80 para uma lona a 5,0). Divide sempre;
      // não dá para desempatar pela medida, que atrasa em aceleração.
      return scaled <= range.max * 1.5 ? Math.min(scaled, range.max) : null;
    }
    if (kmh <= range.max * 1.5) return Math.min(kmh, range.max);
    if (scaled >= range.min * 0.5 && scaled <= range.max * 1.5) {
      return Math.min(scaled, range.max);
    }
    return null;
  }

  private handleMachineStatus(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    let event;
    try {
      event = parseMachineStatus(bytes);
    } catch (error) {
      this.log('error', `Fitness Machine Status ilegível: ${errorMessage(error)}`, bytes);
      return;
    }
    this.log('rx', `Fitness Machine Status: ${event.type}`, bytes);
    switch (event.type) {
      case 'reset':
        // O Reset devolve a esteira aos padrões e encerra a permissão de controle.
        this.markBrakedIfBeltChanges('stopped');
        this.dropQueuedCommands();
        this.invalidateSpeedTarget();
        this.invalidateInclinationTarget();
        this.update({
          belt: 'stopped',
          control: this.snapshot.control === 'unavailable' ? 'unavailable' : 'idle',
        });
        break;
      case 'stoppedOrPausedByUser':
        this.markBrakedIfBeltChanges(event.action === 'pause' ? 'paused' : 'stopped');
        this.dropQueuedCommands();
        if (event.action === 'pause') {
          this.update({ belt: 'paused' });
        } else {
          this.invalidateSpeedTarget();
          this.update({ belt: 'stopped' });
        }
        break;
      case 'stoppedBySafetyKey':
        this.markBrakedIfBeltChanges('safetyKey');
        this.dropQueuedCommands();
        this.invalidateSpeedTarget();
        this.update({ belt: 'safetyKey' });
        break;
      case 'startedOrResumedByUser':
        // A lona vai acelerar de volta ao alvo: ele ganha o prazo de novo.
        this.speedTargetSetAt = this.options.now();
        this.update({ belt: 'running' });
        break;
      case 'targetSpeedChanged': {
        const speed = this.normalizeReportedSpeed(event.speedKmh);
        if (speed === null) {
          this.log(
            'error',
            `Fitness Machine Status: alvo de velocidade implausível (${event.speedKmh})`,
            bytes,
          );
          break;
        }
        this.confirmedSpeed = speed;
        this.speedTargetSetAt = this.options.now();
        // Um pedido do app ainda na fila vale mais que o aviso da esteira.
        if (this.pendingSpeed === null) {
          this.update({ targetSpeedKmh: speed });
        }
        break;
      }
      case 'targetInclineChanged':
        this.confirmedInclination = event.inclinationPercent;
        if (this.pendingInclination === null) {
          this.update({ targetInclinationPercent: event.inclinationPercent });
        }
        break;
      case 'controlPermissionLost':
        this.dropQueuedCommands();
        if (this.snapshot.control !== 'unavailable') {
          this.update({ control: 'lost' });
          this.notify(
            'warning',
            'A esteira retomou o controle. O próximo comando do app pede o controle de novo.',
          );
        }
        break;
      case 'other':
        break;
    }
  }

  private handleTrainingStatus(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    try {
      const status = parseTrainingStatus(bytes);
      this.log('rx', `Training Status: ${status.name}`, bytes);
      this.update({ trainingStatus: status });
    } catch (error) {
      this.log('error', `Training Status ilegível: ${errorMessage(error)}`, bytes);
    }
  }

  private handleControlPointIndication(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    const response = parseControlPointResponse(bytes);
    if (!response) {
      this.log('error', 'Indication do Control Point em formato desconhecido', bytes);
      return;
    }
    this.controlPointSilent = false;
    this.log(
      'rx',
      `Resposta a ${controlPointOpName(response.requestOpCode)}: ${controlPointResultName(response.resultCode)}`,
      bytes,
    );
    if (this.pendingResponse?.opCode === response.requestOpCode) {
      this.settlePendingResponse({
        type: 'result',
        resultCode: response.resultCode,
        parameter: response.parameter,
      });
    } else if (
      response.requestOpCode === ControlPointOp.RequestControl &&
      response.resultCode === ControlPointResult.Success &&
      this.snapshot.control !== 'unavailable'
    ) {
      // Resposta a um pedido de controle que o app já tinha dado por perdido
      // (a escrita ficou presa enquanto o sistema pareava com a esteira).
      this.update({ control: 'granted' });
    }
  }

  // --- Comandos ------------------------------------------------------------

  private confirmIdentity(): void {
    if (this.snapshot.phase === 'connected' && !this.snapshot.identityConfirmed) {
      this.update({ identityConfirmed: true });
      this.log('info', 'Usuário confirmou que esta é a esteira dele');
    }
  }

  /** Há conexão com Control Point e o usuário já confirmou que a esteira é a dele. */
  private canCommand(): boolean {
    return (
      this.snapshot.phase === 'connected' &&
      this.snapshot.capabilities?.hasControlPoint === true &&
      this.snapshot.identityConfirmed
    );
  }

  // --- Opcodes vendor do FTMS (experimento de campo) ----------------------

  /**
   * Envia um op code proprietário da JHT no Control Point (`0x7E`/`0x7F`). É o
   * experimento para descobrir se o firmware desta T600X aceita extensões do
   * fabricante: um `Success` em `0x7E` indica que o console entra no modo de
   * atualização (Wi-Fi AP de serviço).
   *
   * Segurança: este app **não** tem cliente HTTP do console e **nunca** chama
   * `/upload` — não existe caminho de atualização de firmware por aqui. O único
   * efeito colateral conhecido é o console reiniciar e a conexão cair.
   */
  sendVendorOpcode(opCode: number): void {
    if (!isVendorControlOpcode(opCode)) {
      return;
    }
    const info = vendorControlOpcodeInfo(opCode);
    const blocked = this.vendorOpcodeBlockedReason();
    if (blocked) {
      this.update({
        vendorOpcodeProbe: {
          opCode,
          label: info.label,
          status: 'blocked',
          at: this.options.now(),
          resultCode: null,
          parameterHex: null,
          detail: blocked,
        },
      });
      this.log('info', `Sonda FTMS: opcode vendor ${info.short} não enviado (${blocked})`);
      this.notify('warning', `Opcode ${info.short} não enviado: ${blocked}.`);
      return;
    }
    const token = ++this.vendorOpcodeProbeToken;
    this.update({
      vendorOpcodeProbe: {
        opCode,
        label: info.label,
        status: 'pending',
        at: this.options.now(),
        resultCode: null,
        parameterHex: null,
        detail: 'pedindo o controle…',
      },
    });
    void this.runVendorOpcode(opCode, info.short, token);
  }

  /** `null` = pode enviar; senão, o motivo em texto para o usuário. */
  private vendorOpcodeBlockedReason(): string | null {
    if (this.snapshot.mode !== 'ble') {
      return 'o teste só funciona conectado à esteira real (o modo demonstração não tem rádio)';
    }
    if (this.snapshot.phase !== 'connected' || !this.snapshot.capabilities?.hasControlPoint) {
      return 'a conexão atual não tem Control Point';
    }
    if (!this.snapshot.identityConfirmed) {
      return 'confirme “É esta esteira” antes do teste';
    }
    if (this.snapshot.vendor.enabled) {
      return 'desative o controle experimental 0xFFF0 antes de testar o Control Point';
    }
    if (this.snapshot.vendorOpcodeProbe?.status === 'pending' || this.pendingResponse) {
      return 'já há um comando aguardando resposta';
    }
    if (this.stopRequested) {
      return 'há um Parar em andamento';
    }
    const speed = this.snapshot.metrics.speedKmh;
    if (speed === null) {
      return 'ainda não recebi a velocidade da esteira; espere a telemetria mostrar 0,0 km/h';
    }
    if (this.snapshot.belt === 'running' || speed > 0.5) {
      return 'a lona está andando: pare a esteira e espere parar antes do teste';
    }
    if (this.hungWrites > 0) {
      return 'há uma escrita presa na fila do sistema; desconecte e conecte de novo';
    }
    return null;
  }

  private async runVendorOpcode(
    opCode: VendorControlOpCode,
    short: string,
    token: number,
  ): Promise<void> {
    const epoch = this.linkEpoch;
    this.log('info', `Sonda FTMS: enviando opcode vendor ${short}`);
    if (this.snapshot.control !== 'granted') {
      const control = await this.requestControl(epoch);
      if (this.vendorOpcodeProbeToken !== token) return;
      if (control.status !== 'granted') {
        const detail =
          control.status === 'refused'
            ? `o controle não foi liberado (${controlPointResultName(control.resultCode)})`
            : 'não foi possível obter o controle do console';
        this.finishVendorOpcodeProbe(token, 'blocked', null, null, detail);
        this.notify('warning', `Opcode ${short} não enviado: ${detail}.`);
        return;
      }
    }
    const outcome = await this.runProcedure(
      encodeVendorControlOpcode(opCode),
      `Sonda: opcode vendor ${short} (${vendorControlOpcodeInfo(opCode).label})`,
      false,
    );
    if (this.vendorOpcodeProbeToken !== token) return;
    switch (outcome.type) {
      case 'result': {
        const parameterHex = outcome.parameter.length > 0 ? bytesToHex(outcome.parameter) : null;
        const resultName = controlPointResultName(outcome.resultCode);
        this.finishVendorOpcodeProbe(token, 'answered', outcome.resultCode, parameterHex, resultName);
        if (outcome.resultCode === ControlPointResult.Success) {
          this.notify(
            'success',
            `Opcode ${short}: Success${parameterHex ? ` (parâmetro ${parameterHex})` : ''}.`,
          );
        } else {
          this.notify('info', `Opcode ${short}: ${resultName}.`);
        }
        return;
      }
      case 'timeout':
        this.finishVendorOpcodeProbe(token, 'timeout', null, null, 'sem resposta do console');
        this.notify('warning', `Opcode ${short}: sem resposta (o console pode ter reiniciado).`);
        return;
      case 'writeError':
        this.finishVendorOpcodeProbe(
          token,
          'failed',
          null,
          null,
          `falha ao escrever: ${outcome.error.message}`,
        );
        this.notify('error', `Opcode ${short}: falha ao escrever.`);
        return;
      case 'preempted':
        this.finishVendorOpcodeProbe(token, 'blocked', null, null, 'um Parar passou na frente');
        this.notify('info', `Opcode ${short} cancelado por um Parar.`);
        return;
      case 'linkLost':
        this.finishVendorOpcodeProbe(
          token,
          'failed',
          null,
          null,
          'a conexão caiu (o console pode ter reiniciado)',
        );
        this.notify(
          'warning',
          `Opcode ${short}: a conexão caiu — se o console reiniciou, isso indica que o opcode foi aceito.`,
        );
        return;
    }
  }

  private finishVendorOpcodeProbe(
    token: number,
    status: VendorOpcodeProbe['status'],
    resultCode: number | null,
    parameterHex: string | null,
    detail: string | null,
  ): void {
    if (this.vendorOpcodeProbeToken !== token) return;
    const current = this.snapshot.vendorOpcodeProbe;
    this.update({
      vendorOpcodeProbe: {
        opCode: current?.opCode ?? 0,
        label: current?.label ?? '',
        status,
        at: current?.at ?? this.options.now(),
        resultCode,
        parameterHex,
        detail,
      },
    });
    this.log(
      status === 'answered' ? 'info' : 'error',
      `Sonda FTMS: opcode vendor ${current?.label ?? '?'} → ${detail ?? status}`,
    );
  }

  private changeSpeed(deltaKmh: number): void {
    if (this.gizwitsControlEnabled()) {
      this.changeSpeedGizwits(deltaKmh);
      return;
    }
    if (this.vendorControlEnabled()) {
      this.changeSpeedVendor(deltaKmh);
      return;
    }
    const capabilities = this.snapshot.capabilities;
    if (!capabilities || !this.canCommand()) {
      return;
    }
    if (this.stopRequested) {
      // Com um Parar em andamento, nenhum outro pedido é aceito.
      return;
    }
    const measured = this.snapshot.metrics.speedKmh;
    if (this.snapshot.belt !== 'running' || measured === null || measured <= 0) {
      // Ajustar velocidade nunca põe a lona em movimento: isso é papel de
      // `start()`. Vale também para a lona que ainda gira enquanto freia depois
      // de um Parar — não se sabe se a esteira trataria o ajuste como partida.
      this.notify('info', 'Inicie a lona para ajustar a velocidade.');
      return;
    }
    const base = this.snapshot.targetSpeedKmh ?? measured;
    const target = quantize(base + deltaKmh, capabilities.speedRange);
    if (target === this.snapshot.targetSpeedKmh) {
      return;
    }
    this.countRequest('speed');
    this.pendingSpeed = target;
    this.speedTargetSetAt = this.options.now();
    this.update({ targetSpeedKmh: target });
    void this.pump();
  }

  private changeInclination(deltaPercent: number): void {
    if (this.gizwitsControlEnabled()) {
      this.changeInclinationGizwits(deltaPercent);
      return;
    }
    if (this.vendorControlEnabled()) {
      this.changeInclinationVendor(deltaPercent);
      return;
    }
    const capabilities = this.snapshot.capabilities;
    if (!capabilities || !this.canCommand()) {
      return;
    }
    if (this.stopRequested) {
      return;
    }
    const base =
      this.snapshot.targetInclinationPercent ??
      this.snapshot.metrics.inclinationPercent ??
      // Sem leitura da esteira, parte do plano (0 %), não do mínimo da faixa.
      clamp(0, capabilities.inclinationRange.min, capabilities.inclinationRange.max);
    const target = quantize(base + deltaPercent, capabilities.inclinationRange);
    if (target === this.snapshot.targetInclinationPercent) {
      return;
    }
    this.countRequest('inclination');
    this.pendingInclination = target;
    this.update({ targetInclinationPercent: target });
    void this.pump();
  }

  private requestBelt(action: BeltCommand | 'stop'): void {
    if (this.gizwitsControlEnabled()) {
      this.requestBeltGizwits(action);
      return;
    }
    if (this.vendorControlEnabled()) {
      this.requestBeltVendor(action);
      return;
    }
    if (!this.canCommand()) {
      return;
    }
    if (action === 'stop') {
      this.countRequest('stop');
      this.requestStop();
      return;
    }
    if (this.stopRequested) {
      return;
    }
    if (action === 'start') {
      if (this.isStartBlocked()) {
        return;
      }
      this.countRequest('start');
    } else {
      this.countRequest('pause');
      this.markBraked();
      // Nada que acelere a lona sai depois de um Pausar.
      this.beltQueue = this.beltQueue.filter((queued) => queued !== 'start');
      this.dropPendingSpeed();
    }
    // Toque repetido no mesmo botão é um comando só.
    const last = this.beltQueue[this.beltQueue.length - 1] ?? this.inFlightBelt;
    if (last !== action) {
      this.beltQueue.push(action);
    }
    void this.pump();
  }

  // --- Controle experimental (0xFFF0) ---------------------------------------
  //
  // O FTMS desta esteira recusa velocidade/inclinação (Target Setting Features =
  // 0x10). O 0xFFF0 é a única porta conhecida para comandos, mas o protocolo do
  // fabricante ainda não é conhecido: o app manda os bytes do mapeamento
  // configurado na Sonda e registra o que voltar. Não há confirmação da esteira
  // nesse canal; o efeito é conferido pela telemetria (0x2ACD) e pelo painel.

  /** Leitura fresca do estado da lona (método evita o estreitamento de tipo do `if` anterior). */
  private beltMayBeRunning(): boolean {
    return this.snapshot.belt === 'running';
  }

  private vendorControlEnabled(): boolean {
    return (
      this.snapshot.vendor.enabled &&
      this.snapshot.phase === 'connected' &&
      this.snapshot.identityConfirmed
    );
  }

  private async setVendorMode(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.cancelVendorDiscovery();
      this.removeVendorSubscription();
      this.update({ vendor: { ...this.snapshot.vendor, enabled: false } });
      this.notify('info', 'Controle experimental desativado.');
      return;
    }
    if (this.snapshot.phase !== 'connected' || !this.snapshot.identityConfirmed) {
      this.notify('warning', 'Conecte e confirme a esteira antes de ativar o controle experimental.');
      return;
    }
    if (!this.snapshot.vendor.available) {
      this.notify('error', 'Esta esteira não expôs o canal proprietário 0xFFF0.');
      return;
    }
    if (!this.snapshot.vendor.mapping) {
      this.notify('warning', 'Escolha um protocolo experimental na Sonda antes de ativar o controle.');
      return;
    }
    try {
      await this.ensureVendorSubscription();
    } catch (error) {
      this.notify('error', `Não foi possível assinar o FFF4: ${errorMessage(error)}`);
      return;
    }
    if (this.snapshot.phase !== 'connected' || !this.snapshot.identityConfirmed) {
      this.notify('warning', 'A conexão caiu antes de ativar o controle experimental.');
      return;
    }
    this.update({ vendor: { ...this.snapshot.vendor, enabled: true } });
    const deviceRange = this.snapshot.capabilities?.inclinationRange;
    if (
      deviceRange &&
      (deviceRange.max > T600X_INCLINATION_RANGE.max ||
        deviceRange.step > T600X_INCLINATION_RANGE.step)
    ) {
      this.notify(
        'warning',
        'Controle experimental ativado. A faixa de inclinação do FTMS é implausível (0–50 %, passo 3 %): o app usa a ficha da T600X (0–15 %, passo 0,5 %). Confira o painel a cada toque.',
      );
      return;
    }
    this.notify(
      'info',
      'Controle experimental ativado: os comandos vão pelo 0xFFF0 e não têm confirmação da esteira. Confira o painel a cada toque.',
    );
  }

  private async setVendorMapping(mapping: VendorMapping): Promise<void> {
    this.update({ vendor: { ...this.snapshot.vendor, mapping } });
    try {
      await this.options.vendorStorage.save(mapping);
    } catch (error) {
      this.trace(
        'error',
        `Controle 0xFFF0: não foi possível salvar o mapeamento: ${errorMessage(error)}`,
      );
    }
  }

  private async ensureVendorSubscription(): Promise<void> {
    if (this.vendorSubscription) return;
    if (this.vendorSubscriptionPending) return this.vendorSubscriptionPending;
    const connection = this.connection;
    if (!connection) throw new Error('sem conexão com a esteira');
    const epoch = this.linkEpoch;
    const pending = (async () => {
      const subscription = await withTimeout(
        connection.subscribe(VENDOR_SERVICE, VENDOR_CHANNELS.fff4, (data) =>
          this.handleVendorReply(data),
        ),
        this.options.writeTimeoutMs,
        'a esteira não confirmou a assinatura do FFF4 a tempo',
      );
      if (epoch !== this.linkEpoch) {
        // A conexão caiu durante a assinatura: não deixa nada pendurado.
        subscription.remove();
        return;
      }
      this.vendorSubscription = subscription;
      this.subscriptions.push(subscription);
      this.trace('info', 'Controle 0xFFF0: assinatura FFF4 ativa');
    })();
    this.vendorSubscriptionPending = pending.finally(() => {
      this.vendorSubscriptionPending = null;
    });
    return this.vendorSubscriptionPending;
  }

  private removeVendorSubscription(): void {
    const subscription = this.vendorSubscription;
    if (!subscription) return;
    subscription.remove();
    this.subscriptions = this.subscriptions.filter((item) => item !== subscription);
    this.vendorSubscription = null;
    this.trace('info', 'Controle 0xFFF0: assinatura FFF4 cancelada');
  }

  // --- Plano automático do canal alternativo (protocolo Gizwits / AFG Pro) ---
  //
  // O app AFG Pro (JHT) controla esteira pelo mesmo serviço 0xFFF0 da T600X:
  // assina o FFF4 e manda frames `55 AA ...` no FFF3. O plano abaixo é só de
  // leitura/parada (nunca liga a lona) e roda sozinho depois que o usuário
  // confirma a esteira. Se o primeiro pedido não responder, tenta variantes de
  // canal, sequência e CRC; se precisar de uma ação humana (parar a lona), deixa
  // a frase em `hint`, que o painel mostra na faixa do topo.

  private removeGizwitsProbeSubscription(): void {
    const subscription = this.gizwitsProbeSubscription;
    if (!subscription) return;
    this.gizwitsProbeSubscription = null;
    subscription.remove();
    this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
  }

  private setGizwitsProbe(patch: Partial<GizwitsProbeSnapshot>): void {
    this.update({ gizwitsProbe: { ...this.snapshot.gizwitsProbe, ...patch } });
  }

  private setGizwitsAttempt(
    name: string,
    label: string,
    patch: Partial<Omit<GizwitsAttempt, 'name' | 'label'>>,
  ): void {
    const attempts = [...this.snapshot.gizwitsProbe.attempts];
    const index = attempts.findIndex((attempt) => attempt.name === name);
    if (index === -1) {
      attempts.push({ name, label, status: 'pending', replyHex: null, detail: null, ...patch });
    } else {
      attempts[index] = { ...attempts[index], ...patch };
    }
    this.setGizwitsProbe({ attempts });
  }

  private async subscribeGizwitsProbe(
    connection: BleConnection,
    token: number,
  ): Promise<boolean> {
    try {
      const subscription = await connection.subscribe(
        VENDOR_SERVICE,
        VENDOR_CHANNELS.fff4,
        (data) => {
          if (token !== this.gizwitsProbeToken) return;
          this.gizwitsProbeObservations?.push(data);
          this.trace('rx', 'Teste Gizwits: notificação', data);
        },
      );
      if (token !== this.gizwitsProbeToken) {
        subscription.remove();
        return false;
      }
      this.gizwitsProbeSubscription = subscription;
      this.subscriptions.push(subscription);
      this.trace('info', 'Teste Gizwits: FFF4 assinado (aguardando notificações)');
      return true;
    } catch (error) {
      this.trace(
        'error',
        `Teste Gizwits: não consegui assinar o FFF4: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private async sendGizwitsAndWait(
    connection: BleConnection,
    token: number,
    target: GizwitsTarget,
    frame: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array | null> {
    const observations = this.gizwitsProbeObservations;
    if (!observations) return null;
    const start = observations.length;
    const channel = target === 'fff1' ? VENDOR_CHANNELS.fff1 : VENDOR_CHANNELS.fff3;
    try {
      await connection.write(VENDOR_SERVICE, channel, frame);
      this.trace('tx', `Teste Gizwits (${target.toUpperCase()})`, frame);
    } catch (error) {
      this.trace(
        'error',
        `Teste Gizwits: falha ao escrever no ${target.toUpperCase()}: ${errorMessage(error)}`,
      );
      throw error;
    }
    const deadline = this.options.now() + timeoutMs;
    while (this.options.now() < deadline) {
      if (this.gizwitsProbeToken !== token) return null;
      const found = observations.slice(start).find(looksLikeGizwitsFrame);
      if (found) return found;
      await wait(GIZWITS_PROBE_POLL_MS);
    }
    return null;
  }

  private async runGizwitsAttempt(
    connection: BleConnection,
    token: number,
    name: string,
    label: string,
    target: GizwitsTarget,
    frame: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array | null> {
    this.setGizwitsProbe({ stage: label });
    this.setGizwitsAttempt(name, label, { status: 'running', detail: null, replyHex: null });
    let reply: Uint8Array | null = null;
    try {
      reply = await this.sendGizwitsAndWait(connection, token, target, frame, timeoutMs);
    } catch (error) {
      if (this.gizwitsProbeToken !== token) return null;
      this.setGizwitsAttempt(name, label, { status: 'error', detail: errorMessage(error) });
      this.trace('info', `Teste Gizwits: ${label} falhou na escrita: ${errorMessage(error)}`);
      return null;
    }
    if (this.gizwitsProbeToken !== token) return null;
    if (!reply) {
      this.setGizwitsAttempt(name, label, { status: 'timeout' });
      return null;
    }
    const limited = reply.slice(0, GIZWITS_PROBE_REPLY_LIMIT);
    this.setGizwitsAttempt(name, label, {
      status: 'reply',
      replyHex: bytesToHex(limited),
      detail: `${target.toUpperCase()} · ${reply.length} byte(s)`,
    });
    return reply;
  }

  /**
   * Varredura automática e segura (a mesma da Sonda, sem precisar abrir a Sonda):
   * escreve 1 byte por vez no FFF3/FFF1 e observa qualquer notificação no FFF4,
   * além de ler FFF1/FFF2 antes/depois. Só roda com a lona parada.
   */
  private async runAutomaticGizwitsSweep(
    connection: BleConnection,
    token: number,
  ): Promise<Uint8Array | null> {
    const candidates: {
      name: string;
      label: string;
      target: GizwitsTarget;
      bytes: Uint8Array;
    }[] = [
      { name: 'disc-fff3-00', label: 'FFF3 ← 00', target: 'fff3', bytes: hexToBytes('00') },
      { name: 'disc-fff3-01', label: 'FFF3 ← 01', target: 'fff3', bytes: hexToBytes('01') },
      { name: 'disc-fff3-55', label: 'FFF3 ← 55', target: 'fff3', bytes: hexToBytes('55') },
      { name: 'disc-fff3-aa', label: 'FFF3 ← AA', target: 'fff3', bytes: hexToBytes('AA') },
      {
        name: 'disc-fff3-at',
        label: 'FFF3 ← AT\r\n',
        target: 'fff3',
        bytes: Uint8Array.of(0x41, 0x54, 0x0d, 0x0a),
      },
      { name: 'disc-fff1-00', label: 'FFF1 ← 00', target: 'fff1', bytes: hexToBytes('00') },
      { name: 'disc-fff1-55', label: 'FFF1 ← 55', target: 'fff1', bytes: hexToBytes('55') },
      { name: 'disc-fff1-aa', label: 'FFF1 ← AA', target: 'fff1', bytes: hexToBytes('AA') },
    ];
    const observations = this.gizwitsProbeObservations;
    if (!observations) return null;

    for (const candidate of candidates) {
      if (this.gizwitsProbeToken !== token) return null;
      if (this.beltMayBeRunning()) {
        this.setGizwitsProbe({
          status: 'waitingBelt',
          stage: null,
          hint: 'No painel, pare a esteira. Eu termino o teste do canal alternativo sozinho.',
          detail: 'a lona começou a andar durante a varredura',
        });
        return null;
      }
      this.setGizwitsProbe({ stage: candidate.label });
      this.setGizwitsAttempt(candidate.name, candidate.label, {
        status: 'running',
        detail: null,
        replyHex: null,
      });
      const start = observations.length;
      const channel = candidate.target === 'fff1' ? VENDOR_CHANNELS.fff1 : VENDOR_CHANNELS.fff3;
      try {
        await connection.write(VENDOR_SERVICE, channel, candidate.bytes);
        this.trace('tx', `Teste Gizwits (${candidate.target.toUpperCase()})`, candidate.bytes);
      } catch (error) {
        this.setGizwitsAttempt(candidate.name, candidate.label, {
          status: 'error',
          detail: errorMessage(error),
        });
        continue;
      }
      const deadline = this.options.now() + 1200;
      let found: Uint8Array | null = null;
      while (this.options.now() < deadline) {
        if (this.gizwitsProbeToken !== token) return null;
        found = observations[start] ?? null;
        if (found) break;
        await wait(100);
      }
      if (found) {
        this.setGizwitsAttempt(candidate.name, candidate.label, {
          status: 'reply',
          replyHex: bytesToHex(found.slice(0, GIZWITS_PROBE_REPLY_LIMIT)),
          detail: `${found.length} byte(s)`,
        });
        return found;
      }
      this.setGizwitsAttempt(candidate.name, candidate.label, { status: 'timeout' });
    }
    return null;
  }

  private async traceGizwitsReads(connection: BleConnection, token: number): Promise<void> {
    const channels: [string, string][] = [
      ['FFF1', VENDOR_CHANNELS.fff1],
      ['FFF2', VENDOR_CHANNELS.fff2],
      ['FFF5', VENDOR_CHANNELS.fff5],
    ];
    for (const [label, uuid] of channels) {
      if (this.gizwitsProbeToken !== token) return;
      try {
        const value = await connection.read(VENDOR_SERVICE, uuid);
        this.trace('rx', `Teste Gizwits: leitura ${label}`, value);
      } catch (error) {
        this.trace('info', `Teste Gizwits: ${label} sem leitura (${errorMessage(error)})`);
      }
    }
  }

  async runGizwitsProbe(): Promise<void> {
    if (this.gizwitsProbeInFlight) return;
    if (this.snapshot.phase !== 'connected' || !this.connection) return;
    if (!this.snapshot.identityConfirmed) return;
    if (this.snapshot.mode === 'demo') {
      this.setGizwitsProbe({ status: 'unavailable', detail: 'modo demonstração', hint: null });
      return;
    }
    if (!this.snapshot.vendor.available) {
      this.setGizwitsProbe({
        status: 'unavailable',
        detail: 'esta esteira não expôs o canal 0xFFF0',
        hint: null,
      });
      return;
    }
    if (this.beltMayBeRunning()) {
      this.setGizwitsProbe({
        status: 'waitingBelt',
        stage: null,
        hint: 'No painel, pare a esteira. Eu termino o teste do canal alternativo sozinho.',
        detail: 'a lona está andando',
      });
      this.trace('info', 'Teste Gizwits: adiado com a lona andando');
      return;
    }

    const token = ++this.gizwitsProbeToken;
    const startedAt = this.options.now();
    this.gizwitsProbeInFlight = true;
    this.gizwitsProbeObservations = [];
    this.update({
      gizwitsProbe: {
        ...EMPTY_GIZWITS_PROBE,
        status: 'running',
        stage: 'machine info',
        startedAt,
        attempts: [],
      },
    });
    this.trace('info', 'Teste Gizwits: começando o plano automático');
    try {
      const connection = this.probeConnection();
      if (!(await this.subscribeGizwitsProbe(connection, token))) {
        throw new Error('não foi possível assinar o FFF4');
      }
      await this.traceGizwitsReads(connection, token);

      // 1) O handshake do app AFG: pede machine info no FFF3.
      let target: GizwitsTarget = 'fff3';
      let reply = await this.runGizwitsAttempt(
        connection,
        token,
        'machine-info',
        'machine info (FFF3)',
        target,
        GIZWITS_MACHINE_INFO_REQUEST,
        5000,
      );

      // 2) Sem resposta: variantes baratas e seguras.
      if (!reply) {
        const variants: GizwitsVariant[] = [
          {
            name: 'fff1',
            label: 'machine info no FFF1',
            target: 'fff1',
            frame: GIZWITS_MACHINE_INFO_REQUEST,
            timeoutMs: 2500,
          },
          {
            name: 'seq',
            label: 'machine info com sequência 1',
            target: 'fff3',
            frame: encodeGizwitsFrame(GIZWITS_LINGO.general, GIZWITS_COMMANDS.general.getMachineInfo, undefined, 1),
            timeoutMs: 2500,
          },
          {
            // Pausar com a lona parada é inofensivo; serve para testar o CRC invertido.
            name: 'crc-be',
            label: 'pausar com CRC invertido',
            target: 'fff3',
            frame: reverseCrc(encodeGizwitsFrame(GIZWITS_LINGO.remote, GIZWITS_COMMANDS.remote.pauseWorkout, Uint8Array.of(0))),
            timeoutMs: 2500,
          },
          {
            name: 'aa55',
            label: 'machine info com sincronismo AA 55',
            target: 'fff3',
            frame: reverseSync(GIZWITS_MACHINE_INFO_REQUEST),
            timeoutMs: 2500,
          },
          {
            name: 'pause-std',
            label: 'pausar com CRC normal',
            target: 'fff3',
            frame: encodeGizwitsPause(false),
            timeoutMs: 2500,
          },
          {
            name: 'ack',
            label: 'ack do canal remoto',
            target: 'fff3',
            frame: encodeGizwitsFrame(GIZWITS_LINGO.remote, 0),
            timeoutMs: 2000,
          },
        ];
        for (const variant of variants) {
          if (this.beltMayBeRunning()) {
            this.setGizwitsProbe({
              status: 'waitingBelt',
              stage: null,
              hint: 'No painel, pare a esteira. Eu termino o teste do canal alternativo sozinho.',
              detail: 'a lona começou a andar durante o teste',
            });
            return;
          }
          reply = await this.runGizwitsAttempt(
            connection,
            token,
            variant.name,
            variant.label,
            variant.target,
            variant.frame,
            variant.timeoutMs,
          );
          if (reply) {
            target = variant.target;
            break;
          }
        }
      }

      if (this.gizwitsProbeToken !== token) return;

      if (!reply) {
        // 2.1) Ainda sem resposta: varredura automática de bytes seguros.
        const sweepReply = await this.runAutomaticGizwitsSweep(connection, token);
        if (this.gizwitsProbeToken !== token) return;
        if (this.snapshot.gizwitsProbe.status === 'waitingBelt') return;
        if (sweepReply) {
          this.setGizwitsProbe({
            status: 'compatible',
            stage: null,
            compatible: true,
            finishedAt: this.options.now(),
            replyHex: bytesToHex(sweepReply.slice(0, GIZWITS_PROBE_REPLY_LIMIT)),
            replyBytes: sweepReply.length,
            replyCommand: null,
            detail: 'o canal enviou dados durante a varredura automática',
            hint: null,
          });
          this.trace('info', 'Teste Gizwits: varredura recebeu dados');
          this.notify(
            'info',
            'Teste automático do canal alternativo: a esteira enviou dados durante a varredura. O detalhe fica na Sonda.',
          );
          return;
        }
      }

      if (!reply) {
        this.setGizwitsProbe({
          status: 'incompatible',
          stage: null,
          compatible: false,
          finishedAt: this.options.now(),
          detail: 'a esteira não respondeu a nenhuma das tentativas',
          hint: null,
        });
        this.trace('info', 'Teste Gizwits: nenhuma tentativa respondeu');
        this.notify(
          'info',
          'Teste automático do canal alternativo: a esteira não respondeu a nenhuma tentativa. O treino segue normal.',
        );
        return;
      }

      const parsed = parseGizwitsFrame(reply);
      this.setGizwitsProbe({
        status: 'running',
        compatible: true,
        replyHex: bytesToHex(reply.slice(0, GIZWITS_PROBE_REPLY_LIMIT)),
        replyBytes: reply.length,
        replyCommand: parsed === null ? null : gizwitsCommandName(parsed.lingo, parsed.command),
      });
      this.trace('info', 'Teste Gizwits: canal respondeu; seguindo com testes seguros');

      // 3) Canal respondeu: testa comandos de leitura/parada, nunca de movimento.
      const safeSteps: GizwitsSafeStep[] = [
        {
          name: 'workout-data',
          label: 'consultar dados do treino',
          frame: encodeGizwitsFrame(
            GIZWITS_LINGO.general,
            GIZWITS_COMMANDS.general.getWorkoutData,
          ),
          timeoutMs: 2000,
        },
        {
          name: 'stop-idle',
          label: 'parar treino (já parado)',
          frame: encodeGizwitsFrame(GIZWITS_LINGO.general, GIZWITS_COMMANDS.general.stopWorkout),
          timeoutMs: 2000,
        },
        {
          name: 'pause-idle',
          label: 'pausar (já parado)',
          frame: encodeGizwitsFrame(
            GIZWITS_LINGO.remote,
            GIZWITS_COMMANDS.remote.pauseWorkout,
            Uint8Array.of(0),
          ),
          timeoutMs: 2000,
        },
      ];
      for (const step of safeSteps) {
        if (this.beltMayBeRunning()) {
          this.setGizwitsProbe({
            status: 'waitingBelt',
            stage: null,
            hint: 'No painel, pare a esteira. Eu termino o teste do canal alternativo sozinho.',
            detail: 'a lona começou a andar durante o teste',
          });
          return;
        }
        await this.runGizwitsAttempt(
          connection,
          token,
          step.name,
          step.label,
          target,
          step.frame,
          step.timeoutMs,
        );
        if (this.gizwitsProbeToken !== token) return;
      }

      const answered = this.snapshot.gizwitsProbe.attempts.filter(
        (attempt) => attempt.status === 'reply',
      ).length;
      this.setGizwitsProbe({
        status: 'compatible',
        stage: null,
        finishedAt: this.options.now(),
        detail: `canal compatível: ${answered} tentativa(s) com resposta`,
        hint: null,
      });
      this.trace('info', `Teste Gizwits: plano concluído com ${answered} resposta(s)`);
      this.notify(
        'info',
        'Teste automático do canal alternativo: a esteira respondeu. Os controles do app agora usam esse canal.',
      );
    } catch (error) {
      if (this.gizwitsProbeToken !== token) return;
      const detail = errorMessage(error);
      this.setGizwitsProbe({
        status: 'error',
        stage: null,
        finishedAt: this.options.now(),
        detail,
        hint: 'A conexão atrapalhou o teste. Desconecte e conecte de novo para repetir.',
      });
      this.trace('error', 'Teste Gizwits: ' + detail);
    } finally {
      if (token === this.gizwitsProbeToken) {
        this.gizwitsProbeInFlight = false;
        this.gizwitsProbeObservations = null;
        this.removeGizwitsProbeSubscription();
      }
    }
  }

  private updateGizwitsProbe(patch: Partial<GizwitsProbeSnapshot>): void {
    this.setGizwitsProbe(patch);
  }

  private handleVendorReply(bytes: Uint8Array): void {
    const hex = bytesToHex(bytes);
    this.trace('rx', 'Controle 0xFFF0: resposta', bytes);
    this.vendorReplyCollector?.push(hex);
    this.update({
      vendor: { ...this.snapshot.vendor, lastReply: { at: this.options.now(), hex } },
    });
  }

  private async writeVendor(
    target: VendorTarget,
    bytes: Uint8Array,
    label: string,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection || this.snapshot.phase !== 'connected') {
      throw new Error('sem conexão com a esteira');
    }
    this.trace('info', `Controle 0xFFF0: ${label} (${bytesToHex(bytes)})`);
    // A escrita no 0xFFF0 não tem indication de confirmação; o prazo evita que um
    // rádio travado segure o Parar ou a próxima tentativa para sempre.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`a escrita não terminou em ${this.options.writeTimeoutMs} ms`)),
        this.options.writeTimeoutMs,
      );
      connection.write(VENDOR_SERVICE, vendorTargetUuid(target), bytes).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    this.trace('tx', `Controle 0xFFF0: ${label}`, bytes);
  }

  /** Envia a ação pelo canal proprietário. Devolve `false` quando não há o que enviar. */
  private async sendVendorAction(action: VendorAction, value: number | null): Promise<boolean> {
    if (this.snapshot.vendor.discovery?.running) {
      this.notify('warning', 'Aguarde a varredura do 0xFFF0 terminar antes de mandar comandos.');
      return false;
    }
    const mapping = this.snapshot.vendor.mapping;
    if (!mapping) {
      this.notify('warning', 'Nenhum protocolo experimental configurado. Escolha um na Sonda.');
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = buildVendorPayload(mapping, action, value);
    } catch (error) {
      this.notify('warning', errorMessage(error));
      return false;
    }
    const at = this.options.now();
    const tally = (ok: boolean) => {
      // O canal não responde: uma escrita aceita é "sem resposta", não "aceita".
      if (!this.stopRequested) {
        this.bumpTally(commandKindOfVendorAction(action), ok ? 'unconfirmed' : 'refused');
      }
    };
    const outcome = (ok: boolean, error: string | null) => {
      this.update({
        vendor: {
          ...this.snapshot.vendor,
          lastSend: { action, hex: bytesToHex(bytes), at, ok, error },
        },
      });
      tally(ok);
    };
    try {
      await this.writeVendor(mapping.target, bytes, VENDOR_ACTION_LABELS[action]);
    } catch (error) {
      outcome(false, errorMessage(error));
      this.notify(
        'error',
        `Falha ao enviar "${VENDOR_ACTION_LABELS[action]}" pelo 0xFFF0: ${errorMessage(error)}`,
      );
      return false;
    }
    outcome(true, null);
    return true;
  }

  private changeSpeedVendor(deltaKmh: number): void {
    const capabilities = this.snapshot.capabilities;
    if (!capabilities) return;
    if (this.stopRequested || this.isStartBlocked()) {
      this.notify('info', 'Aguarde a lona parar antes de ajustar a velocidade.');
      return;
    }
    const measured = this.snapshot.metrics.speedKmh;
    if (this.snapshot.belt !== 'running' || measured === null || measured <= 0) {
      this.notify('info', 'Inicie a lona para ajustar a velocidade.');
      return;
    }
    // A velocidade medida é a única base confiável: o alvo notificado pode vir na
    // escala errada do firmware e não há confirmação do canal proprietário.
    const target = quantize(measured + deltaKmh, capabilities.speedRange);
    if (target === this.snapshot.targetSpeedKmh) return;
    if (Math.abs(target - measured) > Math.max(1, Math.abs(deltaKmh) * 2)) {
      this.notify(
        'warning',
        'Ajuste de velocidade recusado: o alvo calculado ficou longe da velocidade medida.',
      );
      return;
    }
    this.countRequest('speed');
    this.speedTargetSetAt = this.options.now();
    this.update({ targetSpeedKmh: target });
    const action: VendorAction = deltaKmh > 0 ? 'speedUp' : 'speedDown';
    void this.sendVendorAction(action, target).then((ok) => {
      if (!ok && this.snapshot.targetSpeedKmh === target) {
        this.invalidateSpeedTarget();
      }
    });
  }

  /**
   * Inclinação plausível para servir de base no controle experimental. O alvo
   * notificado em 0x2ADA já usa a unidade certa (0,1 %); a medição do 0x2ACD
   * desta unidade vem inflada ~6,667× (dossiê §7.2) e precisa ser convertida.
   */
  /**
   * Converte a inclinação lida no 0x2ACD para a escala real quando a faixa
   * declarada denuncia o template do firmware (o contador interno usa raw×0,015;
   * o app lê raw/10, então toda leitura acima de ~2 % já vem inflada).
   */
  private correctedInclinationReading(percent: number): number {
    const range = this.snapshot.capabilities?.inclinationRange;
    if (!range || plausibleInclinationRange(range) === range) {
      return percent;
    }
    return percent * T600X_INCLINATION_READING_FACTOR;
  }

  private vendorInclinationBase(): number | null {
    const limit = T600X_INCLINATION_RANGE.max + 0.5;
    const target = this.snapshot.targetInclinationPercent;
    if (target !== null && target >= 0 && target <= limit) {
      return target;
    }
    const measured = this.snapshot.metrics.inclinationPercent;
    if (measured === null || measured < 0) return null;
    const corrected = this.correctedInclinationReading(measured);
    return corrected >= 0 && corrected <= limit ? corrected : null;
  }

  private changeInclinationVendor(deltaPercent: number): void {
    const capabilities = this.snapshot.capabilities;
    if (!capabilities) return;
    if (this.stopRequested || this.isStartBlocked()) {
      this.notify('info', 'Aguarde a lona parar antes de ajustar a inclinação.');
      return;
    }
    // No canal experimental o alvo vale de verdade: usa a faixa plausível, não a
    // declarada pelo template do FTMS (0–50 %/3 % nesta unidade).
    const range = plausibleInclinationRange(capabilities.inclinationRange);
    const base = this.vendorInclinationBase();
    if (base === null) {
      this.notify(
        'warning',
        'Sem leitura de inclinação confiável nesta conexão; ajuste pelo painel da esteira.',
      );
      return;
    }
    const target = quantize(base + deltaPercent, range);
    if (target === this.snapshot.targetInclinationPercent) return;
    if (Math.abs(target - base) > Math.max(range.step * 2, Math.abs(deltaPercent) * 2)) {
      this.notify('warning', 'Ajuste de inclinação recusado: o alvo ficou longe da inclinação medida.');
      return;
    }
    this.countRequest('inclination');
    this.update({ targetInclinationPercent: target });
    const action: VendorAction = deltaPercent > 0 ? 'inclineUp' : 'inclineDown';
    void this.sendVendorAction(action, target).then((ok) => {
      if (!ok && this.snapshot.targetInclinationPercent === target) {
        this.invalidateInclinationTarget();
      }
    });
  }

  private requestBeltVendor(action: BeltCommand | 'stop'): void {
    if (action === 'stop') {
      // O Parar não pode ficar preso atrás da varredura: cancela e manda os bytes.
      this.cancelVendorDiscovery();
      this.countRequest('stop');
      this.dropQueuedCommands();
      this.dropPendingSpeed();
      this.markBraked();
      this.invalidateSpeedTarget();
      this.invalidateInclinationTarget();
      // Em paralelo, tenta o Control Point do FTMS: nesta T600X ele recusa, mas se
      // o canal proprietário for só configuração, o Parar não pode depender dele.
      this.requestStop();
      void this.sendVendorAction('stop', null).then((ok) => {
        this.notify(
          ok ? 'info' : 'warning',
          ok
            ? 'Parar enviado pelo canal experimental (e tentado pelo FTMS). Se a lona não parar, use o painel ou o Emergency Stop.'
            : 'Não foi possível enviar o Parar pelo 0xFFF0. O app tentou o FTMS; se a lona não parar, use o painel ou o Emergency Stop.',
        );
      });
      return;
    }
    if (action === 'start') {
      if (this.stopRequested || this.isStartBlocked()) return;
      this.countRequest('start');
      void this.sendVendorAction('start', null).then((ok) => {
        if (ok) this.notify('info', 'Iniciar enviado pelo canal experimental; confira o painel.');
      });
      return;
    }
    if (this.stopRequested) return;
    this.cancelVendorDiscovery();
    this.countRequest('pause');
    this.markBraked();
    this.dropPendingSpeed();
    void this.sendVendorAction('pause', null).then((ok) => {
      if (ok) this.notify('info', 'Pausar enviado pelo canal experimental; confira o painel.');
    });
  }

  /**
   * Varredura segura do 0xFFF0: escreve 1 byte por vez (ou `AT`) nas
   * características de escrita, com o FFF4 assinado, e registra o que mudou.
   * Não manda comando de controle nenhum; a lona precisa estar parada.
   */
  private async runVendorDiscovery(): Promise<void> {
    if (this.vendorDiscoveryActive || this.snapshot.vendor.discovery?.running) return;
    if (this.snapshot.phase !== 'connected' || !this.snapshot.identityConfirmed) {
      this.notify('warning', 'Conecte e confirme a esteira antes de sondar o 0xFFF0.');
      return;
    }
    if (!this.snapshot.vendor.available) {
      this.notify('error', 'Esta esteira não expôs o canal proprietário 0xFFF0.');
      return;
    }
    if (this.snapshot.belt === 'running') {
      this.notify('warning', 'Pare a lona antes de rodar a varredura do 0xFFF0.');
      return;
    }
    const epoch = ++this.vendorDiscoveryEpoch;
    this.vendorDiscoveryActive = true;
    const candidates = VENDOR_DISCOVERY_CANDIDATES;
    try {
      try {
        await this.ensureVendorSubscription();
      } catch (error) {
        this.notify('error', `Não foi possível assinar o FFF4: ${errorMessage(error)}`);
        return;
      }
      if (epoch !== this.vendorDiscoveryEpoch || this.snapshot.phase !== 'connected') {
        this.notify('warning', 'A conexão caiu antes de começar a varredura.');
        return;
      }
      this.update({
        vendor: {
          ...this.snapshot.vendor,
          discovery: { running: true, index: 0, total: candidates.length, observations: [] },
        },
      });
      this.notify(
        'info',
        'Varredura do 0xFFF0 iniciada: 1 byte por vez, com 6 s de observação cada (cerca de 70 s no total). Lona vazia e Emergency Stop à mão.',
      );
      for (let index = 0; index < candidates.length; index++) {
        if (epoch !== this.vendorDiscoveryEpoch || this.snapshot.phase !== 'connected') return;
        if (this.beltMayBeRunning()) {
          // Se a lona andou, algo respondeu: parar a varredura e mandar Parar.
          this.cancelVendorDiscovery();
          this.notify('warning', 'A lona começou a andar: varredura do 0xFFF0 interrompida.');
          this.requestStop();
          void this.sendVendorAction('stop', null);
          return;
        }
        const observation = await this.runVendorCandidate(candidates[index], epoch);
        if (epoch !== this.vendorDiscoveryEpoch || this.snapshot.phase !== 'connected') return;
        const current = this.snapshot.vendor.discovery;
        if (!current) return;
        this.trace(
          'info',
          'Controle 0xFFF0: varredura — ' +
            observation.label +
            ' → FFF4=[' +
            (observation.replies.length > 0 ? observation.replies.join(' ') : 'nada') +
            '] FFF1=' +
            (observation.fff1Before ?? '?') +
            '→' +
            (observation.fff1After ?? '?') +
            ' FFF2=' +
            (observation.fff2Before ?? '?') +
            '→' +
            (observation.fff2After ?? '?') +
            ' vel=' +
            String(observation.speedBefore) +
            '→' +
            String(observation.speedAfter) +
            (observation.error ? ' erro=' + observation.error : ''),
        );
        this.update({
          vendor: {
            ...this.snapshot.vendor,
            discovery: {
              ...current,
              index: index + 1,
              observations: [...current.observations, observation],
            },
          },
        });
        await wait(VENDOR_DISCOVERY_PAUSE_MS);
      }
      if (epoch !== this.vendorDiscoveryEpoch) return;
      const discovery = this.snapshot.vendor.discovery;
      if (!discovery) return;
      this.update({
        vendor: { ...this.snapshot.vendor, discovery: { ...discovery, running: false } },
      });
      const hits = discovery.observations.filter(
        (observation) =>
          observation.replies.length > 0 ||
          observation.fff1After !== observation.fff1Before ||
          observation.fff2After !== observation.fff2Before ||
          observation.speedAfter !== observation.speedBefore ||
          observation.inclinationAfter !== observation.inclinationBefore,
      );
      this.notify(
        hits.length > 0 ? 'warning' : 'info',
        hits.length > 0
          ? `Varredura concluída: ${hits.length} de ${discovery.total} bytes provocaram resposta. Veja os resultados na Sonda.`
          : 'Varredura concluída: nenhum dos bytes testados provocou resposta visível no 0xFFF0.',
      );
    } finally {
      if (epoch === this.vendorDiscoveryEpoch) {
        this.vendorDiscoveryActive = false;
      }
    }
  }

  private cancelVendorDiscovery(): void {
    const discovery = this.snapshot.vendor.discovery;
    if (!discovery?.running) return;
    this.vendorDiscoveryEpoch++;
    this.vendorDiscoveryActive = false;
    this.update({
      vendor: { ...this.snapshot.vendor, discovery: { ...discovery, running: false } },
    });
    this.trace('info', 'Controle 0xFFF0: varredura cancelada');
    this.notify('info', 'Varredura do 0xFFF0 cancelada.');
  }

  private async runVendorCandidate(
    candidate: VendorDiscoveryCandidate,
    epoch: number,
  ): Promise<VendorDiscoveryObservation> {
    const metricsBefore = this.snapshot.metrics;
    const fff1Before = await this.readVendorChannel(VENDOR_CHANNELS.fff1);
    const fff2Before = await this.readVendorChannel(VENDOR_CHANNELS.fff2);
    this.vendorReplyCollector = [];
    let hex = '';
    let error: string | null = null;
    if (epoch !== this.vendorDiscoveryEpoch || this.snapshot.phase !== 'connected') {
      // Cancelou ou caiu durante as leituras: não escreve nada.
      this.vendorReplyCollector = null;
      return {
        label: candidate.label,
        target: candidate.target,
        hex,
        at: this.options.now(),
        error: 'varredura cancelada antes da escrita',
        replies: [],
        fff1Before,
        fff1After: fff1Before,
        fff2Before,
        fff2After: fff2Before,
        speedBefore: metricsBefore.speedKmh,
        speedAfter: this.snapshot.metrics.speedKmh,
        inclinationBefore: metricsBefore.inclinationPercent,
        inclinationAfter: this.snapshot.metrics.inclinationPercent,
      };
    }
    try {
      const bytes = buildLiteralPayload(candidate.format, candidate.payload);
      hex = bytesToHex(bytes);
      await this.writeVendor(candidate.target, bytes, 'descoberta ' + candidate.label);
    } catch (writeError) {
      error = errorMessage(writeError);
    }
    await wait(VENDOR_DISCOVERY_SETTLE_MS);
    const replies = this.vendorReplyCollector ?? [];
    this.vendorReplyCollector = null;
    const fff1After = await this.readVendorChannel(VENDOR_CHANNELS.fff1);
    const fff2After = await this.readVendorChannel(VENDOR_CHANNELS.fff2);
    return {
      label: candidate.label,
      target: candidate.target,
      hex,
      at: this.options.now(),
      error,
      replies,
      fff1Before,
      fff1After,
      fff2Before,
      fff2After,
      speedBefore: metricsBefore.speedKmh,
      speedAfter: this.snapshot.metrics.speedKmh,
      inclinationBefore: metricsBefore.inclinationPercent,
      inclinationAfter: this.snapshot.metrics.inclinationPercent,
    };
  }

  private async readVendorChannel(characteristicUuid: string): Promise<string | null> {
    const connection = this.connection;
    if (!connection) return null;
    try {
      const bytes = await readWithTimeout(
        connection,
        VENDOR_SERVICE,
        characteristicUuid,
        VENDOR_DISCOVERY_READ_TIMEOUT_MS,
      );
      return bytesToHex(bytes);
    } catch {
      return null;
    }
  }

  /**
   * Parar não entra na fila: enquanto houver um Parar a executar, nenhum outro
   * comando é escrito e nenhuma espera se prolonga.
   */
  private requestStop(): void {
    this.markBraked();
    this.dropQueuedCommands();
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.stopRequestedAt = this.options.now();
    const epoch = this.linkEpoch;
    // Quem estiver esperando para repetir um pedido de controle acorda já.
    this.wakeSleep?.();
    // A resposta do comando em andamento só é esperada por um instante. Uma
    // esteira que responde no tempo normal termina antes, e o Parar sai sem
    // disputar o Control Point com ele.
    setTimeout(() => {
      if (
        epoch === this.linkEpoch &&
        this.stopRequested &&
        this.pendingResponse &&
        !this.pendingResponse.urgent
      ) {
        this.settlePendingResponse({ type: 'preempted' });
      }
    }, this.options.stopPreemptDelayMs);
    void this.pump();
  }

  /** Registra um Pausar ou Parar (do app ou da esteira) e bloqueia o Iniciar até a lona parar. */
  private markBraked(): void {
    this.brakedAt = this.options.now();
    this.refreshStartBlock();
  }

  /**
   * Para os avisos da esteira: só conta como frenagem nova se o estado da lona
   * muda. Uma esteira que repetisse o aviso com a lona já parada recomeçaria o
   * bloqueio do Iniciar a cada repetição.
   */
  private markBrakedIfBeltChanges(next: BeltState): void {
    if (this.snapshot.belt !== next) {
      this.markBraked();
    }
  }

  /**
   * Depois de Pausar ou Parar, o botão vira Iniciar/Retomar no mesmo lugar, e a
   * lona ainda girando convida a tocar de novo. Um Iniciar só volta a valer com
   * a lona parada há um instante — ou depois de um teto, para a esteira cuja
   * velocidade medida nunca chega a zero.
   */
  private isStartBlocked(): boolean {
    const now = this.options.now();
    const sinceBrake = now - this.brakedAt;
    if (sinceBrake >= this.options.startMaxLockoutMs) {
      return false;
    }
    if (sinceBrake < this.options.startLockoutMs) {
      return true;
    }
    const speed = this.snapshot.metrics.speedKmh;
    if (speed !== null && speed > 0) {
      return true;
    }
    const stillSince = Math.max(this.zeroSpeedSince ?? this.brakedAt, this.brakedAt);
    return now - stillSince < this.options.startSettleMs;
  }

  private refreshStartBlock(): void {
    if (this.startBlockTimer) {
      clearTimeout(this.startBlockTimer);
      this.startBlockTimer = null;
    }
    const blocked = this.isStartBlocked();
    this.update({ startBlocked: blocked });
    if (blocked) {
      // Reavalia mesmo que a esteira pare de mandar dados.
      this.startBlockTimer = setTimeout(() => this.refreshStartBlock(), 250);
    }
  }

  /** Esvazia a fila e devolve os alvos exibidos ao último valor confirmado. Um Parar pedido continua valendo. */
  private dropQueuedCommands(): void {
    this.beltQueue = [];
    this.dropPendingSpeed();
    if (this.pendingInclination !== null) {
      this.pendingInclination = null;
      this.update({ targetInclinationPercent: this.confirmedInclination });
    }
  }

  private dropPendingSpeed(): void {
    if (this.pendingSpeed !== null) {
      this.pendingSpeed = null;
      this.update({ targetSpeedKmh: this.confirmedSpeed });
    }
  }

  /** O alvo de velocidade deixou de valer, inclusive o de um ajuste ainda em andamento. */
  private invalidateSpeedTarget(): void {
    this.speedTargetEpoch++;
    this.confirmedSpeed = null;
    this.pendingSpeed = null;
    this.update({ targetSpeedKmh: null });
  }

  private invalidateInclinationTarget(): void {
    this.inclinationTargetEpoch++;
    this.confirmedInclination = null;
    this.pendingInclination = null;
    this.update({ targetInclinationPercent: null });
  }

  private targetEpochOf(command: Command): number {
    return command.kind === 'speed'
      ? this.speedTargetEpoch
      : command.kind === 'inclination'
        ? this.inclinationTargetEpoch
        : 0;
  }

  private takeNextCommand(): QueuedCommand | null {
    const action = this.beltQueue.shift();
    if (action) {
      return { kind: 'belt', action };
    }
    if (this.pendingSpeed !== null) {
      const kmh = this.pendingSpeed;
      this.pendingSpeed = null;
      return { kind: 'speed', kmh };
    }
    if (this.pendingInclination !== null) {
      const percent = this.pendingInclination;
      this.pendingInclination = null;
      return { kind: 'inclination', percent };
    }
    return null;
  }

  /**
   * Executa os comandos, um procedimento por vez: a esteira recusa uma escrita
   * no Control Point enquanto o procedimento anterior não terminou. Toques
   * repetidos em "+" só atualizam o alvo pendente, então viram um comando só.
   * Um Parar pedido passa na frente de tudo.
   */
  private async pump(): Promise<void> {
    const epoch = this.linkEpoch;
    if (this.pumpingEpoch === epoch) {
      return;
    }
    this.pumpingEpoch = epoch;
    this.update({ busy: true });
    try {
      while (epoch === this.linkEpoch) {
        if (this.stopRequested) {
          await this.executeStop(epoch);
          continue;
        }
        const command = this.takeNextCommand();
        if (!command) break;
        await this.execute(command, epoch);
      }
    } finally {
      // Se o link mudou no meio, a fila já foi zerada por `resetLinkState` (e
      // pode haver outra rodando para o link novo): não mexe em nada.
      if (this.pumpingEpoch === epoch) {
        this.pumpingEpoch = null;
        this.update({ busy: false });
      }
    }
  }

  /** Executa um comando que não é o Parar. */
  private async execute(command: QueuedCommand, epoch: number): Promise<void> {
    // A esteira chia a cada comando recebido; não repete um alvo que ela já tem.
    if (command.kind === 'speed' && command.kmh === this.confirmedSpeed) return;
    if (command.kind === 'inclination' && command.percent === this.confirmedInclination) return;
    if (command.kind === 'speed' && this.snapshot.belt !== 'running') {
      // A lona parou ou foi pausada entre o toque e o envio.
      this.revert(command);
      return;
    }

    const targetEpoch = this.targetEpochOf(command);
    if (command.kind === 'belt') this.inFlightBelt = command.action;
    if (command.kind === 'speed') this.speedInFlight = true;
    try {
      const outcome = await this.runWithControl(command, epoch);
      if (!outcome || epoch !== this.linkEpoch) {
        return;
      }
      if (targetEpoch !== this.targetEpochOf(command)) {
        // A esteira parou ou foi reiniciada com este ajuste em andamento: o
        // alvo que ele definiu já não é o que a esteira vai seguir.
        return;
      }
      this.applyOutcome(command, outcome);
    } finally {
      if (epoch === this.linkEpoch) {
        this.inFlightBelt = null;
        this.speedInFlight = false;
      }
    }
  }

  /**
   * Garante a permissão de controle e executa o procedimento. Devolve `null`
   * quando o comando foi abandonado antes de ter um resultado.
   */
  private async runWithControl(
    command: QueuedCommand,
    epoch: number,
  ): Promise<ProcedureOutcome | null> {
    const run = () => this.runProcedure(commandBytes(command), commandLabel(command), false);

    if (this.snapshot.control !== 'granted') {
      const control = await this.requestControl(epoch);
      if (control.status !== 'granted') {
        this.abandon(command, epoch, control);
        return null;
      }
    }
    let outcome = await run();
    if (
      outcome.type === 'result' &&
      outcome.resultCode === ControlPointResult.ControlNotPermitted
    ) {
      // A esteira tirou o controle sem avisar: pede de novo, uma vez só.
      this.update({ control: 'idle' });
      const control = await this.requestControl(epoch);
      if (control.status !== 'granted') {
        this.abandon(command, epoch, control);
        return null;
      }
      outcome = await run();
    }
    return outcome;
  }

  /** O comando não vai ser enviado: sem controle, ou atropelado por um Parar. */
  private abandon(command: QueuedCommand, epoch: number, control: ControlOutcome): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    this.revert(command);
    switch (control.status) {
      case 'granted':
      case 'preempted':
      case 'linkLost':
        return;
      case 'writeFailed':
        this.tally(command, 'refused');
        this.dropQueuedCommands();
        this.notify(
          'error',
          // A primeira escrita no Control Point é o momento em que o sistema
          // pareia com a esteira, se ela exigir.
          `Não foi possível pedir o controle da esteira: ${control.error.message}. Se o celular pedir para parear com a esteira, aceite (e use o código do painel, se pedir um) e repita o comando.`,
        );
        return;
      case 'refused':
        this.tally(command, 'refused');
        this.dropQueuedCommands();
        this.notify(
          'error',
          `A esteira recusou o controle pelo app (${controlPointResultName(control.resultCode)}).`,
        );
    }
  }

  /**
   * Para a lona. Insiste até a esteira aceitar a escrita ou o prazo acabar: se
   * o Parar atropelou um procedimento que a esteira ainda não concluiu (uma
   * partida com contagem regressiva, por exemplo), ela recusa escritas até
   * concluí-lo.
   */
  private async executeStop(epoch: number): Promise<void> {
    const command: Command = { kind: 'stop' };
    const deadline = this.stopRequestedAt + this.options.stopDeadlineMs;
    try {
      while (epoch === this.linkEpoch) {
        let failure: string;
        const control: ControlOutcome =
          this.snapshot.control === 'granted'
            ? { status: 'granted' }
            : await this.requestControlOnce(true, deadline);
        if (epoch !== this.linkEpoch || control.status === 'linkLost') {
          return;
        }
        if (control.status === 'refused') {
          this.tally(command, 'refused');
          this.notify(
            'error',
            `A esteira recusou o controle pelo app, e sem ele não aceita o Parar. ${STOP_FALLBACK}`,
          );
          return;
        }
        if (control.status === 'granted') {
          const outcome = await this.runProcedure(
            commandBytes(command),
            commandLabel(command),
            true,
            deadline,
          );
          if (epoch !== this.linkEpoch || outcome.type === 'linkLost') {
            return;
          }
          if (
            outcome.type === 'result' &&
            outcome.resultCode === ControlPointResult.ControlNotPermitted
          ) {
            this.update({ control: 'idle' });
            failure = 'a esteira não reconheceu o controle do app';
          } else if (outcome.type === 'writeError') {
            failure = outcome.error.message;
          } else {
            this.applyOutcome(command, outcome);
            return;
          }
        } else {
          failure =
            control.status === 'writeFailed'
              ? control.error.message
              : 'o pedido de controle foi interrompido';
        }
        if (this.options.now() + this.options.stopRetryDelayMs + STOP_MIN_ATTEMPT_MS > deadline) {
          this.tally(command, 'refused');
          this.notify('error', `Não foi possível parar a lona pelo app: ${failure}. ${STOP_FALLBACK}`);
          return;
        }
        await this.sleep(this.options.stopRetryDelayMs);
      }
    } finally {
      if (epoch === this.linkEpoch) this.stopRequested = false;
    }
  }

  private applyOutcome(command: Command, outcome: ProcedureOutcome): void {
    const verb = commandVerb(command);
    const isStop = command.kind === 'stop';
    if (outcome.type === 'timeout') {
      this.tally(command, 'unconfirmed');
    } else if (outcome.type === 'writeError' || outcome.type === 'result') {
      const accepted =
        outcome.type === 'result' && outcome.resultCode === ControlPointResult.Success;
      this.tally(command, accepted ? 'accepted' : 'refused');
    }
    switch (outcome.type) {
      case 'linkLost':
        return;
      case 'preempted':
        this.revert(command);
        return;
      case 'writeError':
        this.revert(command);
        this.notify('error', `Não foi possível ${verb}: ${outcome.error.message}`);
        return;
      case 'timeout':
        // Sem confirmação não dá para saber se a esteira obedeceu. Um alvo é
        // dado como aceito (se não se confirmar nos dados, é descartado); o
        // estado da lona, não: dizer "parada" com a lona girando seria pior que
        // não dizer nada, e a velocidade medida o corrige.
        if (command.kind === 'speed' || command.kind === 'inclination') this.confirm(command);
        this.notify(
          'warning',
          `A esteira não confirmou o comando para ${verb}.${isStop ? ` ${STOP_FALLBACK}` : ''}`,
        );
        return;
      case 'result':
        break;
    }
    switch (outcome.resultCode) {
      case ControlPointResult.Success:
        this.confirm(command);
        return;
      case ControlPointResult.OpCodeNotSupported:
        this.revert(command);
        this.notify(
          'error',
          `Esta esteira não permite ${verb} por Bluetooth.${isStop ? ` ${STOP_FALLBACK}` : ''}`,
        );
        return;
      case ControlPointResult.InvalidParameter:
        this.revert(command);
        this.notify('error', `A esteira recusou o valor enviado para ${verb}.`);
        return;
      case ControlPointResult.ControlNotPermitted:
        this.revert(command);
        this.update({ control: 'denied' });
        this.notify('error', 'A esteira não liberou o controle para o app.');
        return;
      case ControlPointResult.OperationFailed:
        this.revert(command);
        this.notify(
          isStop ? 'warning' : 'error',
          isStop
            ? `A esteira não executou a parada (ela pode já estar parada). ${STOP_FALLBACK}`
            : `A esteira não conseguiu ${verb} agora.`,
        );
        return;
      default:
        this.revert(command);
        this.notify(
          'error',
          `A esteira respondeu com um código desconhecido (${controlPointResultName(outcome.resultCode)}) ao ${verb}.${isStop ? ` ${STOP_FALLBACK}` : ''}`,
        );
    }
  }

  private tally(command: Command, outcome: 'accepted' | 'refused' | 'unconfirmed'): void {
    this.bumpTally(commandKind(command), outcome);
  }

  /**
   * Conta o toque que o app aceitou para enviar, na hora do toque. Quem observa a sessão sabe
   * assim que um Parar ou Pausar foi pedido, mesmo que a resposta demore ou nunca venha.
   */
  private countRequest(kind: CommandKind): void {
    this.bumpTally(kind, 'requested');
  }

  private bumpTally(kind: CommandKind, field: keyof CommandTally): void {
    const current = this.snapshot.commands[kind];
    this.update({
      commands: { ...this.snapshot.commands, [kind]: { ...current, [field]: current[field] + 1 } },
    });
  }

  /** O comando valeu: fixa o alvo ou o estado da lona. */
  private confirm(command: Command): void {
    switch (command.kind) {
      case 'speed':
        this.confirmedSpeed = command.kmh;
        this.speedTargetSetAt = this.options.now();
        this.settledSpeedSamples = 0;
        break;
      case 'inclination':
        this.confirmedInclination = command.percent;
        this.settledInclinationSamples = 0;
        break;
      // Nem toda esteira manda Fitness Machine Status a quem deu o comando: o
      // estado da lona é atualizado aqui também.
      case 'belt':
        if (command.action === 'pause') {
          this.dropPendingSpeed();
          this.update({ belt: 'paused' });
        } else {
          // A lona vai acelerar de volta ao alvo: ele ganha o prazo de novo.
          this.speedTargetSetAt = this.options.now();
          this.update({ belt: 'running' });
        }
        break;
      case 'stop':
        this.invalidateSpeedTarget();
        this.update({ belt: 'stopped' });
        break;
    }
  }

  /** O comando não valeu: o alvo exibido volta ao último confirmado. */
  private revert(command: Command): void {
    if (command.kind === 'speed' && this.pendingSpeed === null) {
      this.update({ targetSpeedKmh: this.confirmedSpeed });
    }
    if (command.kind === 'inclination' && this.pendingInclination === null) {
      this.update({ targetInclinationPercent: this.confirmedInclination });
    }
  }

  /** Pede o controle para um comando comum, com uma segunda tentativa se a escrita falhar. */
  private async requestControl(epoch: number): Promise<ControlOutcome> {
    let outcome = await this.requestControlOnce(false);
    if (
      outcome.status === 'writeFailed' &&
      epoch === this.linkEpoch &&
      !this.stopRequested &&
      this.hungWrites === 0
    ) {
      // O Control Point exige link criptografado: na primeira escrita o sistema
      // pode estar pareando com a esteira. Uma segunda tentativa cobre esse caso.
      await this.sleep(this.options.controlRetryDelayMs);
      if (epoch !== this.linkEpoch) return { status: 'linkLost' };
      outcome = await this.requestControlOnce(false);
    }
    return outcome;
  }

  private async requestControlOnce(
    urgent: boolean,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<ControlOutcome> {
    this.update({ control: 'requesting' });
    const outcome = await this.runProcedure(
      encodeRequestControl(),
      'Request Control',
      urgent,
      deadline,
    );
    switch (outcome.type) {
      case 'linkLost':
        return { status: 'linkLost' };
      case 'preempted':
        // Não se sabe se a esteira chegou a liberar; o Parar pede de novo.
        this.update({ control: 'idle' });
        return { status: 'preempted' };
      case 'writeError':
        this.update({ control: 'idle' });
        return { status: 'writeFailed', error: outcome.error };
      case 'timeout':
        // Esteira que não confirma nada: segue como se tivesse liberado. Se não
        // liberou, os comandos seguintes simplesmente não surtem efeito.
        this.update({ control: 'granted' });
        this.notify(
          'warning',
          'A esteira não confirmou o pedido de controle. Os comandos serão enviados mesmo assim.',
        );
        return { status: 'granted' };
      case 'result':
        if (outcome.resultCode === ControlPointResult.Success) {
          this.update({ control: 'granted' });
          return { status: 'granted' };
        }
        this.update({ control: 'denied' });
        return { status: 'refused', resultCode: outcome.resultCode };
    }
  }

  /**
   * Escreve no Control Point e espera a indication de resposta do mesmo op
   * code. `urgent` é o caminho do Parar: espera menos, não é barrado por um
   * Parar pendente (ele é o Parar) e não passa de `deadline`.
   *
   * A resposta é casada só pelo op code, que é tudo o que a indication traz.
   * Uma resposta atrasada de um comando já abandonado pode, por isso, ser
   * tomada como a do comando seguinte de mesmo op code.
   */
  private async runProcedure(
    bytes: Uint8Array,
    label: string,
    urgent: boolean,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<ProcedureOutcome> {
    const connection = this.connection;
    if (!connection) {
      return { type: 'linkLost' };
    }
    if (!urgent && this.stopRequested) {
      // Há um Parar a caminho: nada mais é escrito antes dele.
      return { type: 'preempted' };
    }
    if (!urgent && this.hungWrites > 0) {
      // Uma escrita anterior ainda está presa na fila do sistema (em geral,
      // esperando o pareamento). Outra entraria atrás dela e sairia fora de
      // hora, depois de o app já ter avisado que falhou.
      return {
        type: 'writeError',
        error: new Error(
          'a esteira ainda não respondeu a um comando anterior; se continuar assim, desconecte e conecte de novo',
        ),
      };
    }
    const remaining = () => Math.max(deadline - this.options.now(), 0);
    // A espera é armada antes da escrita: a indication pode chegar junto com a
    // confirmação da escrita.
    let settle!: (outcome: ProcedureOutcome) => void;
    const response = new Promise<ProcedureOutcome>((resolve) => {
      settle = resolve;
    });
    const pending = { opCode: bytes[0], urgent, settle };
    this.pendingResponse = pending;
    this.log('tx', label, bytes);

    const writeFailure = await Promise.race([
      this.writeControlPoint(connection, bytes, Math.min(this.options.writeTimeoutMs, remaining())),
      // Resposta, queda do link ou um Parar chegaram antes de a escrita terminar.
      response.then(() => 'settled' as const),
    ]);
    if (writeFailure === 'settled') {
      return response;
    }
    if (writeFailure) {
      this.log('error', `${label}: ${writeFailure.message}`);
      if (this.pendingResponse === pending) this.pendingResponse = null;
      return { type: 'writeError', error: writeFailure };
    }

    const timeoutMs = Math.min(
      urgent || this.controlPointSilent
        ? this.options.unconfirmedGraceMs
        : this.options.responseTimeoutMs,
      remaining(),
    );
    const timer = setTimeout(() => {
      if (this.pendingResponse !== pending) return;
      // A especificação manda encerrar o link depois de um timeout. Aqui a
      // sessão continua, de propósito: há esteiras que obedecem sem nunca
      // enviar a indication, e derrubar a conexão as tornaria inutilizáveis.
      this.controlPointSilent = true;
      this.log('error', `${label}: sem resposta em ${timeoutMs} ms`);
      this.settlePendingResponse({ type: 'timeout' });
    }, timeoutMs);
    const outcome = await response;
    clearTimeout(timer);
    return outcome;
  }

  /**
   * Escrita com prazo: `null` se deu certo, o erro se falhou. No Android a
   * biblioteca não devolve nada enquanto o sistema pareia com a esteira, e sem
   * o prazo o app ficaria esperando essa escrita indefinidamente. O prazo não
   * tira a escrita da fila do sistema: `hungWrites` conta as que ainda estão lá.
   */
  private writeControlPoint(
    connection: BleConnection,
    bytes: Uint8Array,
    timeoutMs: number,
  ): Promise<Error | null> {
    const epoch = this.linkEpoch;
    return new Promise((resolve) => {
      let hung = false;
      const timer = setTimeout(() => {
        hung = true;
        this.hungWrites++;
        resolve(new Error('a esteira não confirmou o recebimento do comando'));
      }, timeoutMs);
      const finished = (error: Error | null) => {
        clearTimeout(timer);
        if (hung && epoch === this.linkEpoch) this.hungWrites--;
        resolve(error);
      };
      connection.write(FTMS.service, FTMS.controlPoint, bytes).then(
        () => finished(null),
        (error: unknown) => finished(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private settlePendingResponse(outcome: ProcedureOutcome): void {
    const pending = this.pendingResponse;
    if (pending) {
      this.pendingResponse = null;
      pending.settle(outcome);
    }
  }

  /** Espera que um Parar (ou o fim da conexão) pode interromper. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        if (this.wakeSleep === wake) this.wakeSleep = null;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakeSleep = wake;
    });
  }

  // --- Estado --------------------------------------------------------------

  private update(patch: Partial<TreadmillSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof TreadmillSnapshot)[]) {
      if (patch[key] !== this.snapshot[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    const before = this.snapshot;
    this.snapshot = { ...this.snapshot, ...patch };
    this.traceStateChanges(before, this.snapshot);
    for (const listener of this.listeners) {
      // Um ouvinte com defeito não pode interromper quem chamou: `update` roda no meio do
      // caminho de um Parar.
      try {
        listener();
      } catch (error) {
        this.trace('error', `Um ouvinte da sessão falhou: ${errorMessage(error)}`);
      }
    }
  }

  /** Manda uma linha só para o registro completo (o arquivo), sem passar pela tela de diagnóstico. */
  private trace(kind: TraceLine['kind'], text: string, bytes?: Uint8Array): void {
    try {
      this.options.trace({
        at: this.options.now(),
        kind,
        text,
        hex: bytes ? bytesToHex(bytes) : null,
      });
    } catch {
      // O registro é acessório: uma falha ao gravar não pode afetar a esteira.
    }
  }

  private traceStateChanges(before: TreadmillSnapshot, after: TreadmillSnapshot): void {
    for (const key of TRACED_STATE) {
      if (before[key] !== after[key]) {
        this.trace('state', `${key}: ${String(before[key])} → ${String(after[key])}`);
      }
    }
    if (before.device !== after.device) {
      this.trace(
        'state',
        after.device ? `device: ${after.device.name ?? 'sem nome'} (${after.device.id})` : 'device: nenhum',
      );
    }
    if (before.capabilities !== after.capabilities && after.capabilities) {
      const { hasControlPoint, speedRange, inclinationRange, feature } = after.capabilities;
      this.trace(
        'state',
        `capabilities: Control Point ${hasControlPoint ? 'sim' : 'não'}; ` +
          `velocidade ${speedRange.min}–${speedRange.max} passo ${speedRange.step} (${speedRange.source}); ` +
          `inclinação ${inclinationRange.min}–${inclinationRange.max} passo ${inclinationRange.step} (${inclinationRange.source}); ` +
          (feature
            ? `features 0x${feature.machineFeaturesRaw.toString(16)} / alvos 0x${feature.targetSettingsRaw.toString(16)}`
            : 'Feature não lida'),
      );
    }
    if (before.notice !== after.notice && after.notice) {
      this.trace('state', `aviso (${after.notice.kind}): ${after.notice.message}`);
    }
    if (before.commands !== after.commands) {
      const summary = (Object.keys(after.commands) as CommandKind[])
        .map((kind) => {
          const tally = after.commands[kind];
          return `${kind} ${tally.requested}/${tally.accepted}/${tally.refused}/${tally.unconfirmed}`;
        })
        .join(', ');
      this.trace('state', `commands (pedidos/aceitos/recusados/sem resposta): ${summary}`);
    }
  }

  private notify(kind: Notice['kind'], message: string): void {
    this.update({ notice: { id: this.nextId++, kind, message } });
  }

  private log(kind: LogEntry['kind'], label: string, bytes?: Uint8Array): void {
    const entry: LogEntry = {
      id: this.nextId++,
      at: this.options.now(),
      kind,
      label,
      hex: bytes ? bytesToHex(bytes) : null,
    };
    const log = [...this.snapshot.log, entry];
    if (log.length > this.options.maxLogEntries) {
      log.splice(0, log.length - this.options.maxLogEntries);
    }
    this.update({ log });
    this.trace(kind, label, bytes);
  }
}

/**
 * Equipamentos FTMS primeiro; dentro de cada grupo, o sinal mais forte na
 * frente. Numa academia cheia de aparelhos, o mais próximo é a esteira em que
 * a pessoa está. (O RSSI só é atualizado quando muda bastante, então a lista
 * não fica dançando.)
 */
function sortDevices(devices: ScannedDevice[]): ScannedDevice[] {
  const bySignal = (a: ScannedDevice, b: ScannedDevice) =>
    (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity);
  return [
    ...devices.filter((device) => device.advertisesFtms).sort(bySignal),
    ...devices.filter((device) => !device.advertisesFtms).sort(bySignal),
  ];
}

/**
 * Deduz o estado da lona pela velocidade medida, para esteiras que não mandam
 * Fitness Machine Status. Um estado vindo da esteira só é trocado quando a
 * velocidade o contradiz: depois de pausar, a lona ainda gira enquanto freia, e
 * isso não quer dizer que voltou a rodar.
 */
function inferBelt(
  current: BeltState,
  speed: number,
  previousSpeed: number | null,
  steady: boolean,
): BeltState {
  if (speed > 0) {
    if (current === 'unknown') return 'running';
    // Acelerando, ou girando firme há alguns segundos: não está freando, então
    // está rodando, diga o que disser o último aviso.
    const accelerating = previousSpeed !== null && speed - previousSpeed >= 0.05;
    if (current !== 'running' && (accelerating || steady)) return 'running';
    return current;
  }
  if (current === 'unknown') return 'stopped';
  if (current === 'running' && previousSpeed !== null && previousSpeed > 0) return 'stopped';
  return current;
}
