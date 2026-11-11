import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
  ServiceInfo,
} from '@/ble/transport';
import { ControlPointOp, ControlPointResult, FTMS, sameUuid } from '@/ftms';

import {
  ByteWriter,
  buildTreadmillData,
  MACHINE_FEATURE_BIT,
  STATUS_OP,
  TARGET_SETTING_BIT,
  TRAINING_STATUS_CODE,
} from './wire';

export const SIMULATED_DEVICE_ID = 'esteira-simulada';

interface Range {
  min: number;
  max: number;
  step: number;
}

export interface SimulatedTreadmillOptions {
  name?: string;
  /** Intervalo das notificações de Treadmill Data (e do passo da física). */
  tickMs?: number;
  /** Atraso da indication do Control Point. */
  responseDelayMs?: number;
  scanDelayMs?: number;
  connectDelayMs?: number;
  /** `false`: esteira que só transmite dados (sem Control Point nem Machine Status). */
  hasControlPoint?: boolean;
  /** `false`: Request Control responde Control Not Permitted. */
  grantControl?: boolean;
  /** `true`: aplica o comando mas nunca envia a indication. */
  muteControlPoint?: boolean;
  /** Envia Machine Status também para mudanças pedidas pelo próprio cliente. */
  notifyStatusToCommander?: boolean;
  /** 0: sem campos de ritmo; 1 ou 2: largura em octetos do Instantaneous Pace. */
  paceFieldWidth?: 0 | 1 | 2;
  /** Cada registro de Treadmill Data vai em duas notificações (bit More Data). */
  splitRecords?: boolean;
  /** `false`: sem Supported Speed Range nem Supported Inclination Range. */
  exposeRanges?: boolean;
  /** Em km/h. */
  speedRange?: Range;
  /** Em %. */
  inclinationRange?: Range;
}

type Resolved = Required<SimulatedTreadmillOptions>;

const DEFAULTS: Resolved = {
  name: 'Esteira simulada',
  tickMs: 1000,
  responseDelayMs: 40,
  scanDelayMs: 300,
  connectDelayMs: 200,
  hasControlPoint: true,
  grantControl: true,
  muteControlPoint: false,
  notifyStatusToCommander: true,
  paceFieldWidth: 0,
  splitRecords: false,
  exposeRanges: true,
  speedRange: { min: 0.8, max: 22, step: 0.1 },
  inclinationRange: { min: 0, max: 15, step: 0.5 },
};

// Modelo físico.
const ACCELERATION_KMH_PER_S = 1;
const DECELERATION_KMH_PER_S = 2;
const INCLINATION_PERCENT_PER_S = 1;
const RESTING_HEART_RATE = 70;
const MAX_HEART_RATE = 185;

type BeltState = 'stopped' | 'running' | 'paused';
type Origin = 'client' | 'console';

/** Características notificáveis/indicáveis que aceitam `subscribe`. */
type Channel = 'treadmillData' | 'trainingStatus' | 'controlPoint' | 'machineStatus';

const CHANNEL_UUID: Record<Channel, string> = {
  treadmillData: FTMS.treadmillData,
  trainingStatus: FTMS.trainingStatus,
  controlPoint: FTMS.controlPoint,
  machineStatus: FTMS.machineStatus,
};

function toRaw(value: number, scale: number): number {
  return Math.round(value * scale);
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Lê uint16/sint16 little-endian de um parâmetro do Control Point. */
function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readS16(data: Uint8Array, offset: number): number {
  const raw = readU16(data, offset);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

/**
 * Uma conexão GATT com a esteira. Guarda todo o estado do treino, então uma
 * nova conexão sempre começa do zero.
 */
class SimulatedConnection implements BleConnection {
  readonly deviceId = SIMULATED_DEVICE_ID;
  readonly name: string;

  private closed = false;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly subscribers: Record<Channel, Set<(data: Uint8Array) => void>> = {
    treadmillData: new Set(),
    trainingStatus: new Set(),
    controlPoint: new Set(),
    machineStatus: new Set(),
  };

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;

  // Estado do treino (ponto flutuante; arredonda-se só ao codificar).
  private belt: BeltState = 'stopped';
  private hasControl = false;
  private speedKmh = 0;
  private targetSpeedKmh = 0;
  private inclinationPercent = 0;
  private targetInclinationPercent = 0;
  private distanceM = 0;
  private elapsedS = 0;
  private energyKcal = 0;
  private heartRateBpm = RESTING_HEART_RATE;
  private trainingStatusCode: number = TRAINING_STATUS_CODE.idle;

  constructor(
    private readonly options: Resolved,
    private readonly onClosed: () => void,
  ) {
    this.name = options.name;
    this.tickTimer = setInterval(() => this.tick(), options.tickMs);
  }

  // --- BleConnection -------------------------------------------------------

  async getServices(): Promise<ServiceInfo[]> {
    return [{ uuid: FTMS.service, characteristics: await this.getCharacteristics(FTMS.service) }];
  }

  async getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]> {
    this.assertOpen();
    if (!sameUuid(serviceUuid, FTMS.service)) return [];
    const { hasControlPoint, exposeRanges } = this.options;
    const info = (
      uuid: string,
      props: Partial<Omit<CharacteristicInfo, 'uuid'>>,
    ): CharacteristicInfo => ({
      uuid,
      canRead: false,
      canWrite: false,
      canNotify: false,
      canIndicate: false,
      ...props,
    });
    return [
      info(FTMS.feature, { canRead: true }),
      info(FTMS.treadmillData, { canNotify: true }),
      info(FTMS.trainingStatus, { canRead: true, canNotify: true }),
      ...(exposeRanges
        ? [
            info(FTMS.supportedSpeedRange, { canRead: true }),
            info(FTMS.supportedInclinationRange, { canRead: true }),
          ]
        : []),
      ...(hasControlPoint
        ? [
            info(FTMS.controlPoint, { canWrite: true, canIndicate: true }),
            info(FTMS.machineStatus, { canNotify: true }),
          ]
        : []),
    ];
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    this.assertOpen();
    if (sameUuid(serviceUuid, FTMS.service)) {
      const { exposeRanges, speedRange, inclinationRange } = this.options;
      if (sameUuid(characteristicUuid, FTMS.feature)) return this.encodeFeature();
      if (sameUuid(characteristicUuid, FTMS.trainingStatus)) return this.encodeTrainingStatus();
      if (exposeRanges && sameUuid(characteristicUuid, FTMS.supportedSpeedRange)) {
        return new ByteWriter()
          .u16(toRaw(speedRange.min, 100))
          .u16(toRaw(speedRange.max, 100))
          .u16(toRaw(speedRange.step, 100))
          .finish();
      }
      if (exposeRanges && sameUuid(characteristicUuid, FTMS.supportedInclinationRange)) {
        return new ByteWriter()
          .s16(toRaw(inclinationRange.min, 10))
          .s16(toRaw(inclinationRange.max, 10))
          .u16(toRaw(inclinationRange.step, 10))
          .finish();
      }
    }
    throw new Error(`Característica ${characteristicUuid} não existe ou não permite leitura`);
  }

  async write(serviceUuid: string, characteristicUuid: string, data: Uint8Array): Promise<void> {
    this.assertOpen();
    if (
      !this.options.hasControlPoint ||
      !sameUuid(serviceUuid, FTMS.service) ||
      !sameUuid(characteristicUuid, FTMS.controlPoint)
    ) {
      throw new Error(`Característica ${characteristicUuid} não permite escrita`);
    }
    // Erro ATT "CCCD Improperly Configured".
    if (this.subscribers.controlPoint.size === 0) {
      throw new Error('CCCD Improperly Configured: assine as indications do Control Point antes');
    }
    // Erro ATT "Procedure Already In Progress".
    if (this.responseTimer !== null) {
      throw new Error('Procedure Already In Progress: aguarde a resposta do comando anterior');
    }
    if (data.length < 1) {
      throw new Error('Escrita vazia no Control Point');
    }

    const request = data[0];
    const result = this.execute(Uint8Array.from(data));
    // O procedimento só termina depois de `responseDelayMs`, com ou sem indication.
    this.responseTimer = setTimeout(() => {
      this.responseTimer = null;
      if (!this.options.muteControlPoint) {
        this.emit('controlPoint', bytesOf(ControlPointOp.ResponseCode, request, result));
      }
    }, this.options.responseDelayMs);
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription> {
    this.assertOpen();
    const channel = (Object.keys(CHANNEL_UUID) as Channel[]).find(
      (key) =>
        sameUuid(serviceUuid, FTMS.service) &&
        sameUuid(characteristicUuid, CHANNEL_UUID[key]) &&
        (this.options.hasControlPoint || (key !== 'controlPoint' && key !== 'machineStatus')),
    );
    if (!channel) {
      throw new Error(`Característica ${characteristicUuid} não permite notify nem indicate`);
    }
    const subscribers = this.subscribers[channel];
    subscribers.add(onValue);
    return { remove: () => void subscribers.delete(onValue) };
  }

  onDisconnect(listener: () => void): BleSubscription {
    this.disconnectListeners.add(listener);
    return { remove: () => void this.disconnectListeners.delete(listener) };
  }

  async disconnect(): Promise<void> {
    this.close();
  }

  // --- Mãos no console ------------------------------------------------------

  consoleStart(): void {
    this.start('console');
  }

  consoleStop(): void {
    if (this.belt !== 'stopped') this.stopOrPause('stop', 'console');
  }

  consolePause(): void {
    if (this.belt === 'running') this.stopOrPause('pause', 'console');
  }

  consoleSetSpeed(kmh: number): void {
    const { min, max } = this.options.speedRange;
    this.setTargetSpeed(Math.min(max, Math.max(min, kmh)), 'console');
  }

  consoleSetInclination(percent: number): void {
    const { min, max } = this.options.inclinationRange;
    this.setTargetInclination(Math.min(max, Math.max(min, percent)), 'console');
  }

  pullSafetyKey(): void {
    this.belt = 'stopped';
    this.targetSpeedKmh = 0;
    this.notifyStatus(bytesOf(STATUS_OP.stoppedBySafetyKey), 'console');
    this.syncTrainingStatus();
  }

  revokeControl(): void {
    this.hasControl = false;
    this.notifyStatus(bytesOf(STATUS_OP.controlLost), 'console');
  }

  /** Queda de link: os ouvintes de `onDisconnect` são chamados uma vez. */
  dropLink(): void {
    if (this.closed) return;
    const listeners = [...this.disconnectListeners];
    this.close();
    listeners.forEach((listener) => listener());
  }

  // --- Interno ---------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error('Conexão encerrada');
  }

  /** Encerra a conexão e todos os timers; não chama ouvintes. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.responseTimer !== null) clearTimeout(this.responseTimer);
    this.tickTimer = null;
    this.responseTimer = null;
    Object.values(this.subscribers).forEach((set) => set.clear());
    this.disconnectListeners.clear();
    this.onClosed();
  }

  private emit(channel: Channel, data: Uint8Array): void {
    if (this.closed) return;
    // Cópia: um ouvinte que se remova durante a entrega não afeta a iteração.
    [...this.subscribers[channel]].forEach((listener) => listener(data.slice()));
  }

  /** Machine Status só existe com Control Point; do cliente, só se configurado. */
  private notifyStatus(data: Uint8Array, origin: Origin): void {
    if (!this.options.hasControlPoint) return;
    if (origin === 'client' && !this.options.notifyStatusToCommander) return;
    this.emit('machineStatus', data);
  }

  private encodeFeature(): Uint8Array {
    const B = MACHINE_FEATURE_BIT;
    let machine =
      (1 << B.totalDistance) |
      (1 << B.inclination) |
      (1 << B.expendedEnergy) |
      (1 << B.heartRate) |
      (1 << B.elapsedTime);
    if (this.options.paceFieldWidth > 0) machine |= 1 << B.pace;
    const targets = this.options.hasControlPoint
      ? (1 << TARGET_SETTING_BIT.speed) | (1 << TARGET_SETTING_BIT.inclination)
      : 0;
    return new ByteWriter().u32(machine).u32(targets).finish();
  }

  private encodeTrainingStatus(): Uint8Array {
    return bytesOf(0, this.trainingStatusCode);
  }

  /** Atualiza o Training Status a partir da lona e notifica se mudou. */
  private syncTrainingStatus(): void {
    const code =
      this.belt === 'running'
        ? TRAINING_STATUS_CODE.manualMode
        : this.belt === 'paused'
          ? TRAINING_STATUS_CODE.postWorkout
          : TRAINING_STATUS_CODE.idle;
    if (code === this.trainingStatusCode) return;
    this.trainingStatusCode = code;
    this.emit('trainingStatus', this.encodeTrainingStatus());
  }

  // --- Ações compartilhadas entre cliente e console ----------------------------

  private start(origin: Origin): boolean {
    if (this.belt === 'running') return false;
    this.belt = 'running';
    if (this.targetSpeedKmh < this.options.speedRange.min) {
      this.targetSpeedKmh = this.options.speedRange.min;
    }
    this.notifyStatus(bytesOf(STATUS_OP.startedOrResumed), origin);
    this.syncTrainingStatus();
    return true;
  }

  private stopOrPause(kind: 'stop' | 'pause', origin: Origin): void {
    if (kind === 'stop') {
      this.belt = 'stopped';
      this.targetSpeedKmh = 0;
    } else {
      this.belt = 'paused';
    }
    this.notifyStatus(bytesOf(STATUS_OP.stoppedOrPaused, kind === 'stop' ? 1 : 2), origin);
    this.syncTrainingStatus();
  }

  private setTargetSpeed(kmh: number, origin: Origin): void {
    this.targetSpeedKmh = kmh;
    const raw = toRaw(kmh, 100);
    this.notifyStatus(bytesOf(STATUS_OP.targetSpeedChanged, raw & 0xff, raw >> 8), origin);
  }

  private setTargetInclination(percent: number, origin: Origin): void {
    this.targetInclinationPercent = percent;
    const raw = toRaw(percent, 10) & 0xffff;
    this.notifyStatus(
      bytesOf(STATUS_OP.targetInclinationChanged, raw & 0xff, raw >> 8),
      origin,
    );
  }

  private reset(): void {
    this.belt = 'stopped';
    this.hasControl = false;
    this.targetSpeedKmh = 0;
    this.targetInclinationPercent = 0;
    this.distanceM = 0;
    this.elapsedS = 0;
    this.energyKcal = 0;
    this.notifyStatus(bytesOf(STATUS_OP.reset), 'client');
    this.syncTrainingStatus();
  }

  // --- Control Point ---------------------------------------------------------------

  /** Decodifica e aplica o comando; devolve o result code da indication. */
  private execute(data: Uint8Array): number {
    const R = ControlPointResult;
    const op = data[0];

    if (op === ControlPointOp.RequestControl) {
      if (!this.options.grantControl) return R.ControlNotPermitted;
      this.hasControl = true;
      return R.Success;
    }
    if (!this.hasControl) return R.ControlNotPermitted;

    switch (op) {
      case ControlPointOp.Reset:
        this.reset();
        return R.Success;

      case ControlPointOp.SetTargetSpeed: {
        const { min, max } = this.options.speedRange;
        if (data.length !== 3) return R.InvalidParameter;
        const raw = readU16(data, 1);
        if (raw < toRaw(min, 100) || raw > toRaw(max, 100)) return R.InvalidParameter;
        this.setTargetSpeed(raw / 100, 'client');
        return R.Success;
      }

      case ControlPointOp.SetTargetInclination: {
        const { min, max } = this.options.inclinationRange;
        if (data.length !== 3) return R.InvalidParameter;
        const raw = readS16(data, 1);
        if (raw < toRaw(min, 10) || raw > toRaw(max, 10)) return R.InvalidParameter;
        this.setTargetInclination(raw / 10, 'client');
        return R.Success;
      }

      case ControlPointOp.StartOrResume:
        return this.start('client') ? R.Success : R.OperationFailed;

      case ControlPointOp.StopOrPause: {
        if (data.length !== 2 || (data[1] !== 1 && data[1] !== 2)) return R.InvalidParameter;
        if (data[1] === 1) {
          if (this.belt === 'stopped') return R.OperationFailed;
          this.stopOrPause('stop', 'client');
        } else {
          if (this.belt !== 'running') return R.OperationFailed;
          this.stopOrPause('pause', 'client');
        }
        return R.Success;
      }

      default:
        return R.OpCodeNotSupported;
    }
  }

  // --- Física ----------------------------------------------------------------------

  private tick(): void {
    const dt = this.options.tickMs / 1000;
    this.stepPhysics(dt);
    if (this.subscribers.treadmillData.size === 0) return;

    // Energia por minuto (kcal/min) na velocidade e inclinação atuais; 0 com a lona parada.
    const energyPerMinute = this.speedKmh > 0 ? this.kcalPerMinute() : 0;
    const records = buildTreadmillData(
      {
        speedKmh: this.speedKmh,
        distanceM: this.distanceM,
        inclinationPercent: this.inclinationPercent,
        energyKcal: this.energyKcal,
        energyPerMinuteKcal: energyPerMinute,
        heartRateBpm: this.heartRateBpm,
        elapsedS: this.elapsedS,
      },
      this.options.paceFieldWidth,
      this.options.splitRecords,
    );
    records.forEach((record) => this.emit('treadmillData', record));
  }

  /** Fórmula ACSM de corrida: VO2 = 0,2·S + 0,9·S·G + 3,5, com S em m/min. */
  private kcalPerMinute(): number {
    const metersPerMin = (this.speedKmh / 3.6) * 60;
    const grade = this.inclinationPercent / 100;
    const vo2 = 0.2 * metersPerMin + 0.9 * metersPerMin * grade + 3.5;
    return ((vo2 * 70) / 1000) * 5;
  }

  private stepPhysics(dt: number): void {
    if (this.belt === 'running' && this.speedKmh < this.targetSpeedKmh) {
      this.speedKmh = Math.min(this.targetSpeedKmh, this.speedKmh + ACCELERATION_KMH_PER_S * dt);
    } else {
      const floor = this.belt === 'running' ? this.targetSpeedKmh : 0;
      this.speedKmh = Math.max(floor, this.speedKmh - DECELERATION_KMH_PER_S * dt);
    }

    const incStep = INCLINATION_PERCENT_PER_S * dt;
    const incDiff = this.targetInclinationPercent - this.inclinationPercent;
    this.inclinationPercent =
      Math.abs(incDiff) <= incStep
        ? this.targetInclinationPercent
        : this.inclinationPercent + Math.sign(incDiff) * incStep;

    this.distanceM += (this.speedKmh / 3.6) * dt;
    if (this.belt === 'running') this.elapsedS += dt;
    if (this.speedKmh > 0) this.energyKcal += (this.kcalPerMinute() * dt) / 60;

    const targetHr = Math.min(
      MAX_HEART_RATE,
      RESTING_HEART_RATE + 6 * this.speedKmh + 2 * this.inclinationPercent,
    );
    const hrDiff = targetHr - this.heartRateBpm;
    this.heartRateBpm += Math.abs(hrDiff) <= 1 ? hrDiff : Math.sign(hrDiff);
  }
}

export class SimulatedTreadmillTransport implements BleTransport {
  private readonly options: Resolved;
  private active: SimulatedConnection | null = null;
  private connecting = false;

  constructor(options: SimulatedTreadmillOptions = {}) {
    this.options = { ...DEFAULTS, ...stripUndefined(options) };
  }

  async prepare(): Promise<void> {}

  scan(onDevice: (device: ScannedDevice) => void, _onError: (error: Error) => void): BleSubscription {
    const timer = setTimeout(() => {
      onDevice({
        id: SIMULATED_DEVICE_ID,
        name: this.options.name,
        rssi: -48,
        advertisesFtms: true,
        ftms: {
          available: true,
          machineTypes: {
            treadmill: true,
            crossTrainer: false,
            stepClimber: false,
            stairClimber: false,
            rower: false,
            indoorBike: false,
          },
        },
      });
    }, this.options.scanDelayMs);
    return { remove: () => clearTimeout(timer) };
  }

  connect(deviceId: string): Promise<BleConnection> {
    if (deviceId !== SIMULATED_DEVICE_ID) {
      return Promise.reject(new Error(`Equipamento ${deviceId} não encontrado`));
    }
    if (this.active || this.connecting) {
      return Promise.reject(new Error('A esteira simulada já tem uma conexão'));
    }
    this.connecting = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.connecting = false;
        this.active = new SimulatedConnection(this.options, () => {
          this.active = null;
        });
        resolve(this.active);
      }, this.options.connectDelayMs);
    });
  }

  // "Mãos no console": sem conexão, não há treino para mexer e nada acontece.

  consoleStart(): void {
    this.active?.consoleStart();
  }

  consoleStop(): void {
    this.active?.consoleStop();
  }

  consolePause(): void {
    this.active?.consolePause();
  }

  consoleSetSpeed(kmh: number): void {
    this.active?.consoleSetSpeed(kmh);
  }

  consoleSetInclination(percent: number): void {
    this.active?.consoleSetInclination(percent);
  }

  pullSafetyKey(): void {
    this.active?.pullSafetyKey();
  }

  revokeControl(): void {
    this.active?.revokeControl();
  }

  dropLink(): void {
    this.active?.dropLink();
  }
}

/** `{ name: undefined }` não deve sobrescrever o padrão. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
