import type { BleConnection, BleTransport } from '@/ble/transport';
import { FTMS, sameUuid } from '@/ftms/uuids';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
  type SimulatedTreadmillOptions,
} from '@/simulator/simulated-treadmill';
import { TreadmillSession } from '@/treadmill/treadmill-session';
import type { TraceLine, TreadmillSnapshot } from '@/treadmill/types';

import { FirstTestGuide } from '../first-test-guide';
import {
  DATA_ONLY_DETAIL,
  EFFECT_WINDOW_MS,
  EMERGENCY_QUESTION_HINT,
  EMERGENCY_DONE_DETAILS,
  EMERGENCY_IDLE_HINT,
  EMERGENCY_OBSERVATION_DETAILS,
  EMERGENCY_SPINNING_DETAIL,
  NOT_STOPPED_DETAIL,
  SPEED_REFUSED_DETAIL,
  SPEED_UNCONFIRMED_DETAIL,
  STARTED_BY_PANEL_DETAIL,
  START_DONE_DETAIL,
  START_FAILED_DETAIL,
  START_MISPLACED_DETAIL,
  START_NO_MOVEMENT_DETAIL,
  START_UNCONFIRMED_DETAIL,
  START_UNCONFIRMED_MOVED_DETAIL,
  START_UNCONFIRMED_STILL_DETAIL,
  START_WAITING_DETAIL,
  STILL_HOLD_MS,
  STOP_CONFIRM_DETAIL,
  STOP_DONE_DETAIL,
  STOP_HELPED_DETAIL,
  STOP_INTERRUPTED_DETAIL,
  STOP_MISPLACED_DETAIL,
  STOP_NOT_SEEN_DETAIL,
  STOP_NOT_STOPPED_DETAIL,
  STOP_QUESTION_HINT,
  STOP_REFUSED_DETAIL,
  STOP_UNCONFIRMED_STOPPED_DETAIL,
  STOP_WAITING_DETAIL,
  buildGuideSnapshot,
  initialGuideState,
  nextGuideDeadline,
  observeSession,
  summarizeGuide,
  type GuideState,
} from '../guide-logic';
import type { GuideCheckId, GuideSnapshot, GuideStepId } from '../types';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

interface Rig {
  sim: SimulatedTreadmillTransport;
  session: TreadmillSession;
  guide: FirstTestGuide;
  lines: TraceLine[];
  /** A conexão segue de pé, mas o app não recebe mais nenhum pacote de Treadmill Data. */
  freezeData(): void;
}

interface RigExtras {
  now?: () => number;
  /** A esteira responde Success ao Parar e não para a lona. */
  ignoreStop?: boolean | (() => boolean);
  /** A esteira responde Success ao Iniciar e não move a lona. */
  ignoreStart?: boolean;
}

function createRig(options: SimulatedTreadmillOptions = {}, extras: RigExtras = {}): Rig {
  const { now } = extras;
  const sim = new SimulatedTreadmillTransport(options);
  let frozen = false;
  const gated: BleTransport = {
    prepare: () => sim.prepare(),
    scan: (onDevice, onError) => sim.scan(onDevice, onError),
    connect: async (deviceId) => {
      const connection = await sim.connect(deviceId);
      let indicate: ((data: Uint8Array) => void) | null = null;
      const proxy: BleConnection = {
        deviceId: connection.deviceId,
        name: connection.name,
        getServices: () => connection.getServices(),
        getCharacteristics: (service) => connection.getCharacteristics(service),
        read: (service, characteristic) => connection.read(service, characteristic),
        write: async (service, characteristic, data) => {
          const ignoreStop =
            typeof extras.ignoreStop === 'function' ? extras.ignoreStop() : extras.ignoreStop;
          const ignored =
            (ignoreStop && data[0] === 0x08 && data[1] === 0x01) ||
            (extras.ignoreStart && data[0] === 0x07);
          if (ignored) {
            // Responde Success, mas o comando nunca chega à esteira.
            setTimeout(() => indicate?.(Uint8Array.of(0x80, data[0], 0x01)), 40);
            return;
          }
          return connection.write(service, characteristic, data);
        },
        subscribe: (service, characteristic, onValue) => {
          if (sameUuid(characteristic, FTMS.controlPoint)) {
            indicate = onValue;
          }
          return connection.subscribe(
            service,
            characteristic,
            sameUuid(characteristic, FTMS.treadmillData)
              ? (data) => {
                  if (!frozen) onValue(data);
                }
              : onValue,
          );
        },
        onDisconnect: (listener) => connection.onDisconnect(listener),
        disconnect: () => connection.disconnect(),
      };
      return proxy;
    },
  };
  const session = new TreadmillSession({
    ble: gated,
    demo: { transport: gated, deviceId: SIMULATED_DEVICE_ID },
    responseTimeoutMs: 3000,
    unconfirmedGraceMs: 500,
    controlRetryDelayMs: 500,
  });
  const lines: TraceLine[] = [];
  // Sem `now`, o roteiro usa o relógio (falso) do Jest, que anda junto com os temporizadores.
  const guide = new FirstTestGuide({ session, trace: (line) => lines.push(line), now });
  return {
    sim,
    session,
    guide,
    lines,
    freezeData: () => {
      frozen = true;
    },
  };
}

const g = (rig: Rig): GuideSnapshot => rig.guide.getSnapshot();
const stepState = (rig: Rig, id: GuideStepId) => g(rig).steps.find((s) => s.id === id)?.state;
const check = (rig: Rig, id: GuideCheckId) =>
  g(rig).steps.find((s) => s.id === 'commands')?.checks.find((c) => c.id === id);
const texts = (rig: Rig) => rig.lines.map((line) => line.text);

/** Passos 1 a 4: Feito, Feito, conecta no modo demonstração (já vem confirmada). */
async function reachCommands(rig: Rig): Promise<void> {
  rig.guide.actions.start();
  rig.guide.actions.acknowledge('safety');
  rig.guide.actions.acknowledge('appMode');
  rig.session.actions.openDemo();
  await advance(300);
  expect(rig.session.getSnapshot().phase).toBe('connected');
}

/** Inicia pelo app e espera a lona andar. */
async function startBelt(rig: Rig): Promise<void> {
  rig.session.actions.start();
  await advance(1100);
}

/** Toca em Parar e espera a lona parar de girar. */
async function stopBelt(rig: Rig): Promise<void> {
  rig.session.actions.stop();
  await advance(3000);
  expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
}

/** Para a lona pelo app e responde que ela parou sozinha: a verificação do Parar conclui. */
async function stopAndConfirm(rig: Rig): Promise<void> {
  await stopBelt(rig);
  expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
  rig.guide.actions.reportStop('alone');
  expect(check(rig, 'stop')).toMatchObject({ state: 'done', detail: STOP_DONE_DETAIL });
}

describe('progressão completa', () => {
  it('passa pelos seis passos e termina com o registro compartilhado', async () => {
    const rig = createRig();
    expect(g(rig).active).toBe(false);
    expect(g(rig).hint).toBeNull();

    rig.guide.actions.start();
    expect(g(rig).active).toBe(true);
    expect(g(rig).currentStepId).toBe('safety');
    expect(g(rig).currentStepNumber).toBe(1);

    rig.guide.actions.acknowledge('safety');
    expect(g(rig).currentStepId).toBe('appMode');
    rig.guide.actions.setPanelCode('1234');
    rig.guide.actions.commitText('panelCode');
    rig.guide.actions.acknowledge('appMode');
    expect(g(rig).currentStepId).toBe('connect');
    expect(g(rig).panelCode).toBe('1234');

    rig.session.actions.openDemo();
    await advance(300);
    // No modo demonstração a esteira já vem confirmada.
    expect(stepState(rig, 'connect')).toBe('done');
    expect(stepState(rig, 'identity')).toBe('done');
    expect(g(rig).currentStepId).toBe('commands');
    expect(check(rig, 'start')?.state).toBe('current');
    expect(g(rig).hint).toBe('Toque em Iniciar.');

    rig.guide.actions.answerBluetoothIndicator('yes');
    expect(g(rig).bluetoothIndicator).toBe('yes');

    await startBelt(rig);
    expect(check(rig, 'start')?.state).toBe('done');
    expect(check(rig, 'speed')?.state).toBe('current');

    rig.session.actions.changeSpeed(0.1);
    await advance(100);
    expect(check(rig, 'speed')?.state).toBe('done');
    await advance(2000);
    expect(check(rig, 'speed')?.detail).toBe('A esteira foi a 0,9 km/h');

    await stopBelt(rig);
    // O app viu a lona parar; quem a parou, só o dono sabe.
    expect(check(rig, 'stop')).toMatchObject({ state: 'current', detail: STOP_CONFIRM_DETAIL });
    expect(g(rig).hint).toBe(STOP_QUESTION_HINT);
    expect(check(rig, 'emergencyStop')?.state).toBe('pending');
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')).toMatchObject({ state: 'done', detail: STOP_DONE_DETAIL });
    expect(g(rig).stopQuestion).toBeNull();
    expect(check(rig, 'emergencyStop')?.state).toBe('current');

    await startBelt(rig);
    expect(g(rig).hint).toBe('Aperte o botão vermelho Emergency Stop.');
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_SPINNING_DETAIL);
    // O Emergency Stop corta a lona e a esteira avisa a parada de emergência.
    rig.sim.pullSafetyKey();
    await advance(3000);
    expect(g(rig).emergencyStop).toBe('stopped');
    expect(g(rig).emergencyCause).toBe('safetyKey');
    expect(check(rig, 'emergencyStop')).toMatchObject({
      state: 'done',
      detail: EMERGENCY_DONE_DETAILS.safetyKey,
    });
    expect(stepState(rig, 'commands')).toBe('done');
    expect(g(rig).currentStepId).toBe('share');

    rig.guide.actions.setNotes('Tudo certo');
    rig.guide.actions.markShared();
    expect(g(rig).shared).toBe(true);
    expect(g(rig).finished).toBe(true);
    expect(g(rig).currentStepId).toBeNull();
    expect(g(rig).hint).toBe('Encerre o roteiro quando quiser, na tela dele.');

    rig.guide.actions.stop();
    expect(g(rig).active).toBe(false);
    // As respostas ficam depois de encerrar.
    expect(g(rig).notes).toBe('Tudo certo');
    expect(g(rig).panelCode).toBe('1234');
  });
});

describe('queda de conexão', () => {
  it('volta ao passo 3 sem perder as verificações concluídas', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    expect(check(rig, 'start')?.state).toBe('done');

    rig.sim.dropLink();
    await advance(100);
    expect(rig.session.getSnapshot().phase).toBe('idle');
    expect(g(rig).currentStepId).toBe('connect');
    expect(g(rig).hint).toBe('A conexão caiu: conecte de novo na esteira.');
    expect(check(rig, 'start')?.state).toBe('done');

    rig.session.actions.openDemo();
    await advance(300);
    expect(g(rig).currentStepId).toBe('commands');
    // A contagem de comandos zerou com a nova conexão, mas a verificação ficou travada.
    expect(rig.session.getSnapshot().commands.start.accepted).toBe(0);
    expect(check(rig, 'start')?.state).toBe('done');
    expect(check(rig, 'speed')?.state).toBe('current');
  });
});

describe('Iniciar', () => {
  it('recusado: fica como falhou, mesmo depois de a lona ser iniciada pelo painel', async () => {
    const rig = createRig({ grantControl: false });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(2000);
    expect(rig.session.getSnapshot().commands.start.refused).toBeGreaterThanOrEqual(1);
    expect(check(rig, 'start')).toMatchObject({ state: 'failed', detail: START_FAILED_DETAIL });
    // A falha é um desfecho: o roteiro segue para a próxima verificação.
    expect(check(rig, 'speed')?.state).toBe('current');
    expect(g(rig).hint).toBe('Inicie pelo botão verde do painel e toque em +0,1.');

    rig.sim.consoleStart();
    await advance(2000);
    // A lona andou, mas não pelo app: a verificação do Iniciar pelo app não vira "concluída".
    expect(check(rig, 'start')).toMatchObject({ state: 'failed', detail: STARTED_BY_PANEL_DETAIL });
    expect(g(rig).hint).toBe('Toque em +0,1 na velocidade.');
  });

  it('sem resposta, com a lona andando: não diz que foi pelo painel nem dá por concluído', async () => {
    const rig = createRig({ muteControlPoint: true });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(8000);
    const session = rig.session.getSnapshot();
    expect(session.commands.start).toMatchObject({ accepted: 0, unconfirmed: 1 });
    expect(session.metrics.speedKmh).toBeGreaterThan(0);
    expect(check(rig, 'start')).toMatchObject({
      state: 'unconfirmed',
      detail: START_UNCONFIRMED_MOVED_DETAIL,
    });
    // É um desfecho: o roteiro segue para a próxima verificação.
    expect(check(rig, 'speed')?.state).toBe('current');
  });

  it('sem resposta e a lona não anda no prazo: o detalhe diz isso, e a lona que anda depois não conta', () => {
    const base = sessionSnapshot();
    let state = observeSession(pristineState(), withCommands(base, { start: { ...TALLY, requested: 1 } }), 0);
    const silent = withCommands(base, { start: { ...TALLY, requested: 1, unconfirmed: 1 } });
    state = observeSession(state, silent, 2000);
    expect(state.start).toEqual({ outcome: 'unconfirmed', detail: START_UNCONFIRMED_DETAIL });
    expect(nextGuideDeadline(state, 2000)).toBe(2000 + EFFECT_WINDOW_MS + 1);

    state = observeSession(state, silent, 2000 + EFFECT_WINDOW_MS + 1);
    expect(state.start).toEqual({ outcome: 'unconfirmed', detail: START_UNCONFIRMED_STILL_DETAIL });
    const byPanel = { ...silent, belt: 'running' as const, metrics: { ...silent.metrics, speedKmh: 1 } };
    state = observeSession(state, byPanel, 90_000);
    expect(state.start).toEqual({ outcome: 'unconfirmed', detail: START_UNCONFIRMED_STILL_DETAIL });
  });

  it('aceito, mas a lona não anda no prazo: falha, e a lona iniciada depois pelo painel não conta', () => {
    const base = sessionSnapshot();
    const requested = withCommands(base, { start: { ...TALLY, requested: 1 } });
    const accepted = withCommands(base, { start: { ...TALLY, requested: 1, accepted: 1 } });
    let state = observeSession(pristineState(), requested, 1000);
    state = observeSession(state, accepted, 1500);
    expect(state.start).toEqual({ outcome: 'pending', detail: START_WAITING_DETAIL });
    // O roteiro pede para ser acordado quando o prazo vence, mesmo sem a sessão mudar.
    expect(nextGuideDeadline(state, 1500)).toBe(1500 + EFFECT_WINDOW_MS + 1);

    state = observeSession(state, accepted, 1500 + EFFECT_WINDOW_MS + 1);
    expect(state.start).toEqual({ outcome: 'failed', detail: START_NO_MOVEMENT_DETAIL });
    // Prazo vencido não é agendado de novo: nada de acordar o roteiro sem parar.
    expect(nextGuideDeadline(state, 1500 + EFFECT_WINDOW_MS + 1)).toBeNull();

    const byPanel = { ...accepted, belt: 'running' as const, metrics: { ...accepted.metrics, speedKmh: 1 } };
    state = observeSession(state, byPanel, 60_000);
    expect(state.start.outcome).toBe('failed');
  });

  it('aceito e a lona anda dentro do prazo: concluída', () => {
    const base = sessionSnapshot();
    let state = observeSession(pristineState(), withCommands(base, { start: { ...TALLY, requested: 1 } }), 0);
    const accepted = withCommands(base, { start: { ...TALLY, requested: 1, accepted: 1 } });
    state = observeSession(state, accepted, 100);
    const running = { ...accepted, belt: 'running' as const, metrics: { ...accepted.metrics, speedKmh: 0.8 } };
    state = observeSession(state, running, 5000);
    expect(state.start).toEqual({ outcome: 'done', detail: START_DONE_DETAIL });
  });

  it('um Iniciar cancelado não empresta a tentativa a outro, tocado com a lona já girando', () => {
    const base = sessionSnapshot();
    // O primeiro Iniciar fica sem desfecho (um Parar o cancelou antes de ele sair).
    let state = observeSession(pristineState(), withCommands(base, { start: { ...TALLY, requested: 1 } }), 0);
    // A lona passa a girar pelo painel, e o dono toca em Iniciar de novo.
    const spinning = { ...base, belt: 'running' as const, metrics: { ...base.metrics, speedKmh: 2 } };
    state = observeSession(state, withCommands(spinning, { start: { ...TALLY, requested: 1 } }), 15_000);
    state = observeSession(state, withCommands(spinning, { start: { ...TALLY, requested: 2 } }), 16_000);
    state = observeSession(
      state,
      withCommands(spinning, { start: { ...TALLY, requested: 2, accepted: 1 } }),
      16_100,
    );
    expect(state.start).toEqual({ outcome: 'pending', detail: START_MISPLACED_DETAIL });
  });

  it('pedido com a lona já girando não prova nada', () => {
    const spinning = sessionSnapshot({ belt: 'running' });
    const moving = { ...spinning, metrics: { ...spinning.metrics, speedKmh: 3 } };
    let state = observeSession(pristineState(), moving, 0);
    state = observeSession(state, withCommands(moving, { start: { ...TALLY, requested: 1 } }), 10);
    state = observeSession(state, withCommands(moving, { start: { ...TALLY, requested: 1, accepted: 1 } }), 50);
    expect(state.start).toEqual({ outcome: 'pending', detail: START_MISPLACED_DETAIL });
  });
});

describe('Parar', () => {
  /** Lona girando livre a 1 km/h, vista em duas leituras seguidas. */
  function spinningState(): { state: GuideState; moving: TreadmillSnapshot } {
    const base = sessionSnapshot({ belt: 'running' });
    const moving = { ...base, metrics: { ...base.metrics, speedKmh: 1, updatedAt: 1 } };
    let state = observeSession(pristineState(), moving, 0);
    state = observeSession(state, { ...moving, metrics: { ...moving.metrics, updatedAt: 2 } }, 500);
    return { state, moving };
  }
  const at = (session: TreadmillSnapshot, speedKmh: number, updatedAt: number): TreadmillSnapshot => ({
    ...session,
    metrics: { ...session.metrics, speedKmh, updatedAt },
  });

  it('com a lona parada não conclui nem falha: pede para repetir com ela girando', async () => {
    const rig = createRig();
    await reachCommands(rig);
    rig.session.actions.stop();
    await advance(2000);
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_MISPLACED_DETAIL });
    expect(['pending', 'current']).toContain(check(rig, 'stop')?.state);
    expect(g(rig).stopQuestion).toBeNull();
    // O Emergency Stop só entra em cena depois de o Parar ter desfecho.
    expect(check(rig, 'emergencyStop')?.detail).toBeNull();
  });

  it('aceito com a lona parada (esteira que aceita qualquer Parar) também não conclui nem pergunta', () => {
    const base = sessionSnapshot();
    const still = { ...base, metrics: { ...base.metrics, speedKmh: 0 } };
    let state = observeSession(pristineState(), still, 0);
    state = observeSession(state, withCommands(still, { stop: { ...TALLY, requested: 1 } }), 10);
    state = observeSession(state, withCommands(still, { stop: { ...TALLY, requested: 1, accepted: 1 } }), 5000);
    expect(state.stop).toEqual({ outcome: 'pending', detail: STOP_MISPLACED_DETAIL });
    expect(state.stopAwaitingAnswer).toBe(false);
  });

  it('aceito e a lona para: o app não conclui sozinho, pergunta se ela parou sozinha', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopBelt(rig);
    // Mesmo fora da vez (o +0,1 ficou para trás), a pergunta aparece na verificação.
    expect(check(rig, 'stop')).toMatchObject({ state: 'pending', detail: STOP_CONFIRM_DETAIL });
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
    expect(g(rig).hint).toBe(STOP_QUESTION_HINT);
    expect(stepState(rig, 'commands')).not.toBe('done');

    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')).toMatchObject({ state: 'done', detail: STOP_DONE_DETAIL });
    expect(g(rig).stopAnswer).toBe('alone');
    expect(texts(rig)).toContain('Parar, resposta do usuário: a lona parou sozinha? sim');
    expect(summarizeGuide(g(rig))).toContain('Parar, a lona parou sozinha: sim');
  });

  it('aceito sem efeito, e quem para a lona é o painel: a resposta do usuário faz a verificação falhar', async () => {
    const rig = createRig({}, { ignoreStop: true });
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.stop();
    await advance(2000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    // A esteira não avisa nada de especial: para o app, é igual a um Parar que funcionou.
    rig.sim.consoleStop();
    await advance(4000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_CONFIRM_DETAIL });
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);

    rig.guide.actions.reportStop('helped');
    expect(check(rig, 'stop')).toMatchObject({ state: 'failed', detail: STOP_HELPED_DETAIL });
    expect(g(rig).stopQuestion).toBeNull();
    expect(summarizeGuide(g(rig))).toContain('Parar, a lona parou sozinha: não, você a parou');
    // Dá para corrigir um toque errado.
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')?.state).toBe('done');
  });

  it('depois de um "não", um novo Parar posto à prova pergunta de novo', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopBelt(rig);
    rig.guide.actions.reportStop('helped');
    expect(check(rig, 'stop')?.state).toBe('failed');

    await startBelt(rig);
    await stopBelt(rig);
    expect(g(rig).stopAnswer).toBeNull();
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_CONFIRM_DETAIL });
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')?.state).toBe('done');
  });

  it('um Parar que falhou continua no resumo depois de outro que funcionou', async () => {
    let ignore = true;
    const rig = createRig({}, { ignoreStop: () => ignore });
    await reachCommands(rig);
    await startBelt(rig);
    // 1º Parar: a esteira responde Success e a lona não para.
    rig.session.actions.stop();
    await advance(EFFECT_WINDOW_MS + 1000);
    expect(check(rig, 'stop')).toMatchObject({ state: 'failed', detail: STOP_NOT_SEEN_DETAIL, earlier: [] });

    // 2º Parar: agora a lona para. Enquanto ele está em andamento, a falha do 1º aparece uma
    // vez só, como tentativa anterior.
    ignore = false;
    rig.session.actions.stop();
    await advance(100);
    expect(check(rig, 'stop')).toMatchObject({ earlier: [STOP_NOT_SEEN_DETAIL] });
    expect(check(rig, 'stop')?.state).not.toBe('failed');
    expect(
      summarizeGuide(g(rig)).filter((line) => line.includes(STOP_NOT_SEEN_DETAIL)),
    ).toHaveLength(1);
    await advance(3000);
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')).toMatchObject({
      state: 'done',
      detail: STOP_DONE_DETAIL,
      earlier: [STOP_NOT_SEEN_DETAIL],
    });
    expect(texts(rig)).toContain(
      `Verificação "Toque em Parar, com a lona girando": tentativa anterior sem sucesso guardada. ${STOP_NOT_SEEN_DETAIL}`,
    );
    expect(summarizeGuide(g(rig))).toContain(
      `Verificação "Toque em Parar, com a lona girando", tentativa 1 sem sucesso: ${STOP_NOT_SEEN_DETAIL}`,
    );
  });

  it('um "não" seguido de um novo Parar: a resposta anterior fica guardada, mesmo sem nova resposta', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopBelt(rig);
    rig.guide.actions.reportStop('helped');
    await startBelt(rig);
    await stopBelt(rig);
    // A pergunta voltou e ainda não foi respondida; o "falhou" anterior não se perde.
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
    expect(check(rig, 'stop')?.earlier).toEqual([STOP_HELPED_DETAIL]);
    rig.guide.actions.stop();
    expect(texts(rig)).toContain(
      `Resumo: Verificação "Toque em Parar, com a lona girando", tentativa 1 sem sucesso: ${STOP_HELPED_DETAIL}`,
    );
  });

  it('"a lona não parou" faz a verificação falhar, e corrigir a resposta não cria tentativa', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopBelt(rig);
    rig.guide.actions.reportStop('notStopped');
    expect(check(rig, 'stop')).toMatchObject({ state: 'failed', detail: STOP_NOT_STOPPED_DETAIL });
    expect(summarizeGuide(g(rig))).toContain('Parar, a lona parou sozinha: não, a lona não parou');
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')).toMatchObject({ state: 'done', earlier: [] });
  });

  it('sem pergunta pendente, a resposta do Parar não faz nada', async () => {
    const rig = createRig();
    await reachCommands(rig);
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')?.state).not.toBe('done');
    expect(g(rig).stopAnswer).toBeNull();
    expect(texts(rig).some((t) => t.startsWith('Parar, resposta do usuário'))).toBe(false);
  });

  it('a pergunta continua valendo se a conexão terminar antes da resposta', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopBelt(rig);
    rig.sim.dropLink();
    await advance(200);
    expect(g(rig).currentStepId).toBe('connect');
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
    expect(g(rig).hint).toBe(STOP_QUESTION_HINT);
    rig.guide.actions.reportStop('alone');
    expect(check(rig, 'stop')?.state).toBe('done');
  });

  it('aceito e a velocidade não chega a zero no prazo: falha em vez de esperar para sempre', () => {
    const { state: spinning, moving } = spinningState();
    let state = observeSession(spinning, withCommands(moving, { stop: { ...TALLY, requested: 1 } }), 1000);
    const accepted = withCommands(moving, { stop: { ...TALLY, requested: 1, accepted: 1 } });
    state = observeSession(state, accepted, 1200);
    expect(state.stop).toEqual({ outcome: 'pending', detail: STOP_WAITING_DETAIL });
    // Dois prazos correm: o do freio pedido pelo app (do toque) e o do efeito (da resposta).
    expect(nextGuideDeadline(state, 1200)).toBe(1000 + EFFECT_WINDOW_MS);
    expect(nextGuideDeadline(state, 1000 + EFFECT_WINDOW_MS)).toBe(1200 + EFFECT_WINDOW_MS + 1);

    state = observeSession(state, accepted, 1200 + EFFECT_WINDOW_MS + 1);
    expect(state.stop).toEqual({ outcome: 'failed', detail: STOP_NOT_SEEN_DETAIL });
    expect(nextGuideDeadline(state, 1200 + EFFECT_WINDOW_MS + 1)).toBeNull();
    // Quem parou a lona depois do prazo foi outra coisa: não vira pergunta nem conclusão.
    state = observeSession(state, at(accepted, 0, 9), 1200 + EFFECT_WINDOW_MS + 2000);
    state = observeSession(state, at(accepted, 0, 10), 1200 + EFFECT_WINDOW_MS + 5000);
    expect(state.stop).toEqual({ outcome: 'failed', detail: STOP_NOT_SEEN_DETAIL });
    expect(state.stopAwaitingAnswer).toBe(false);
    // Com o Parar resolvido, a verificação seguinte fica disponível.
    const snapshot = buildGuideSnapshot(state, accepted, null, 1200 + EFFECT_WINDOW_MS + 5000);
    expect(snapshot.steps[4].checks.find((c) => c.id === 'stop')?.state).toBe('failed');
  });

  it('uma leitura solta de 0 km/h não vale como lona parada', () => {
    const { state: spinning, moving } = spinningState();
    let state = observeSession(spinning, withCommands(moving, { stop: { ...TALLY, requested: 1 } }), 1000);
    const accepted = withCommands(moving, { stop: { ...TALLY, requested: 1, accepted: 1 } });
    state = observeSession(state, accepted, 1200);
    // Um pacote com zero no meio, e a lona segue a 1 km/h na leitura seguinte.
    state = observeSession(state, at(accepted, 0, 3), 2000);
    expect(nextGuideDeadline(state, 2000)).toBe(2000 + STILL_HOLD_MS);
    state = observeSession(state, at(accepted, 1, 4), 3000);
    state = observeSession(state, at(accepted, 1, 5), 4000);
    expect(state.stop).toEqual({ outcome: 'pending', detail: STOP_WAITING_DETAIL });
    expect(state.stopAwaitingAnswer).toBe(false);

    // Zero que se mantém conta, mesmo sem chegar outra leitura.
    state = observeSession(state, at(accepted, 0, 6), 5000);
    state = observeSession(state, at(accepted, 0, 6), 5000 + STILL_HOLD_MS);
    expect(state.stopAwaitingAnswer).toBe(true);
  });

  it('numa esteira que manda uma leitura a cada 2 s, o tempo em zero acompanha o intervalo', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const moving = { ...base, metrics: { ...base.metrics, speedKmh: 1, updatedAt: 1 } };
    let state = observeSession(pristineState(), moving, 0);
    state = observeSession(state, at(moving, 1, 2), 2000);
    state = observeSession(state, withCommands(at(moving, 1, 2), { stop: { ...TALLY, requested: 1 } }), 2100);
    const accepted = withCommands(moving, { stop: { ...TALLY, requested: 1, accepted: 1 } });
    state = observeSession(state, at(accepted, 1, 2), 2200);
    // Uma leitura solta de zero; a seguinte, 2 s depois, mostra a lona girando.
    state = observeSession(state, at(accepted, 0, 3), 4000);
    expect(nextGuideDeadline(state, 4000)).toBe(4000 + 3000);
    state = observeSession(state, at(accepted, 0, 3), 4000 + STILL_HOLD_MS);
    expect(state.stopAwaitingAnswer).toBe(false);
    state = observeSession(state, at(accepted, 1, 4), 6000);
    state = observeSession(state, at(accepted, 1, 4), 7000);
    expect(state.stopAwaitingAnswer).toBe(false);
    expect(state.stop).toEqual({ outcome: 'pending', detail: STOP_WAITING_DETAIL });
  });

  it('a lona para antes de a resposta chegar (esteira lenta para responder): pergunta do mesmo jeito', () => {
    const { state: spinning, moving } = spinningState();
    const requested = withCommands(moving, { stop: { ...TALLY, requested: 1 } });
    let state = observeSession(spinning, requested, 1000);
    state = observeSession(state, at(requested, 0, 3), 2000);
    state = observeSession(state, at(requested, 0, 3), 2000 + STILL_HOLD_MS);
    expect(state.stop.outcome).toBe('pending');
    expect(state.stopAwaitingAnswer).toBe(false);
    state = observeSession(
      state,
      at(withCommands(moving, { stop: { ...TALLY, requested: 1, accepted: 1 } }), 0, 3),
      4500,
    );
    expect(state.stop).toEqual({ outcome: 'pending', detail: STOP_CONFIRM_DETAIL });
    expect(state.stopAwaitingAnswer).toBe(true);
  });

  it('o prazo vence sozinho, pelo temporizador do roteiro, numa esteira que para de mandar dados', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.stop();
    await advance(100);
    expect(check(rig, 'stop')?.detail).toBe(STOP_WAITING_DETAIL);
    // A conexão segue de pé, mas não chega mais nenhum pacote de dados.
    rig.freezeData();
    await advance(EFFECT_WINDOW_MS + 100);
    expect(check(rig, 'stop')).toMatchObject({ state: 'failed', detail: STOP_NOT_SEEN_DETAIL });
  });

  it('a lona que para e não manda mais dados: o tempo em zero vence pelo temporizador', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.stop();
    await advance(1100);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expect(g(rig).stopQuestion).toBeNull();
    rig.freezeData();
    await advance(STILL_HOLD_MS);
    expect(g(rig).stopQuestion).toBe(STOP_CONFIRM_DETAIL);
  });

  it('o aviso de parada de emergência antes de a lona parar anula a tentativa, sem perguntar', async () => {
    const rig = createRig({}, { ignoreStop: true });
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(2000);
    rig.session.actions.stop();
    await advance(3000);
    expect(rig.session.getSnapshot().commands.stop.accepted).toBe(1);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    expect(check(rig, 'stop')?.detail).toBe(STOP_WAITING_DETAIL);

    rig.sim.pullSafetyKey();
    await advance(4000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    // A lona parou, mas pelo Emergency Stop: nem concluída, nem pergunta.
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_INTERRUPTED_DETAIL });
    expect(['pending', 'current']).toContain(check(rig, 'stop')?.state);
    expect(g(rig).stopQuestion).toBeNull();
    expect(g(rig).emergencyStop).toBe('pending');
    // Com o botão vermelho acionado, o Iniciar do app fica desabilitado: a faixa diz como voltar.
    expect(g(rig).hint).toBe(
      'Libere o Emergency Stop, inicie a lona pelo painel e toque em Parar com ela girando.',
    );
  });

  it('o Emergency Stop apertado com a lona já freando pelo Parar também anula a tentativa', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    // Rápida o bastante para a frenagem durar alguns segundos.
    for (let tap = 0; tap < 5; tap++) {
      rig.session.actions.changeSpeed(1);
    }
    await advance(10_000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(5);
    rig.session.actions.stop();
    await advance(1100);
    // A lona freia, mas ainda gira.
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    rig.sim.pullSafetyKey();
    await advance(5000);
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_INTERRUPTED_DETAIL });
    expect(['pending', 'current']).toContain(check(rig, 'stop')?.state);
    expect(g(rig).stopQuestion).toBeNull();
  });

  it.each([
    ['Pausar pelo app', (rig: Rig) => rig.session.actions.pause()],
    ['Pausar pelo painel', (rig: Rig) => rig.sim.consolePause()],
  ])('%s logo antes do Parar: a lona já freava, o Parar não foi posto à prova', async (_name, brake) => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(1);
    await advance(6000);
    brake(rig);
    await advance(150);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    rig.session.actions.stop();
    await advance(6000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_MISPLACED_DETAIL });
    expect(['pending', 'current']).toContain(check(rig, 'stop')?.state);
    expect(g(rig).stopQuestion).toBeNull();
  });

  it('Pausar pelo app ainda sem resposta, e o Parar logo em seguida: também não é posto à prova', async () => {
    // A esteira demora a responder e não avisa quem comandou: quando o Parar é tocado, a sessão
    // ainda mostra a lona "rodando", mas o Pausar já pode estar freando.
    const rig = createRig({ responseDelayMs: 2500, notifyStatusToCommander: false });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(7000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    rig.session.actions.pause();
    await advance(150);
    expect(rig.session.getSnapshot().belt).toBe('running');
    // A faixa não manda tocar em Parar agora: o toque não contaria.
    expect(g(rig).hint).not.toBe('Toque em Parar.');
    rig.session.actions.stop();
    await advance(10_000);
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_MISPLACED_DETAIL });
    expect(['pending', 'current']).toContain(check(rig, 'stop')?.state);
  });

  it('com o Parar enviado, a faixa pede para esperar, e não para tocar de novo', async () => {
    const rig = createRig({ responseDelayMs: 1000, notifyStatusToCommander: false });
    await reachCommands(rig);
    rig.session.actions.start();
    expect(g(rig).hint).toBe('Iniciar enviado: espere a lona andar, sem tocar no painel.');
    await advance(5000);
    rig.session.actions.changeSpeed(0.1);
    await advance(3000);
    expect(g(rig).hint).toBe('Toque em Parar.');
    rig.session.actions.stop();
    expect(g(rig).hint).toBe('Parar enviado: espere a lona parar, sem tocar no painel.');
    await advance(400);
    expect(g(rig).hint).toBe('Parar enviado: espere a lona parar, sem tocar no painel.');
  });

  it('a faixa só manda tocar em Parar com a lona girando livre', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(1500);
    expect(g(rig).hint).toBe('Toque em Parar.');
    rig.sim.consolePause();
    await advance(100);
    // A esteira avisou a pausa; a lona ainda gira enquanto freia.
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    expect(g(rig).hint).toBe('Espere a lona girar firme e toque em Parar.');
    await advance(3000);
    expect(g(rig).hint).toBe('Inicie a lona e toque em Parar com ela girando.');
  });

  it('Pausar e Retomar antes do Parar não atrapalham: a lona voltou a girar livre', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.pause();
    await advance(3000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    rig.session.actions.start();
    await advance(2500);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    // Menos de 15 s depois do Pausar, mas a lona parou e voltou a girar nesse meio-tempo.
    await stopAndConfirm(rig);
  });

  it('duplo toque em Parar é uma tentativa só', async () => {
    const rig = createRig({ responseDelayMs: 300, notifyStatusToCommander: false });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(4000);
    rig.session.actions.stop();
    await advance(100);
    // O segundo toque chega antes da resposta ao primeiro.
    rig.session.actions.stop();
    await advance(5000);
    expect(rig.session.getSnapshot().commands.stop).toMatchObject({ requested: 2, accepted: 1 });
    expect(check(rig, 'stop')).toMatchObject({ detail: STOP_CONFIRM_DETAIL });
  });

  it('recusado com a lona girando: falhou, e a vigia do Emergency Stop já vale', async () => {
    const rig = createRig({ grantControl: false });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(2000);
    rig.sim.consoleStart();
    await advance(2000);
    rig.session.actions.changeSpeed(0.1);
    await advance(2000);
    expect(check(rig, 'speed')?.state).toBe('failed');
    rig.session.actions.stop();
    await advance(2000);
    expect(check(rig, 'stop')).toMatchObject({ state: 'failed', detail: STOP_REFUSED_DETAIL });
    // O app não freou a lona: o próximo passo é o Emergency Stop, sem esperar ela parar.
    expect(g(rig).hint).toBe('Aperte o botão vermelho Emergency Stop.');
    rig.sim.pullSafetyKey();
    await advance(4000);
    expect(g(rig).emergencyStop).toBe('stopped');
    expect(g(rig).emergencyCause).toBe('safetyKey');
  });
});

describe('Emergency Stop', () => {
  async function armEmergency(rig: Rig): Promise<void> {
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(200);
    await stopAndConfirm(rig);
    expect(check(rig, 'emergencyStop')?.state).toBe('current');
  }

  /** A verificação segue aberta: nada foi dado por concluído sem o usuário. */
  function expectStillPending(rig: Rig): void {
    expect(g(rig).emergencyStop).toBe('pending');
    expect(g(rig).emergencyCause).toBeNull();
    expect(check(rig, 'emergencyStop')?.state).not.toBe('done');
    expect(stepState(rig, 'commands')).not.toBe('done');
  }

  it('não confunde um Parar pelo app com o Emergency Stop', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    await stopBelt(rig);
    expectStillPending(rig);
    // Nem como observação: a lona parou por um comando do app.
    expect(check(rig, 'emergencyStop')?.detail).toBeNull();
    // E o Parar, já concluído, não volta a perguntar.
    expect(g(rig).stopQuestion).toBeNull();
    expect(check(rig, 'stop')?.state).toBe('done');
  });

  it('conclui sozinho só com o aviso de parada de emergência e a velocidade em zero', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.sim.pullSafetyKey();
    await advance(3000);
    expect(rig.session.getSnapshot().belt).toBe('safetyKey');
    expect(g(rig).emergencyStop).toBe('stopped');
    expect(g(rig).emergencyCause).toBe('safetyKey');
    rig.guide.actions.stop();
    expect(texts(rig)).toContain('Resumo: Emergency Stop: a lona parou (aviso da esteira)');
  });

  it('o aviso de emergência sozinho não conclui: espera a velocidade medida chegar a zero', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.sim.pullSafetyKey();
    await advance(50);
    // O aviso chegou, mas o último pacote de dados ainda mostra a lona girando.
    expect(rig.session.getSnapshot().belt).toBe('safetyKey');
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.safetyKey);

    await advance(3000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expect(g(rig).emergencyStop).toBe('stopped');
  });

  it.each([
    ['Parar', (rig: Rig) => rig.sim.consoleStop()],
    ['Pausar', (rig: Rig) => rig.sim.consolePause()],
  ])('%s pelo painel e o botão vermelho logo em seguida: o aviso não conclui sozinho', async (_name, brake) => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(1);
    await advance(6000);
    brake(rig);
    await advance(100);
    // A lona já freava pelo painel quando o aviso de emergência chegou.
    rig.sim.pullSafetyKey();
    await advance(5000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expectStillPending(rig);
    expect(g(rig).emergencyQuestion).toBe(EMERGENCY_OBSERVATION_DETAILS.safetyKey);
  });

  it('numa esteira que não avisa parada nenhuma, a lona que para vira observação, nunca conclusão', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const reading = (speedKmh: number, updatedAt: number, belt: TreadmillSnapshot['belt'] = 'running') => ({
      ...base,
      belt,
      metrics: { ...base.metrics, speedKmh, updatedAt },
    });
    let state: GuideState = { ...pristineState(), stop: { outcome: 'done', detail: 'x' }, emergencyWatch: 'waitSpin' };
    state = observeSession(state, reading(1, 1), 0);
    expect(state.emergencyWatch).toBe('spinning');
    // A velocidade vai a zero de uma leitura para a outra, sem aviso da esteira.
    state = observeSession(state, reading(0, 2, 'stopped'), 1000);
    expect(state.emergencyStop).toBe('pending');
    expect(state.emergencyObservation).toBe('belt');
    expect(state.emergencyWatch).toBe('waitSpin');
  });

  it('o registro de dados dividido em duas notificações não apaga a queda de velocidade já vista', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const reading = (speedKmh: number, updatedAt: number, belt: TreadmillSnapshot['belt'] = 'running') => ({
      ...base,
      belt,
      metrics: { ...base.metrics, speedKmh, updatedAt },
    });
    let state: GuideState = { ...pristineState(), stop: { outcome: 'done', detail: 'x' }, emergencyWatch: 'waitSpin' };
    state = observeSession(state, reading(3, 1), 0);
    state = observeSession(state, reading(3, 2), 10);
    state = observeSession(state, reading(3, 3), 1000);
    expect(state.emergencyWatch).toBe('spinning');
    // A velocidade cai (Stop do painel, sem aviso). O registro vem dividido: a metade sem a
    // velocidade primeiro, a que traz a velocidade depois, as duas no mesmo milissegundo (e com
    // o mesmo `updatedAt`).
    state = observeSession(state, reading(3, 4), 2000);
    state = observeSession(state, reading(1.5, 4), 2000);
    expect(state.speedDropping).toBe(true);
    // A metade seguinte, sem velocidade, não desfaz o que já foi visto.
    state = observeSession(state, reading(1.5, 5), 2010);
    expect(state.speedDropping).toBe(true);
    state = observeSession(state, reading(1.5, 5, 'safetyKey'), 2300);
    state = observeSession(state, reading(0, 6, 'safetyKey'), 3000);
    state = observeSession(state, reading(0, 7, 'safetyKey'), 3010);
    state = observeSession(state, reading(0, 8, 'safetyKey'), 3000 + STILL_HOLD_MS + 500);
    expect(state.emergencyStop).toBe('pending');
    expect(state.emergencyObservation).toBe('safetyKey');
  });

  it('depois do aviso de emergência, uma leitura solta de 0 km/h não conclui', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const reading = (speedKmh: number, updatedAt: number, belt: TreadmillSnapshot['belt'] = 'running') => ({
      ...base,
      belt,
      metrics: { ...base.metrics, speedKmh, updatedAt },
    });
    let state: GuideState = { ...pristineState(), stop: { outcome: 'done', detail: 'x' }, emergencyWatch: 'waitSpin' };
    state = observeSession(state, reading(3, 1), 0);
    state = observeSession(state, reading(3, 2), 1000);
    state = observeSession(state, reading(3, 2, 'safetyKey'), 1100);
    expect(state.emergencyWatch).toBe('emergencyBraking');
    // Zero num pacote, 3 km/h no seguinte: a lona não parou.
    state = observeSession(state, reading(0, 3, 'safetyKey'), 2000);
    state = observeSession(state, reading(3, 4, 'safetyKey'), 3000);
    state = observeSession(state, reading(3, 5, 'safetyKey'), 4000);
    expect(state.emergencyStop).toBe('pending');
    // Zero que se mantém conclui.
    state = observeSession(state, reading(0, 6, 'safetyKey'), 5000);
    state = observeSession(state, reading(0, 7, 'safetyKey'), 6000);
    expect(state.emergencyStop).toBe('pending');
    state = observeSession(state, reading(0, 8, 'safetyKey'), 7000);
    expect(state.emergencyStop).toBe('stopped');
    expect(state.emergencyCause).toBe('safetyKey');
  });

  it('numa esteira que não avisa a parada do painel, o aviso que chega com a velocidade já caindo não conclui', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const reading = (speedKmh: number, updatedAt: number, belt: TreadmillSnapshot['belt'] = 'running') => ({
      ...base,
      belt,
      metrics: { ...base.metrics, speedKmh, updatedAt },
    });
    // O Parar já tem desfecho e a lona gira livre, a 3 km/h.
    let state: GuideState = { ...pristineState(), stop: { outcome: 'done', detail: 'x' }, emergencyWatch: 'waitSpin' };
    state = observeSession(state, reading(3, 1), 0);
    state = observeSession(state, reading(3, 2), 1000);
    expect(state.emergencyWatch).toBe('spinning');
    // A velocidade cai sem aviso nenhum (Stop do painel) e só então chega o aviso de emergência.
    state = observeSession(state, reading(1.5, 3), 2000);
    state = observeSession(state, reading(1.5, 3, 'safetyKey'), 2100);
    state = observeSession(state, reading(0, 4, 'safetyKey'), 3000);
    state = observeSession(state, reading(0, 5, 'safetyKey'), 4000);
    state = observeSession(state, reading(0, 6, 'safetyKey'), 5000);
    expect(state.emergencyStop).toBe('pending');
    expect(state.emergencyObservation).toBe('safetyKey');
  });

  it('o Emergency Stop apertado antes da resposta do Parar vira pergunta assim que ela é dada', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(200);
    await stopBelt(rig);
    // O dono segue em frente sem responder: inicia de novo e aperta o botão vermelho.
    await startBelt(rig);
    rig.sim.pullSafetyKey();
    await advance(4000);
    expect(g(rig).hint).toBe(STOP_QUESTION_HINT);
    expect(g(rig).emergencyQuestion).toBeNull();

    rig.guide.actions.reportStop('alone');
    // O aviso da esteira continua lá: em vez de mandar iniciar de novo, o roteiro pergunta.
    expectStillPending(rig);
    expect(g(rig).emergencyQuestion).toBe(EMERGENCY_OBSERVATION_DETAILS.safetyKey);
    expect(g(rig).hint).toBe(EMERGENCY_QUESTION_HINT);
  });

  it('o Emergency Stop que derruba a conexão: a pergunta fica à vista em qualquer passo', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.sim.pullSafetyKey();
    rig.sim.dropLink();
    await advance(500);
    expectStillPending(rig);
    // O roteiro volta ao passo 3, mas a pergunta e a faixa continuam falando do Emergency Stop.
    expect(g(rig).currentStepId).toBe('connect');
    expect(g(rig).emergencyQuestion).toBe(EMERGENCY_OBSERVATION_DETAILS.safetyKey);
    expect(g(rig).hint).toBe(EMERGENCY_QUESTION_HINT);

    rig.guide.actions.reportEmergencyStop('stopped');
    expect(g(rig).emergencyQuestion).toBeNull();
    expect(g(rig).currentStepId).toBe('share');
  });

  it('a conexão que cai com a lona girando não vale como parada: pergunta ao usuário', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.sim.dropLink();
    await advance(200);
    expect(rig.session.getSnapshot().phase).toBe('idle');
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.link);
    // A conexão caiu sem o passo 5 concluído: o roteiro volta ao passo 3.
    expect(g(rig).currentStepId).toBe('connect');
    expect(g(rig).emergencyQuestion).toBe(EMERGENCY_OBSERVATION_DETAILS.link);
    expect(g(rig).hint).toBe(EMERGENCY_QUESTION_HINT);

    rig.guide.actions.reportEmergencyStop('stopped');
    expect(g(rig).emergencyCause).toBe('manual');
    expect(check(rig, 'emergencyStop')).toMatchObject({ state: 'done', detail: EMERGENCY_DONE_DETAILS.manual });
    // Com os comandos testados, a conexão caída não segura mais o roteiro.
    expect(g(rig).currentStepId).toBe('share');
  });

  it('Desconectar pelo app com a lona girando também não vale como parada', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.session.actions.disconnect();
    await advance(500);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.link);
  });

  it.each([
    ['Parar', (rig: Rig) => rig.sim.consoleStop()],
    ['Pausar', (rig: Rig) => rig.sim.consolePause()],
  ])('%s pelo painel não é Emergency Stop: vira observação e a resposta é do usuário', async (_name, act) => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    act(rig);
    await advance(4000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.belt);
    expect(g(rig).hint).toBe(EMERGENCY_QUESTION_HINT);

    // Uma nova tentativa limpa a observação.
    await startBelt(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_SPINNING_DETAIL);
  });

  it('esteira que obedece sem responder: o Parar do app não passa por Emergency Stop', async () => {
    const rig = createRig({ muteControlPoint: true });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(8000);
    rig.session.actions.changeSpeed(0.1);
    await advance(8000);
    rig.session.actions.stop();
    await advance(15_000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    // Sem resposta da esteira, o Parar não fica como concluído; a lona parada vai no detalhe.
    expect(check(rig, 'stop')).toMatchObject({
      state: 'unconfirmed',
      detail: STOP_UNCONFIRMED_STOPPED_DETAIL,
    });

    rig.session.actions.start();
    await advance(8000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    rig.session.actions.stop();
    // A lona para muito antes de o app desistir de esperar a resposta.
    await advance(4000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBeNull();
    await advance(15_000);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBeNull();
  });

  it('Pausar pelo app com resposta lenta: a lona para antes da resposta e não conta', async () => {
    const rig = createRig({ responseDelayMs: 2500 });
    await reachCommands(rig);
    rig.session.actions.start();
    await advance(6000);
    rig.session.actions.changeSpeed(0.1);
    await advance(4000);
    rig.session.actions.stop();
    await advance(8000);
    // O aviso da esteira chegou, mas a resposta ao comando veio tarde demais para a sessão.
    expect(check(rig, 'stop')?.state).toBe('unconfirmed');
    rig.session.actions.start();
    await advance(6000);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_SPINNING_DETAIL);

    rig.session.actions.pause();
    await advance(2000);
    // A resposta ao Pausar ainda não chegou e a lona já freou.
    expect(rig.session.getSnapshot().commands.pause.accepted).toBe(0);
    await advance(6000);
    expect(rig.session.getSnapshot().metrics.speedKmh).toBe(0);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBeNull();
  });

  it('o aviso de emergência com a lona já parada pelo painel não conclui', async () => {
    const rig = createRig();
    await armEmergency(rig);
    await startBelt(rig);
    rig.sim.consoleStop();
    await advance(4000);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.belt);
    // O botão vermelho apertado com a lona parada há um tempo não prova que ele a para: a
    // pergunta continua sendo sobre a parada que o app viu, sem o aviso.
    rig.sim.pullSafetyKey();
    await advance(1000);
    expectStillPending(rig);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_OBSERVATION_DETAILS.belt);
  });

  it('a lona zera e o aviso de emergência chega logo depois: é a mesma parada, e vira pergunta', () => {
    const base = sessionSnapshot({ belt: 'running' });
    const reading = (speedKmh: number, updatedAt: number, belt: TreadmillSnapshot['belt'] = 'running') => ({
      ...base,
      belt,
      metrics: { ...base.metrics, speedKmh, updatedAt },
    });
    let state: GuideState = { ...pristineState(), stop: { outcome: 'done', detail: 'x' }, emergencyWatch: 'waitSpin' };
    state = observeSession(state, reading(1, 1), 0);
    state = observeSession(state, reading(1, 2), 1000);
    // A esteira manda a leitura com zero antes do aviso.
    state = observeSession(state, reading(0, 3, 'stopped'), 2000);
    expect(state.emergencyObservation).toBe('belt');
    state = observeSession(state, reading(0, 3, 'safetyKey'), 2400);
    expect(state.emergencyStop).toBe('pending');
    expect(state.emergencyObservation).toBe('safetyKey');
  });

  it('o botão vermelho acionado com a lona já parada não vira pergunta: o roteiro pede para repetir', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(0.1);
    await advance(200);
    await stopBelt(rig);
    // Com a pergunta do Parar esperando e a lona parada, o dono aperta o botão vermelho.
    rig.sim.pullSafetyKey();
    await advance(1000);
    rig.guide.actions.reportStop('alone');
    expectStillPending(rig);
    expect(g(rig).emergencyQuestion).toBeNull();
    expect(check(rig, 'emergencyStop')).toMatchObject({
      state: 'current',
      detail: EMERGENCY_OBSERVATION_DETAILS.idle,
    });
    expect(g(rig).hint).toBe(EMERGENCY_IDLE_HINT);

    // Liberado o botão e iniciada a lona pelo painel, o teste de verdade acontece.
    rig.sim.consoleStart();
    await advance(3000);
    expect(check(rig, 'emergencyStop')?.detail).toBe(EMERGENCY_SPINNING_DETAIL);
    rig.sim.pullSafetyKey();
    await advance(4000);
    expect(g(rig).emergencyStop).toBe('stopped');
    expect(g(rig).emergencyCause).toBe('safetyKey');
  });

  it('aceita a resposta manual nos dois sentidos', async () => {
    const rig = createRig();
    await armEmergency(rig);
    rig.guide.actions.reportEmergencyStop('notStopped');
    expect(check(rig, 'emergencyStop')).toMatchObject({
      state: 'failed',
      detail: NOT_STOPPED_DETAIL,
      urgent: true,
    });
    expect(stepState(rig, 'commands')).toBe('done');
    rig.guide.actions.reportEmergencyStop('stopped');
    expect(check(rig, 'emergencyStop')).toMatchObject({ state: 'done', urgent: false });
    expect(texts(rig)).toContain('Emergency Stop, resposta do usuário: a lona não parou');
    expect(texts(rig)).toContain('Emergency Stop, resposta do usuário: a lona parou');
    expect(summarizeGuide(g(rig))).toContain('Emergency Stop: a lona parou (resposta sua)');
  });

  it('a resposta do usuário vale mesmo antes de o Parar ter desfecho, mas não fecha o passo 5', async () => {
    const rig = createRig();
    await reachCommands(rig);
    rig.guide.actions.reportEmergencyStop('stopped');
    expect(g(rig).emergencyStop).toBe('stopped');
    expect(stepState(rig, 'commands')).not.toBe('done');
  });
});

describe('temporizador de prazos', () => {
  it('um prazo já vencido não acorda o roteiro sem parar', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopAndConfirm(rig);
    await startBelt(rig);
    rig.session.actions.changeSpeed(1);
    await advance(6000);
    // Pausar pelo app e, com a lona ainda freando, a esteira para de mandar dados: a vigia fica
    // esperando a lona parar, com o prazo do freio vencido.
    rig.session.actions.pause();
    await advance(500);
    rig.freezeData();
    expect(rig.session.getSnapshot().metrics.speedKmh).toBeGreaterThan(0);
    await advance(EFFECT_WINDOW_MS + 1000);

    const reads = jest.spyOn(rig.session, 'getSnapshot');
    await advance(60_000);
    expect(reads.mock.calls.length).toBeLessThan(10);
  });
});

describe('isolamento', () => {
  it('uma falha ao observar a sessão não escapa para quem a avisou', async () => {
    const rig = createRig();
    await reachCommands(rig);
    let broken = false;
    let notify: () => void = () => {};
    const lines: string[] = [];
    // Uma sessão de mentira, que entrega o ouvinte ao teste e pode falhar ao ser lida.
    const guide = new FirstTestGuide({
      session: {
        actions: rig.session.actions,
        probe: rig.session.probe,
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        getSnapshot: () => {
          if (broken) {
            throw new Error('leitura quebrada');
          }
          return rig.session.getSnapshot();
        },
      },
      trace: (line) => lines.push(line.text),
    });
    guide.actions.start();
    broken = true;
    // A sessão chama os ouvintes no meio de um Parar: nada pode sair daqui.
    expect(() => notify()).not.toThrow();
    expect(lines).toContain('O roteiro falhou ao observar a sessão: leitura quebrada');
  });
});

describe('esteira sem Control Point', () => {
  it('dá o passo 5 por concluído', async () => {
    const rig = createRig({ hasControlPoint: false });
    await reachCommands(rig);
    const commands = g(rig).steps.find((s) => s.id === 'commands');
    expect(commands?.state).toBe('done');
    expect(commands?.detail).toBe(DATA_ONLY_DETAIL);
    expect(commands?.checks).toEqual([]);
    expect(g(rig).currentStepId).toBe('share');
  });
});

describe('registro', () => {
  it('emite linhas guide para início, passos, verificações, respostas e textos', async () => {
    const rig = createRig({}, { now: () => 42 });
    rig.guide.actions.start();
    rig.guide.actions.acknowledge('safety');
    rig.guide.actions.setPanelCode('1');
    rig.guide.actions.setPanelCode('12');
    rig.guide.actions.commitText('panelCode');
    rig.guide.actions.commitText('panelCode');
    rig.guide.actions.setNotes('a');
    rig.guide.actions.setNotes('ab');
    rig.guide.actions.answerBluetoothIndicator('no');
    rig.guide.actions.markShared();
    rig.guide.actions.stop();

    expect(rig.lines.every((line) => line.kind === 'guide' && line.hex === null && line.at === 42)).toBe(
      true,
    );
    const all = texts(rig);
    expect(all[0]).toMatch(/^Roteiro iniciado/);
    expect(all).toContain('Passo 1, Segurança: atual');
    expect(all).toContain('Usuário tocou em Feito: Segurança');
    expect(all).toContain('Passo 1, Segurança: feito');
    expect(all).toContain('Passo 2, Modo APP: atual');
    // Os campos de texto vão para o registro uma vez, não a cada tecla.
    expect(all.filter((t) => t.startsWith('Código que apareceu no painel'))).toEqual([
      'Código que apareceu no painel: "12"',
    ]);
    expect(all.filter((t) => t.startsWith('Observações'))).toEqual(['Observações: "ab"']);
    expect(all).toContain('Indicador Bluetooth do painel acendeu: não');
    expect(all).toContain('Usuário tocou em Compartilhar registro');
    expect(all).toContain('Resumo: Código do painel: 12');
    expect(all[all.length - 1]).toBe('Roteiro encerrado');
  });

  it('registra a mudança de estado das verificações com a contagem de comandos', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    expect(
      texts(rig).some((t) =>
        t.startsWith('Verificação "Toque em Iniciar": concluída. A esteira aceitou o Iniciar'),
      ),
    ).toBe(true);
    expect(texts(rig).some((t) => t.includes('pedidos 1, aceitos 1, recusados 0, sem resposta 0'))).toBe(
      true,
    );
  });

  it('registra os passos da vigia do Emergency Stop', async () => {
    const rig = createRig();
    await reachCommands(rig);
    await startBelt(rig);
    await stopAndConfirm(rig);
    await startBelt(rig);
    rig.sim.consoleStop();
    await advance(4000);
    const watch = texts(rig).filter((t) => t.startsWith('Vigia do Emergency Stop'));
    expect(watch.some((t) => t.includes('waitStill → waitSpin'))).toBe(true);
    expect(watch.some((t) => t.includes('waitSpin → spinning'))).toBe(true);
    // A esteira simulada avisa a parada pelo painel antes de a lona parar.
    expect(watch.some((t) => t.includes('spinning → otherBraking'))).toBe(true);
    expect(watch.some((t) => t.includes('otherBraking → waitSpin, observação belt'))).toBe(true);
  });

  it('registra o envio do registro antes do fim, sem concluir o passo 6', () => {
    const rig = createRig();
    rig.guide.actions.start();
    rig.guide.actions.setNotes('a esteira não apareceu');
    rig.guide.actions.noteEarlyShare();
    expect(texts(rig)).toContain('Observações: "a esteira não apareceu"');
    expect(texts(rig)).toContain('Usuário compartilhou o registro antes do fim do roteiro (passo 1)');
    expect(g(rig).shared).toBe(false);
    expect(stepState(rig, 'share')).toBe('pending');
  });

  it('uma falha do registro não interrompe o roteiro', () => {
    const sim = new SimulatedTreadmillTransport();
    const session = new TreadmillSession({
      ble: sim,
      demo: { transport: sim, deviceId: SIMULATED_DEVICE_ID },
    });
    const guide = new FirstTestGuide({
      session,
      trace: () => {
        throw new Error('disco cheio');
      },
    });
    guide.actions.start();
    guide.actions.acknowledge('safety');
    expect(guide.getSnapshot().currentStepId).toBe('appMode');
  });
});

describe('snapshot', () => {
  it('é um objeto novo a cada mudança e reaproveita o que não mudou', () => {
    const rig = createRig();
    rig.guide.actions.start();
    const before = g(rig);
    const frozen = JSON.stringify(before);
    rig.guide.actions.acknowledge('safety');
    const after = g(rig);
    expect(after).not.toBe(before);
    expect(JSON.stringify(before)).toBe(frozen);
    expect(after.steps[0]).not.toBe(before.steps[0]);
    // Passos que não mudaram mantêm a referência.
    expect(after.steps[2]).toBe(before.steps[2]);
    expect(after.steps[4].checks).toBe(before.steps[4].checks);
  });

  it('não avisa os ouvintes quando nada mudou', async () => {
    const rig = createRig();
    rig.guide.actions.start();
    const listener = jest.fn();
    rig.guide.subscribe(listener);
    rig.guide.actions.acknowledge('safety');
    rig.guide.actions.acknowledge('safety');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('para de observar a sessão depois de dispose()', async () => {
    const rig = createRig();
    rig.guide.actions.start();
    rig.guide.actions.acknowledge('safety');
    rig.guide.actions.acknowledge('appMode');
    rig.guide.dispose();
    rig.session.actions.openDemo();
    await advance(300);
    expect(g(rig).currentStepId).toBe('connect');
  });
});

// --- Lógica pura, com snapshots da sessão montados à mão -----------------------

const TALLY = { requested: 0, accepted: 0, refused: 0, unconfirmed: 0 };

function sessionSnapshot(patch: Partial<TreadmillSnapshot> = {}): TreadmillSnapshot {
  const rig = createRig();
  return { ...rig.session.getSnapshot(), phase: 'connected', control: 'granted', identityConfirmed: true, ...patch };
}

function withCommands(
  base: TreadmillSnapshot,
  commands: Partial<TreadmillSnapshot['commands']>,
): TreadmillSnapshot {
  return { ...base, commands: { ...base.commands, ...commands } };
}

/** Roteiro em andamento, com os passos 1 e 2 feitos e nenhuma verificação ainda. */
function pristineState(): GuideState {
  return { ...initialGuideState(), active: true, acknowledged: { safety: true, appMode: true } };
}

function activeState(): GuideState {
  return { ...pristineState(), start: { outcome: 'done', detail: 'x' } };
}

describe('ajuste de velocidade', () => {
  it('recusado sem nenhum aceito vira falhou', () => {
    const session = withCommands(sessionSnapshot(), {
      speed: { ...TALLY, refused: 1 },
    });
    const state = observeSession(activeState(), session, 0);
    expect(state.speed).toEqual({ outcome: 'failed', detail: SPEED_REFUSED_DETAIL });
    const snapshot = buildGuideSnapshot(state, session, null, 0);
    const speed = snapshot.steps[4].checks.find((c) => c.id === 'speed');
    expect(speed?.state).toBe('failed');
  });

  it('sem resposta fica sem confirmação, com o detalhe próprio, e um aceito depois conclui', () => {
    const base = sessionSnapshot();
    let state = observeSession(
      activeState(),
      withCommands(base, { speed: { ...TALLY, unconfirmed: 1 } }),
      0,
    );
    expect(state.speed).toEqual({ outcome: 'unconfirmed', detail: SPEED_UNCONFIRMED_DETAIL });
    state = observeSession(state, withCommands(base, { speed: { ...TALLY, accepted: 1, unconfirmed: 1 } }), 1);
    expect(state.speed.outcome).toBe('done');
  });

  it('fora do roteiro não observa nada', () => {
    const state = initialGuideState();
    const session = withCommands(sessionSnapshot(), { speed: { ...TALLY, refused: 1 } });
    expect(observeSession(state, session, 0)).toBe(state);
  });
});
