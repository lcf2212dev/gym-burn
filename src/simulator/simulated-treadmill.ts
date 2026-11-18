import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
  ServiceInfo,
} from '@/ble/transport';
import { DEVICE_INFORMATION_SERVICE, FTMS, sameUuid, uuid16 } from '@/ftms';

import {
  buildTreadmillData,
  ByteWriter,
  MACHINE_FEATURE_BIT,
  machineStatusTargetInclination,
  machineStatusTargetSpeed,
  STATUS_OP,
  TRAINING_STATUS_CODE,
} from './wire';

export const SIMULATED_DEVICE_ID = 'esteira-simulada';

/**
 * Identidade do módulo BLE que a esteira simulada anuncia no Device Information
 * (0x180A), igual à da T600X real: o modelo vem como placeholder do firmware.
 */
const DEVICE_INFORMATION: Readonly<Record<string, string>> = {
  [uuid16(0x2a29)]: 'WiLinktech',
  [uuid16(0x2a24)]: '000000',
  [uuid16(0x2a25)]: 'WLT8258',
  [uuid16(0x2a26)]: 'V10.23.17',
  [uuid16(0x2a28)]: 'V100.0.0',
};

/** Texto como o firmware manda: ASCII e preenchido com zeros até 10 octetos. */
function asciiPadded(text: string): Uint8Array {
  const bytes = new Uint8Array(Math.max(10, text.length));
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

interface Range {
  min: number;
  max: number;
  step: number;
}

export interface SimulatedTreadmillOptions {
  name?: string;
  /** Intervalo das notificações de Treadmill Data (e do passo da física). */
  tickMs?: number;
  scanDelayMs?: number;
  connectDelayMs?: number;
  /**
   * A lona começa a andar sozinha alguns instantes depois de conectar, como se
   * alguém estivesse usando o console. É o que faz o modo demonstração mostrar
   * dados vivos. Os testes que querem comandar o console passam `false`.
   */
  autoStart?: boolean;
  /** Velocidade que o `autoStart` mantém enquanto ninguém mexe no console. */
  autoStartSpeedKmh?: number;
  /** Inclinação que o `autoStart` aplica (o console de verdade costuma andar em 1,5 %). */
  autoStartInclinePercent?: number;
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
  scanDelayMs: 300,
  connectDelayMs: 200,
  autoStart: true,
  autoStartSpeedKmh: 5,
  autoStartInclinePercent: 1.5,
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

/** Características notificáveis que aceitam `subscribe`. */
type Channel = 'treadmillData' | 'trainingStatus' | 'machineStatus';

const CHANNEL_UUID: Record<Channel, string> = {
  treadmillData: FTMS.treadmillData,
  trainingStatus: FTMS.trainingStatus,
  machineStatus: FTMS.machineStatus,
};

function toRaw(value: number, scale: number): number {
  return Math.round(value * scale);
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/**
 * Uma conexão GATT com a esteira simulada. Guarda todo o estado do treino, então
 * uma nova conexão sempre começa do zero.
 *
 * A simulação representa uma esteira em uso: o console (as ações `console*`) é
 * quem liga, desliga e muda velocidade/inclinação — o app nunca escreve nada.
 */
class SimulatedConnection implements BleConnection {
  readonly deviceId = SIMULATED_DEVICE_ID;
  readonly name: string;

  private closed = false;
  private autoStarted = false;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly subscribers: Record<Channel, Set<(data: Uint8Array) => void>> = {
    treadmillData: new Set(),
    trainingStatus: new Set(),
    machineStatus: new Set(),
  };

  private tickTimer: ReturnType<typeof setInterval> | null = null;

  // Estado do treino (ponto flutuante; arredonda-se só ao codificar).
  private belt: BeltState = 'stopped';
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
    return [
      { uuid: FTMS.service, characteristics: await this.getCharacteristics(FTMS.service) },
      {
        uuid: DEVICE_INFORMATION_SERVICE,
        characteristics: await this.getCharacteristics(DEVICE_INFORMATION_SERVICE),
      },
    ];
  }

  async getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]> {
    this.assertOpen();
    const info = (
      uuid: string,
      props: Partial<Omit<CharacteristicInfo, 'uuid'>> = {},
    ): CharacteristicInfo => ({
      uuid,
      canRead: false,
      canNotify: false,
      canIndicate: false,
      ...props,
    });
    if (sameUuid(serviceUuid, DEVICE_INFORMATION_SERVICE)) {
      return Object.keys(DEVICE_INFORMATION).map((uuid) => info(uuid, { canRead: true }));
    }
    if (!sameUuid(serviceUuid, FTMS.service)) return [];
    const { exposeRanges } = this.options;
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
      info(FTMS.machineStatus, { canNotify: true }),
    ];
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    this.assertOpen();
    if (sameUuid(serviceUuid, DEVICE_INFORMATION_SERVICE)) {
      const value = Object.entries(DEVICE_INFORMATION).find(([uuid]) =>
        sameUuid(uuid, characteristicUuid),
      )?.[1];
      if (value !== undefined) return asciiPadded(value);
    }
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

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription> {
    this.assertOpen();
    const channel = (Object.keys(CHANNEL_UUID) as Channel[]).find(
      (key) =>
        sameUuid(serviceUuid, FTMS.service) && sameUuid(characteristicUuid, CHANNEL_UUID[key]),
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
  //
  // O app não chama nada disto: são as ações de quem está usando a esteira. A
  // demonstração usa o `autoStart`; os testes usam estas ações para provocar
  // eventos reais (alguém mexe no console) e verificar o que a sessão exibe.

  consoleStart(): void {
    this.start();
  }

  consoleStop(): void {
    if (this.belt !== 'stopped') this.stopOrPause('stop');
  }

  consolePause(): void {
    if (this.belt === 'running') this.stopOrPause('pause');
  }

  consoleSetSpeed(kmh: number): void {
    const { min, max } = this.options.speedRange;
    this.setTargetSpeed(Math.min(max, Math.max(min, kmh)));
  }

  consoleSetInclination(percent: number): void {
    const { min, max } = this.options.inclinationRange;
    this.setTargetInclination(Math.min(max, Math.max(min, percent)));
  }

  pullSafetyKey(): void {
    this.belt = 'stopped';
    this.targetSpeedKmh = 0;
    this.notifyStatus(bytesOf(STATUS_OP.stoppedBySafetyKey));
    this.syncTrainingStatus();
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
    this.tickTimer = null;
    Object.values(this.subscribers).forEach((set) => set.clear());
    this.disconnectListeners.clear();
    this.onClosed();
  }

  private emit(channel: Channel, data: Uint8Array): void {
    if (this.closed) return;
    // Cópia: um ouvinte que se remova durante a entrega não afeta a iteração.
    [...this.subscribers[channel]].forEach((listener) => listener(data.slice()));
  }

  private notifyStatus(data: Uint8Array): void {
    this.emit('machineStatus', data);
  }

  private encodeFeature(): Uint8Array {
    const B = MACHINE_FEATURE_BIT;
    let machine =
      (1 << B.totalDistance) |
      (1 << B.inclination) |
      (1 << B.expendedEnergy) |
      (1 << B.heartRate) |
      (1 << B.metabolicEquivalent) |
      (1 << B.elapsedTime);
    if (this.options.paceFieldWidth > 0) machine |= 1 << B.pace;
    // Sem Control Point: a esteira não aceita nenhum alvo, como a T600X real.
    return new ByteWriter().u32(machine).u32(0).finish();
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

  // --- Ações do console -------------------------------------------------------

  private start(): void {
    if (this.belt === 'running') return;
    this.belt = 'running';
    if (this.targetSpeedKmh < this.options.speedRange.min) {
      this.targetSpeedKmh = this.options.speedRange.min;
    }
    this.notifyStatus(bytesOf(STATUS_OP.startedOrResumed));
    this.syncTrainingStatus();
  }

  private stopOrPause(kind: 'stop' | 'pause'): void {
    if (kind === 'stop') {
      this.belt = 'stopped';
      this.targetSpeedKmh = 0;
    } else {
      this.belt = 'paused';
    }
    this.notifyStatus(bytesOf(STATUS_OP.stoppedOrPaused, kind === 'stop' ? 1 : 2));
    this.syncTrainingStatus();
  }

  private setTargetSpeed(kmh: number): void {
    this.targetSpeedKmh = kmh;
    this.notifyStatus(machineStatusTargetSpeed(kmh));
  }

  private setTargetInclination(percent: number): void {
    this.targetInclinationPercent = percent;
    this.notifyStatus(machineStatusTargetInclination(percent));
  }

  // --- Física ----------------------------------------------------------------------

  private tick(): void {
    if (this.options.autoStart && !this.autoStarted) {
      this.autoStarted = true;
      this.belt = 'running';
      const { min, max } = this.options.speedRange;
      this.targetSpeedKmh = Math.min(max, Math.max(min, this.options.autoStartSpeedKmh));
      const incline = this.options.inclinationRange;
      this.targetInclinationPercent = Math.min(
        incline.max,
        Math.max(incline.min, this.options.autoStartInclinePercent),
      );
      this.notifyStatus(bytesOf(STATUS_OP.startedOrResumed));
      this.syncTrainingStatus();
    }
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
        metabolicEquivalent: this.metabolicEquivalent(),
        elapsedS: this.elapsedS,
      },
      this.options.paceFieldWidth,
      this.options.splitRecords,
    );
    records.forEach((record) => this.emit('treadmillData', record));
  }

  /**
   * METs como o console desta família calcula: equação de caminhada da ACSM
   * (VO2 = 0,1·S + 1,8·S·G + 3,5, S em m/min) dividida por 3,5. Com a lona
   * parada dá 1,0 MET, o mesmo que o firmware real envia.
   */
  private metabolicEquivalent(): number {
    if (this.speedKmh <= 0) return 1;
    const metersPerMin = (this.speedKmh / 3.6) * 60;
    const grade = this.inclinationPercent / 100;
    const vo2 = 0.1 * metersPerMin + 1.8 * metersPerMin * grade + 3.5;
    return Math.max(1, Math.round((vo2 / 3.5) * 10) / 10);
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

  dropLink(): void {
    this.active?.dropLink();
  }
}

/** `{ name: undefined }` não deve sobrescrever o padrão. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
