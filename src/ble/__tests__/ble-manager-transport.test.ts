import { Platform } from 'react-native';
import BleManager from 'react-native-ble-manager';

import { FTMS } from '@/ftms';

import { createBleManagerTransport } from '../ble-manager-transport';
import { requestBlePermissions } from '../permissions';
import { BleUnavailableError } from '../transport';
import type { BleConnection, BleTransport } from '../transport';

jest.mock('react-native-ble-manager', () => {
  // Os enums (BleState, BleScanMode…) são JavaScript puro e valem como estão.
  const types = jest.requireActual('react-native-ble-manager/dist/cjs/types');

  const listeners = new Map<string, Set<(event: unknown) => void>>();
  // Funções comuns, não jest.fn: `resetAllMocks` apagaria a implementação.
  const on = (name: string) => (callback: (event: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    set.add(callback);
    return { remove: () => set.delete(callback) };
  };

  return {
    __esModule: true,
    ...types,
    default: {
      start: jest.fn(),
      checkState: jest.fn(),
      enableBluetooth: jest.fn(),
      scan: jest.fn(),
      stopScan: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      retrieveServices: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      startNotification: jest.fn(),
      stopNotification: jest.fn(),
      onDiscoverPeripheral: on('discover'),
      onStopScan: on('stopScan'),
      onDidUpdateState: on('state'),
      onDisconnectPeripheral: on('disconnect'),
      onDidUpdateValueForCharacteristic: on('value'),
      __emit: (name: string, event: unknown) =>
        [...(listeners.get(name) ?? [])].forEach((callback) => callback(event)),
      __listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
      __clearListeners: () => listeners.clear(),
    },
  };
});

jest.mock('../permissions', () => ({ requestBlePermissions: jest.fn() }));

type Mocked = jest.Mocked<
  Pick<
    typeof BleManager,
    | 'start'
    | 'checkState'
    | 'enableBluetooth'
    | 'scan'
    | 'stopScan'
    | 'connect'
    | 'disconnect'
    | 'retrieveServices'
    | 'read'
    | 'write'
    | 'startNotification'
    | 'stopNotification'
  >
> & {
  __emit(name: string, event: unknown): void;
  __listenerCount(name: string): number;
  __clearListeners(): void;
};

const ble = BleManager as unknown as Mocked;
const permissions = jest.mocked(requestBlePermissions);

const DEVICE_ID = 'AA:BB:CC:DD:EE:FF';
const FTMS_LONG = '00001826-0000-1000-8000-00805f9b34fb';

function advertisingBytes(...bytes: number[]) {
  return { CDVType: 'ArrayBuffer' as const, bytes, data: '' };
}

/** Deixa as promises pendentes (com timers reais) se resolverem. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setPlatform(os: 'android' | 'ios') {
  jest.replaceProperty(Platform, 'OS', os);
}

beforeEach(() => {
  jest.resetAllMocks();
  ble.__clearListeners();
  setPlatform('android');
  permissions.mockResolvedValue(undefined);
  ble.start.mockResolvedValue(undefined);
  ble.checkState.mockResolvedValue('on' as never);
  ble.enableBluetooth.mockResolvedValue(undefined);
  ble.scan.mockResolvedValue(undefined);
  ble.stopScan.mockResolvedValue(undefined);
  ble.connect.mockResolvedValue(undefined);
  ble.disconnect.mockResolvedValue(undefined);
  ble.write.mockResolvedValue(undefined);
  ble.startNotification.mockResolvedValue(undefined);
  ble.stopNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('prepare', () => {
  it('pede permissões, inicia a biblioteca uma única vez e confere o adaptador', async () => {
    const transport = createBleManagerTransport();
    await transport.prepare();
    await transport.prepare();

    expect(permissions).toHaveBeenCalledTimes(2);
    expect(ble.start).toHaveBeenCalledTimes(1);
    expect(ble.start).toHaveBeenCalledWith({ showAlert: false });
  });

  it('repassa a negação de permissão sem iniciar a biblioteca', async () => {
    const denied = new BleUnavailableError('unauthorized', 'Permissão negada.');
    permissions.mockRejectedValue(denied);

    await expect(createBleManagerTransport().prepare()).rejects.toBe(denied);
    expect(ble.start).not.toHaveBeenCalled();
  });

  it("converte 'No bluetooth support' do start em 'unsupported' e tenta de novo na próxima", async () => {
    ble.start.mockRejectedValueOnce('No bluetooth support');
    const transport = createBleManagerTransport();

    await expect(transport.prepare()).rejects.toMatchObject({ reason: 'unsupported' });
    await expect(transport.prepare()).resolves.toBeUndefined();
    expect(ble.start).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unsupported', 'unsupported'],
    ['unauthorized', 'unauthorized'],
  ])("estado '%s' do adaptador vira BleUnavailableError('%s')", async (state, reason) => {
    ble.checkState.mockResolvedValue(state as never);

    const error = await createBleManagerTransport()
      .prepare()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BleUnavailableError);
    expect(error).toMatchObject({ reason });
  });

  it('Bluetooth desligado no Android: pede para ligar e segue se o usuário aceitar', async () => {
    ble.checkState.mockResolvedValue('off' as never);
    ble.enableBluetooth.mockImplementation(async () => {
      ble.checkState.mockResolvedValue('on' as never);
    });

    await expect(createBleManagerTransport().prepare()).resolves.toBeUndefined();
    expect(ble.enableBluetooth).toHaveBeenCalledTimes(1);
  });

  it("Bluetooth desligado no Android: usuário recusa o diálogo -> 'poweredOff'", async () => {
    ble.checkState.mockResolvedValue('off' as never);
    ble.enableBluetooth.mockRejectedValue('User refused to enable');

    const error = await createBleManagerTransport()
      .prepare()
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ reason: 'poweredOff' });
    expect((error as Error).message).toBe(
      'O Bluetooth está desligado. Ligue o Bluetooth do celular e tente de novo.',
    );
  });

  it("Bluetooth desligado no iOS: vai direto para 'poweredOff', sem diálogo", async () => {
    setPlatform('ios');
    ble.checkState.mockResolvedValue('off' as never);

    await expect(createBleManagerTransport().prepare()).rejects.toMatchObject({
      reason: 'poweredOff',
    });
    expect(ble.enableBluetooth).not.toHaveBeenCalled();
  });

  it('estado transitório: espera onDidUpdateState', async () => {
    ble.checkState.mockResolvedValue('turning_on' as never);

    const prepared = createBleManagerTransport().prepare();
    await flush();
    expect(ble.__listenerCount('state')).toBe(1);
    ble.__emit('state', { state: 'on' });

    await expect(prepared).resolves.toBeUndefined();
    expect(ble.__listenerCount('state')).toBe(0);
  });

  it('estado transitório que não se resolve em 3 s: erro genérico, sem BleUnavailableError', async () => {
    jest.useFakeTimers();
    ble.checkState.mockResolvedValue('unknown' as never);

    const prepared = createBleManagerTransport()
      .prepare()
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(3_000);

    const error = await prepared;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BleUnavailableError);
    expect(ble.__listenerCount('state')).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('scan', () => {
  function startScan() {
    const onDevice = jest.fn();
    const onError = jest.fn();
    const subscription = createBleManagerTransport().scan(onDevice, onError);
    return { onDevice, onError, subscription };
  }

  it('busca sem filtro de serviço, contínua, com duplicatas', () => {
    startScan();

    expect(ble.scan).toHaveBeenCalledWith(
      expect.objectContaining({ serviceUUIDs: [], seconds: 0, allowDuplicates: true }),
    );
  });

  it('mapeia nome, RSSI e serviceUUIDs em formato curto', () => {
    const { onDevice } = startScan();

    ble.__emit('discover', {
      id: DEVICE_ID,
      name: 'T600X',
      rssi: -61,
      advertising: { serviceUUIDs: ['1826'] },
    });

    expect(onDevice).toHaveBeenCalledWith({
      id: DEVICE_ID,
      name: 'T600X',
      rssi: -61,
      advertisesFtms: true,
      ftms: null,
      advertisement: 'serviços=[0x1826]',
    });
  });

  it('resume em texto o que o aparelho anuncia, para o registro', () => {
    const { onDevice } = startScan();

    ble.__emit('discover', {
      id: DEVICE_ID,
      name: 'CTM781',
      rssi: -50,
      advertising: {
        isConnectable: false,
        serviceUUIDs: ['1826', 'fff0'],
        serviceData: { '1826': { bytes: [0x01, 0x01, 0x00] } },
        manufacturerData: { '004c': { bytes: [0x02, 0x15] } },
      },
    });

    expect(onDevice.mock.calls[0][0].advertisement).toBe(
      'serviços=[0x1826, 0xFFF0] serviceData[0x1826]=01 01 00 fabricante[004c]=02 15 não conectável',
    );
  });

  it('sem nada anunciado, o resumo fica vazio', () => {
    const { onDevice } = startScan();
    ble.__emit('discover', { id: DEVICE_ID, rssi: -80, advertising: {} });
    expect(onDevice.mock.calls[0][0].advertisement).toBeNull();
  });

  it.each([
    ['longo', FTMS_LONG],
    ['maiúsculo', '00001826-0000-1000-8000-00805F9B34FB'],
    ['curto maiúsculo', '1826'.toUpperCase()],
    ['com 0x', '0x1826'],
  ])('reconhece o FTMS em serviceUUIDs no formato %s', (_label, uuid) => {
    const { onDevice } = startScan();

    ble.__emit('discover', {
      id: DEVICE_ID,
      rssi: -50,
      advertising: { serviceUUIDs: ['180a', uuid] },
    });

    expect(onDevice.mock.calls[0][0].advertisesFtms).toBe(true);
  });

  it('não marca advertisesFtms para outros serviços', () => {
    const { onDevice } = startScan();

    ble.__emit('discover', {
      id: DEVICE_ID,
      rssi: -50,
      advertising: { serviceUUIDs: ['180d', '00001800-0000-1000-8000-00805f9b34fb'] },
    });

    expect(onDevice.mock.calls[0][0].advertisesFtms).toBe(false);
  });

  it.each([['1826'], [FTMS_LONG], [FTMS_LONG.toUpperCase()]])(
    'reconhece o FTMS em serviceData com a chave %s e decodifica os bytes',
    (key) => {
      const { onDevice } = startScan();

      // flags = 1 (disponível), tipos = 0x0001 (esteira)
      ble.__emit('discover', {
        id: DEVICE_ID,
        rssi: -70,
        advertising: { serviceData: { [key]: advertisingBytes(0x01, 0x01, 0x00) } },
      });

      const device = onDevice.mock.calls[0][0];
      expect(device.advertisesFtms).toBe(true);
      expect(device.ftms).toEqual({
        available: true,
        machineTypes: expect.objectContaining({ treadmill: true, indoorBike: false }),
      });
    },
  );

  it('serviceData incompleto marca advertisesFtms mas não decodifica', () => {
    const { onDevice } = startScan();

    ble.__emit('discover', {
      id: DEVICE_ID,
      rssi: -70,
      advertising: { serviceData: { '1826': advertisingBytes(0x01) } },
    });

    expect(onDevice.mock.calls[0][0]).toMatchObject({ advertisesFtms: true, ftms: null });
  });

  it('usa o localName do anúncio quando o periférico não tem nome', () => {
    const { onDevice } = startScan();

    ble.__emit('discover', { id: DEVICE_ID, rssi: -50, advertising: { localName: 'Matrix' } });
    ble.__emit('discover', { id: 'x', name: '', rssi: -50, advertising: {} });
    ble.__emit('discover', { id: 'y', rssi: null });

    expect(onDevice.mock.calls[0][0].name).toBe('Matrix');
    expect(onDevice.mock.calls[1][0].name).toBeNull();
    expect(onDevice.mock.calls[2][0]).toMatchObject({ name: null, rssi: null });
  });

  it('remove() para o scan e os listeners, e pode ser chamado duas vezes', () => {
    const { onDevice, subscription } = startScan();

    subscription.remove();
    subscription.remove();

    expect(ble.stopScan).toHaveBeenCalledTimes(1);
    expect(ble.__listenerCount('discover')).toBe(0);
    expect(ble.__listenerCount('stopScan')).toBe(0);

    ble.__emit('discover', { id: DEVICE_ID, rssi: -50, advertising: {} });
    expect(onDevice).not.toHaveBeenCalled();
  });

  it('remove() não falha se o stopScan nativo rejeitar', async () => {
    ble.stopScan.mockRejectedValue('Bluetooth is not enabled');
    const { subscription } = startScan();

    expect(() => subscription.remove()).not.toThrow();
    await Promise.resolve();
  });

  it('erro ao iniciar o scan chega em onError', async () => {
    ble.scan.mockRejectedValue('Failed to start scan: SCAN_FAILED_ALREADY_STARTED');
    const { onError } = startScan();

    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    const error: Error = onError.mock.calls[0][0];
    expect(error.message).toBe(
      'Falha ao iniciar a busca por esteiras: Failed to start scan: SCAN_FAILED_ALREADY_STARTED',
    );
    expect(error.cause).toBe('Failed to start scan: SCAN_FAILED_ALREADY_STARTED');
  });

  it('parada espontânea do scan avisa via onError uma vez e não reinicia', () => {
    const { onError, subscription } = startScan();

    ble.__emit('stopScan', { status: 2 });
    ble.__emit('stopScan', { status: 2 });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain('código 2');
    expect(ble.scan).toHaveBeenCalledTimes(1);

    subscription.remove();
    expect(ble.stopScan).not.toHaveBeenCalled();
  });

  it('o evento de parada provocado pelo próprio remove() não vira erro', () => {
    const { onError, subscription } = startScan();
    ble.stopScan.mockImplementation(async () => ble.__emit('stopScan', { status: 0 }));

    subscription.remove();

    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('connect', () => {
  const peripheralInfo = {
    id: DEVICE_ID,
    name: 'T600X',
    rssi: -60,
    advertising: {},
    characteristics: [
      {
        service: '1826',
        characteristic: '2acd',
        properties: { Notify: 'Notify' },
      },
      {
        service: '00001826-0000-1000-8000-00805f9b34fb',
        characteristic: '00002ad9-0000-1000-8000-00805f9b34fb',
        properties: { Write: 'Write', Indicate: 'Indicate' },
      },
      {
        service: '1826',
        characteristic: '2acc',
        properties: { Read: 'Read', WriteWithoutResponse: 'WriteWithoutResponse' },
      },
      {
        service: '180a',
        characteristic: '2a29',
        properties: { Read: 'Read' },
      },
    ],
  };

  beforeEach(() => {
    ble.retrieveServices.mockResolvedValue(peripheralInfo as never);
  });

  it('conecta, descobre serviços e devolve a conexão', async () => {
    const connection = await createBleManagerTransport().connect(DEVICE_ID);

    expect(ble.connect).toHaveBeenCalledWith(DEVICE_ID);
    expect(ble.retrieveServices).toHaveBeenCalledWith(DEVICE_ID);
    // Sem MTU, prioridade de conexão nem bond: a API nem é usada.
    expect(connection.deviceId).toBe(DEVICE_ID);
    expect(connection.name).toBe('T600X');
  });

  it('usa o nome visto na busca quando o nativo não informa', async () => {
    const transport = createBleManagerTransport();
    transport.scan(jest.fn(), jest.fn());
    ble.__emit('discover', { id: DEVICE_ID, name: 'Matrix T600X', rssi: -60, advertising: {} });
    ble.retrieveServices.mockResolvedValue({ ...peripheralInfo, name: undefined } as never);

    const connection = await transport.connect(DEVICE_ID);

    expect(connection.name).toBe('Matrix T600X');
  });

  it('estouro de tempo: tenta disconnect e rejeita com mensagem clara', async () => {
    jest.useFakeTimers();
    ble.connect.mockReturnValue(new Promise(() => {}));

    const result = createBleManagerTransport()
      .connect(DEVICE_ID)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(ble.disconnect).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    const error = (await result) as Error;
    expect(error.message).toBe(
      'Tempo esgotado ao conectar na esteira (15 s). Aproxime o celular da esteira e tente de novo.',
    );
    expect(ble.disconnect).toHaveBeenCalledWith(DEVICE_ID);
    expect(ble.retrieveServices).not.toHaveBeenCalled();
    expect(ble.__listenerCount('disconnect')).toBe(0);
  });

  it('o tempo limite vale para connect + retrieveServices juntos', async () => {
    jest.useFakeTimers();
    ble.retrieveServices.mockReturnValue(new Promise(() => {}));

    const result = createBleManagerTransport()
      .connect(DEVICE_ID)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(15_000);

    expect(((await result) as Error).message).toContain('Tempo esgotado');
    expect(ble.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falha nativa vira Error em português com a causa original e desconecta', async () => {
    ble.connect.mockRejectedValue('Device disconnected');

    const error = (await createBleManagerTransport()
      .connect(DEVICE_ID)
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toBe('Falha ao conectar na esteira: Device disconnected');
    expect(error.cause).toBe('Device disconnected');
    expect(ble.disconnect).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('entende o erro estruturado do iOS ({ message })', async () => {
    ble.connect.mockRejectedValue({ code: 6, domain: 'CBErrorDomain', message: 'Connection timed out' });

    await expect(createBleManagerTransport().connect(DEVICE_ID)).rejects.toThrow(
      'Falha ao conectar na esteira: Connection timed out',
    );
  });
});

// ---------------------------------------------------------------------------

describe('BleConnection', () => {
  let transport: BleTransport;
  let connection: BleConnection;

  beforeEach(async () => {
    ble.retrieveServices.mockResolvedValue({
      id: DEVICE_ID,
      name: 'T600X',
      rssi: -60,
      advertising: {},
      characteristics: [
        { service: '1826', characteristic: '2acd', properties: { Notify: 'Notify' } },
        {
          service: FTMS_LONG,
          characteristic: '00002ad9-0000-1000-8000-00805f9b34fb',
          properties: { Write: 'Write', Indicate: 'Indicate' },
        },
        {
          service: '1826',
          characteristic: '2acc',
          properties: { Read: 'Read', WriteWithoutResponse: 'WriteWithoutResponse' },
        },
        { service: '180a', characteristic: '2a29', properties: { Read: 'Read' } },
      ],
    } as never);
    transport = createBleManagerTransport();
    connection = await transport.connect(DEVICE_ID);
  });

  describe('getCharacteristics', () => {
    it('lista só as do serviço pedido, em qualquer formato de UUID', async () => {
      const characteristics = await connection.getCharacteristics(FTMS.service);

      expect(characteristics).toEqual([
        {
          uuid: FTMS.treadmillData,
          canRead: false,
          canWrite: false,
          canNotify: true,
          canIndicate: false,
        },
        {
          uuid: FTMS.controlPoint,
          canRead: false,
          canWrite: true,
          canNotify: false,
          canIndicate: true,
        },
        {
          uuid: FTMS.feature,
          canRead: true,
          // WriteWithoutResponse não conta como escrita com resposta.
          canWrite: false,
          canNotify: false,
          canIndicate: false,
        },
      ]);
      expect(await connection.getCharacteristics('1826')).toHaveLength(3);
    });

    it('serviço inexistente devolve lista vazia', async () => {
      expect(await connection.getCharacteristics('180d')).toEqual([]);
    });
  });

  describe('read e write', () => {
    it('lê como Uint8Array e passa UUIDs no formato curto', async () => {
      ble.read.mockResolvedValue([0x0d, 0x16]);

      const data = await connection.read(FTMS.service, FTMS.feature);

      expect(data).toEqual(Uint8Array.of(0x0d, 0x16));
      expect(ble.read).toHaveBeenCalledWith(DEVICE_ID, '1826', '2acc');
    });

    it('UUID de 128 bits fora da base do SIG segue por extenso e UUID de 32 bits é expandido', async () => {
      ble.read.mockResolvedValue([]);

      await connection.read('6E400001-B5A3-F393-E0A9-E50E24DCCA9E', '0x00002acc');

      expect(ble.read).toHaveBeenCalledWith(
        DEVICE_ID,
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        '2acc',
      );
    });

    it('escreve com resposta convertendo para number[] sem fatiar o comando', async () => {
      await connection.write(FTMS.service, FTMS.controlPoint, Uint8Array.of(0x02, 0x64, 0x00));

      expect(ble.write).toHaveBeenCalledWith(DEVICE_ID, '1826', '2ad9', [0x02, 0x64, 0x00], 20);
    });

    it('embrulha erro de leitura', async () => {
      ble.read.mockRejectedValue('Device is not connected');

      const error = (await connection
        .read(FTMS.service, FTMS.feature)
        .catch((e: unknown) => e)) as Error;

      expect(error.message).toBe('Falha ao ler Fitness Machine Feature: Device is not connected');
      expect(error.cause).toBe('Device is not connected');
    });

    it('embrulha erro de escrita', async () => {
      ble.write.mockRejectedValue('Write failed');

      const error = (await connection
        .write(FTMS.service, FTMS.controlPoint, Uint8Array.of(0x00))
        .catch((e: unknown) => e)) as Error;

      expect(error.message).toBe(
        'Falha ao escrever em Fitness Machine Control Point: Write failed',
      );
      expect(error.cause).toBe('Write failed');
    });
  });

  describe('subscribe', () => {
    function emitValue(
      value: number[],
      overrides: Partial<{ peripheral: string; service: string; characteristic: string }> = {},
    ) {
      ble.__emit('value', {
        peripheral: DEVICE_ID,
        service: FTMS_LONG,
        characteristic: '00002acd-0000-1000-8000-00805f9b34fb',
        value,
        ...overrides,
      });
    }

    it('só resolve depois que startNotification resolve', async () => {
      let confirm!: () => void;
      ble.startNotification.mockReturnValue(new Promise<void>((resolve) => (confirm = resolve)));
      const onValue = jest.fn();
      let resolved = false;

      const pending = connection.subscribe(FTMS.service, FTMS.controlPoint, onValue).then((s) => {
        resolved = true;
        return s;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(ble.startNotification).toHaveBeenCalledWith(DEVICE_ID, '1826', '2ad9');
      expect(resolved).toBe(false);

      confirm();
      await pending;
      expect(resolved).toBe(true);
    });

    it('característica só com indicate usa o mesmo startNotification', async () => {
      await connection.subscribe(FTMS.service, FTMS.controlPoint, jest.fn());

      expect(ble.startNotification).toHaveBeenCalledTimes(1);
    });

    it('entrega só valores do periférico e da característica certos, normalizando UUIDs', async () => {
      const onValue = jest.fn();
      await connection.subscribe(FTMS.service, '2ACD', onValue);

      emitValue([1, 2, 3]); // longo (Android)
      emitValue([4], { service: '1826', characteristic: '2acd' }); // curto (iOS)
      emitValue([5], { peripheral: '11:22:33:44:55:66' }); // outro periférico
      emitValue([6], { characteristic: '00002ad3-0000-1000-8000-00805f9b34fb' }); // outra característica
      emitValue([7], { service: '180a' }); // outro serviço

      expect(onValue.mock.calls.map(([data]) => Array.from(data as Uint8Array))).toEqual([
        [1, 2, 3],
        [4],
      ]);
      expect(onValue.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    });

    it('usa um único listener global por conexão', async () => {
      await connection.subscribe(FTMS.service, FTMS.treadmillData, jest.fn());
      await connection.subscribe(FTMS.service, FTMS.controlPoint, jest.fn());

      expect(ble.__listenerCount('value')).toBe(1);
    });

    it('remove() tira o callback e chama stopNotification (uma vez)', async () => {
      const onValue = jest.fn();
      const subscription = await connection.subscribe(FTMS.service, FTMS.treadmillData, onValue);

      subscription.remove();
      subscription.remove();
      emitValue([1]);

      expect(onValue).not.toHaveBeenCalled();
      expect(ble.stopNotification).toHaveBeenCalledTimes(1);
      expect(ble.stopNotification).toHaveBeenCalledWith(DEVICE_ID, '1826', '2acd');
    });

    it('remove() engole erro do stopNotification', async () => {
      ble.stopNotification.mockRejectedValue('Device disconnected');
      const subscription = await connection.subscribe(FTMS.service, FTMS.treadmillData, jest.fn());

      expect(() => subscription.remove()).not.toThrow();
      await Promise.resolve();
    });

    it('com duas assinaturas na mesma característica, só a última remoção desliga o notify', async () => {
      const first = jest.fn();
      const second = jest.fn();
      const a = await connection.subscribe(FTMS.service, FTMS.treadmillData, first);
      const b = await connection.subscribe(FTMS.service, FTMS.treadmillData, second);

      a.remove();
      expect(ble.stopNotification).not.toHaveBeenCalled();
      emitValue([9]);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);

      b.remove();
      expect(ble.stopNotification).toHaveBeenCalledTimes(1);
    });

    it('falha em startNotification rejeita com mensagem em português e solta o callback', async () => {
      ble.startNotification.mockRejectedValue('Error writing descriptor status=5');
      const onValue = jest.fn();

      const error = (await connection
        .subscribe(FTMS.service, FTMS.controlPoint, onValue)
        .catch((e: unknown) => e)) as Error;

      expect(error.message).toBe(
        'Falha ao ativar as notificações de Fitness Machine Control Point: Error writing descriptor status=5',
      );
      expect(error.cause).toBe('Error writing descriptor status=5');
      emitValue([1], { characteristic: '00002ad9-0000-1000-8000-00805f9b34fb' });
      expect(onValue).not.toHaveBeenCalled();
    });
  });

  describe('onDisconnect', () => {
    function emitDisconnect(peripheral = DEVICE_ID) {
      ble.__emit('disconnect', { peripheral, status: 8 });
    }

    it('é chamado uma vez quando o link cai', () => {
      const listener = jest.fn();
      connection.onDisconnect(listener);

      emitDisconnect();
      emitDisconnect();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('ignora queda de outro periférico', () => {
      const listener = jest.fn();
      connection.onDisconnect(listener);

      emitDisconnect('11:22:33:44:55:66');

      expect(listener).not.toHaveBeenCalled();
    });

    it('não é chamado depois de disconnect(), nem pelo evento que o próprio disconnect gera', async () => {
      const listener = jest.fn();
      connection.onDisconnect(listener);
      ble.disconnect.mockImplementation(async () => emitDisconnect());

      await connection.disconnect();
      emitDisconnect();

      expect(listener).not.toHaveBeenCalled();
    });

    it('remove() do listener impede a chamada', () => {
      const listener = jest.fn();
      connection.onDisconnect(listener).remove();

      emitDisconnect();

      expect(listener).not.toHaveBeenCalled();
    });

    it('listener registrado depois da queda ainda é avisado', async () => {
      emitDisconnect();
      const listener = jest.fn();

      connection.onDisconnect(listener);
      await Promise.resolve();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('depois da queda, os valores deixam de ser entregues e o stopNotification não é chamado', async () => {
      const onValue = jest.fn();
      const subscription = await connection.subscribe(FTMS.service, FTMS.treadmillData, onValue);

      emitDisconnect();
      ble.__emit('value', {
        peripheral: DEVICE_ID,
        service: '1826',
        characteristic: '2acd',
        value: [1],
      });
      subscription.remove();

      expect(onValue).not.toHaveBeenCalled();
      expect(ble.stopNotification).not.toHaveBeenCalled();
      expect(ble.__listenerCount('value')).toBe(0);
      expect(ble.__listenerCount('disconnect')).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('desconecta e remove os listeners globais da conexão', async () => {
      await connection.disconnect();

      expect(ble.disconnect).toHaveBeenCalledWith(DEVICE_ID);
      expect(ble.__listenerCount('value')).toBe(0);
      expect(ble.__listenerCount('disconnect')).toBe(0);
    });

    it('é idempotente', async () => {
      await connection.disconnect();
      await connection.disconnect();

      expect(ble.disconnect).toHaveBeenCalledTimes(1);
    });

    it('não rejeita se o link já caiu', async () => {
      ble.disconnect.mockRejectedValue('Peripheral not found');
      ble.__emit('disconnect', { peripheral: DEVICE_ID });

      await expect(connection.disconnect()).resolves.toBeUndefined();
    });
  });
});
