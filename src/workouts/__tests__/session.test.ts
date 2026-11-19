import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';
import { WorkoutSession } from '../session';
import { makePlan, type Plan } from '../model';
import { dailyTarget } from '../physiology';
import { assess, reviewIntensity } from '../ai';
import {
  clearData,
  clearSource,
  deleteWorkout,
  readProfile,
  readWorkouts,
  saveWorkout,
} from '../storage';

jest.mock('../ai', () => ({ assess: jest.fn(), reviewIntensity: jest.fn() }));
jest.mock('../storage', () => ({
  clearData: jest.fn(),
  clearSource: jest.fn(),
  deleteWorkout: jest.fn(),
  readProfile: jest.fn(),
  readWorkouts: jest.fn(),
  saveWorkout: jest.fn(),
}));

const T0 = 1_800_000_000_000;
type Reply = Awaited<ReturnType<typeof reviewIntensity>>;

// 36 anos: máxima estimada de 184. Em "Base aeróbica", faixa de 101 a 120 BPM.
function setup() {
  jest.useFakeTimers({ now: T0 });
  jest.mocked(readProfile).mockReturnValue({ age: 36, weightKg: 75, heightCm: 175 });
  jest.mocked(readWorkouts).mockReturnValue([]);
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
  let now = T0;
  /** Um segundo de esteira: avança o relógio e entrega uma amostra. */
  function packet(speedKmh: number, bpm: number | null = null, incline = 0) {
    now += 1000;
    jest.setSystemTime(now);
    snapshot.samples = [
      ...snapshot.samples.slice(-119),
      {
        speedAt: now,
        inclineAt: now,
        at: now,
        speedKmh,
        inclinationPercent: incline,
        heartRateBpm: bpm,
        energyKcal: null,
        distanceM: null,
      },
    ];
    notify();
  }
  const walk = (seconds: number, speedKmh: number, bpm: number | null = null, incline = 0) => {
    for (let i = 0; i < seconds; i++) packet(speedKmh, bpm, incline);
  };
  return { session, snapshot, notify: () => notify(), walk };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
// Planos curtos, a 5 km/h e 1%, com a faixa em 55–65% da FC máxima (101 a 120 BPM aos 36 anos).
const short = (warmup: number, reps: number, work: number, recovery: number): Plan => ({
  ...makePlan('Base aeróbica', { warmup, reps, work, recovery, cooldown: warmup }, 5, 1),
  objective: 'Base aeróbica',
  zone: [55, 65],
});
// Aquecimento de 120 s, um bloco de esforço de 6 min e volta à calma.
const continuous = () => short(2, 1, 6, 0);
// Aquecimento de 120 s, dois blocos de esforço de 120 s, cada um com 60 s de recuperação.
const intervals = () => short(2, 2, 2, 1);

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

it('encerra o guia uma vez, guarda o treino e não consulta a IA sem leituras', async () => {
  const { session, walk } = setup();
  session.start(makePlan('Base aeróbica', { warmup: 1, reps: 1, work: 3, recovery: 0, cooldown: 1 }, 4, 1));
  walk(302, 5);
  expect(session.snapshot().active).toBeNull();
  expect(session.snapshot().history).toHaveLength(1);
  expect(session.snapshot().history[0]).toMatchObject({
    reason: 'Duração concluída',
    totals: { movingMs: 300000 },
  });
  expect(saveWorkout).toHaveBeenCalledWith(
    expect.objectContaining({ estimate: null, reason: 'Duração concluída' }),
  );
  await flush();
  expect(assess).not.toHaveBeenCalled();
  expect(session.snapshot().history[0].estimate?.level).toBe('Dados insuficientes');
});

it('registra o treino livre por etapa, preserva a sessão se a IA falhar e guarda a FC máxima ao reavaliar', async () => {
  const { session, walk, snapshot, notify } = setup();
  jest
    .mocked(assess)
    .mockRejectedValueOnce(new Error('sem rede'))
    .mockResolvedValue({ level: 'Em adaptação', summary: 'Primeira sessão.', maxBpm: 183 });
  walk(200, 4, 105);
  snapshot.phase = 'idle';
  notify();
  await flush();
  const saved = session.snapshot().history[0];
  expect(saved).toMatchObject({ reason: 'Esteira desconectada', estimate: null, restBpm: 105 });
  expect(saved.log).toHaveLength(1);
  expect(saved.log![0]).toMatchObject({ ms: 199000, bpmCount: 200, top: 105 });
  // Os batimentos ficam também minuto a minuto, para a linha do tempo do painel.
  expect(saved.beats).toEqual([[6300, 60], [6300, 60], [6300, 60], [2100, 20]]);
  expect(session.snapshot().error).toBe('sem rede');
  await session.evaluate(saved);
  expect(assess).toHaveBeenCalledTimes(2);
  expect(session.snapshot().history[0].estimate).toMatchObject({ level: 'Em adaptação', maxBpm: 183 });
});

it('lê a FC de repouso nas primeiras leituras do treino', () => {
  const { session, walk } = setup();
  session.start(continuous());
  expect(session.snapshot().guidance?.bpmRequestedAt).not.toBeNull();
  walk(3, 1);
  walk(6, 1, 90);
  expect(session.snapshot().active?.restBpm).toBeNull();
  walk(1, 1, 90);
  const active = session.snapshot().active!;
  expect(active.restBpm).toBe(90);
  expect(active.hr).toEqual({ rest: 75, max: 184, maxSource: 'idade' });
  // O repouso entra no perfil do dia, mas a faixa continua nos percentuais da FC máxima.
  expect(dailyTarget(active.plan, active.profile, active.hr)).toMatchObject({ low: 101, high: 120 });
  // O aviso de batimentos fecha depois das 6 leituras.
  expect(session.snapshot().guidance?.bpmReceived).toBe(true);
});

it('pede os batimentos de novo a cada 3 minutos dentro da mesma etapa', () => {
  const { session, walk } = setup();
  // Aquecimento de 300 s e um bloco de esforço de 1200 s a 5 km/h e 1%.
  session.start(short(5, 1, 20, 0));
  const guidance = () => session.snapshot().guidance!;
  // Sem segurar o sensor, o pedido da FC de repouso caduca aos 90 s e o guia volta a pedir aos 3 minutos.
  walk(100, 4);
  expect(guidance().bpmRequestedAt).toBeNull();
  walk(81, 4);
  expect(guidance()).toMatchObject({ index: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).not.toBeNull();
  // No bloco de esforço o primeiro pedido espera 120 s.
  walk(120, 4);
  walk(119, 5, null, 1);
  expect(guidance()).toMatchObject({ index: 1, bpmRequestedAt: null });
  walk(1, 5, null, 1);
  const first = guidance().bpmRequestedAt;
  expect(first).not.toBeNull();
  walk(6, 5, 110, 1);
  expect(guidance()).toMatchObject({ bpmRequestedAt: first, bpmReceived: true });
  walk(179, 5, null, 1);
  expect(guidance()).toMatchObject({ bpmRequestedAt: first, bpmReceived: true });
  walk(1, 5, null, 1);
  expect(guidance()).toMatchObject({ index: 1, bpmCount: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).toBe(first! + 186000);
  // Leituras na faixa: o guia confirma sem consultar a IA.
  walk(6, 5, 110, 1);
  expect(guidance().bpmReceived).toBe(true);
  expect(session.snapshot().coach).toBe('Na faixa · 110 BPM');
  expect(reviewIntensity).not.toHaveBeenCalled();
});

it('resolve sem a IA o que não tem escolha: etapa leve abaixo da faixa e BPM na faixa', () => {
  const { session, walk } = setup();
  session.start(continuous());
  walk(3, 4);
  walk(8, 4, 90);
  expect(session.snapshot().coach).toBe('Etapa leve · 90 BPM');
  walk(25, 4);
  walk(8, 4, 112);
  expect(session.snapshot().coach).toBe('Na faixa · 112 BPM');
  expect(reviewIntensity).not.toHaveBeenCalled();
});

it('acima da faixa consulta a IA, aplica o alvo, leva aos blocos iguais e espera antes de revisar de novo', async () => {
  const { session, walk } = setup();
  jest
    .mocked(reviewIntensity)
    .mockResolvedValue({ decision: 'reduzir inclinação', reason: '30 bpm acima' });
  // Aquecimento de 120 s, depois blocos de esforço de 120 s nas etapas 1 e 3.
  session.start(intervals());
  walk(121, 4);
  expect(session.snapshot().guidance?.index).toBe(1);
  walk(5, 5, null, 1);
  walk(5, 5, 150, 1);
  expect(reviewIntensity).not.toHaveBeenCalled();
  walk(1, 5, 150, 1);
  expect(reviewIntensity).toHaveBeenCalledTimes(1);
  expect(jest.mocked(reviewIntensity).mock.calls[0][0]).toMatchObject({
    index: 1,
    // Caminhando com rampa, o app oferece aliviar a inclinação.
    allowed: ['manter', 'reduzir inclinação'],
    features: { median: 150, position: 'acima', margin: 30 },
  });
  await flush();
  const { active, guidance, coach } = session.snapshot();
  expect(active?.plan?.stages.map((s) => s.incline)).toEqual([0, 0.5, 0, 0.5, 0, 0]);
  expect(active?.changes).toEqual([
    expect.objectContaining({ stage: 1, decision: 'reduzir inclinação', bpm: 150 }),
  ]);
  expect(guidance?.adjusted).toBe(false);
  expect(coach).toBe('IA · reduzir inclinação · 30 bpm acima');
  expect(active?.totals.movingMs).toBe(131000);
  // A FC ainda está respondendo ao ajuste: nada de nova revisão no minuto seguinte.
  walk(30, 5, null, 0.5);
  walk(10, 5, 150, 0.5);
  expect(reviewIntensity).toHaveBeenCalledTimes(1);
});

it('descarta a decisão que chega depois de encerrar e começar outra sessão', async () => {
  const { session, walk } = setup();
  let resolve!: (v: Reply) => void;
  jest.mocked(reviewIntensity).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const plan = intervals();
  session.start(plan);
  walk(2, 4);
  walk(6, 4, 160);
  expect(reviewIntensity).toHaveBeenCalledTimes(1);
  session.finish('Encerrado no app');
  session.start(plan);
  resolve({ decision: 'reduzir velocidade', reason: '' });
  await flush();
  expect(session.snapshot().active?.plan).toEqual(plan);
  expect(session.snapshot().coach).toBe('');
});

it('resposta tardia só vale com leitura recente; nova pegada troca a chamada que ainda espera', async () => {
  const { session, walk } = setup();
  const pending: ((v: Reply) => void)[] = [];
  jest.mocked(reviewIntensity).mockImplementation(
    () =>
      new Promise((r) => {
        pending.push(r);
      }),
  );
  const plan = intervals();
  session.start(plan);
  walk(2, 4);
  walk(6, 4, 160);
  expect(pending).toHaveLength(1);
  // 40 s sem segurar o sensor: a resposta chega sem leitura que a confirme.
  walk(40, 4);
  pending[0]({ decision: 'reduzir velocidade', reason: '' });
  await flush();
  expect(session.snapshot().active?.plan).toEqual(plan);
  expect(session.snapshot().coach).toBe('Aguardando nova leitura');

  // Nova pegada, e a resposta demora: a pegada seguinte cancela a chamada antiga.
  walk(6, 4, 160);
  expect(pending).toHaveLength(2);
  walk(35, 4);
  walk(6, 4, 160);
  expect(pending).toHaveLength(3);
  expect(jest.mocked(reviewIntensity).mock.calls[1][1]?.signal?.aborted).toBe(true);
  expect(jest.mocked(reviewIntensity).mock.calls[2][1]?.signal?.aborted).toBe(false);
  pending[2]({ decision: 'reduzir velocidade', reason: '' });
  await flush();
  expect(session.snapshot().active?.plan?.stages[0].speed).toBe(3.7);
});

it('descarta as demonstrações ao abrir e apaga um registro do histórico a pedido', async () => {
  const { session, walk, snapshot, notify } = setup();
  // As sessões da esteira simulada não ficam guardadas de uma abertura para a outra.
  expect(clearSource).toHaveBeenCalledWith('demo');
  jest.mocked(assess).mockResolvedValue({ level: 'Em adaptação', summary: 'ok', maxBpm: 184 });
  walk(200, 4, 105);
  snapshot.phase = 'idle';
  notify();
  await flush();
  const [saved] = session.snapshot().history;
  session.remove(saved.id);
  expect(deleteWorkout).toHaveBeenCalledWith(saved.id);
  expect(session.snapshot().history).toEqual([]);
});

it('apagar os dados descarta o registro em curso e a avaliação que ainda não voltou', async () => {
  const { session, walk, snapshot, notify } = setup();
  let resolve!: (v: Awaited<ReturnType<typeof assess>>) => void;
  jest.mocked(assess).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  walk(200, 4, 105);
  snapshot.phase = 'idle';
  notify();
  expect(assess).toHaveBeenCalledTimes(1);
  snapshot.phase = 'connected';
  walk(5, 4, 105);
  expect(session.snapshot().active).not.toBeNull();
  jest.mocked(saveWorkout).mockClear();
  session.reset();
  expect(clearData).toHaveBeenCalledTimes(1);
  expect(session.snapshot()).toMatchObject({ profile: null, active: null, history: [] });
  // A resposta da IA chega depois: nada volta para o banco.
  resolve({ level: 'Em adaptação', summary: 'ok', maxBpm: 180 });
  await flush();
  walk(5, 4, 105);
  expect(saveWorkout).not.toHaveBeenCalled();
  expect(session.snapshot()).toMatchObject({ active: null, history: [] });
});
