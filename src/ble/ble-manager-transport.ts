import { Platform } from 'react-native';
import BleManager, { BleScanMode, BleState } from 'react-native-ble-manager';
import type {
  AdvertisingData,
  Characteristic,
  Peripheral,
  PeripheralInfo,
} from 'react-native-ble-manager';

import {
  bytesToHex,
  characteristicName,
  FTMS,
  normalizeUuid,
  parseFtmsServiceData,
  sameUuid,
  shortUuid,
} from '@/ftms';

import { requestBlePermissions } from './permissions';
import { BleUnavailableError } from './transport';
import type {
  BleConnection,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
  ServiceInfo,
} from './transport';

/** Tempo total para conectar e descobrir serviços; a promise nativa pode nunca resolver. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Quanto esperar o adaptador sair de um estado transitório (ligando, reiniciando…). */
const ADAPTER_STATE_TIMEOUT_MS = 3_000;

/** Estados do adaptador que ainda vão mudar sozinhos. */
const TRANSIENT_STATES: readonly string[] = [
  BleState.Unknown,
  BleState.Resetting,
  BleState.TurningOn,
];

const BASE_UUID_SHORT = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/;

/**
 * UUID no formato que o código nativo aceita nas duas plataformas: 4 dígitos
 * hexa (16 bits) ou 128 bits com hífens. `UUIDHelper.isValidBLEUUID` (Android)
 * e `Helper.isValidBLEUUID` (iOS) rejeitam o formato de 32 bits e o prefixo
 * `0x`, que `normalizeUuid` aceita.
 */
function toNativeUuid(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  return BASE_UUID_SHORT.exec(normalized)?.[1] ?? normalized;
}

/** Texto de um erro nativo: string (Android), `{ message }` (iOS) ou `Error`. */
function describeError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function wrapError(message: string, cause: unknown): Error {
  return new Error(`${message}: ${describeError(cause)}`, { cause });
}

function nonEmpty(value: string | null | undefined): string | null {
  return value ? value : null;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function noop(): void {}

// ---------------------------------------------------------------------------
// Anúncio -> ScannedDevice
// ---------------------------------------------------------------------------

/** O que o aparelho anuncia, em texto, para o registro. */
function describeAdvertisement(advertising: AdvertisingData): string | null {
  const parts: string[] = [];
  const services = advertising.serviceUUIDs ?? [];
  if (services.length > 0) {
    parts.push(`serviços=[${services.map(shortUuid).join(', ')}]`);
  }
  for (const [uuid, data] of Object.entries(advertising.serviceData ?? {})) {
    parts.push(`serviceData[${shortUuid(uuid)}]=${bytesToHex(data?.bytes ?? [])}`);
  }
  for (const [company, data] of Object.entries(advertising.manufacturerData ?? {})) {
    parts.push(`fabricante[${company}]=${bytesToHex(data?.bytes ?? [])}`);
  }
  if (advertising.isConnectable === false) {
    parts.push('não conectável');
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function toScannedDevice(peripheral: Peripheral): ScannedDevice {
  const advertising: AdvertisingData = peripheral.advertising ?? {};
  const serviceData = advertising.serviceData ?? {};

  // Android e iOS entregam o Service Data sem o UUID na frente, em bytes sem sinal
  // (`DefaultPeripheral.java:83`, `Helper.swift:62`): é o que parseFtmsServiceData espera.
  const ftmsKey = Object.keys(serviceData).find((key) => sameUuid(key, FTMS.service));
  const ftmsBytes = ftmsKey === undefined ? undefined : serviceData[ftmsKey]?.bytes;

  const listsFtmsService = (advertising.serviceUUIDs ?? []).some((uuid) =>
    sameUuid(uuid, FTMS.service),
  );

  return {
    id: peripheral.id,
    name: nonEmpty(peripheral.name) ?? nonEmpty(advertising.localName),
    rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
    advertisesFtms: listsFtmsService || ftmsKey !== undefined,
    ftms: ftmsBytes ? parseFtmsServiceData(Uint8Array.from(ftmsBytes)) : null,
    advertisement: describeAdvertisement(advertising),
  };
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

function characteristicKey(serviceUuid: string, characteristicUuid: string): string {
  return `${normalizeUuid(serviceUuid)}|${normalizeUuid(characteristicUuid)}`;
}

function toCharacteristicInfo(characteristic: Characteristic): CharacteristicInfo {
  const { properties } = characteristic;
  return {
    uuid: normalizeUuid(characteristic.characteristic),
    canRead: properties.Read !== undefined,
    canNotify: properties.Notify !== undefined,
    canIndicate: properties.Indicate !== undefined,
  };
}

function createConnection(
  deviceId: string,
  name: string | null,
  info: PeripheralInfo,
): BleConnection {
  /** `disconnect()` foi chamado por nós. */
  let closed = false;
  /** O link caiu sem que tivéssemos pedido. */
  let dropped = false;
  let disconnecting: Promise<void> | null = null;

  const valueHandlers = new Map<string, Set<(data: Uint8Array) => void>>();
  const disconnectListeners = new Set<() => void>();

  // Um único listener global de valores por conexão; o despacho é por característica.
  const valueSubscription = BleManager.onDidUpdateValueForCharacteristic((event) => {
    if (!sameId(event.peripheral, deviceId)) {
      return;
    }
    const handlers = valueHandlers.get(characteristicKey(event.service, event.characteristic));
    if (!handlers) {
      return;
    }
    // Uma cópia por assinante: ninguém recebe o array de quem veio antes.
    handlers.forEach((handler) => handler(Uint8Array.from(event.value)));
  });

  const disconnectSubscription = BleManager.onDisconnectPeripheral((event) => {
    if (closed || dropped || !sameId(event.peripheral, deviceId)) {
      return;
    }
    dropped = true;
    releaseNativeListeners();
    valueHandlers.clear();
    const listeners = [...disconnectListeners];
    disconnectListeners.clear();
    listeners.forEach((listener) => listener());
  });

  function releaseNativeListeners(): void {
    valueSubscription.remove();
    disconnectSubscription.remove();
  }

  return {
    deviceId,
    name,

    async getServices() {
      const byService = new Map<string, ServiceInfo>();
      const entry = (uuid: string): ServiceInfo => {
        const key = normalizeUuid(uuid);
        let service = byService.get(key);
        if (!service) {
          service = { uuid: key, characteristics: [] };
          byService.set(key, service);
        }
        return service;
      };
      // `services` garante que um serviço sem características também apareça.
      (info.services ?? []).forEach((service) => entry(service.uuid));
      (info.characteristics ?? []).forEach((characteristic) =>
        entry(characteristic.service).characteristics.push(toCharacteristicInfo(characteristic)),
      );
      return [...byService.values()];
    },

    async getCharacteristics(serviceUuid) {
      return (info.characteristics ?? [])
        .filter((characteristic) => sameUuid(characteristic.service, serviceUuid))
        .map(toCharacteristicInfo);
    },

    async read(serviceUuid, characteristicUuid) {
      try {
        const data = await BleManager.read(
          deviceId,
          toNativeUuid(serviceUuid),
          toNativeUuid(characteristicUuid),
        );
        return Uint8Array.from(data);
      } catch (error) {
        throw wrapError(`Falha ao ler ${characteristicName(characteristicUuid)}`, error);
      }
    },

    async subscribe(serviceUuid, characteristicUuid, onValue) {
      const key = characteristicKey(serviceUuid, characteristicUuid);
      const nativeService = toNativeUuid(serviceUuid);
      const nativeCharacteristic = toNativeUuid(characteristicUuid);

      // Registra antes de habilitar: nenhum valor enviado logo após a habilitação se perde.
      let handlers = valueHandlers.get(key);
      if (!handlers) {
        handlers = new Set();
        valueHandlers.set(key, handlers);
      }
      const handler = (data: Uint8Array) => onValue(data);
      handlers.add(handler);

      const unregister = (): boolean => {
        const current = valueHandlers.get(key);
        current?.delete(handler);
        if (current && current.size === 0) {
          valueHandlers.delete(key);
          return true;
        }
        return false;
      };

      try {
        // Vale para notify e para característica só com indicate:
        // `Peripheral.java:730` e `getContext` em `SwiftBleManager.swift:320`.
        await BleManager.startNotification(deviceId, nativeService, nativeCharacteristic);
      } catch (error) {
        unregister();
        throw wrapError(
          `Falha ao ativar as notificações de ${characteristicName(characteristicUuid)}`,
          error,
        );
      }

      let removed = false;
      return {
        remove() {
          if (removed) {
            return;
          }
          removed = true;
          const lastOne = unregister();
          // Se o link já acabou, não há o que desligar no equipamento.
          if (lastOne && !closed && !dropped) {
            BleManager.stopNotification(deviceId, nativeService, nativeCharacteristic).catch(noop);
          }
        },
      };
    },

    onDisconnect(listener) {
      if (closed) {
        return { remove: noop };
      }
      if (dropped) {
        // A queda aconteceu antes de o chamador registrar o listener: avisa assim mesmo.
        let cancelled = false;
        Promise.resolve().then(() => {
          if (!cancelled && !closed) {
            listener();
          }
        });
        return {
          remove() {
            cancelled = true;
          },
        };
      }
      disconnectListeners.add(listener);
      return {
        remove() {
          disconnectListeners.delete(listener);
        },
      };
    },

    disconnect() {
      if (!disconnecting) {
        // Marca antes de chamar o nativo: o Android emite o evento de desconexão
        // dentro da própria chamada (`Peripheral.java:198`).
        closed = true;
        releaseNativeListeners();
        valueHandlers.clear();
        disconnectListeners.clear();
        disconnecting = BleManager.disconnect(deviceId).catch(noop);
      }
      return disconnecting;
    },
  };
}

/** Rejeita com `onTimeout()` se `promise` não resolver em `ms`. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

export function createBleManagerTransport(): BleTransport {
  let starting: Promise<void> | null = null;
  /** Nomes vistos na busca: o Android pode não informar o nome depois de conectar. */
  const scannedNames = new Map<string, string>();

  function ensureStarted(): Promise<void> {
    starting ??= BleManager.start({ showAlert: false }).catch((error: unknown) => {
      starting = null;
      if (describeError(error).includes('No bluetooth support')) {
        throw new BleUnavailableError(
          'unsupported',
          'Este aparelho não tem Bluetooth de baixa energia (BLE), necessário para ler os dados da esteira.',
        );
      }
      throw wrapError('Falha ao iniciar o Bluetooth', error);
    });
    return starting;
  }

  /**
   * Lê o estado do adaptador e, se for transitório, espera até
   * `ADAPTER_STATE_TIMEOUT_MS` por um estado definitivo. O listener entra antes
   * do `checkState` para nenhuma mudança escapar entre as duas chamadas.
   */
  function readAdapterState(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let finished = false;
      let latest: string = BleState.Unknown;
      const subscription = BleManager.onDidUpdateState(({ state }) => handle(state));
      const timer = setTimeout(() => finish(() => resolve(latest)), ADAPTER_STATE_TIMEOUT_MS);

      function finish(settle: () => void): void {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        subscription.remove();
        settle();
      }

      function handle(state: string): void {
        latest = state;
        if (!TRANSIENT_STATES.includes(state)) {
          finish(() => resolve(state));
        }
      }

      BleManager.checkState().then(handle, (error: unknown) =>
        finish(() => reject(wrapError('Falha ao consultar o estado do Bluetooth', error))),
      );
    });
  }

  async function ensureAdapterOn(): Promise<void> {
    let state = await readAdapterState();

    if (state === BleState.Unsupported) {
      throw new BleUnavailableError(
        'unsupported',
        'Este aparelho não tem Bluetooth de baixa energia (BLE), necessário para ler os dados da esteira.',
      );
    }
    if (state === BleState.Unauthorized) {
      throw new BleUnavailableError(
        'unauthorized',
        'O Gym Burn não tem acesso ao Bluetooth. Abra os Ajustes do iPhone, toque em Gym Burn e libere o Bluetooth.',
      );
    }
    if (TRANSIENT_STATES.includes(state)) {
      throw new Error(
        'Não foi possível confirmar o estado do Bluetooth. Verifique se ele está ligado e tente de novo.',
      );
    }
    if (state === BleState.On) {
      return;
    }

    // Desligado (ou desligando).
    if (Platform.OS === 'android') {
      try {
        await BleManager.enableBluetooth();
        state = await readAdapterState();
      } catch {
        // O usuário recusou o diálogo do sistema ou ele não pôde ser aberto.
      }
      if (state === BleState.On) {
        return;
      }
    }
    throw new BleUnavailableError(
      'poweredOff',
      'O Bluetooth está desligado. Ligue o Bluetooth do celular e tente de novo.',
    );
  }

  return {
    async prepare() {
      await requestBlePermissions();
      await ensureStarted();
      await ensureAdapterOn();
    },

    scan(onDevice, onError) {
      let removed = false;
      let stopped = false;

      const discoverSubscription = BleManager.onDiscoverPeripheral((peripheral) => {
        if (removed || stopped) {
          return;
        }
        const device = toScannedDevice(peripheral);
        if (device.name) {
          scannedNames.set(device.id, device.name);
        }
        onDevice(device);
      });

      // O scan é contínuo (`seconds: 0`), então um evento de parada antes do `remove()`
      // é falha do rádio (no Android, `onScanFailed` em `DefaultScanManager.java:334`).
      // Reiniciar sozinho poderia girar em laço contra um erro persistente (ex.: limite de
      // inícios de scan do Android); quem decide tentar de novo é a sessão.
      const stopSubscription = BleManager.onStopScan(({ status }) => {
        if (removed || stopped) {
          return;
        }
        stopped = true;
        discoverSubscription.remove();
        stopSubscription.remove();
        const code = status === undefined ? '' : ` (código ${status})`;
        onError(new Error(`A busca por esteiras parou sozinha${code}. Tente buscar de novo.`));
      });

      BleManager.scan({
        // Sem filtro de serviço: a T600X pode não anunciar 0x1826 no pacote de anúncio.
        serviceUUIDs: [],
        // 0 = sem limite de tempo (`index.js:391`): vale até o `remove()`.
        seconds: 0,
        // iOS: sem isso o RSSI só chega uma vez. No Android é ignorado — o callback
        // AllMatches já repassa todo anúncio.
        allowDuplicates: true,
        // Padrão da biblioteca é LowPower, que demora a achar o aparelho.
        scanMode: BleScanMode.LowLatency,
      }).catch((error: unknown) => {
        if (!removed && !stopped) {
          stopped = true;
          onError(wrapError('Falha ao iniciar a busca por esteiras', error));
        }
      });

      return {
        remove() {
          if (removed) {
            return;
          }
          removed = true;
          // Antes do stopScan: o nativo emite onStopScan na própria chamada
          // (`BleManager.java:395`) e isso não é uma parada inesperada.
          discoverSubscription.remove();
          stopSubscription.remove();
          if (!stopped) {
            BleManager.stopScan().catch(noop);
          }
        },
      };
    },

    async connect(deviceId) {
      // O Android não exige parar o scan antes de conectar (`BleManager.java:452`) e o iOS
      // reaproveita ou recupera o periférico pelo UUID (`SwiftBleManager.swift:542`).
      // Sem MTU, sem prioridade de conexão e sem createBond, de propósito.
      let abandoned = false;
      let timedOut = false;

      const attempt = (async (): Promise<PeripheralInfo> => {
        await BleManager.connect(deviceId);
        if (abandoned) {
          throw new Error('Conexão abandonada.');
        }
        return BleManager.retrieveServices(deviceId);
      })();

      let info: PeripheralInfo;
      try {
        info = await raceWithTimeout(
          attempt,
          CONNECT_TIMEOUT_MS,
          () => {
            timedOut = true;
            return new Error(
              `Tempo esgotado ao conectar na esteira (${CONNECT_TIMEOUT_MS / 1000} s). Aproxime o celular da esteira e tente de novo.`,
            );
          },
        );
      } catch (error) {
        abandoned = true;
        // Se o nativo ainda responder depois do estouro, a rejeição não pode ficar solta.
        attempt.catch(noop);
        await BleManager.disconnect(deviceId).catch(noop);
        if (timedOut) {
          throw error;
        }
        throw wrapError('Falha ao conectar na esteira', error);
      }

      const name = nonEmpty(info.name) ?? scannedNames.get(deviceId) ?? null;
      return createConnection(deviceId, name, info);
    },
  };
}
