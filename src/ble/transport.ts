import type { FtmsAdvertisement } from '@/ftms';

/**
 * Contrato entre as sessões (a da esteira e a da cinta de batimentos) e o rádio. Existem duas implementações:
 * a real (`ble-manager-transport.ts`) e a esteira simulada do modo
 * demonstração e dos testes (`src/simulator`).
 *
 * A leitura é o contrato de todos. A escrita é uma capacidade à parte
 * (`BleConnection.writer`) e só existe para a cinta: o canal proprietário da
 * XOSS X2 Pro (passos, gravação, alerta, arquivos) é conversado por escrita.
 * A esteira continua 100% só leitura: a sessão dela nunca usa o `writer`, e a
 * esteira simulada nem o implementa.
 *
 * UUIDs entram e saem em qualquer formato aceito por `normalizeUuid`; quem
 * compara é responsável por normalizar.
 */

/**
 * Maior escrita aceita numa chamada. A cinta só aceita uma conexão por vez e o
 * app não pede MTU maior: 20 bytes é o que cabe num pacote com o MTU padrão.
 * Quem precisa mandar mais fatia antes (o cliente XOSS).
 */
export const MAX_WRITE_BYTES = 20;

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
  /** O anúncio cita o Heart Rate Service (0x180D): é uma cinta ou relógio de batimentos. */
  advertisesHeartRate?: boolean;
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
  /** Aceita escrita com resposta (GATT Write Request). */
  canWrite?: boolean;
  /** Aceita escrita sem resposta (GATT Write Command). */
  canWriteWithoutResponse?: boolean;
}

/** `response`: o equipamento confirma a escrita. `noResponse`: vai sem confirmação. */
export type WriteMode = 'response' | 'noResponse';

/**
 * A capacidade de escrever numa característica. Só a cinta usa.
 *
 * A promise não prova que os bytes chegaram: sem resposta ela resolve assim
 * que a escrita entra na fila do Android, e com a fila nativa presa ela nunca
 * resolve. Quem conversa por escrita confirma pela notificação do aparelho,
 * com prazo próprio, e escreve uma coisa por vez (ver `ble-manager-transport.ts`).
 */
export interface BleWriter {
  /** Lança se `data` tiver mais de `MAX_WRITE_BYTES`. */
  write(
    serviceUuid: string,
    characteristicUuid: string,
    data: Uint8Array,
    mode: WriteMode,
  ): Promise<void>;
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

  /**
   * Escrita em característica. Existe no rádio de verdade e nos falsos da
   * cinta; a esteira simulada não tem. A sessão da esteira não usa.
   */
  readonly writer?: BleWriter;

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
   * equipamento pode ser entregue várias vezes (o RSSI muda). Pode haver mais
   * de uma busca aberta ao mesmo tempo (a da esteira e a da cinta): o rádio
   * faz uma só e entrega a todas.
   */
  scan(
    onDevice: (device: ScannedDevice) => void,
    onError: (error: Error) => void,
  ): BleSubscription;

  /** Conecta e descobre serviços e características. */
  connect(deviceId: string): Promise<BleConnection>;
}
