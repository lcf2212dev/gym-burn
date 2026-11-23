/**
 * Uma XOSS X2 Pro de mentira, para os testes: uma `BleConnection` com
 * `writer` que responde aos quadros do controle por notificação e serve e
 * recebe arquivos por YMODEM em pedaços de 20 bytes, como a cinta medida em
 * 22/11/2026. Fica fora de `__tests__` para o Jest não a tomar por um teste;
 * nada do app a importa.
 *
 * As respostas saem dentro da própria escrita, antes de a promise dela
 * resolver: é o caso difícil (a notificação chega ao JavaScript antes da
 * confirmação da escrita) e obriga o cliente a esperar a resposta antes de
 * escrever. Com `latencyMs` > 0 elas saem por temporizador.
 */
import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  BleWriter,
  CharacteristicInfo,
  ScannedDevice,
  WriteMode,
} from '@/ble/transport';
import { DEVICE_INFORMATION_SERVICE, normalizeUuid, sameUuid, uuid16 } from '@/ftms';

import { BATTERY, HEART_RATE } from '../../heart-rate';
import { FIT_EPOCH_OFFSET_S } from '../fit';
import { validFrame, xor, XOSS } from '../frames';
import { ACK, C, CAN, crc16Arc, EOT, encodeBlock, NAK, parseHeader, SOH } from '../ymodem';

const MODEL_NUMBER = uuid16(0x2a24);

/** O `user_profile.json` de fábrica, no formato da cinta. */
export const FACTORY_PROFILE =
  '{"sn":"000001","updated_at":1763800000,"gender":1,"birthday":441763200,' +
  '"weight":70000,"height":1700,"MAXHR":200,"LTHR":170,"time_zone":-10800}';

/** Um FIT mínimo como o da cinta: `file_id` e um `record` por segundo (FC e cadência). */
export function encodeFit(startMs: number, records: { bpm: number | null; cadence: number | null }[]) {
  const out: number[] = [];
  const u32 = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const start = Math.floor(startMs / 1000) - FIT_EPOCH_OFFSET_S;
  // file_id: local 0, global 0, campo 4 (time_created, uint32).
  out.push(0x40, 0, 0, 0, 0, 1, 4, 4, 0x86);
  out.push(0x00);
  u32(start);
  // record: local 1, global 20, campos 253 (uint32), 3 e 4 (uint8).
  out.push(0x41, 0, 0, 20, 0, 3, 253, 4, 0x86, 3, 1, 2, 4, 1, 2);
  records.forEach((record, i) => {
    out.push(0x01);
    u32(start + 1 + i);
    out.push(record.bpm ?? 0xff, record.cadence ?? 0xff);
  });
  const header = [14, 0x20, 0x77, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const size = out.length;
  header[4] = size & 0xff;
  header[5] = (size >>> 8) & 0xff;
  header[6] = (size >>> 16) & 0xff;
  return Uint8Array.from([...header, ...out, 0, 0]);
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const text = (bytes: ArrayLike<number>) => String.fromCharCode(...Array.from(bytes));

function reply(opcode: number, content: number[]): Uint8Array {
  const body = [opcode, ...content];
  return Uint8Array.from([...body, xor(body)]);
}

/** Nome do FIT pelo início da gravação, em UTC: `AAAAMMDDhhmmss.fit`. */
export function fitName(atMs: number): string {
  const d = new Date(atMs);
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    two(d.getUTCMonth() + 1) +
    two(d.getUTCDate()) +
    two(d.getUTCHours()) +
    two(d.getUTCMinutes()) +
    two(d.getUTCSeconds()) +
    '.fit'
  );
}

export interface XossFaults {
  /** Códigos de comando que ficam sem resposta (e sem efeito). */
  silent: Set<number>;
  /** Comandos (em hexa, sem o XOR: `75 01`) que a cinta executa, mas cuja resposta se perde. */
  lostReplies: Set<string>;
  /** A cinta responde ao `75 01` e não começa a gravar. */
  refuseRecording: boolean;
  /** A próxima escrita deste comando (hexa, sem o XOR) é recusada pelo rádio, como o "Write failed" do Android. */
  rejectCommand: string | null;
  /** A resposta destes comandos (hexa, sem o XOR) sai só depois de tantos ms. */
  replyDelay: Map<string, number>;
  /** Pedidos de download destes arquivos ficam sem resposta. */
  silentFetch: Set<string>;
  /** No envio (a cinta recebendo), um pedaço do meio deste bloco se perde uma vez. */
  dropChunkOfBlock: number | null;
  /** A cinta responde aos `71 01 <bpm>`, mas não troca o alerta. */
  frozenAlert: boolean;
  /** No download, o bloco de dados deste número vai uma vez com CRC ruim. */
  badCrcBlock: number | null;
  /** No download, o bloco zero vai duas vezes (o ACK ou o `C` "se perdeu"). */
  repeatHeader: boolean;
  /** No download, este bloco vai de novo depois do ACK (o ACK "se perdeu"). */
  repeatBlock: number | null;
  /** No envio, a cinta não responde o primeiro envio deste bloco. */
  loseAckBlock: number | null;
  /** O link cai quando a cinta for mandar este bloco do download. */
  dropAtBlock: number | null;
  /** `filelist.txt` vem vazio. */
  emptyList: boolean;
  /** No envio, a cinta responde `15` no fim (não entendeu o arquivo). */
  rejectFile: boolean;
  /** As escritas nunca resolvem: a fila nativa presa. */
  stuckWrites: boolean;
}

export class FakeXossStrap implements BleConnection {
  readonly name: string | null = 'XOSS_X2P_989171';
  readonly writer: BleWriter;
  /** Sem o serviço 6e400001, é uma cinta como outra qualquer. */
  xossService = true;
  model = 'X2PRO';
  battery = 86;
  disconnected = false;
  latencyMs = 0;

  // Estado da cinta.
  stepsOn = false;
  spm = 0;
  steps = 0;
  alert = 0;
  recording = false;
  recordingStartedAt: number | null = null;
  recordMode = 0;
  freeKb = 970;
  totalKb = 972;
  clock: number | null = null;
  readonly files = new Map<string, Uint8Array>([['user_profile.json', ascii(FACTORY_PROFILE)]]);
  /** Como a cinta reescreve o perfil aceito (o `sn` vira o número de série, a formatação muda). */
  rewriteProfile = (raw: string) => raw.replace('"sn":"000001"', '"sn": "989171"').replace(/,"/g, ', "');

  readonly faults: XossFaults = {
    silent: new Set(),
    lostReplies: new Set(),
    refuseRecording: false,
    rejectCommand: null,
    replyDelay: new Map(),
    silentFetch: new Set(),
    dropChunkOfBlock: null,
    frozenAlert: false,
    badCrcBlock: null,
    repeatHeader: false,
    repeatBlock: null,
    loseAckBlock: null,
    dropAtBlock: null,
    emptyList: false,
    rejectFile: false,
    stuckWrites: false,
  };

  /** Tudo o que o app escreveu, em ordem. */
  readonly writes: { characteristic: string; bytes: number[]; mode: WriteMode }[] = [];
  /** Os comandos recebidos no controle, em hexa (`72 01 …`), sem o XOR. */
  readonly commands: string[] = [];
  /** O app mandou CAN no canal de dados. */
  cancelled = false;
  /** Arquivos que a cinta aceitou por YMODEM. */
  readonly received: { name: string; data: Uint8Array }[] = [];

  private readonly handlers = new Map<string, (data: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  // YMODEM: a cinta mandando (download) ou recebendo (envio).
  private outgoing: {
    name: string;
    data: Uint8Array;
    state: 'waitC' | 'header' | 'headerC' | 'block' | 'eot1' | 'eot2';
    block: number;
    headerRepeated: boolean;
    badSent: boolean;
    repeated: boolean;
  } | null = null;
  private incoming: {
    name: string;
    state: 'header' | 'data' | 'eot';
    buffer: number[];
    data: number[];
    size: number | null;
    last: number;
    lostAck: boolean;
    /** O bloco que está chegando e quantos pedaços dele já vieram. */
    block: number;
    chunk: number;
    droppedChunk: boolean;
    lastAt: number;
  } | null = null;

  constructor(readonly deviceId = 'C5:2A:C5:16:AF:97') {
    this.writer = { write: (service, characteristic, data, mode) => this.write(service, characteristic, data, mode) };
  }

  // --- BleConnection ---------------------------------------------------------

  async getServices() {
    return [];
  }

  async getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]> {
    const info = (uuid: string, flags: Partial<CharacteristicInfo>): CharacteristicInfo => ({
      uuid: normalizeUuid(uuid),
      canRead: false,
      canNotify: false,
      canIndicate: false,
      ...flags,
    });
    if (sameUuid(serviceUuid, HEART_RATE.service)) return [info(HEART_RATE.measurement, { canNotify: true })];
    if (sameUuid(serviceUuid, BATTERY.service))
      return [info(BATTERY.level, { canRead: true, canNotify: true })];
    if (sameUuid(serviceUuid, DEVICE_INFORMATION_SERVICE)) return [info(MODEL_NUMBER, { canRead: true })];
    if (sameUuid(serviceUuid, XOSS.service) && this.xossService)
      return [
        info(XOSS.rx, { canWrite: true, canWriteWithoutResponse: true }),
        info(XOSS.tx, { canNotify: true }),
        info(XOSS.control, { canWrite: true, canNotify: true }),
      ];
    return [];
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    if (sameUuid(characteristicUuid, BATTERY.level)) return Uint8Array.of(this.battery);
    if (sameUuid(characteristicUuid, MODEL_NUMBER)) return ascii(this.model);
    throw new Error('não legível');
  }

  async subscribe(
    _service: string,
    characteristicUuid: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription> {
    const key = normalizeUuid(characteristicUuid);
    this.handlers.set(key, onValue);
    return { remove: () => void (this.handlers.get(key) === onValue && this.handlers.delete(key)) };
  }

  onDisconnect(listener: () => void): BleSubscription {
    this.disconnectListeners.add(listener);
    return { remove: () => void this.disconnectListeners.delete(listener) };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.handlers.clear();
    this.disconnectListeners.clear();
  }

  // --- Simulação ---------------------------------------------------------------

  subscribed(characteristicUuid: string): boolean {
    return this.handlers.has(normalizeUuid(characteristicUuid));
  }

  private notify(characteristicUuid: string, data: Uint8Array): void {
    const deliver = () => this.handlers.get(normalizeUuid(characteristicUuid))?.(data);
    if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
    else deliver();
  }

  /** Um pacote de Heart Rate Measurement com RR (flags 0x10), como a X2 Pro manda. */
  beat(bpm: number, rrMs: number[] = [Math.round(60000 / bpm)]): void {
    const bytes = [0x10, bpm];
    for (const rr of rrMs) {
      const raw = Math.round((rr * 1024) / 1000);
      bytes.push(raw & 0xff, raw >> 8);
    }
    this.handlers.get(normalizeUuid(HEART_RATE.measurement))?.(Uint8Array.from(bytes));
  }

  batteryLevel(percent: number): void {
    this.battery = percent;
    this.handlers.get(normalizeUuid(BATTERY.level))?.(Uint8Array.of(percent));
  }

  /** A queda do link, sem `disconnect()` do app. */
  drop(): void {
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    this.handlers.clear();
    this.disconnected = true;
    listeners.forEach((listener) => listener());
  }

  /** Uma gravação encerrada vira um FIT na memória (as de menos de 30 s não geram arquivo). */
  private finishRecording(): void {
    const startedAt = this.recordingStartedAt;
    this.recording = false;
    this.recordingStartedAt = null;
    this.steps = 0;
    if (startedAt === null) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds < 30) return;
    const records = Array.from({ length: seconds }, (_, i) => ({ bpm: 120 + (i % 10), cadence: 110 }));
    this.files.set(fitName(startedAt), encodeFit(startedAt, records));
  }

  private fileList(): Uint8Array {
    if (this.faults.emptyList) return new Uint8Array(0);
    const lines = [...this.files.entries()]
      .filter(([name]) => name.endsWith('.fit'))
      .map(([name, data]) => `${name} ${data.length}\n`);
    return ascii(lines.join(''));
  }

  private write(
    serviceUuid: string,
    characteristicUuid: string,
    data: Uint8Array,
    mode: WriteMode,
  ): Promise<void> {
    if (data.length > 20) {
      throw new Error(`escrita de ${data.length} bytes na cinta`);
    }
    if (this.disconnected) {
      return Promise.reject(new Error('desconectada'));
    }
    this.writes.push({ characteristic: normalizeUuid(characteristicUuid), bytes: Array.from(data), mode });
    if (this.faults.stuckWrites) {
      return new Promise(() => {});
    }
    if (!sameUuid(serviceUuid, XOSS.service)) {
      return Promise.reject(new Error('serviço errado'));
    }
    if (sameUuid(characteristicUuid, XOSS.control)) {
      const command = Array.from(data.subarray(0, data.length - 1), (b) => b.toString(16).padStart(2, '0')).join(' ');
      if (this.faults.rejectCommand === command) {
        this.faults.rejectCommand = null;
        return Promise.reject(new Error('Write failed'));
      }
      this.control(Uint8Array.from(data));
    } else if (sameUuid(characteristicUuid, XOSS.rx)) {
      this.data(Uint8Array.from(data));
    }
    return Promise.resolve();
  }

  private control(frame: Uint8Array): void {
    if (!validFrame(frame)) return;
    const opcode = frame[0];
    const body = Array.from(frame.subarray(1, frame.length - 1));
    const command = [opcode, ...body].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    this.commands.push(command);
    if (this.faults.silent.has(opcode)) return;
    const lost = this.faults.lostReplies.has(command);
    const delay = this.faults.replyDelay.get(command);
    const send = (bytes: Uint8Array) => {
      if (lost) return;
      if (delay) setTimeout(() => this.notify(XOSS.control, bytes), delay);
      else this.notify(XOSS.control, bytes);
    };
    switch (opcode) {
      case 0xff:
        send(reply(0x04, [0x00]));
        break;
      case 0x09:
        send(reply(0x0a, Array.from(ascii(`${this.freeKb}/${this.totalKb}`))));
        break;
      case 0x54:
        this.clock = (body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] << 24)) >>> 0;
        send(reply(0x55, [0x00]));
        break;
      case 0x71:
        if (body[0] === 0x01 && !this.faults.frozenAlert) this.alert = body[1] ?? 0;
        send(reply(0x71, [this.alert, 0, 0]));
        break;
      case 0x72: {
        if (body.length >= 6) this.stepsOn = body[0] === 1;
        const s = this.steps;
        send(reply(0x72, [this.stepsOn ? 1 : 0, this.spm, s & 0xff, (s >>> 8) & 0xff, (s >>> 16) & 0xff, s >>> 24]));
        break;
      }
      case 0x75:
        if (body[0] === 0x01) {
          if (this.recordMode === 0 && !this.recording && !this.faults.refuseRecording) {
            this.recording = true;
            this.recordingStartedAt = Date.now();
          }
          send(reply(0x75, [this.recording ? 0x01 : 0xff]));
        } else if (body[0] === 0x02) {
          this.finishRecording();
          send(reply(0x75, [0x04]));
        } else {
          send(reply(0x75, [this.recording ? 0x01 : 0xff]));
        }
        break;
      case 0x76:
        send(reply(0x76, [this.recordMode]));
        break;
      case 0x05: {
        const name = text(body);
        const file = name === 'filelist.txt' ? this.fileList() : this.files.get(name);
        if (!file || this.faults.silentFetch.has(name)) return;
        this.outgoing = {
          name,
          data: file,
          state: 'waitC',
          block: 0,
          headerRepeated: false,
          badSent: false,
          repeated: false,
        };
        send(reply(0x06, body));
        break;
      }
      case 0x07: {
        const name = text(body);
        this.incoming = {
          name,
          state: 'header',
          buffer: [],
          data: [],
          size: null,
          last: 0,
          lostAck: false,
          block: -1,
          chunk: 0,
          droppedChunk: false,
          lastAt: Date.now(),
        };
        send(reply(0x08, body));
        this.notify(XOSS.tx, Uint8Array.of(C));
        break;
      }
      default:
        break;
    }
  }

  /** Um bloco do download em pedaços de 20 bytes, como chegam as notificações. */
  private sendBlock(number: number, corrupt = false): void {
    const out = this.outgoing!;
    const payload =
      number === 0
        ? ascii(`${out.name} ${out.data.length}`)
        : out.data.subarray((number - 1) * 128, number * 128);
    const block = encodeBlock(number, payload);
    if (corrupt) block[131] ^= 0xff;
    for (let i = 0; i < block.length; i += 20) {
      this.notify(XOSS.tx, block.subarray(i, i + 20));
    }
  }

  private data(bytes: Uint8Array): void {
    if (bytes.length === 1 && bytes[0] === CAN) {
      this.cancelled = true;
      this.outgoing = null;
      this.incoming = null;
      return;
    }
    if (this.outgoing) this.serve(bytes);
    else if (this.incoming) this.take(bytes);
  }

  /** A cinta mandando um arquivo: responde aos `C`, ACK e NAK do app. */
  private serve(bytes: Uint8Array): void {
    const out = this.outgoing!;
    const blocks = Math.ceil(out.data.length / 128);
    for (const value of bytes) {
      switch (out.state) {
        case 'waitC':
          if (value === C) {
            out.state = 'header';
            this.sendBlock(0);
          }
          break;
        case 'header':
          if (value === ACK) out.state = 'headerC';
          break;
        case 'headerC':
          if (value !== C) break;
          if (this.faults.repeatHeader && !out.headerRepeated) {
            out.headerRepeated = true;
            out.state = 'header';
            this.sendBlock(0);
            break;
          }
          this.next(out, blocks);
          break;
        case 'block':
          if (value === NAK) {
            this.sendBlock(out.block);
          } else if (value === ACK) {
            if (this.faults.repeatBlock === out.block && !out.repeated) {
              out.repeated = true;
              this.sendBlock(out.block);
              break;
            }
            this.next(out, blocks);
          }
          break;
        case 'eot1':
          if (value === NAK) {
            out.state = 'eot2';
            this.notify(XOSS.tx, Uint8Array.of(EOT));
          }
          break;
        case 'eot2':
          if (value === ACK) {
            this.outgoing = null;
            this.notify(XOSS.control, reply(0x04, [0x00]));
          }
          break;
      }
      if (!this.outgoing) return;
    }
  }

  private next(out: NonNullable<FakeXossStrap['outgoing']>, blocks: number): void {
    out.block += 1;
    if (out.block > blocks) {
      out.state = 'eot1';
      this.notify(XOSS.tx, Uint8Array.of(EOT));
      return;
    }
    if (this.faults.dropAtBlock === out.block) {
      this.drop();
      return;
    }
    out.state = 'block';
    const corrupt = this.faults.badCrcBlock === out.block && !out.badSent;
    if (corrupt) out.badSent = true;
    this.sendBlock(out.block, corrupt);
  }

  /** A cinta recebendo um arquivo: junta os pedaços em blocos e responde ACK (ou NAK). */
  private take(bytes: Uint8Array): void {
    const inc = this.incoming!;
    // Como um receptor de verdade, um silêncio longo no meio de um bloco descarta o pedaço guardado.
    if (Date.now() - inc.lastAt > 1000) inc.buffer = [];
    inc.lastAt = Date.now();
    if (inc.buffer.length === 0 && bytes[0] === SOH) {
      inc.block = bytes[1];
      inc.chunk = 0;
    } else {
      inc.chunk += 1;
    }
    if (inc.block === this.faults.dropChunkOfBlock && inc.chunk === 3 && !inc.droppedChunk) {
      inc.droppedChunk = true;
      return;
    }
    for (const value of bytes) {
      if (inc.state === 'eot') {
        if (value === EOT) {
          this.notify(XOSS.tx, Uint8Array.of(ACK));
          const data = Uint8Array.from(inc.data.slice(0, inc.size ?? inc.data.length));
          this.incoming = null;
          if (this.faults.rejectFile) {
            this.notify(XOSS.control, Uint8Array.of(0x15, 0x15));
            return;
          }
          this.received.push({ name: inc.name, data });
          this.files.set(
            inc.name,
            inc.name === 'user_profile.json' ? ascii(this.rewriteProfile(text(data))) : data,
          );
          this.notify(XOSS.control, reply(0x04, [0x00]));
          return;
        }
        continue;
      }
      if (inc.buffer.length === 0 && value === EOT && inc.state === 'data') {
        inc.state = 'eot';
        this.notify(XOSS.tx, Uint8Array.of(NAK));
        continue;
      }
      inc.buffer.push(value);
      if (inc.buffer[0] !== SOH) {
        inc.buffer = [];
        continue;
      }
      if (inc.buffer.length < 133) continue;
      const block = inc.buffer.splice(0, 133);
      const number = block[1];
      const crc = (block[131] << 8) | block[132];
      if ((number ^ block[2]) !== 0xff || crc16Arc(block, 3, 131) !== crc) {
        this.notify(XOSS.tx, Uint8Array.of(NAK));
        continue;
      }
      const payload = block.slice(3, 131);
      if (inc.state === 'header') {
        const header = parseHeader(payload);
        inc.size = header.size;
        inc.state = 'data';
        this.notify(XOSS.tx, Uint8Array.of(ACK));
        this.notify(XOSS.tx, Uint8Array.of(C));
        continue;
      }
      if (number === inc.last) {
        this.notify(XOSS.tx, Uint8Array.of(ACK));
        continue;
      }
      if (this.faults.loseAckBlock === number && !inc.lostAck) {
        inc.lostAck = true;
        continue;
      }
      inc.data.push(...payload);
      inc.last = number;
      this.notify(XOSS.tx, Uint8Array.of(ACK));
    }
  }
}

/** Um transporte que entrega sempre uma `FakeXossStrap` nova (ajustável antes da entrega). */
export class FakeXossTransport implements BleTransport {
  connections: FakeXossStrap[] = [];
  configure: (strap: FakeXossStrap) => void = () => undefined;
  private readonly scanners = new Set<{ onDevice: (device: ScannedDevice) => void }>();

  get last(): FakeXossStrap {
    const strap = this.connections.at(-1);
    if (!strap) throw new Error('a sessão não conectou');
    return strap;
  }

  async prepare(): Promise<void> {}

  scan(onDevice: (device: ScannedDevice) => void): BleSubscription {
    const scanner = { onDevice };
    this.scanners.add(scanner);
    return { remove: () => void this.scanners.delete(scanner) };
  }

  async connect(deviceId: string): Promise<BleConnection> {
    const strap = new FakeXossStrap(deviceId);
    this.configure(strap);
    this.connections.push(strap);
    return strap;
  }

  see(id = 'C5:2A:C5:16:AF:97'): void {
    const device: ScannedDevice = {
      id,
      name: 'XOSS_X2P_989171',
      rssi: -60,
      advertisesFtms: false,
      ftms: null,
      advertisesHeartRate: true,
    };
    [...this.scanners].forEach((scanner) => scanner.onDevice(device));
  }
}
