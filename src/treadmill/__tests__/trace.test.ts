import type { BleTransport, ScannedDevice } from '@/ble/transport';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
  type SimulatedTreadmillOptions,
} from '@/simulator/simulated-treadmill';

import { TreadmillSession, type TreadmillSessionOptions } from '../treadmill-session';
import type { TraceLine } from '../types';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

function createRig(
  simulatorOptions: SimulatedTreadmillOptions = {},
  sessionOptions: Partial<TreadmillSessionOptions> = {},
  transport?: (simulator: SimulatedTreadmillTransport) => BleTransport,
) {
  const simulator = new SimulatedTreadmillTransport(simulatorOptions);
  const lines: TraceLine[] = [];
  const ble = transport ? transport(simulator) : simulator;
  const session = new TreadmillSession({
    ble,
    demo: { transport: simulator, deviceId: SIMULATED_DEVICE_ID },
    trace: (line) => lines.push(line),
    ...sessionOptions,
  });
  const texts = (kind: TraceLine['kind']) =>
    lines.filter((line) => line.kind === kind).map((line) => line.text);
  return { simulator, session, lines, texts };
}

async function connectAndConfirm(rig: ReturnType<typeof createRig>) {
  rig.session.actions.connect(SIMULATED_DEVICE_ID);
  await advance(200);
  rig.session.actions.confirmIdentity();
}

describe('registro completo (trace)', () => {
  it('recebe cada toque do usuário antes do efeito dele', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(1500);
    rig.session.actions.changeSpeed(0.1);
    rig.session.actions.changeInclination(-0.5);
    rig.session.actions.pause();
    rig.session.actions.stop();
    await advance(500);

    expect(rig.texts('action')).toEqual([
      `Conectar em ${SIMULATED_DEVICE_ID}`,
      'É esta esteira',
      'Iniciar',
      'Velocidade +0,10 km/h',
      'Inclinação −0,5 %',
      'Pausar',
      'Parar',
    ]);
    // O toque vem antes do pacote que ele provoca.
    const startTap = rig.lines.findIndex((line) => line.kind === 'action' && line.text === 'Iniciar');
    const startWrite = rig.lines.findIndex((line) => line.kind === 'tx' && line.hex === '07');
    expect(startTap).toBeGreaterThanOrEqual(0);
    expect(startWrite).toBeGreaterThan(startTap);
  });

  it('traz os pacotes enviados e recebidos com o hexadecimal', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(300);

    const sent = rig.lines.filter((line) => line.kind === 'tx').map((line) => line.hex);
    expect(sent).toEqual(['00', '07']);
    const responses = rig.lines
      .filter((line) => line.kind === 'rx' && line.text.startsWith('Resposta a'))
      .map((line) => line.hex);
    expect(responses).toEqual(['80 00 01', '80 07 01']);
  });

  it('guarda todos os pacotes de Treadmill Data, não só o primeiro de cada formato', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    await advance(10_000);

    const inFile = rig.lines.filter(
      (line) => line.kind === 'rx' && line.text.startsWith('Treadmill Data'),
    );
    const onScreen = rig.session
      .getSnapshot()
      .log.filter((entry) => entry.label.startsWith('Treadmill Data'));
    expect(onScreen).toHaveLength(1);
    expect(inFile.length).toBeGreaterThanOrEqual(9);
    expect(inFile.every((line) => line.hex !== null)).toBe(true);
  });

  it('registra as mudanças de estado, os avisos e as capacidades lidas', async () => {
    const rig = createRig({ grantControl: false });
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(500);

    const state = rig.texts('state');
    expect(state).toContain('phase: idle → connecting');
    expect(state).toContain('phase: connecting → connected');
    expect(state).toContain('identityConfirmed: false → true');
    expect(state).toContain('control: idle → requesting');
    expect(state).toContain('control: requesting → denied');
    expect(state.some((text) => text.startsWith('capabilities: Control Point sim'))).toBe(true);
    expect(state.some((text) => text.startsWith('aviso (error): A esteira recusou o controle'))).toBe(
      true,
    );
    expect(state.some((text) => text.startsWith('device: Esteira simulada'))).toBe(true);
  });

  it('registra os aparelhos da busca que não se anunciam como FTMS', async () => {
    const stranger: ScannedDevice = {
      id: 'AA:BB:CC:DD:EE:FF',
      name: null,
      rssi: -71,
      advertisesFtms: false,
      ftms: null,
    };
    const rig = createRig({}, {}, (simulator) => ({
      prepare: () => simulator.prepare(),
      connect: (id) => simulator.connect(id),
      scan: (onDevice, onError) => {
        onDevice(stranger);
        onDevice(stranger); // repetido: só entra uma vez
        return simulator.scan(onDevice, onError);
      },
    }));
    rig.session.actions.startScan();
    await advance(500);

    const info = rig.texts('info');
    expect(info.filter((text) => text.includes('AA:BB:CC:DD:EE:FF'))).toEqual([
      'Aparelho na busca: sem nome (AA:BB:CC:DD:EE:FF), RSSI -71',
    ]);
    expect(info.some((text) => text.startsWith('Encontrado com FTMS: Esteira simulada'))).toBe(true);
    // O aparelho FTMS também entra na lista completa da busca.
    expect(info.some((text) => text.startsWith('Aparelho na busca: Esteira simulada'))).toBe(true);
  });

  it('registra de novo o aparelho quando o nome ou o anúncio chegam num pacote posterior', async () => {
    const id = 'AA:BB:CC:DD:EE:01';
    const packet = (patch: Partial<ScannedDevice>): ScannedDevice => ({
      id,
      name: null,
      rssi: -60,
      advertisesFtms: false,
      ftms: null,
      ...patch,
    });
    const rig = createRig({}, {}, (simulator) => ({
      prepare: () => simulator.prepare(),
      connect: (deviceId) => simulator.connect(deviceId),
      scan: (onDevice) => {
        // O anúncio traz os serviços; o scan response, que chega depois, traz o nome.
        onDevice(packet({ advertisement: 'serviços=[0x1826]' }));
        onDevice(packet({ name: 'CTM-TESTE', advertisement: 'nome completo' }));
        // Os dois se alternam durante a busca: nada de novo, nada no registro.
        onDevice(packet({ advertisement: 'serviços=[0x1826]' }));
        onDevice(packet({ name: 'CTM-TESTE', advertisement: 'nome completo' }));
        return { remove: () => {} };
      },
    }));
    rig.session.actions.startScan();
    await advance(100);

    expect(rig.texts('info').filter((text) => text.includes(id))).toEqual([
      `Aparelho na busca: sem nome (${id}), RSSI -60, anúncio: serviços=[0x1826]`,
      `Aparelho na busca (atualização): CTM-TESTE (${id}), RSSI -60, anúncio: nome completo`,
    ]);
  });

  it('o aparelho que muda o anúncio a cada pacote não inunda o registro', async () => {
    const id = 'AA:BB:CC:DD:EE:02';
    const rig = createRig({}, {}, (simulator) => ({
      prepare: () => simulator.prepare(),
      connect: (deviceId) => simulator.connect(deviceId),
      scan: (onDevice) => {
        for (let counter = 0; counter < 50; counter++) {
          onDevice({
            id,
            name: 'Farol',
            rssi: -80,
            advertisesFtms: false,
            ftms: null,
            advertisement: `fabricante[004c]=${counter}`,
          });
        }
        return { remove: () => {} };
      },
    }));
    rig.session.actions.startScan();
    await advance(100);

    expect(rig.texts('info').filter((text) => text.includes(id))).toHaveLength(6);
  });

  it('um ouvinte que lança não interrompe o Parar, e a falha vai para o registro', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(1500);
    expect(rig.session.getSnapshot().belt).toBe('running');

    rig.session.subscribe(() => {
      throw new Error('ouvinte quebrado');
    });
    expect(() => rig.session.actions.stop()).not.toThrow();
    await advance(3000);

    expect(rig.session.getSnapshot().commands.stop.accepted).toBe(1);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expect(rig.texts('error')).toContain('Um ouvinte da sessão falhou: ouvinte quebrado');
  });

  it('ao desconectar, ninguém vê a sessão "conectada" com o estado da conexão já zerado', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(2500);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);

    const seen: { phase: string; speed: number | null; confirmed: boolean }[] = [];
    rig.session.subscribe(() => {
      const snapshot = rig.session.getSnapshot();
      seen.push({
        phase: snapshot.phase,
        speed: snapshot.metrics.speedKmh,
        confirmed: snapshot.identityConfirmed,
      });
    });
    rig.simulator.dropLink();
    await advance(200);

    expect(rig.session.getSnapshot().phase).toBe('idle');
    expect(seen.length).toBeGreaterThan(0);
    // Velocidade "desconhecida" com a fase ainda "connected" pareceria uma lona que parou.
    expect(seen.filter((s) => s.phase === 'connected' && (s.speed === null || !s.confirmed))).toEqual([]);
  });

  it('uma falha no destino do registro não afeta a sessão', async () => {
    const simulator = new SimulatedTreadmillTransport();
    const session = new TreadmillSession({
      ble: simulator,
      demo: { transport: simulator, deviceId: SIMULATED_DEVICE_ID },
      trace: () => {
        throw new Error('disco cheio');
      },
    });
    session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    session.actions.confirmIdentity();
    session.actions.start();
    await advance(1500);

    expect(session.getSnapshot().phase).toBe('connected');
    expect(session.getSnapshot().belt).toBe('running');
  });

  it('sem destino configurado, a sessão funciona igual', async () => {
    const simulator = new SimulatedTreadmillTransport();
    const session = new TreadmillSession({
      ble: simulator,
      demo: { transport: simulator, deviceId: SIMULATED_DEVICE_ID },
    });
    session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    expect(session.getSnapshot().phase).toBe('connected');
  });
});

describe('contagem dos comandos', () => {
  const tally = (rig: ReturnType<typeof createRig>) => rig.session.getSnapshot().commands;

  it('conta os comandos que a esteira aceitou, por tipo', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    expect(tally(rig).start).toEqual({ requested: 0, accepted: 0, refused: 0, unconfirmed: 0 });

    rig.session.actions.start();
    await advance(1500);
    rig.session.actions.changeSpeed(0.1);
    await advance(300);
    rig.session.actions.changeInclination(0.5);
    await advance(300);
    rig.session.actions.pause();
    await advance(300);
    rig.session.actions.stop();
    await advance(300);

    expect(tally(rig)).toEqual({
      start: { requested: 1, accepted: 1, refused: 0, unconfirmed: 0 },
      speed: { requested: 1, accepted: 1, refused: 0, unconfirmed: 0 },
      inclination: { requested: 1, accepted: 1, refused: 0, unconfirmed: 0 },
      pause: { requested: 1, accepted: 1, refused: 0, unconfirmed: 0 },
      stop: { requested: 1, accepted: 1, refused: 0, unconfirmed: 0 },
    });
  });

  it('conta o pedido na hora do toque, antes de a esteira responder', async () => {
    const rig = createRig({ responseDelayMs: 2000 });
    await connectAndConfirm(rig);
    rig.session.actions.start();
    // Nem o pedido de controle foi respondido ainda.
    expect(tally(rig).start).toEqual({ requested: 1, accepted: 0, refused: 0, unconfirmed: 0 });
    await advance(6000);
    expect(tally(rig).start.accepted).toBe(1);

    rig.session.actions.stop();
    rig.session.actions.stop();
    // Cada toque conta como pedido, mesmo que os dois virem um comando só.
    expect(tally(rig).stop).toEqual({ requested: 2, accepted: 0, refused: 0, unconfirmed: 0 });
    rig.session.actions.pause();
    // Com um Parar em andamento, o Pausar não é aceito: não conta como pedido.
    expect(tally(rig).pause.requested).toBe(0);
  });

  it('não conta como pedido o toque que o app ignora', async () => {
    const rig = createRig();
    rig.session.actions.connect(SIMULATED_DEVICE_ID);
    await advance(200);
    // Sem "É esta esteira", nenhum comando sai, nem o Parar.
    rig.session.actions.stop();
    rig.session.actions.start();
    rig.session.actions.changeSpeed(0.1);
    expect(tally(rig).stop.requested).toBe(0);
    expect(tally(rig).start.requested).toBe(0);
    expect(tally(rig).speed.requested).toBe(0);
  });

  it('conta como recusado o comando que a esteira não executa', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    // A lona já está parada: a esteira responde Operation Failed ao Parar.
    rig.session.actions.stop();
    await advance(500);

    expect(tally(rig).stop).toEqual({ requested: 1, accepted: 0, refused: 1, unconfirmed: 0 });
  });

  it('conta como recusado o comando que não saiu porque a esteira negou o controle', async () => {
    const rig = createRig({ grantControl: false });
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(500);

    expect(tally(rig).start).toEqual({ requested: 1, accepted: 0, refused: 1, unconfirmed: 0 });
  });

  it('conta como sem resposta o comando que a esteira não confirma', async () => {
    const rig = createRig({ muteControlPoint: true }, { responseTimeoutMs: 1000 });
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(4000);

    expect(tally(rig).start).toEqual({ requested: 1, accepted: 0, refused: 0, unconfirmed: 1 });
  });

  it('a contagem recomeça a cada conexão e não muda de referência sem comando novo', async () => {
    const rig = createRig();
    await connectAndConfirm(rig);
    rig.session.actions.start();
    await advance(1500);
    const afterStart = tally(rig);
    expect(afterStart.start.accepted).toBe(1);

    await advance(5000); // só dados chegando
    expect(tally(rig)).toBe(afterStart);

    rig.session.actions.disconnect();
    await advance(200);
    expect(tally(rig).start.accepted).toBe(0);
  });
});
