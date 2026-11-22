import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
} from '@/ble/transport';
import {
  bytesToHex,
  decodeDeviceInformationText,
  DEVICE_INFORMATION_FIELDS,
  DEVICE_INFORMATION_SERVICE,
  FTMS,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedInclinationRange,
  parseSupportedSpeedRange,
  parseTrainingStatus,
  parseTreadmillData,
  sameUuid,
  uuid16,
  type MachineStatusEvent,
  type SupportedRange,
  type TrainingStatus,
} from '@/ftms';

import {
  correctInclinationPercent,
  T600X_INCLINATION_RANGE,
  T600X_SPEED_RANGE,
} from './t600x';
import type { TreadmillStore } from './treadmill-context';
import type {
  EquipmentInfo,
  HeartRateSource,
  LinkInfo,
  Notice,
  RangeInfo,
  SessionMode,
  TreadmillActions,
  TreadmillCapabilities,
  TreadmillMetrics,
  TreadmillSnapshot,
  TreadmillStatus,
} from './types';

/** Quanto esperar por uma leitura opcional antes de seguir sem ela. */
const READ_TIMEOUT_MS = 2000;

/** A busca para sozinha depois deste tempo, para não gastar bateria. */
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

/**
 * Amostras guardadas. A revisão da carga usa o último minuto de leituras da
 * cinta, e a esteira manda mais de um pacote por segundo: 300 cobrem esse
 * minuto com folga.
 */
const MAX_SAMPLES = 300;

/** Eventos do console guardados (o mais novo primeiro). */
const MAX_CONSOLE_EVENTS = 8;

/** Intervalos entre pacotes usados na mediana do enlace. */
const MAX_INTERVALS = 30;

/** Característica PnP ID do Device Information; não há campo no contrato. */
const PNP_ID_UUID = uuid16(0x2a50);

const EMPTY_METRICS: TreadmillMetrics = {
  speedKmh: null,
  averageSpeedKmh: null,
  distanceM: null,
  inclinationPercent: null,
  rampAngleDeg: null,
  positiveElevationGainM: null,
  negativeElevationGainM: null,
  instantaneousPaceRaw: null,
  averagePaceRaw: null,
  totalEnergyKcal: null,
  energyPerHourKcal: null,
  energyPerMinuteKcal: null,
  heartRateBpm: null,
  heartRateSource: null,
  metabolicEquivalent: null,
  elapsedTimeS: null,
  remainingTimeS: null,
  forceOnBeltN: null,
  powerOutputW: null,
  updatedAt: null,
  flags: null,
};

const EMPTY_STATUS: TreadmillStatus = {
  training: null,
  consoleEvents: [],
  stoppedBySafetyKey: false,
};

const EMPTY_LINK: LinkInfo = {
  lastPacketAt: null,
  packets: 0,
  intervalMs: null,
  rssi: null,
};

export interface TreadmillSessionOptions {
  /** O rádio de verdade. */
  ble: BleTransport;
  /** A esteira simulada do modo demonstração. */
  demo: { transport: BleTransport; deviceId: string };
  /**
   * A leitura de uma cinta no peito que vale neste instante, com a hora em que
   * chegou, ou `null` se ela não tem leitura recente. Quando há leitura, é ela
   * que vale; o sensor de mão da esteira fica como reserva.
   */
  heartRate?: (now: number) => { bpm: number; at: number } | null;
  /** A busca para sozinha depois deste tempo (para não gastar bateria). */
  scanTimeoutMs?: number;
  now?: () => number;
}

type ResolvedOptions = Required<TreadmillSessionOptions>;

/** Marca a leitura que estourou o prazo (para não insistir nas próximas). */
class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`sem resposta em ${ms} ms`);
    this.name = 'ReadTimeoutError';
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mediana de uma lista (não ordena a original). */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** FTMS primeiro (é o que interessa), depois o maior RSSI. */
function sortDevices(devices: ScannedDevice[]): ScannedDevice[] {
  const bySignal = (a: ScannedDevice, b: ScannedDevice) =>
    (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity);
  return [
    ...devices.filter((device) => device.advertisesFtms).sort(bySignal),
    ...devices.filter((device) => !device.advertisesFtms).sort(bySignal),
  ];
}

/** `""` vira `null`: característica vazia não é informação. */
function nullIfEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * Uma sessão com a esteira: busca, conexão, descoberta do GATT, leitura da
 * identidade/capacidades e assinatura das notificações de dados.
 *
 * O app é 100% somente leitura: esta classe nunca escreve uma característica,
 * nunca pede Control Point e não conhece nenhum protocolo proprietário. O que
 * ela faz com o rádio é `prepare`, `scan`, `connect`, `read` e `subscribe`.
 * Quem liga, desliga ou muda a velocidade é o painel da esteira; o app só
 * observa e mostra.
 *
 * Não depende de React nem da biblioteca de Bluetooth — só do contrato
 * `BleTransport`.
 */
export class TreadmillSession implements TreadmillStore {
  readonly actions: TreadmillActions;

  private readonly options: ResolvedOptions;
  private readonly listeners = new Set<() => void>();
  private snapshot: TreadmillSnapshot;
  private nextNoticeId = 1;

  private scanSubscription: BleSubscription | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanEpoch = 0;

  /** Muda a cada conexão/desconexão; callbacks de um link antigo são ignorados. */
  private linkEpoch = 0;
  private connection: BleConnection | null = null;
  private subscriptions: BleSubscription[] = [];

  private packets = 0;
  private lastPacketAt: number | null = null;
  private readonly packetIntervals: number[] = [];
  private dataErrorNotified = false;
  /** Última leitura do sensor de mão da esteira; `null` sem contato nas alças. */
  private gripBpm: number | null = null;
  /** Hora da última leitura da cinta que já entrou numa amostra. */
  private strapSampledAt: number | null = null;

  constructor(options: TreadmillSessionOptions) {
    this.options = {
      heartRate: () => null,
      scanTimeoutMs: DEFAULT_SCAN_TIMEOUT_MS,
      now: Date.now,
      ...options,
    };
    this.snapshot = {
      mode: 'ble',
      scan: 'idle',
      devices: [],
      phase: 'idle',
      device: null,
      equipment: null,
      capabilities: null,
      metrics: EMPTY_METRICS,
      samples: [],
      status: EMPTY_STATUS,
      link: EMPTY_LINK,
      notice: null,
    };
    this.actions = {
      startScan: () => void this.startScan(),
      stopScan: () => this.stopScan(),
      connect: (deviceId) => void this.connect(deviceId, 'ble'),
      openDemo: () => void this.connect(this.options.demo.deviceId, 'demo'),
      disconnect: () => void this.disconnect(),
      dismissNotice: () => this.update({ notice: null }),
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

  private update(patch: Partial<TreadmillSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private notify(kind: Notice['kind'], message: string): void {
    this.update({ notice: { id: this.nextNoticeId++, kind, message } });
  }

  // --- Busca ---------------------------------------------------------------

  /**
   * Procura esteiras sempre que a tela pedir. Não guarda resultado de busca
   * anterior: a lista é a deste pedido.
   */
  private async startScan(): Promise<void> {
    if (this.snapshot.scan !== 'idle' || this.snapshot.phase !== 'idle') {
      return;
    }
    const epoch = ++this.scanEpoch;
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
  }

  private stopScan(): void {
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
      this.update({ scan: 'idle' });
    }
  }

  private handleScanTimeout(): void {
    this.scanTimer = null;
    const found = this.snapshot.devices.length;
    this.stopScan();
    if (found === 0) {
      this.notify(
        'info',
        'Nenhuma esteira encontrada. Confira se o painel está no modo APP e procure de novo.',
      );
    }
  }

  private handleScanResult(found: ScannedDevice): void {
    const devices = this.snapshot.devices;
    const index = devices.findIndex((device) => device.id === found.id);
    if (index === -1) {
      this.update({ devices: sortDevices([...devices, found]) });
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
    const changed =
      merged.name !== known.name ||
      merged.rssi !== known.rssi ||
      merged.advertisesFtms !== known.advertisesFtms ||
      merged.ftms !== known.ftms;
    if (!changed) {
      return;
    }
    const next = devices.slice();
    next[index] = merged;
    this.update({ devices: sortDevices(next) });
  }

  // --- Conexão -------------------------------------------------------------

  private async connect(deviceId: string, mode: SessionMode): Promise<void> {
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
      link: { ...EMPTY_LINK, rssi: known?.rssi ?? null },
      notice: null,
    });

    let connection: BleConnection | null = null;
    try {
      await transport.prepare();
      connection = await transport.connect(deviceId);
      if (epoch !== this.linkEpoch) {
        // A tela desistiu enquanto conectava.
        await connection.disconnect().catch(() => undefined);
        return;
      }
      this.connection = connection;
      this.subscriptions.push(connection.onDisconnect(() => this.handleLinkLost(epoch)));
      this.update({
        device: { id: deviceId, name: connection.name ?? known?.name ?? null },
      });

      const equipment = await this.readEquipment(connection, epoch);
      if (epoch !== this.linkEpoch) return;
      if (equipment) {
        this.update({ equipment });
      }

      const capabilities = await this.setUpTreadmill(connection, epoch);
      if (epoch !== this.linkEpoch) return;
      this.update({ phase: 'connected', capabilities });
    } catch (error) {
      if (epoch !== this.linkEpoch) {
        return;
      }
      await this.teardown(connection);
      this.notify('error', errorMessage(error));
    }
  }

  private async disconnect(): Promise<void> {
    if (this.snapshot.phase === 'idle' || this.snapshot.phase === 'disconnecting') {
      return;
    }
    this.linkEpoch++;
    const connection = this.connection;
    this.update({ phase: 'disconnecting' });
    await this.teardown(connection);
  }

  /** O link caiu sem que o app tenha pedido. */
  private handleLinkLost(epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    this.linkEpoch++;
    void this.teardown(this.connection).then(() => {
      this.notify(
        'error',
        'A conexão com a esteira caiu. A lona continua como estava: use o painel da esteira e conecte de novo quando quiser.',
      );
    });
  }

  /** Solta tudo o que pertence à conexão atual e volta ao estado sem esteira. */
  private async teardown(connection: BleConnection | null): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];
    this.connection = null;
    if (connection) {
      await connection.disconnect().catch(() => undefined);
    }
    this.resetLinkState();
    // Num passo só: quem observa a sessão nunca vê "conectado" com o estado da
    // conexão já zerado. A origem volta a "ble" aqui dentro, e não depois:
    // quem observa pode abrir outra conexão assim que a sessão fica livre, e
    // uma troca feita mais tarde marcaria a esteira simulada como real.
    this.update({ phase: 'idle', device: null, mode: 'ble' });
  }

  private resetLinkState(): void {
    this.packets = 0;
    this.lastPacketAt = null;
    this.packetIntervals.length = 0;
    this.dataErrorNotified = false;
    this.gripBpm = null;
    this.strapSampledAt = null;
    this.update({
      equipment: null,
      capabilities: null,
      metrics: EMPTY_METRICS,
      samples: [],
      status: EMPTY_STATUS,
      link: EMPTY_LINK,
    });
  }

  // --- Identidade e capacidades ---------------------------------------------

  /**
   * Lê o Device Information (0x180A). O modelo é lido primeiro: se uma leitura
   * travar, as seguintes são abandonadas para não prender a fila do rádio. Uma
   * característica que falha sem travar não impede as outras.
   */
  private async readEquipment(
    connection: BleConnection,
    epoch: number,
  ): Promise<EquipmentInfo | null> {
    let available: CharacteristicInfo[];
    try {
      available = await connection.getCharacteristics(DEVICE_INFORMATION_SERVICE);
    } catch {
      return null;
    }
    const values = new Map<string, Uint8Array>();
    for (const field of DEVICE_INFORMATION_FIELDS) {
      if (field.uuid === PNP_ID_UUID) continue;
      const readable = available.some(
        (characteristic) => characteristic.canRead && sameUuid(characteristic.uuid, field.uuid),
      );
      if (!readable) {
        continue;
      }
      try {
        values.set(
          field.uuid,
          await this.readWithTimeout(connection, DEVICE_INFORMATION_SERVICE, field.uuid),
        );
      } catch (error) {
        if (error instanceof ReadTimeoutError) {
          break;
        }
      }
      if (epoch !== this.linkEpoch) {
        return null;
      }
    }

    const text = (shortUuid: number): string | null => {
      const bytes = values.get(uuid16(shortUuid));
      return bytes ? nullIfEmpty(decodeDeviceInformationText(bytes)) : null;
    };
    const hex = (shortUuid: number): string | null => {
      const bytes = values.get(uuid16(shortUuid));
      return bytes && bytes.length > 0 ? bytesToHex(bytes) : null;
    };

    return {
      manufacturer: text(0x2a29),
      model: text(0x2a24),
      serial: text(0x2a25),
      firmware: text(0x2a26),
      software: text(0x2a28),
      hardware: text(0x2a27),
      systemId: hex(0x2a23),
    };
  }

  /** Lê as capacidades e assina as notificações. Lança se o aparelho não for uma esteira. */
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

    const feature = find(FTMS.feature)?.canRead
      ? await this.readOptional(connection, FTMS.feature, parseFitnessMachineFeature)
      : null;
    const speedRange = find(FTMS.supportedSpeedRange)?.canRead
      ? await this.readOptional(connection, FTMS.supportedSpeedRange, parseSupportedSpeedRange)
      : null;
    const inclinationRange = find(FTMS.supportedInclinationRange)?.canRead
      ? await this.readOptional(
          connection,
          FTMS.supportedInclinationRange,
          parseSupportedInclinationRange,
        )
      : null;

    const capabilities: TreadmillCapabilities = {
      feature,
      speedRange: resolveRange(speedRange, T600X_SPEED_RANGE),
      inclinationRange: resolveRange(inclinationRange, T600X_INCLINATION_RANGE),
      characteristics: characteristics.map((characteristic) => characteristic.uuid),
    };
    // Antes de assinar: a primeira notificação já precisa da faixa para corrigir a inclinação.
    this.update({ capabilities });
    if (epoch !== this.linkEpoch) {
      return capabilities;
    }

    // Training Status: assina se avisa e lê uma vez, para o console já abrir com estado.
    const trainingStatus = find(FTMS.trainingStatus);
    if (trainingStatus?.canNotify || trainingStatus?.canIndicate) {
      await this.subscribeOptional(connection, FTMS.trainingStatus, (bytes) =>
        this.handleTrainingStatus(bytes, epoch),
      );
    }
    if (trainingStatus?.canRead) {
      const training = await this.readOptional(
        connection,
        FTMS.trainingStatus,
        parseTrainingStatus,
      );
      if (training && epoch === this.linkEpoch) {
        this.update({ status: { ...this.snapshot.status, training } });
      }
    }

    const machineStatus = find(FTMS.machineStatus);
    if (machineStatus?.canNotify || machineStatus?.canIndicate) {
      await this.subscribeOptional(connection, FTMS.machineStatus, (bytes) =>
        this.handleMachineStatus(bytes, epoch),
      );
    }

    // Obrigatória: sem os dados de esteira não há o que mostrar.
    this.subscriptions.push(
      await connection.subscribe(FTMS.service, FTMS.treadmillData, (bytes) =>
        this.handleTreadmillData(bytes, epoch),
      ),
    );
    return capabilities;
  }

  private async readOptional<T>(
    connection: BleConnection,
    characteristicUuid: string,
    parse: (bytes: Uint8Array) => T,
  ): Promise<T | null> {
    try {
      return parse(await this.readWithTimeout(connection, FTMS.service, characteristicUuid));
    } catch {
      return null;
    }
  }

  private async subscribeOptional(
    connection: BleConnection,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<void> {
    try {
      this.subscriptions.push(
        await connection.subscribe(FTMS.service, characteristicUuid, onValue),
      );
    } catch {
      // Característica opcional: sem ela a tela mostra menos, mas o painel funciona.
    }
  }

  /** `read` com prazo: um rádio mudo não pode prender a conexão para sempre. */
  private readWithTimeout(
    connection: BleConnection,
    serviceUuid: string,
    characteristicUuid: string,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new ReadTimeoutError(timeoutMs));
      }, timeoutMs);
      connection.read(serviceUuid, characteristicUuid).then(
        (bytes) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(bytes);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // --- Dados recebidos -----------------------------------------------------

  /** Contabiliza um pacote e atualiza a saúde do enlace. */
  private recordPacket(now: number): LinkInfo {
    if (this.lastPacketAt !== null) {
      const delta = now - this.lastPacketAt;
      if (delta >= 0) {
        this.packetIntervals.push(delta);
        if (this.packetIntervals.length > MAX_INTERVALS) {
          this.packetIntervals.shift();
        }
      }
    }
    this.lastPacketAt = now;
    this.packets += 1;
    return {
      lastPacketAt: now,
      packets: this.packets,
      intervalMs: median(this.packetIntervals),
      rssi: this.snapshot.link.rssi,
    };
  }

  private handleTreadmillData(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    let data;
    try {
      data = parseTreadmillData(bytes);
    } catch (error) {
      if (!this.dataErrorNotified) {
        this.dataErrorNotified = true;
        this.notify(
          'warning',
          `Recebi um pacote de dados que não consegui ler: ${errorMessage(error)}`,
        );
      }
      return;
    }

    const now = this.options.now();
    const previous = this.snapshot.metrics;
    // 0 significa "sem contato nas alças"; a tela mostra vazio, não um zero falso.
    if (data.heartRateBpm !== undefined) {
      this.gripBpm = data.heartRateBpm === 0 ? null : data.heartRateBpm;
    }
    // A cinta manda uma leitura por segundo, sem ninguém segurar nada: enquanto
    // ela tem leitura recente, vale a dela. Sem cinta, vale o sensor da esteira.
    const strap = this.options.heartRate(now);
    const strapBpm = strap?.bpm ?? null;
    // A esteira manda mais de um pacote por segundo (o registro FTMS vem
    // dividido): cada leitura da cinta entra numa amostra só, senão o treino
    // contaria a mesma leitura duas vezes.
    const strapIsNew = strap !== null && strap.at !== this.strapSampledAt;
    if (strapIsNew) {
      this.strapSampledAt = strap.at;
    }
    const inclinationRange = this.snapshot.capabilities?.inclinationRange ?? T600X_INCLINATION_RANGE;
    const metrics: TreadmillMetrics = {
      speedKmh: data.instantaneousSpeedKmh ?? previous.speedKmh,
      averageSpeedKmh: data.averageSpeedKmh ?? previous.averageSpeedKmh,
      distanceM: data.totalDistanceM ?? previous.distanceM,
      // A leitura crua desta família de firmware sai 6,667× maior; a sessão já entrega corrigido.
      inclinationPercent:
        data.inclinationPercent !== undefined
          ? correctInclinationPercent(data.inclinationPercent, inclinationRange)
          : previous.inclinationPercent,
      rampAngleDeg: data.rampAngleDeg ?? previous.rampAngleDeg,
      positiveElevationGainM: data.positiveElevationGainM ?? previous.positiveElevationGainM,
      negativeElevationGainM: data.negativeElevationGainM ?? previous.negativeElevationGainM,
      instantaneousPaceRaw: data.instantaneousPaceRaw ?? previous.instantaneousPaceRaw,
      averagePaceRaw: data.averagePaceRaw ?? previous.averagePaceRaw,
      totalEnergyKcal: data.totalEnergyKcal ?? previous.totalEnergyKcal,
      energyPerHourKcal: data.energyPerHourKcal ?? previous.energyPerHourKcal,
      energyPerMinuteKcal: data.energyPerMinuteKcal ?? previous.energyPerMinuteKcal,
      heartRateBpm: strapBpm ?? this.gripBpm,
      heartRateSource: strapBpm !== null ? 'strap' : this.gripBpm !== null ? 'treadmill' : null,
      metabolicEquivalent: data.metabolicEquivalent ?? previous.metabolicEquivalent,
      elapsedTimeS: data.elapsedTimeS ?? previous.elapsedTimeS,
      remainingTimeS: data.remainingTimeS ?? previous.remainingTimeS,
      forceOnBeltN: data.forceOnBeltN ?? previous.forceOnBeltN,
      powerOutputW: data.powerOutputW ?? previous.powerOutputW,
      updatedAt: now,
      flags: data.flags,
    };

    // Uma amostra por notificação de Treadmill Data, para o gráfico ao vivo.
    const lastSample = this.snapshot.samples.at(-1);
    // Do sensor da esteira só entra na amostra a leitura que veio neste pacote.
    const sampleSource: HeartRateSource | null =
      strap !== null ? 'strap' : data.heartRateBpm ? 'treadmill' : null;
    const sampleBpm = strap !== null ? (strapIsNew ? strap.bpm : null) : data.heartRateBpm || null;
    const samples = [
      ...this.snapshot.samples,
      {
        at: now,
        speedAt: data.instantaneousSpeedKmh !== undefined ? now : lastSample?.speedAt ?? null,
        inclineAt: data.inclinationPercent !== undefined ? now : lastSample?.inclineAt ?? null,
        speedKmh: metrics.speedKmh,
        inclinationPercent: metrics.inclinationPercent,
        heartRateBpm: sampleBpm,
        heartRateSource: sampleSource,
        energyKcal: metrics.totalEnergyKcal,
        distanceM: metrics.distanceM,
      },
    ];
    if (samples.length > MAX_SAMPLES) {
      samples.splice(0, samples.length - MAX_SAMPLES);
    }

    this.update({ metrics, samples, link: this.recordPacket(now) });
  }

  private handleMachineStatus(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    let event: MachineStatusEvent;
    try {
      event = parseMachineStatus(bytes);
    } catch {
      return;
    }
    const now = this.options.now();
    const status: TreadmillStatus = {
      ...this.snapshot.status,
      consoleEvents: [
        { at: now, event },
        ...this.snapshot.status.consoleEvents,
      ].slice(0, MAX_CONSOLE_EVENTS),
    };
    switch (event.type) {
      case 'stoppedBySafetyKey':
        status.stoppedBySafetyKey = true;
        break;
      case 'startedOrResumedByUser':
        status.stoppedBySafetyKey = false;
        break;
      case 'reset':
        status.stoppedBySafetyKey = false;
        break;
      default:
        break;
    }
    this.update({ status, link: this.recordPacket(now) });
    if (event.type === 'stoppedBySafetyKey') {
      this.notify(
        'warning',
        'A esteira parou pela chave de segurança. Recoloque a chave no painel para liberar o uso.',
      );
    }
  }

  private handleTrainingStatus(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.linkEpoch) {
      return;
    }
    let training: TrainingStatus;
    try {
      training = parseTrainingStatus(bytes);
    } catch {
      return;
    }
    this.update({
      status: { ...this.snapshot.status, training },
      link: this.recordPacket(this.options.now()),
    });
  }
}
