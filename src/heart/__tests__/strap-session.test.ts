import type {
  BleConnection,
  BleSubscription,
  BleTransport,
  CharacteristicInfo,
  ScannedDevice,
} from '@/ble/transport';
import { BleUnavailableError } from '@/ble/transport';
import { sameUuid } from '@/ftms';

import { BATTERY, HEART_RATE } from '../heart-rate';
import {
  HeartStrapSession,
  STRAP_FRESH_MS,
  type HeartStrapSessionOptions,
  type SavedStrap,
} from '../strap-session';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const STRAP_ID = 'C5:2A:C5:16:AF:97';
const strap = (overrides: Partial<ScannedDevice> = {}): ScannedDevice => ({
  id: STRAP_ID,
  name: 'XOSS_X2P_989171',
  rssi: -60,
  advertisesFtms: false,
  ftms: null,
  advertisesHeartRate: true,
  ...overrides,
});

class FakeConnection implements BleConnection {
  readonly name: string | null = 'XOSS_X2P_989171';
  disconnected = false;
  /** Sem a característica de batimentos, o aparelho não é uma cinta. */
  heartRate = true;
  battery: number | Error | null = 87;

  private onValue: ((data: Uint8Array) => void) | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(readonly deviceId: string) {}

  async getServices() {
    return [];
  }

  async getCharacteristics(serviceUuid: string): Promise<CharacteristicInfo[]> {
    const one = (uuid: string, canRead: boolean, canNotify: boolean) => [
      { uuid, canRead, canNotify, canIndicate: false },
    ];
    if (sameUuid(serviceUuid, HEART_RATE.service) && this.heartRate)
      return one(HEART_RATE.measurement, false, true);
    if (sameUuid(serviceUuid, BATTERY.service) && this.battery !== null)
      return one(BATTERY.level, true, false);
    return [];
  }

  async read(): Promise<Uint8Array> {
    if (this.battery instanceof Error) throw this.battery;
    return Uint8Array.of(this.battery ?? 0);
  }

  async subscribe(
    _service: string,
    _characteristic: string,
    onValue: (data: Uint8Array) => void,
  ): Promise<BleSubscription> {
    this.onValue = onValue;
    return { remove: () => void (this.onValue = null) };
  }

  onDisconnect(listener: () => void): BleSubscription {
    this.disconnectListeners.add(listener);
    return { remove: () => void this.disconnectListeners.delete(listener) };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.onValue = null;
    this.disconnectListeners.clear();
  }

  /** Uma notificação de Heart Rate Measurement, com BPM de 8 bits. */
  beat(bpm: number, flags = 0x00): void {
    this.onValue?.(Uint8Array.of(flags, bpm));
  }

  /** Simula a queda do link (sem `disconnect()` do app). */
  drop(): void {
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    this.onValue = null;
    listeners.forEach((listener) => listener());
  }
}

class FakeTransport implements BleTransport {
  prepareError: Error | null = null;
  connectError: Error | null = null;
  scanStarts = 0;
  connections: FakeConnection[] = [];
  /** Ajusta a conexão antes de ela ser entregue à sessão. */
  configure: (connection: FakeConnection) => void = () => undefined;

  private readonly scanners = new Set<{
    onDevice: (device: ScannedDevice) => void;
    onError: (error: Error) => void;
  }>();

  get scanning(): number {
    return this.scanners.size;
  }

  get last(): FakeConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error('a sessão não conectou');
    return connection;
  }

  async prepare(): Promise<void> {
    if (this.prepareError) throw this.prepareError;
  }

  scan(onDevice: (device: ScannedDevice) => void, onError: (error: Error) => void): BleSubscription {
    this.scanStarts += 1;
    const scanner = { onDevice, onError };
    this.scanners.add(scanner);
    return { remove: () => void this.scanners.delete(scanner) };
  }

  async connect(deviceId: string): Promise<BleConnection> {
    if (this.connectError) throw this.connectError;
    const connection = new FakeConnection(deviceId);
    this.configure(connection);
    this.connections.push(connection);
    return connection;
  }

  see(device: ScannedDevice): void {
    [...this.scanners].forEach((scanner) => scanner.onDevice(device));
  }

  failScan(): void {
    const current = [...this.scanners];
    this.scanners.clear();
    current.forEach((scanner) => scanner.onError(new Error('parou')));
  }
}

async function settle(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await Promise.resolve();
  }
  await jest.advanceTimersByTimeAsync(0);
}

function makeSession(
  saved: SavedStrap | null = { id: STRAP_ID, name: 'XOSS_X2P_989171' },
  options: Partial<HeartStrapSessionOptions> = {},
) {
  const transport = new FakeTransport();
  const stored = { value: saved };
  const session = new HeartStrapSession({
    ble: transport,
    storage: { read: () => stored.value, write: (next) => void (stored.value = next) },
    ...options,
  });
  return { transport, session, stored };
}

/** Pede a cinta, deixa a busca vê-la e devolve a conexão já com leituras assinadas. */
async function connectStrap(transport: FakeTransport, session: HeartStrapSession) {
  const release = session.hold();
  await settle();
  transport.see(strap());
  await settle();
  expect(session.getSnapshot().phase).toBe('connected');
  return { connection: transport.last, release };
}

describe('conexão com a cinta pareada', () => {
  it('sem cinta pareada não procura nada', async () => {
    const { transport, session } = makeSession(null);
    session.hold();
    await settle();

    expect(transport.scanStarts).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ saved: null, phase: 'idle' });
  });

  it('sem ninguém pedindo a cinta, não procura mesmo com uma pareada', async () => {
    const { transport, session } = makeSession();
    await settle();

    expect(transport.scanStarts).toBe(0);
    expect(session.getSnapshot().phase).toBe('idle');
  });

  it('procura a cinta pareada, ignora os outros aparelhos e conecta quando ela aparece', async () => {
    const { transport, session } = makeSession();
    session.hold();
    await settle();
    expect(session.getSnapshot().phase).toBe('searching');

    transport.see(strap({ id: 'AA:AA:AA:AA:AA:AA', name: 'Cinta do vizinho' }));
    await settle();
    expect(transport.connections).toHaveLength(0);

    // O endereço chega em minúsculas em algumas plataformas.
    transport.see(strap({ id: STRAP_ID.toLowerCase() }));
    await settle();

    expect(transport.connections).toHaveLength(1);
    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', battery: 87, error: null });
  });

  it('entrega a leitura mais recente enquanto ela é nova', async () => {
    const { transport, session } = makeSession();
    const { connection } = await connectStrap(transport, session);
    expect(session.reading(Date.now())).toBeNull();

    const at = Date.now();
    connection.beat(72);
    expect(session.getSnapshot().bpm).toBe(72);
    expect(session.reading(Date.now())).toEqual({ bpm: 72, at });

    await jest.advanceTimersByTimeAsync(STRAP_FRESH_MS);
    // A hora é a da leitura, não a da consulta: é por ela que cada leitura conta uma vez.
    expect(session.reading(Date.now())).toEqual({ bpm: 72, at });
    await jest.advanceTimersByTimeAsync(1);
    expect(session.reading(Date.now())).toBeNull();

    // Mesmo valor, leitura nova.
    connection.beat(72);
    expect(session.reading(Date.now())).toEqual({ bpm: 72, at: at + STRAP_FRESH_MS + 1 });
  });

  it('BPM zero ou sem contato com a pele não é leitura', async () => {
    const { transport, session } = makeSession();
    const { connection } = await connectStrap(transport, session);
    connection.beat(72);

    connection.beat(0);
    expect(session.getSnapshot().bpm).toBeNull();
    expect(session.reading(Date.now())).toBeNull();

    connection.beat(72);
    // Flags 0x04: o sensor detecta contato, e não há contato.
    connection.beat(70, 0x04);
    expect(session.reading(Date.now())).toBeNull();
    // Flags 0x06: contato detectado.
    connection.beat(70, 0x06);
    expect(session.reading(Date.now())?.bpm).toBe(70);
  });

  it('segue sem a bateria quando a cinta não informa ou a leitura falha', async () => {
    const { transport, session } = makeSession();
    transport.configure = (connection) => (connection.battery = new Error('falhou'));
    await connectStrap(transport, session);

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', battery: null });
  });

  it('quando o link cai, some a leitura e a cinta volta a ser procurada', async () => {
    const { transport, session } = makeSession();
    const { connection } = await connectStrap(transport, session);
    connection.beat(72);

    connection.drop();
    await settle();

    expect(session.reading(Date.now())).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ phase: 'searching', bpm: null, battery: null });
    expect(transport.scanning).toBe(1);

    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connected');
    expect(transport.connections).toHaveLength(2);
  });

  it('uma janela de busca sem a cinta descansa e abre de novo', async () => {
    const { transport, session } = makeSession(undefined, {
      searchWindowMs: 20_000,
      searchPauseMs: 10_000,
    });
    session.hold();
    await settle();
    expect(transport.scanning).toBe(1);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot().phase).toBe('searching');

    await jest.advanceTimersByTimeAsync(10_000);
    expect(transport.scanning).toBe(1);
    expect(transport.scanStarts).toBe(2);
  });

  it('a busca sai do ar enquanto a esteira conecta e volta depois', async () => {
    const { transport, session } = makeSession();
    session.hold();
    await settle();
    expect(transport.scanning).toBe(1);

    session.setQuiet(true);
    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot().phase).toBe('searching');
    // Nem a janela seguinte abre enquanto a esteira não terminar.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(transport.scanning).toBe(0);

    session.setQuiet(false);
    await settle();
    expect(transport.scanning).toBe(1);
    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connected');
  });

  it('o pedido que chega com a esteira conectando só abre a busca depois', async () => {
    const { transport, session } = makeSession();
    session.setQuiet(true);
    session.hold();
    await settle();
    expect(transport.scanStarts).toBe(0);
    expect(session.getSnapshot().phase).toBe('searching');

    session.setQuiet(false);
    await settle();
    expect(transport.scanning).toBe(1);
  });

  it('a cinta já conectada não é afetada pela conexão da esteira', async () => {
    const { transport, session } = makeSession();
    const { connection } = await connectStrap(transport, session);

    session.setQuiet(true);
    connection.beat(72);

    expect(connection.disconnected).toBe(false);
    expect(session.reading(Date.now())?.bpm).toBe(72);
  });

  it('a busca que para sozinha é retomada depois da pausa', async () => {
    const { transport, session } = makeSession(undefined, { searchPauseMs: 10_000 });
    session.hold();
    await settle();

    transport.failScan();
    expect(transport.scanning).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(transport.scanning).toBe(1);
    expect(session.getSnapshot().phase).toBe('searching');
  });

  it('conexão que falha avisa e tenta de novo', async () => {
    const { transport, session } = makeSession(undefined, { retryMs: 3_000 });
    transport.connectError = new Error('Tempo esgotado ao conectar na esteira (15 s).');
    session.hold();
    await settle();
    transport.see(strap());
    await settle();

    // A mensagem do rádio fala em esteira: a tela mostra a da cinta.
    expect(session.getSnapshot()).toMatchObject({
      phase: 'searching',
      error: 'Não foi possível conectar à cinta. Confira se ela está no peito e por perto.',
    });

    transport.connectError = null;
    await jest.advanceTimersByTimeAsync(3_000);
    await settle();
    transport.see(strap());
    await settle();

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', error: null });
  });

  it('aparelho que não mostra o Heart Rate Measurement: avisa, desconecta e tenta de novo mais tarde', async () => {
    const { transport, session } = makeSession(undefined, { unfitRetryMs: 30_000 });
    // A lista de serviços que o Android guardou veio incompleta nesta conexão.
    transport.configure = (connection) => (connection.heartRate = false);
    session.hold();
    await settle();
    transport.see(strap());
    await settle();

    expect(transport.last.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('searching');
    expect(session.getSnapshot().error).toContain('Heart Rate Service');
    // A insistência é espaçada: nada de conectar e desconectar em laço.
    await jest.advanceTimersByTimeAsync(29_000);
    expect(transport.scanStarts).toBe(1);

    transport.configure = () => undefined;
    await jest.advanceTimersByTimeAsync(1_000);
    await settle();
    transport.see(strap());
    await settle();
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', error: null });
  });

  it('a pausa entre as janelas cresce enquanto a cinta não aparece', async () => {
    const { transport, session } = makeSession(undefined, {
      searchWindowMs: 20_000,
      searchPauseMs: 10_000,
    });
    session.hold();
    await settle();

    // Pausas de 10, 20, 30… até 60 s; as janelas continuam de 20 s.
    const pauses = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000];
    for (const pause of pauses) {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(transport.scanning).toBe(0);
      await jest.advanceTimersByTimeAsync(pause - 1);
      expect(transport.scanning).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(transport.scanning).toBe(1);
    }
  });

  it('depois de uma queda do link a busca recomeça com a pausa curta', async () => {
    const { transport, session } = makeSession(undefined, {
      searchWindowMs: 20_000,
      searchPauseMs: 10_000,
    });
    session.hold();
    await settle();
    await jest.advanceTimersByTimeAsync(20_000 + 10_000 + 20_000 + 20_000);
    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connected');

    transport.last.drop();
    await settle();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(transport.scanning).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(transport.scanning).toBe(1);
  });

  it('a cinta que estava conectando dá a vez à esteira e conecta depois', async () => {
    const { transport, session } = makeSession();
    let open!: () => void;
    const gate = new Promise<void>((done) => (open = done));
    const connect = transport.connect.bind(transport);
    let gated = true;
    transport.connect = async (id) => {
      if (gated) await gate;
      return connect(id);
    };
    session.hold();
    await settle();
    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connecting');

    session.setQuiet(true);
    expect(session.getSnapshot().phase).toBe('searching');
    expect(transport.scanning).toBe(0);
    // A conexão antiga, se ainda chegar, é desfeita.
    open();
    await settle();
    expect(transport.last.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('searching');

    gated = false;
    session.setQuiet(false);
    await settle();
    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connected');
  });

  it('Bluetooth indisponível: mostra o motivo e só tenta de novo quando pedirem', async () => {
    const { transport, session } = makeSession();
    transport.prepareError = new BleUnavailableError('poweredOff', 'O Bluetooth está desligado.');
    session.hold();
    await settle();

    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', error: 'O Bluetooth está desligado.' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(transport.scanStarts).toBe(0);

    transport.prepareError = null;
    session.actions.retry();
    await settle();
    expect(session.getSnapshot().phase).toBe('searching');
  });

  it('o banco ilegível abre o app como se não houvesse cinta', () => {
    const session = new HeartStrapSession({
      ble: new FakeTransport(),
      storage: {
        read: () => {
          throw new Error('banco corrompido');
        },
        write: () => undefined,
      },
    });

    expect(session.getSnapshot().saved).toBeNull();
  });
});

describe('pedidos de uso', () => {
  it('solta a cinta só depois da carência, e um pedido novo cancela a soltura', async () => {
    const { transport, session } = makeSession(undefined, { releaseGraceMs: 15_000 });
    const { connection, release } = await connectStrap(transport, session);

    // Entre a busca e a conexão da esteira a sessão fica livre por um instante.
    release();
    await jest.advanceTimersByTimeAsync(14_000);
    const again = session.hold();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connection.disconnected).toBe(false);
    expect(session.getSnapshot().phase).toBe('connected');

    again();
    again();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(connection.disconnected).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', bpm: null });
    expect(session.getSnapshot().saved).not.toBeNull();
  });

  it('com dois pedidos abertos, encerrar um não solta a cinta', async () => {
    const { transport, session } = makeSession(undefined, { releaseGraceMs: 15_000 });
    const { connection, release } = await connectStrap(transport, session);
    session.hold();

    release();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(connection.disconnected).toBe(false);
  });

  it('parar de pedir durante a busca encerra a busca', async () => {
    const { transport, session } = makeSession(undefined, { releaseGraceMs: 15_000 });
    const release = session.hold();
    await settle();
    expect(transport.scanning).toBe(1);

    release();
    await jest.advanceTimersByTimeAsync(15_000);

    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot().phase).toBe('idle');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(transport.scanStarts).toBe(1);
  });

  it('desistir durante a conexão desconecta o que chegar depois', async () => {
    const { transport, session } = makeSession();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => (resolve = done));
    const connect = transport.connect.bind(transport);
    transport.connect = async (id) => {
      await gate;
      return connect(id);
    };
    session.hold();
    await settle();
    transport.see(strap());
    await settle();
    expect(session.getSnapshot().phase).toBe('connecting');

    session.actions.forget();
    resolve();
    await settle();

    expect(transport.last.disconnected).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ saved: null, phase: 'idle' });
  });
});

describe('pareamento', () => {
  it('lista só quem anuncia o Heart Rate Service, juntando nome e serviços de anúncios separados', async () => {
    const { transport, session } = makeSession(null);
    session.actions.startPairing();
    await settle();
    expect(session.getSnapshot().pairing).toBe(true);

    transport.see(strap({ id: 'fone', name: 'Fone', advertisesHeartRate: false }));
    // O nome chega num anúncio e o serviço no outro.
    transport.see(strap({ advertisesHeartRate: false }));
    transport.see(strap({ name: null }));
    // O RSSI oscilando não mexe na lista.
    const listed = session.getSnapshot().candidates;
    transport.see(strap({ name: null, rssi: -75 }));

    expect(session.getSnapshot().candidates).toBe(listed);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: STRAP_ID, name: 'XOSS_X2P_989171' });
  });

  it('escolher pareia, guarda no aparelho e conecta sem nova busca', async () => {
    const { transport, session, stored } = makeSession(null);
    session.actions.startPairing();
    await settle();
    transport.see(strap());

    session.actions.choose(STRAP_ID);
    await settle();

    expect(stored.value).toEqual({ id: STRAP_ID, name: 'XOSS_X2P_989171' });
    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot()).toMatchObject({
      saved: { id: STRAP_ID, name: 'XOSS_X2P_989171' },
      pairing: false,
      phase: 'connected',
    });
  });

  it('a cinta anunciada sem nome ganha o nome da conexão', async () => {
    const { transport, session, stored } = makeSession(null);
    session.actions.startPairing();
    await settle();
    transport.see(strap({ name: null }));

    session.actions.choose(STRAP_ID);
    await settle();

    expect(stored.value).toEqual({ id: STRAP_ID, name: 'XOSS_X2P_989171' });
    expect(session.getSnapshot().saved?.name).toBe('XOSS_X2P_989171');
  });

  it('a busca do pareamento para sozinha', async () => {
    const { transport, session } = makeSession(null, { pairingTimeoutMs: 30_000 });
    session.actions.startPairing();
    await settle();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(transport.scanning).toBe(0);
    expect(session.getSnapshot().pairing).toBe(false);
  });

  it('sem Bluetooth o pareamento mostra o motivo', async () => {
    const { transport, session } = makeSession(null);
    transport.prepareError = new BleUnavailableError('poweredOff', 'O Bluetooth está desligado.');
    session.actions.startPairing();
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      pairing: false,
      error: 'O Bluetooth está desligado.',
    });
  });

  it('esquecer desconecta, apaga do aparelho e para de procurar', async () => {
    const { transport, session, stored } = makeSession();
    const { connection } = await connectStrap(transport, session);
    connection.beat(72);

    session.actions.forget();
    await settle();

    expect(connection.disconnected).toBe(true);
    expect(stored.value).toBeNull();
    expect(session.reading(Date.now())).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ saved: null, phase: 'idle', bpm: null });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(transport.scanning).toBe(0);
  });
});
