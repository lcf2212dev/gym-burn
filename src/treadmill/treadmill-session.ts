import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
} from '@/ble/transport';
import {
  ControlPointOp,
  ControlPointResult,
  FTMS,
  bytesToHex,
  controlPointOpName,
  controlPointResultName,
  encodePause,
  encodeRequestControl,
  encodeSetTargetInclination,
  encodeSetTargetSpeed,
  encodeStartOrResume,
  encodeStop,
  parseControlPointResponse,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedInclinationRange,
  parseSupportedSpeedRange,
  parseTrainingStatus,
  parseTreadmillData,
  sameUuid,
  shortUuid,
  type FitnessMachineFeature,
  type SupportedRange,
} from '@/ftms';

import { T600X_INCLINATION_RANGE, T600X_SPEED_RANGE } from './t600x';
import type { TreadmillStore } from './treadmill-context';
import type {
  BeltState,
  CommandKind,
  CommandTally,
  LogEntry,
  Notice,
  RangeInfo,
  SessionMode,
  TreadmillActions,
  TraceLine,
  TraceSink,
  TreadmillCapabilities,
  TreadmillMetrics,
  TreadmillSnapshot,
} from './types';

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
  | { type: 'result'; resultCode: number }
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
    };
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
        'Nenhuma esteira encontrada. Confira se o painel está no modo APP e busque de novo. Se ela não se anunciar como esteira, ligue "Mostrar outros aparelhos Bluetooth".',
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
      const capabilities = await this.setUpTreadmill(connection, epoch);
      if (epoch !== this.linkEpoch) {
        return;
      }
      this.update({
        phase: 'connected',
        capabilities,
        control: capabilities.hasControlPoint ? 'idle' : 'unavailable',
        // Na demonstração não há outra esteira; sem Control Point não há comando.
        identityConfirmed: mode === 'demo' || !capabilities.hasControlPoint,
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
  ): Promise<TreadmillCapabilities> {
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

    return {
      feature,
      hasControlPoint,
      speedRange: resolveRange(speedRange, T600X_SPEED_RANGE),
      inclinationRange: resolveRange(inclinationRange, T600X_INCLINATION_RANGE),
      characteristics: characteristics.map((characteristic) => characteristic.uuid),
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
    this.resetLinkState({ phase: 'idle', device: null });
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
    return (
      target !== null &&
      this.pendingInclination === null &&
      this.pumpingEpoch === null &&
      this.settledInclinationSamples >= SETTLED_INCLINATION_SAMPLES &&
      Math.abs(inclination - target) > Math.max(step, 0.5)
    );
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
      case 'targetSpeedChanged':
        this.confirmedSpeed = event.speedKmh;
        this.speedTargetSetAt = this.options.now();
        // Um pedido do app ainda na fila vale mais que o aviso da esteira.
        if (this.pendingSpeed === null) {
          this.update({ targetSpeedKmh: event.speedKmh });
        }
        break;
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
      this.settlePendingResponse({ type: 'result', resultCode: response.resultCode });
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

  private changeSpeed(deltaKmh: number): void {
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
