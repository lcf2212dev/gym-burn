import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';
import { WorkoutSession } from '../session';
import { makePlan } from '../model';
import { assess, reviewIntensity } from '../ai';
import { readProfile, readWorkouts, saveWorkout } from '../storage';

jest.mock('../ai', () => ({ assess: jest.fn(), reviewIntensity: jest.fn() }));
jest.mock('../storage', () => ({
  readProfile: jest.fn(),
  readWorkouts: jest.fn(),
  saveWorkout: jest.fn(),
}));

function setup() {
  jest.mocked(readProfile).mockReturnValue({ age: 36, weightKg: 75, heightCm: 175 });
  jest.mocked(readWorkouts).mockReturnValue([]);
  jest
    .mocked(assess)
    .mockResolvedValue({ level: 'Dados insuficientes', summary: 'Sem leituras suficientes.' });
  const snapshot = {
    phase: 'connected',
    mode: 'ble',
    status: { consoleEvents: [], stoppedBySafetyKey: false },
    samples: [] as TreadmillSample[],
  } as unknown as TreadmillSnapshot;
  let notify = () => {};
  const store: TreadmillStore = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      notify = fn;
      return () => {};
    },
    actions: {} as TreadmillStore['actions'],
  };
  const session = new WorkoutSession(store);
  session.connect();
  function packet(at: number, speedKmh: number, bpm: number | null = null) {
    snapshot.samples = [
      ...snapshot.samples.slice(-59),
      {
        speedAt: at,
        inclineAt: at,
        at,
        speedKmh,
        inclinationPercent: 1,
        heartRateBpm: bpm,
        energyKcal: null,
        distanceM: null,
      },
    ];
    notify();
  }
  return { session, snapshot, notify, packet };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('encerra o guia uma vez e guarda o treino antes de consultar a IA', async () => {
  const { session, packet, notify } = setup();
  session.start(makePlan('Resistência', 5, 4, 1));
  for (let i = 0; i <= 300; i++) packet(1000 * i, 5);
  packet(301000, 5);
  notify();
  expect(session.snapshot().active).toBeNull();
  expect(session.snapshot().history).toHaveLength(1);
  expect(session.snapshot().history[0]).toMatchObject({
    reason: 'Duração concluída',
    totals: { movingMs: 300000 },
  });
  expect(saveWorkout).toHaveBeenCalledWith(
    expect.objectContaining({ estimate: null, reason: 'Duração concluída' }),
  );
  await Promise.resolve();
  expect(assess).toHaveBeenCalledTimes(1);
  expect(session.snapshot().history[0].estimate?.level).toBe('Dados insuficientes');
});

it('preserva a sessão interrompida se a IA falhar e permite reavaliar', async () => {
  const { session, packet, snapshot, notify } = setup();
  jest.mocked(assess).mockRejectedValueOnce(new Error('sem rede'));
  packet(1000, 3);
  packet(2000, 3);
  snapshot.phase = 'idle';
  notify();
  await Promise.resolve();
  expect(session.snapshot().history[0]).toMatchObject({
    reason: 'Esteira desconectada',
    estimate: null,
  });
  expect(session.snapshot().error).toBe('sem rede');
  await session.evaluate(session.snapshot().history[0]);
  expect(session.snapshot().history[0].estimate).toBeTruthy();
});

it('revisa com novos BPM, aplica o alvo e reabre o aviso sem perder o tempo registrado', async () => {
  const { session, packet } = setup();
  const plan = makePlan('Resistência', 5, 5, 1);
  jest.mocked(reviewIntensity).mockResolvedValue('reduzir velocidade');
  session.start(plan);
  const start = Date.now();
  for (let i = 0; i < 3; i++) packet(start + i, 4, 155);
  await Promise.resolve();
  expect(reviewIntensity).toHaveBeenCalledTimes(1);
  expect(session.snapshot().active?.plan?.stages[0].speed).toBe(3.7);
  expect(session.snapshot().guidance?.adjusted).toBe(false);
  // A inclinação do alvo de aquecimento era zero.
  expect(session.snapshot().active?.totals.movingMs).toBe(2);
});

it('descarta a decisão anterior ao encerrar e começar outra sessão', async () => {
  const { session, packet } = setup();
  let resolve!: (v: 'reduzir velocidade') => void;
  jest.mocked(reviewIntensity).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const plan = makePlan('Intervalado', 5, 5, 1);
  session.start(plan);
  const start = Date.now();
  for (let i = 0; i < 3; i++) packet(start + i, 4, 150);
  session.finish('Encerrado no app');
  session.start(plan);
  resolve('reduzir velocidade');
  await Promise.resolve();
  expect(session.snapshot().active?.plan).toEqual(plan);
  expect(session.snapshot().coach).toBe('');
});
