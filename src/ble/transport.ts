import type { FtmsAdvertisement } from '@/ftms';

/**
 * Contrato entre a sessão da esteira e o rádio. Existem duas implementações:
 * a real (`ble-manager-transport.ts`) e a esteira simulada do modo
 * demonstração e dos testes (`src/simulator`).
 *
 * O contrato é só de leitura: o app não manda comando para a esteira, então
 * não existe escrita de característica (nem GATT write, nem Control Point).
 *
 * UUIDs entram e saem em qualquer formato aceito por `normalizeUuid`; quem
 * compara é responsável por normalizar.
 */

export type BleUnavailableReason =
  | 'unsupported' // o aparelho não tem Bluetooth LE
  | 'unauthorized' // o usuário negou a permissão
  | 'poweredOff'; // Bluetooth desligado

/** O Bluetooth não pode ser usado agora; `message` já vem pronta para exibir. */
export class BleUnavailableError extends Error {
  readonly reason: BleUnavailableReason;

  constructor(reason: BleUnavailableReason, message: string) {
    super(message);
    this.name = 'BleUnavailableError';
    this.reason = reason;
  }
}

export interface ScannedDevice {
  id: string;
  name: string | null;
  rssi: number | null;
  /** O anúncio cita o Fitness Machine Service (em Service UUIDs ou em Service Data). */
  advertisesFtms: boolean;
  /** Service Data do FTMS decodificado, quando o anúncio traz. */
  ftms: FtmsAdvertisement | null;
  /**
   * O anúncio em texto (serviços, Service Data, dados do fabricante). Fica
   * disponível para a tela de detalhes mostrar como a esteira se anuncia.
   */
  advertisement?: string | null;
}

export interface CharacteristicInfo {
  uuid: string;
  canRead: boolean;
  canNotify: boolean;
  canIndicate: boolean;
}

export interface ServiceInfo {
  uuid: string;
  characteristics: CharacteristicInfo[];
}

export interface BleSubscription {
  remove(): void;
}

export interface BleConnection {
  readonly deviceId: string;
  readonly name: string | null;

  /** Tudo o que o equipamento expõe. */
  getServices(): Promise<ServiceInfo[]>;

  /** Características de um serviço; lista vazia se o equipamento não tem o serviço. */
  getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]>;

  read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array>;

  /**
   * Habilita notify ou indicate e entrega cada valor recebido. A promise só
   * resolve depois que o equipamento confirmou a habilitação — a primeira
   * notificação não se perde.
   */
  subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription>;

  /** Chamado uma vez quando o link cai, por qualquer motivo que não seja `disconnect()`. */
  onDisconnect(listener: () => void): BleSubscription;

  disconnect(): Promise<void>;
}

export interface BleTransport {
  /**
   * Pede as permissões necessárias e confere se o Bluetooth está ligado.
   * Lança `BleUnavailableError` quando não dá para usar o rádio.
   */
  prepare(): Promise<void>;

  /**
   * Procura equipamentos por perto até `remove()` ser chamado. Um mesmo
   * equipamento pode ser entregue várias vezes (o RSSI muda).
   */
  scan(
    onDevice: (device: ScannedDevice) => void,
    onError: (error: Error) => void,
  ): BleSubscription;

  /** Conecta e descobre serviços e características. */
  connect(deviceId: string): Promise<BleConnection>;
}
