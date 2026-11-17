import {
  bytesToHex,
  characteristicName,
  FTMS,
  hexToBytes,
  normalizeUuid,
  parseFtmsServiceData,
  sameUuid,
  shortUuid,
} from '@/ftms';

import { Linking } from 'react-native';

import { BleUnavailableError } from './transport';
import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
  ServiceInfo,
} from './transport';

/**
 * Transporte que fala com o app-ponte (`bridge-app/`) pelo HTTP local.
 *
 * A ponte é um app separado, com serviço em primeiro plano: ela abre o GATT,
 * mantém o link com a esteira e reconecta sozinha. Reinstalar o GymBurn não
 * derruba a conexão — o app só se reconecta à ponte quando volta.
 *
 * O contrato é o mesmo de `ble-manager-transport.ts` (BleTransport).
 */

export const BRIDGE_BASE_URL = 'http://127.0.0.1:8765';

/** Sondagem rápida: a ponte nem sempre está instalada/ativa. */
const PROBE_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 15_000;
const STATUS_POLL_MS = 250;
/** Uma característica nunca pode perder eventos entre dois ciclos de busca. */
const EVENTS_POLL_MS = 180;

type Payload = Record<string, unknown>;

interface BridgeEvent {
  seq?: number;
  type?: string;
  [key: string]: unknown;
}

function normalizeId(id: string): string {
  return id.trim().toUpperCase();
}

function sameId(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function object(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      out[key] = item;
    }
  }
  return out;
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: Payload; timeoutMs?: number } = {},
): Promise<Payload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = (await response.json()) as Payload;
    if (payload.ok === false) {
      throw new Error(text(payload.error) || 'erro na ponte');
    }
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Ponte GymBurn: ${message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Verdadeiro quando o app-ponte está instalado e o serviço está ativo. */
export async function bridgeAvailable(baseUrl: string = BRIDGE_BASE_URL): Promise<boolean> {
  try {
    await request(baseUrl, '/ping', { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Evita abrir o atalho da ponte a cada tentativa quando ela não está instalada. */
let lastBridgeStartAt = 0;
const BRIDGE_START_COOLDOWN_MS = 5_000;

/**
 * Acorda a ponte sem o usuário abrir o app dela: o `StartActivity` do app-ponte
 * sobe o serviço e fecha antes de aparecer. Silencioso quando a ponte não está
 * instalada.
 */
export async function requestBridgeStart(): Promise<void> {
  const now = Date.now();
  if (now - lastBridgeStartAt < BRIDGE_START_COOLDOWN_MS) {
    return;
  }
  lastBridgeStartAt = now;
  try {
    await Linking.openURL('gymburn-bridge://start');
  } catch {
    // App da ponte não instalado, ou o Android recusou abrir o atalho.
  }
}

/** Mesmo formato de `bytesToHex` usado pelo transporte direto, para os logs serem comparáveis. */
function formatHex(value: string): string {
  try {
    return bytesToHex(hexToBytes(value));
  } catch {
    return value.toUpperCase();
  }
}

/** A ponte entrega o ID de fabricante em decimal; o transporte direto usa hexa de 4 dígitos. */
function formatCompany(key: string): string {
  const numeric = Number(key);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffff) {
    return numeric.toString(16).padStart(4, '0');
  }
  return key;
}

function describeAdvertisement(
  serviceUuids: string[],
  serviceData: Record<string, string>,
  manufacturerData: Record<string, string>,
  connectable: boolean | null,
): string | null {
  const parts: string[] = [];
  if (serviceUuids.length > 0) {
    parts.push(`serviços=[${serviceUuids.map(shortUuid).join(', ')}]`);
  }
  for (const [uuid, data] of Object.entries(serviceData)) {
    parts.push(`serviceData[${shortUuid(uuid)}]=${formatHex(data)}`);
  }
  for (const [company, data] of Object.entries(manufacturerData)) {
    parts.push(`fabricante[${formatCompany(company)}]=${formatHex(data)}`);
  }
  if (connectable === false) {
    parts.push('não conectável');
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function toScannedDevice(event: BridgeEvent): ScannedDevice | null {
  const id = text(event.id);
  if (!id) {
    return null;
  }
  const serviceUuids = Array.isArray(event.serviceUuids)
    ? (event.serviceUuids as unknown[]).filter((uuid): uuid is string => typeof uuid === 'string')
    : [];
  const serviceData = object(event.serviceData);
  const manufacturerData = object(event.manufacturerData);
  const connectable = typeof event.connectable === 'boolean' ? event.connectable : null;

  const ftmsKey = Object.keys(serviceData).find((uuid) => sameUuid(uuid, FTMS.service));
  const listsFtmsService = serviceUuids.some((uuid) => sameUuid(uuid, FTMS.service));
  const ftmsBytes = ftmsKey === undefined ? undefined : serviceData[ftmsKey];

  return {
    id,
    name: text(event.name) || null,
    rssi: number(event.rssi),
    advertisesFtms: listsFtmsService || ftmsKey !== undefined,
    ftms: ftmsBytes ? parseFtmsServiceData(hexToBytes(ftmsBytes)) : null,
    advertisement: describeAdvertisement(serviceUuids, serviceData, manufacturerData, connectable),
  };
}

function characteristicKey(serviceUuid: string, characteristicUuid: string): string {
  return `${normalizeUuid(serviceUuid)}|${normalizeUuid(characteristicUuid)}`;
}

function toCharacteristicInfo(entry: Record<string, unknown>): CharacteristicInfo {
  return {
    uuid: normalizeUuid(text(entry.uuid)),
    canRead: entry.read === true,
    canWrite: entry.write === true,
    canNotify: entry.notify === true,
    canIndicate: entry.indicate === true,
  };
}

function parseServices(value: unknown): ServiceInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const services: ServiceInfo[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const characteristics = Array.isArray(record.characteristics)
      ? (record.characteristics as unknown[])
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map(toCharacteristicInfo)
      : [];
    services.push({ uuid: normalizeUuid(text(record.uuid)), characteristics });
  }
  return services;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
  throw new Error(`Ponte GymBurn: tempo esgotado esperando ${what}`);
}

/** Implementação real: só é usada quando a ponte responde em 127.0.0.1:8765. */
export function createBridgeTransport(baseUrl: string = BRIDGE_BASE_URL): BleTransport {
  let lastSeq = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let scanSink: {
    onDevice: (device: ScannedDevice) => void;
    onError: (error: Error) => void;
  } | null = null;
  let routing: {
    onValue: (key: string, data: Uint8Array) => void;
    onDrop: () => void;
  } | null = null;

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollOnce(): Promise<void> {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const payload = await request(baseUrl, `/events?after=${lastSeq}`, { timeoutMs: 2_500 });
      const events = Array.isArray(payload.events) ? (payload.events as unknown[]) : [];
      for (const raw of events) {
        if (typeof raw !== 'object' || raw === null) {
          continue;
        }
        const event = raw as BridgeEvent;
        if (typeof event.seq === 'number' && event.seq > lastSeq) {
          lastSeq = event.seq;
        }
        handleEvent(event);
      }
    } catch {
      // Ponte momentaneamente fora do ar: o próximo ciclo tenta de novo.
    } finally {
      polling = false;
      if (scanSink === null && routing === null) {
        stopPolling();
      }
    }
  }

  function handleEvent(event: BridgeEvent): void {
    switch (event.type) {
      case 'scan': {
        const sink = scanSink;
        if (!sink) {
          return;
        }
        const device = toScannedDevice(event);
        if (device) {
          sink.onDevice(device);
        }
        return;
      }
      case 'notify': {
        const target = routing;
        if (!target) {
          return;
        }
        target.onValue(
          characteristicKey(text(event.service), text(event.char)),
          hexToBytes(text(event.data)),
        );
        return;
      }
      case 'disconnected': {
        routing?.onDrop();
        return;
      }
      default:
        return;
    }
  }

  function ensurePoller(): void {
    if (pollTimer !== null) {
      return;
    }
    pollTimer = setInterval(() => {
      void pollOnce();
    }, EVENTS_POLL_MS);
    void pollOnce();
  }

  async function startSeqFromStatus(): Promise<void> {
    try {
      const status = await request(baseUrl, '/status', { timeoutMs: 1_500 });
      const seq = number(status.lastSeq);
      if (seq !== null && seq > lastSeq) {
        lastSeq = seq;
      }
    } catch {
      // Sem status: começa do zero; eventos antigos são ignorados por tipo.
    }
  }

  function makeConnection(
    deviceId: string,
    name: string | null,
    services: ServiceInfo[],
  ): BleConnection {
    let closed = false;
    let dropped = false;
    const valueHandlers = new Map<string, Set<(data: Uint8Array) => void>>();
    const disconnectListeners = new Set<() => void>();

    routing = {
      onValue(key, data) {
        valueHandlers.get(key)?.forEach((handler) => handler(Uint8Array.from(data)));
      },
      onDrop() {
        if (closed || dropped) {
          return;
        }
        dropped = true;
        routing = null;
        valueHandlers.clear();
        const listeners = [...disconnectListeners];
        disconnectListeners.clear();
        listeners.forEach((listener) => listener());
      },
    };

    const serviceByUuid = new Map<string, ServiceInfo>();
    services.forEach((service) => serviceByUuid.set(normalizeUuid(service.uuid), service));

    return {
      deviceId,
      name,

      async getServices() {
        return services;
      },

      async getCharacteristics(serviceUuid) {
        return serviceByUuid.get(normalizeUuid(serviceUuid))?.characteristics ?? [];
      },

      async read(serviceUuid, characteristicUuid) {
        try {
          const payload = await request(baseUrl, '/read', {
            method: 'POST',
            body: { service: serviceUuid, char: characteristicUuid },
          });
          return hexToBytes(text(payload.data));
        } catch (error) {
          throw new Error(`Falha ao ler ${characteristicName(characteristicUuid)}: ${String(error)}`, {
            cause: error,
          });
        }
      },

      async write(serviceUuid, characteristicUuid, data) {
        try {
          await request(baseUrl, '/write', {
            method: 'POST',
            body: {
              service: serviceUuid,
              char: characteristicUuid,
              data: bytesToHex(data, ''),
              response: true,
            },
          });
        } catch (error) {
          throw new Error(
            `Falha ao escrever em ${characteristicName(characteristicUuid)}: ${String(error)}`,
            { cause: error },
          );
        }
      },

      async subscribe(serviceUuid, characteristicUuid, onValue) {
        const key = characteristicKey(serviceUuid, characteristicUuid);
        let handlers = valueHandlers.get(key);
        if (!handlers) {
          handlers = new Set();
          valueHandlers.set(key, handlers);
        }
        handlers.add(onValue);
        if (handlers.size === 1) {
          try {
            await request(baseUrl, '/subscribe', {
              method: 'POST',
              body: { service: serviceUuid, char: characteristicUuid, notify: true },
            });
          } catch (error) {
            const remaining = handlers;
            remaining.delete(onValue);
            if (remaining.size === 0) {
              valueHandlers.delete(key);
            }
            throw new Error(
              `Falha ao assinar ${characteristicName(characteristicUuid)}: ${String(error)}`,
              { cause: error },
            );
          }
        }
        const subscription: BleSubscription = {
          remove: () => {
            const current = valueHandlers.get(key);
            if (!current) {
              return;
            }
            current.delete(onValue);
            if (current.size === 0) {
              valueHandlers.delete(key);
              void request(baseUrl, '/subscribe', {
                method: 'POST',
                body: { service: serviceUuid, char: characteristicUuid, notify: false },
              }).catch(() => undefined);
            }
          },
        };
        return subscription;
      },

      onDisconnect(listener) {
        disconnectListeners.add(listener);
        return { remove: () => disconnectListeners.delete(listener) };
      },

      async disconnect() {
        closed = true;
        routing = null;
        valueHandlers.clear();
        await request(baseUrl, '/disconnect', { method: 'POST' }).catch(() => undefined);
      },
    };
  }

  return {
    async prepare() {
      await startSeqFromStatus();
      let status: Payload;
      try {
        status = await request(baseUrl, '/status', { timeoutMs: 1_500 });
      } catch {
        throw new BleUnavailableError('unsupported', 'Ponte GymBurn não encontrada em 127.0.0.1:8765');
      }
      if (status.bluetoothEnabled === false) {
        throw new BleUnavailableError('poweredOff', 'Bluetooth desligado — ligue no celular e tente de novo');
      }
      const missing = Array.isArray(status.missingPermissions) ? status.missingPermissions : [];
      if (missing.length > 0) {
        throw new BleUnavailableError(
          'unauthorized',
          'Abra o app "Ponte GymBurn" e conceda as permissões de Bluetooth para ele',
        );
      }
    },

    scan(onDevice, onError) {
      ensurePoller();
      scanSink = { onDevice, onError };
      void request(baseUrl, '/scan/start', { method: 'POST' }).catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        remove() {
          scanSink = null;
          void request(baseUrl, '/scan/stop', { method: 'POST' }).catch(() => undefined);
        },
      };
    },

    async connect(deviceId) {
      ensurePoller();
      const status = await request(baseUrl, '/status', { timeoutMs: 1_500 });
      const currentId = text(status.deviceId);
      const alreadyConnected =
        status.connected === true && currentId.length > 0 && sameId(currentId, deviceId);

      if (!alreadyConnected) {
        await request(baseUrl, '/connect', {
          method: 'POST',
          body: { id: deviceId },
          timeoutMs: 3_000,
        });
        await waitFor(async () => {
          const current = await request(baseUrl, '/status', { timeoutMs: 1_500 });
          return current.connected === true && current.servicesReady === true;
        }, CONNECT_TIMEOUT_MS, 'a conexão com a esteira');
      }

      const servicesPayload = await request(baseUrl, '/services', {
        method: 'POST',
        timeoutMs: 4_000,
      });
      const services = parseServices(servicesPayload.services);
      return makeConnection(deviceId, text(status.name) || null, services);
    },
  };
}
