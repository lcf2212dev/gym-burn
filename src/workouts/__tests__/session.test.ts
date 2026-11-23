import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';
import { WorkoutSession } from '../session';
import { cueKey, pendingAction } from '../guidance';
import { makePlan, metabolicCost, type Plan, type Profile } from '../model';
import { dailyTarget } from '../physiology';
import { assess, reviewLoad } from '../ai';
import {
  clearData,
  clearSource,
  deleteWorkout,
  readProfile,
  readWorkouts,
  saveWorkout,
} from '../storage';

jest.mock('../ai', () => ({ assess: jest.fn(), reviewLoad: jest.fn() }));
jest.mock('../storage', () => ({
  clearData: jest.fn(),
  clearSource: jest.fn(),
  deleteWorkout: jest.fn(),
  readProfile: jest.fn(),
  readWorkouts: jest.fn(),
  saveWorkout: jest.fn(),
  // A trilha por segundo: fora do registro do treino, gravada no checkpoint.
  pruneTracks: jest.fn(),
  saveTrackChunk: jest.fn(),
  readTrackChunks: jest.fn(() => []),
}));

type Reply = Awaited<ReturnType<typeof reviewLoad>>;

const T0 = 1_800_000_000_000;

// 36 anos: máxima estimada de 184. Em "Base aeróbica", faixa de 101 a 120 BPM.
function setup(profile: Profile = { age: 36, weightKg: 75, heightCm: 175 }) {
  jest.useFakeTimers({ now: T0 });
  jest.mocked(readProfile).mockReturnValue(profile);
  jest.mocked(readWorkouts).mockReturnValue([]);
  // Sem rede ou sem chave: a revisão segue com a conta do app.
  jest.mocked(reviewLoad).mockRejectedValue(new Error('Configure a chave DeepSeek em Perfil.'));
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
  // Horário fixo da última leitura de inclinação, para simular a telemetria velha; `undefined` = a de agora.
  let inclineAt: number | null | undefined;
  /**
   * Um segundo de esteira: avança o relógio, entrega uma amostra e deixa correr
   * o que ela disparou, como a resposta da IA. No aparelho cada notificação
   * chega numa tarefa própria.
   */
  async function packet(speedKmh: number, bpm: number | null = null, incline = 0, strap = false) {
    now += 1000;
    jest.advanceTimersByTime(1000);
    snapshot.samples = [
      ...snapshot.samples.slice(-299),
      {
        speedAt: now,
        inclineAt: inclineAt === undefined ? now : inclineAt,
        at: now,
        speedKmh,
        inclinationPercent: incline,
        heartRateBpm: bpm,
        ...(strap ? { heartRateSource: 'strap' as const } : {}),
        energyKcal: null,
        distanceM: null,
      },
    ];
    notify();
    await flush();
  }
  const walk = async (seconds: number, speedKmh: number, bpm: number | null = null, incline = 0) => {
    for (let i = 0; i < seconds; i++) await packet(speedKmh, bpm, incline);
  };
  /**
   * Segundos de esteira com a leitura contínua da cinta em cada amostra. `bpm`
   * pode variar com o segundo (a partir de 0). `each` roda depois de cada um.
   */
  const strap = async (
    seconds: number,
    speedKmh: number,
    bpm: number | ((second: number) => number),
    incline = 0,
    each = () => {},
  ) => {
    for (let i = 0; i < seconds; i++) {
      await packet(speedKmh, typeof bpm === 'number' ? bpm : bpm(i), incline, true);
      each();
    }
  };
  /** Uma pegada no sensor com as leituras dadas, uma por segundo. */
  const hold = async (speedKmh: number, values: number[], incline = 0) => {
    for (const bpm of values) await packet(speedKmh, bpm, incline);
  };
  /** A partir daqui a inclinação para de chegar: a última leitura dela fica neste segundo. */
  const freezeIncline = () => {
    inclineAt = now;
  };
  return { session, snapshot, notify: () => notify(), walk, hold, strap, freezeIncline };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/** Uma resposta da IA que só chega quando o teste quiser. */
function pendingReviews() {
  const pending: ((v: Reply) => void)[] = [];
  jest.mocked(reviewLoad).mockImplementation(
    () =>
      new Promise((r) => {
        pending.push(r);
      }),
  );
  return pending;
}
const coach = (session: WorkoutSession) => session.snapshot().coach;
const changes = (session: WorkoutSession) => session.snapshot().active?.changes;
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
// Aquecimento de 120 s e um bloco de esforço de 20 min: dá tempo de a carga estabilizar.
const long = () => short(2, 1, 20, 0);
const loads = (plan: Plan | null | undefined) => plan?.stages.map((s) => [s.speed, s.incline]);

// 41 anos: FC máxima de 179 e, no VO₂máx (90–95%), faixa de 161 a 170.
const vo2Profile: Profile = { age: 41, weightKg: 80, heightCm: 178 };
// Aquecimento de 120 s e tiros de 4 min a 6,6 km/h e 1%, com 3 min leves entre eles.
const vo2 = (reps: number): Plan => ({
  ...makePlan('VO₂máx', { warmup: 2, reps, work: 4, recovery: 3, cooldown: 2 }, 6.6, 1),
  objective: 'VO₂máx',
  zone: [90, 95],
});
// O 3º tiro de 22/11 como a cinta leu: médias de 132, 158, 171 e 177 por minuto, até 179 no fim.
const knots = [115, 149, 167, 175, 179];
const shot = (t: number) => {
  const i = Math.min(3, Math.floor(t / 60));
  return Math.round(knots[i] + ((knots[i + 1] - knots[i]) * (t - 60 * i)) / 60);
};
/** O primeiro segundo do tiro com a leitura acima de 170. */
const firstOver = Array.from({ length: 240 }, (_, t) => t).find((t) => shot(t) > 170)!;

/**
 * Os avisos que o app reabre sem ajuste novo, quando pede de novo uma redução
 * que não chegou ao painel. Depois de cada um a pessoa minimiza o aviso, como
 * quem o ignora: o seguinte tem de reabrir e tocar de novo, com outra chave.
 */
function realerts(session: WorkoutSession) {
  const seen: { at: number; stage: number; coach: string; key: string | null; reopened: boolean }[] = [];
  let since: number | null = null;
  let index = -1;
  let count = 0;
  const each = () => {
    const { guidance, active, minimizedCue } = session.snapshot();
    if (!guidance || !active) return;
    const n = active.changes?.length ?? 0;
    if (guidance.targetsSince !== since) {
      if (since !== null && guidance.index === index && n === count) {
        const key = cueKey(active.id, guidance, active.plan?.stages[guidance.index]);
        seen.push({ at: guidance.targetsSince, stage: guidance.index, coach: session.snapshot().coach, key, reopened: minimizedCue === null });
        session.minimizeCue(key);
      }
      since = guidance.targetsSince;
    }
    index = guidance.index;
    count = n;
  };
  return { seen, each };
}

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

it('encerra o guia uma vez, guarda o treino e não consulta a IA sem leituras', async () => {
  const { session, walk } = setup();
  session.start(makePlan('Base aeróbica', { warmup: 1, reps: 1, work: 3, recovery: 0, cooldown: 1 }, 4, 1));
  await walk(302, 5);
  expect(session.snapshot().active).toBeNull();
  expect(session.snapshot().history).toHaveLength(1);
  expect(session.snapshot().history[0]).toMatchObject({
    reason: 'Duração concluída',
    totals: { movingMs: 300000 },
  });
  expect(saveWorkout).toHaveBeenCalledWith(
    expect.objectContaining({ estimate: null, reason: 'Duração concluída' }),
  );
  // 5 min a 5 km/h no plano custam 3,38 METs: 16,9 MET·min × 0,0175 × 75 kg.
  expect(coach(session)).toBe('Treino encerrado · cerca de 22 kcal');
  await flush();
  expect(assess).not.toHaveBeenCalled();
  expect(reviewLoad).not.toHaveBeenCalled();
  expect(session.snapshot().history[0].estimate?.level).toBe('Dados insuficientes');
});

it('registra o treino livre por etapa, preserva a sessão se a IA falhar e guarda a FC máxima ao reavaliar', async () => {
  const { session, walk, snapshot, notify } = setup();
  jest
    .mocked(assess)
    .mockRejectedValueOnce(new Error('sem rede'))
    .mockResolvedValue({ level: 'Em adaptação', summary: 'Primeira sessão.', maxBpm: 183 });
  await walk(200, 4, 105);
  snapshot.phase = 'idle';
  notify();
  await flush();
  const saved = session.snapshot().history[0];
  expect(saved).toMatchObject({ reason: 'Esteira desconectada', estimate: null, restBpm: 105 });
  expect(saved.log).toHaveLength(1);
  expect(saved.log![0]).toMatchObject({ ms: 199000, bpmCount: 200, top: 105 });
  // Os batimentos ficam também minuto a minuto, para a linha do tempo do painel.
  expect(saved.beats).toEqual([[6300, 60], [6300, 60], [6300, 60], [2100, 20]]);
  // E a carga medida: km/h × ms, % × ms e os ms de cada minuto em movimento.
  expect(saved.loads).toEqual([[236000, 0, 59000], [240000, 0, 60000], [240000, 0, 60000], [80000, 0, 20000]]);
  expect(session.snapshot().error).toBe('sem rede');
  // O treino livre não tem carga a rever: a IA não é consultada durante ele.
  expect(reviewLoad).not.toHaveBeenCalled();
  await session.evaluate(saved);
  expect(assess).toHaveBeenCalledTimes(2);
  expect(session.snapshot().history[0].estimate).toMatchObject({ level: 'Em adaptação', maxBpm: 183 });
});

it('lê a FC de repouso nas primeiras leituras do treino', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  expect(session.snapshot().guidance?.bpmRequestedAt).not.toBeNull();
  await walk(3, 1);
  await walk(6, 1, 90);
  expect(session.snapshot().active?.restBpm).toBeNull();
  await walk(1, 1, 90);
  const active = session.snapshot().active!;
  expect(active.restBpm).toBe(90);
  expect(active.hr).toEqual({ rest: 75, max: 184, maxSource: 'idade' });
  // O repouso entra no perfil do dia, mas a faixa continua nos percentuais da FC máxima.
  expect(dailyTarget(active.plan, active.profile, active.hr)).toMatchObject({ low: 101, high: 120 });
  // O aviso de batimentos fecha depois das 6 leituras.
  expect(session.snapshot().guidance?.bpmReceived).toBe(true);
});

it('com a cinta no peito o treino corre sem pedido de batimentos, mede o repouso e ajusta a carga', async () => {
  const { session, strap } = setup();
  // Aquecimento de 120 s a 4 km/h e um bloco de esforço de 6 min a 5 km/h e 1%.
  session.start(continuous());
  let asked = 0;
  const count = () => {
    if (pendingAction(session.snapshot().guidance) === 'bpm') asked++;
  };
  await strap(120, 4, 80, 0, count);
  // A FC de repouso sai das primeiras leituras, sem ninguém segurar o sensor.
  expect(session.snapshot().active?.restBpm).toBe(80);
  // Sem a IA, a revisão de 30 em 30 s segue com a conta do app e avisa no painel.
  expect(coach(session)).toBe('Sem IA · Etapa leve · 80 BPM');
  // No bloco de esforço, 10 bpm abaixo do teto. As revisões ainda pegam menos de 90 s na carga.
  await strap(70, 5, 110, 1, count);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · menos de 90 s nesta carga');
  expect(changes(session)).toEqual([]);
  // Na revisão seguinte a carga sobe. Com repouso de 65, são 16 bpm por MET: os 6 bpm que cabem
  // (3 ficam reservados, a carga é nova) valem 0,37 MET.
  await strap(60, 5, 110, 1, count);
  expect(asked).toBe(0);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(changes(session)).toEqual([
    expect.objectContaining({ stage: 1, decision: 'aumentar inclinação', bpm: 110, from: [5, 1], to: [5.2, 1.5], by: 'app' }),
  ]);
  // As leituras da cinta ficam contadas à parte no registro.
  const totals = session.snapshot().active!.totals;
  expect(totals.bpmCount).toBe(250);
  expect(totals.strapCount).toBe(250);
});

it('com a cinta, a trava alivia o bloco de esforço nos primeiros segundos acima do teto', async () => {
  const { session, strap } = setup();
  session.start(continuous());
  await strap(120, 4, 80);
  // 119 BPM, a 1 do teto de 120: no alvo.
  await strap(100, 5, 119, 1);
  expect(coach(session)).toBe('Sem IA · No alvo · 119 BPM');
  // Dois segundos em 123 ainda não tiram a mediana dos últimos 5 s do teto.
  await strap(2, 5, 123, 1);
  expect(changes(session)).toEqual([]);
  // No terceiro, sim: a trava age sem esperar a mediana do minuto, a IA nem o minuto entre ajustes.
  // 6 bpm até 3 abaixo do teto e mais os 4 que o BPM subiu em 30 s: 10 bpm, a 20,6 bpm por MET.
  await strap(1, 5, 123, 1);
  expect(coach(session)).toBe('Acima do teto · 123 BPM · carga reduzida');
  expect(changes(session)).toEqual([
    expect.objectContaining({ stage: 1, decision: 'reduzir velocidade', bpm: 123, from: [5, 1], by: 'trava' }),
  ]);
  const [eased] = changes(session)!;
  const cut = metabolicCost(5, 1) - metabolicCost(...eased.to!);
  expect(cut).toBeGreaterThanOrEqual(10 / 20.6 - 0.03);
  expect(cut).toBeLessThan(10 / 20.6 + 0.1);
});

it('nas etapas leves a trava não age, e segundos acima do teto não mudam a mediana do minuto', async () => {
  const { session, strap } = setup();
  // Aquecimento de 300 s: a FC passa do teto da faixa sem que o aquecimento seja um bloco de esforço.
  session.start(short(5, 1, 6, 0));
  await strap(60, 4, 119);
  // 9 segundos em 123 e de volta a 119: a trava não age no aquecimento, e a mediana não sai da faixa.
  await strap(9, 4, 123);
  await strap(60, 4, 119);
  expect(changes(session)).toEqual([]);
  expect(coach(session)).toBe('Sem IA · Na faixa · 119 BPM');
  // 123 de verdade, por mais de meio minuto: aí a regra local alivia, como em qualquer etapa.
  await strap(70, 4, 123);
  expect(coach(session)).toBe('Acima da faixa · 123 BPM · carga reduzida');
  expect(changes(session)).toEqual([expect.objectContaining({ stage: 0, bpm: 123, by: 'app' })]);
});

it('depois de um alívio a trava espera 30 s, e até 3 minutos só age com 3 bpm de excesso e o BPM sem cair', async () => {
  const { session, strap } = setup();
  session.start(continuous());
  await strap(120, 4, 80);
  await strap(60, 5, 118, 1);
  await strap(3, 5, 123, 1);
  expect(changes(session)).toHaveLength(1);
  const [{ to }] = changes(session)!;
  const [speed, incline] = to!;
  // Nos 30 s seguintes nada dispara, nem 7 bpm acima do teto.
  await strap(20, speed, 127, incline);
  expect(changes(session)).toHaveLength(1);
  // Passados os 30 s, 1 bpm acima do teto é o alívio ainda fazendo efeito.
  await strap(15, speed, 121, incline);
  expect(changes(session)).toHaveLength(1);
  // 4 bpm acima, mas caindo em relação a 30 s atrás (127): também espera.
  await strap(5, speed, 124, incline);
  expect(changes(session)).toHaveLength(1);
  // Quando o BPM de 30 s atrás já é o 121, os mesmos 124 são subida: a trava age de novo.
  await strap(15, speed, 124, incline);
  expect(changes(session)).toHaveLength(2);
  expect(changes(session)![1]).toMatchObject({ bpm: 124, by: 'trava', from: to });
  expect(coach(session)).toBe('Acima do teto · 124 BPM · carga reduzida');
});

it('depois de um aumento a trava age na hora, sem esperar o minuto entre ajustes', async () => {
  const { session, strap } = setup();
  session.start(continuous());
  await strap(120, 4, 80);
  await strap(130, 5, 110, 1);
  expect(changes(session)).toEqual([expect.objectContaining({ decision: 'aumentar inclinação', by: 'app' })]);
  // Dez segundos depois do aumento o BPM passa do teto: a trava não espera.
  await strap(7, 5.2, 110, 1.5);
  await strap(3, 5.2, 125, 1.5);
  expect(changes(session)).toHaveLength(2);
  expect(changes(session)![1]).toMatchObject({ bpm: 125, by: 'trava', from: [5.2, 1.5] });
});

it('com a carga já no mínimo a trava só avisa no painel', async () => {
  const { session, strap } = setup();
  // Um bloco de esforço a 1 km/h e plano: não há velocidade nem rampa para tirar.
  const plan = continuous();
  plan.stages[1] = { ...plan.stages[1], speed: 1, incline: 0 };
  session.start(plan);
  await strap(120, 4, 80);
  await strap(3, 1, 130, 0);
  expect(coach(session)).toBe('Acima do teto · 130 BPM · carga já no mínimo');
  expect(changes(session)).toEqual([]);
});

it('um alívio de etapa leve não segura a trava do bloco seguinte', async () => {
  const { session, strap } = setup();
  session.start(intervals());
  await strap(120, 4, 80);
  await strap(120, 5, 115, 1);
  // A recuperação, ainda acima do teto, é aliviada pela regra do app pouco antes do 2º tiro.
  await strap(58, 4, 126);
  expect(changes(session)).toEqual([expect.objectContaining({ stage: 2, by: 'app' })]);
  // No 2º tiro, 1 bpm acima do teto já basta: o alívio da recuperação não conta para ele.
  await strap(5, 5, 121, 1);
  expect(changes(session)![1]).toMatchObject({ stage: 3, bpm: 121, by: 'trava' });
});

it('a trava cancela a revisão da IA que ainda não voltou', async () => {
  const { session, strap } = setup();
  const pending = pendingReviews();
  session.start(continuous());
  await strap(120, 4, 80);
  // A revisão do aquecimento volta com "manter"; a do bloco fica esperando.
  pending[pending.length - 1]({ decision: 'manter', bpm: 0, reason: 'etapa leve' });
  await strap(41, 5, 110, 1);
  const asked = jest.mocked(reviewLoad).mock.calls.length;
  expect(coach(session)).toBe('IA analisando 110 BPM…');
  await strap(3, 5, 125, 1);
  expect(jest.mocked(reviewLoad).mock.calls[asked - 1][1]?.signal?.aborted).toBe(true);
  expect(coach(session)).toBe('Acima do teto · 125 BPM · carga reduzida');
  const corrected = session.snapshot().active?.plan?.stages[1];
  // A resposta pedida para a carga antiga chega depois e não muda nada.
  pending[asked - 1]({ decision: 'aumentar', bpm: 6, reason: '10 bpm abaixo do teto' });
  await flush();
  expect(session.snapshot().active?.plan?.stages[1]).toEqual(corrected);
  expect(coach(session)).toBe('Acima do teto · 125 BPM · carga reduzida');
  expect(changes(session)).toEqual([expect.objectContaining({ by: 'trava' })]);
});

it('a IA revê a carga a cada 30 s: aumenta, mantém e reduz com o motivo dela, dentro dos limites do app', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(121, 4);
  await walk(100, 5, null, 1);
  // Com 90 s nos alvos e 10 bpm abaixo do teto, a regra local subiria 6 bpm: é o limite da IA.
  jest
    .mocked(reviewLoad)
    .mockResolvedValueOnce({ decision: 'aumentar', bpm: 20, reason: '10 bpm abaixo do teto, BPM estável' });
  await walk(6, 5, 110, 1);
  expect(jest.mocked(reviewLoad).mock.calls[0][0]).toMatchObject({
    index: 1,
    allowed: ['manter', 'reduzir', 'aumentar'],
    maxRaiseBpm: 6,
    live: null,
    features: { median: 110 },
  });
  // Os 20 bpm pedidos ficam nos 6 que cabem: a mesma carga que a regra local daria.
  expect(coach(session)).toBe('IA · carga aumentada · 10 bpm abaixo do teto, BPM estável');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(changes(session)).toEqual([
    expect.objectContaining({ decision: 'aumentar inclinação', bpm: 110, from: [5, 1], to: [5.2, 1.5], by: 'ia' }),
  ]);
  // Um minuto depois do ajuste, a 4 do teto: a IA mantém.
  jest.mocked(reviewLoad).mockResolvedValueOnce({ decision: 'manter', bpm: 0, reason: 'BPM no alvo' });
  await walk(60, 5.2, null, 1.5);
  await walk(6, 5.2, 116, 1.5);
  expect(jest.mocked(reviewLoad).mock.calls[1][0]).toMatchObject({ allowed: ['manter', 'reduzir'], maxRaiseBpm: 0 });
  expect(coach(session)).toBe('IA · BPM no alvo');
  expect(changes(session)).toHaveLength(1);
  // Na pegada seguinte a IA antecipa o teto e reduz. Os 40 bpm pedidos ficam em 15, a 15 bpm por MET.
  jest.mocked(reviewLoad).mockResolvedValueOnce({ decision: 'reduzir', bpm: 40, reason: 'vai passar do teto' });
  await walk(20, 5.2, null, 1.5);
  await walk(6, 5.2, 118, 1.5);
  expect(coach(session)).toBe('IA · carga reduzida · vai passar do teto');
  expect(changes(session)).toHaveLength(2);
  const reduced = changes(session)![1];
  expect(reduced).toMatchObject({ decision: expect.stringMatching(/^reduzir/), bpm: 118, from: [5.2, 1.5], by: 'ia' });
  const cut = metabolicCost(5.2, 1.5) - metabolicCost(...reduced.to!);
  expect(cut).toBeGreaterThanOrEqual(1 - 0.03);
  expect(cut).toBeLessThan(1 + 0.1);
});

it('sem resposta da IA em 12 s, ou com erro, vale a decisão do app', async () => {
  const { session, walk } = setup();
  // A chamada estoura o tempo: a IA desiste depois de 12 s, sem nova tentativa.
  jest.mocked(reviewLoad).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Falha de conexão com a DeepSeek. Tente novamente.')), 12_000);
      }),
  );
  session.start(continuous());
  await walk(121, 4);
  await walk(100, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(coach(session)).toBe('IA analisando 110 BPM…');
  await walk(11, 5, null, 1);
  expect(changes(session)).toEqual([]);
  await walk(1, 5, null, 1);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · carga aumentada');
  expect(changes(session)).toEqual([expect.objectContaining({ decision: 'aumentar inclinação', by: 'app' })]);
  expect(reviewLoad).toHaveBeenCalledTimes(1);
});

it('uma revisão não começa com outra ainda sem resposta, e a de outra etapa é descartada', async () => {
  const { session, strap } = setup();
  const pending = pendingReviews();
  session.start(continuous());
  await strap(60, 4, 80);
  expect(reviewLoad).toHaveBeenCalledTimes(1);
  // 40 s depois a primeira ainda não voltou: nenhuma outra é pedida.
  await strap(40, 4, 80);
  expect(reviewLoad).toHaveBeenCalledTimes(1);
  // Com a resposta, a revisão seguinte sai na amostra seguinte.
  pending[0]({ decision: 'manter', bpm: 0, reason: 'etapa leve' });
  await flush();
  expect(coach(session)).toBe('IA · etapa leve');
  await strap(1, 4, 80);
  expect(reviewLoad).toHaveBeenCalledTimes(2);
  // A etapa muda antes da resposta: a chamada é cancelada e a resposta, ignorada.
  await strap(20, 5, 110, 1);
  expect(session.snapshot().guidance?.index).toBe(1);
  expect(jest.mocked(reviewLoad).mock.calls[1][1]?.signal?.aborted).toBe(true);
  expect(coach(session)).toBe('');
  pending[1]({ decision: 'reduzir', bpm: 10, reason: 'acima do teto' });
  await flush();
  expect(changes(session)).toEqual([]);
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5, incline: 1 });
});

it('num tiro curto a carga não sobe no meio, nem pela regra local nem pela IA', async () => {
  const { session, strap } = setup();
  // Tiros de 4 min a 5 km/h e 1%, com 1 min leve entre eles.
  session.start(short(2, 2, 4, 1));
  await strap(120, 4, 80);
  // Abaixo do piso, nos alvos há mais de 90 s: num bloco longo a carga subiria.
  await strap(150, 5, 95, 1);
  expect(coach(session)).toBe('Sem IA · 25 bpm abaixo do teto · 95 BPM · tiro curto: a carga não sobe no meio');
  expect(changes(session)).toEqual([]);
  // A IA também não pode aumentar: a lista do que ela pode decidir não traz o aumento.
  const calls = jest.mocked(reviewLoad).mock.calls;
  expect(calls[calls.length - 1][0]).toMatchObject({
    load: { short: true, secondsAtLoad: expect.any(Number) },
    allowed: ['manter', 'reduzir'],
    maxRaiseBpm: 0,
  });
  expect(calls[calls.length - 1][0].load.secondsAtLoad).toBeGreaterThanOrEqual(90);
});

it('só uma redução passa aos blocos seguintes, aos que custam mais que a carga nova; um aumento fica no bloco', async () => {
  const { session, walk, hold } = setup();
  const plan = short(2, 3, 6, 1);
  // Três blocos de 6 min: os dois primeiros a 5 km/h e 1% e o terceiro mais leve.
  plan.stages[5] = { ...plan.stages[5], speed: 4.5, incline: 0 };
  session.start(plan);
  await walk(121, 4);
  await walk(100, 5, null, 1);
  await walk(6, 5, 110, 1);
  // O aumento do primeiro bloco não passa aos outros, nem ao bloco igual a ele.
  expect(changes(session)).toEqual([expect.objectContaining({ stage: 1, decision: 'aumentar inclinação', by: 'app' })]);
  expect(loads(session.snapshot().active?.plan)).toEqual([[4, 0], [5.2, 1.5], [4, 0], [5, 1], [4, 0], [4.5, 0], [4, 0], [4, 0]]);
  // Um minuto depois o BPM passa do teto: a redução vale para o segundo bloco, que custa mais
  // que a carga nova, e não para o terceiro, que custa menos.
  await walk(54, 5.2, null, 1.5);
  await hold(5.2, [125, 125, 125, 125, 125, 125], 1.5);
  const [, eased] = changes(session)!;
  expect(eased).toMatchObject({ stage: 1, decision: expect.stringMatching(/^reduzir/), by: 'app' });
  const [speed, incline] = eased.to!;
  expect(metabolicCost(speed, incline)).toBeGreaterThan(metabolicCost(4.5, 0));
  expect(metabolicCost(speed, incline)).toBeLessThan(metabolicCost(5, 1));
  expect(loads(session.snapshot().active?.plan)).toEqual([[4, 0], [speed, incline], [4, 0], [speed, incline], [4, 0], [4.5, 0], [4, 0], [4, 0]]);
});

it('o aumento de uma corrida com rampa antiga acima de 2% baixa a rampa, mas continua sendo aumento', async () => {
  const { session, strap } = setup();
  const plan = short(2, 2, 6, 1);
  plan.stages = plan.stages.map((s) => (s.measure ? s : { ...s, speed: 8, incline: 3 }));
  session.start(plan);
  await strap(120, 4, 80);
  for (let i = 0; i < 200 && !changes(session)!.length; i++) await strap(1, 8, 110, 3);
  // A rampa volta a 2% e a velocidade compensa: o registro diz "reduzir inclinação", mas a carga subiu.
  const [raised] = changes(session)!;
  expect(raised).toMatchObject({ stage: 1, decision: 'reduzir inclinação', from: [8, 3], by: 'app' });
  expect(metabolicCost(...raised.to!)).toBeGreaterThan(metabolicCost(8, 3));
  expect(loads(session.snapshot().active?.plan)![3]).toEqual([8, 3]);
  // Como aumento, ele não segura a trava: na carga nova, o BPM acima do teto é aliviado na hora.
  await strap(3, raised.to![0], 125, raised.to![1]);
  expect(changes(session)).toHaveLength(2);
  expect(changes(session)![1]).toMatchObject({ bpm: 125, by: 'trava' });
});

it('no começo de um tiro a trava espera a lona chegar aos alvos por até 30 s', async () => {
  // Tiros de 2 min a 5 km/h e 1%, com 1 min a 4 km/h entre eles.
  const begin = async () => {
    const t = setup();
    t.session.start(intervals());
    await t.strap(120, 4, 80);
    await t.strap(120, 5, 115, 1);
    await t.strap(61, 4, 118);
    expect(t.session.snapshot().guidance?.index).toBe(3);
    return t;
  };
  // O 2º tiro começa com o BPM acima do teto e a lona ainda a 4 km/h, acelerando.
  const reaching = await begin();
  await reaching.strap(10, 4, 125);
  expect(changes(reaching.session)).toEqual([]);
  expect(loads(reaching.session.snapshot().active?.plan)![3]).toEqual([5, 1]);
  // Nos alvos do tiro, ela age, a partir da carga dele.
  await reaching.strap(1, 5, 125, 1);
  expect(changes(reaching.session)![0]).toMatchObject({ stage: 3, from: [5, 1], bpm: 125, by: 'trava' });
  expect(changes(reaching.session)![0].to![0]).toBeGreaterThan(4);
  // Quem não chega aos alvos em 30 s não fica sem trava: ela corta a partir da carga medida.
  const slow = await begin();
  await slow.strap(29, 4, 125);
  expect(changes(slow.session)).toEqual([]);
  await slow.strap(2, 4, 125);
  const [cut] = changes(slow.session)!;
  expect(cut).toMatchObject({ stage: 3, from: [5, 1], bpm: 125, by: 'trava' });
  expect(cut.to![0]).toBeLessThan(4);
  expect(coach(slow.session)).toBe('Acima do teto · 125 BPM · carga reduzida');
});

it('com um aumento ainda não feito no painel, a trava age na hora, a partir da carga medida', async () => {
  const { session, strap } = setup();
  session.start(long());
  await strap(120, 4, 80);
  for (let i = 0; i < 300 && !changes(session)!.length; i++) await strap(1, 5, 110, 1);
  expect(changes(session)).toEqual([
    expect.objectContaining({ decision: 'aumentar inclinação', from: [5, 1], to: [5.2, 1.5], by: 'app' }),
  ]);
  // A pessoa segue a 5 km/h e 1%, e o BPM passa do teto.
  await strap(2, 5, 110, 1);
  await strap(3, 5, 125, 1);
  const [, cut] = changes(session)!;
  expect(cut).toMatchObject({ from: [5.2, 1.5], bpm: 125, by: 'trava' });
  expect(cut.to![0]).toBeLessThanOrEqual(5);
  expect(cut.to![1]).toBeLessThanOrEqual(1);
});

it('uma redução antecipada da IA, com o BPM ainda no teto, não segura a trava', async () => {
  const { session, strap } = setup();
  jest.mocked(reviewLoad).mockImplementation(async (input) =>
    input.load.stage.measure
      ? { decision: 'manter', bpm: 0, reason: 'etapa leve' }
      : { decision: 'reduzir', bpm: 1, reason: 'a subida chega ao teto' },
  );
  session.start(continuous());
  await strap(120, 4, 80);
  for (let i = 0; i < 120 && !changes(session)!.length; i++) await strap(1, 5, 118, 1);
  const [early] = changes(session)!;
  expect(early).toMatchObject({ stage: 1, bpm: 118, from: [5, 1], by: 'ia' });
  const [speed, incline] = early.to!;
  // 8 s depois, já na carga nova, o BPM passa do teto: a trava age na hora.
  await strap(5, speed, 118, incline);
  await strap(3, speed, 125, incline);
  const [, cut] = changes(session)!;
  expect(cut).toMatchObject({ bpm: 125, by: 'trava', from: [speed, incline] });
  expect(cut.second - early.second).toBeLessThanOrEqual(8);
});

it('o tiro de 22/11: a trava alivia nos primeiros segundos acima do teto, uma vez, e depois reabre o aviso a cada 30 s', async () => {
  const { session, strap } = setup(vo2Profile);
  const plan = vo2(1);
  session.start(plan);
  await strap(120, 4, 100);
  expect(dailyTarget(plan, session.snapshot().active!.profile, session.snapshot().active!.hr)).toMatchObject({
    low: 161,
    high: 170,
  });
  const minute = (m: number) =>
    Math.round(Array.from({ length: 60 }, (_, i) => shot(m * 60 + i)).reduce((a, b) => a + b) / 60);
  expect([0, 1, 2, 3].map(minute)).toEqual([132, 158, 171, 177]);
  // A pessoa não mexe no painel: a esteira segue a 6,6 km/h e 1% o tiro inteiro.
  const alerts = realerts(session);
  await strap(240, 6.6, shot, 1, alerts.each);
  const [cut, ...more] = changes(session)!;
  expect(cut).toMatchObject({ stage: 1, decision: expect.stringMatching(/^reduzir/), from: [6.6, 1], by: 'trava' });
  // O bloco começou aos 120 s de treino: a trava agiu até 3 s depois da primeira leitura acima de 170,
  // e não aos 3:35 do bloco, como a mediana do minuto em 22/11.
  expect(cut.second - 120).toBeLessThanOrEqual(firstOver + 3);
  expect(cut.second - 120).toBeLessThan(215);
  expect(cut.bpm).toBeGreaterThan(170);
  // Nenhum corte por cima do que não chegou ao painel, nem da trava nem da regra do app.
  expect(more).toEqual([]);
  // O aviso reabre a cada 30 s, com outra chave (e bipes), mesmo depois de minimizado.
  const at = alerts.seen.map((a) => a.at);
  expect(at.length).toBeGreaterThanOrEqual(2);
  expect(at[0] - (T0 + cut.second * 1000)).toBeGreaterThanOrEqual(30_000);
  at.slice(1).forEach((t, i) => expect(t - at[i]).toBeGreaterThanOrEqual(30_000));
  expect(alerts.seen.every((a) => a.reopened && a.stage === 1)).toBe(true);
  expect(new Set(alerts.seen.map((a) => a.key)).size).toBe(alerts.seen.length);
  expect(alerts.seen[0].coach).toMatch(/^Acima do teto · \d+ BPM · reduza para 5,2 km\/h$/);
  // O plano termina com um corte só.
  expect(cut.to).toEqual([5.2, 7.5]);
  expect(loads(session.snapshot().active?.plan)).toEqual([[4, 0], [5.2, 7.5], [4, 0], [4, 0]]);
});

it('o tiro de 22/11 a 6,5 km/h num alvo de 6,6: abaixo do alvo a trava também age, a partir da carga medida', async () => {
  const { session, strap } = setup(vo2Profile);
  session.start(vo2(1));
  await strap(120, 4, 100);
  await strap(240, 6.5, shot, 1);
  const [cut] = changes(session)!;
  expect(cut).toMatchObject({ stage: 1, from: [6.6, 1], by: 'trava' });
  expect(cut.second - 120).toBeLessThanOrEqual(firstOver + 3);
  expect(cut.to![0]).toBeLessThanOrEqual(6.5);
});

it('quem ignora o corte recebe o aviso de novo em cada tiro, e os tiros seguintes ficam com um corte só', async () => {
  const { session, strap } = setup(vo2Profile);
  session.start(vo2(4));
  await strap(120, 4, 100);
  const alerts = realerts(session);
  // Os quatro tiros a 6,6 km/h e 1%, como no plano de partida, e as recuperações a 4 km/h.
  for (let rep = 0; rep < 4; rep++) {
    await strap(240, 6.6, shot, 1, alerts.each);
    await strap(180, 4, 140, 0, alerts.each);
  }
  const all = changes(session)!;
  expect(all).toEqual([expect.objectContaining({ stage: 1, by: 'trava' })]);
  const target = all[0].to!;
  expect(loads(session.snapshot().active?.plan)).toEqual([
    [4, 0], target, [4, 0], target, [4, 0], target, [4, 0], target, [4, 0], [4, 0],
  ]);
  expect([...new Set(alerts.seen.map((a) => a.stage))]).toEqual([1, 3, 5, 7]);
  // A espera pelo alívio do 1º tiro não vale para os outros, nem na revisão pela IA.
  const later = jest.mocked(reviewLoad).mock.calls.filter(([input]) => input.index > 2);
  expect(later.length).toBeGreaterThan(0);
  expect(later.every(([input]) => input.sinceRelief === null)).toBe(true);
});

it('sem resposta da IA, a regra do app não sobe a carga com o BPM do momento acima do teto', async () => {
  const { session, strap } = setup();
  // As revisões sem aumento possível falham na hora; a que poderia aumentar fica esperando.
  let fail: ((e: Error) => void) | null = null;
  jest.mocked(reviewLoad).mockImplementation((input) =>
    input.maxRaiseBpm > 0
      ? new Promise((_, reject) => {
          fail = reject;
        })
      : Promise.reject(new Error('sem rede')),
  );
  session.start(long());
  await strap(120, 4, 80);
  await strap(60, 5, 118, 1);
  await strap(3, 5, 123, 1);
  const [cut] = changes(session)!;
  expect(cut).toMatchObject({ by: 'trava' });
  const [speed, incline] = cut.to!;
  for (let i = 0; i < 200 && !fail; i++) await strap(1, speed, 105, incline);
  expect(fail).not.toBeNull();
  // 1 bpm acima do teto, nos 3 minutos depois do alívio: a trava espera, e a regra do app não sobe.
  await strap(3, speed, 121, incline);
  fail!(new Error('Falha de conexão com a DeepSeek. Tente novamente.'));
  await flush();
  expect(coach(session)).toBe('Sem IA · Acima do teto · carga mantida');
  expect(changes(session)).toHaveLength(1);
});

it('com o sensor de mão, um corte que não chegou ao painel também não leva outro por cima: o aviso reabre', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(121, 4);
  await walk(5, 5, null, 1);
  await walk(6, 5, 125, 1);
  expect(changes(session)).toEqual([expect.objectContaining({ from: [5, 1], to: [4.8, 0], by: 'app' })]);
  const minimized = cueKey(session.snapshot().active!.id, session.snapshot().guidance, session.snapshot().active!.plan!.stages[1]);
  session.minimizeCue(minimized);
  // A pessoa segue a 5 km/h e 1%, e a pegada de 1 min depois ainda dá 125.
  await walk(55, 5, null, 1);
  await walk(10, 5, 125, 1);
  expect(changes(session)).toHaveLength(1);
  expect(coach(session)).toBe('Acima da faixa · 125 BPM · reduza para 4,8 km/h e 0%');
  // O aviso de ajuste reabre, com outra chave: toca de novo.
  const { guidance, minimizedCue, active } = session.snapshot();
  expect(pendingAction(guidance)).toBe('adjust');
  expect(minimizedCue).toBeNull();
  expect(cueKey(active!.id, guidance, active!.plan!.stages[1])).not.toBe(minimized);
});

it('sem velocidade e inclinação recentes não há ajuste, mas o painel continua mostrando a leitura', async () => {
  const { session, walk, freezeIncline } = setup();
  session.start(continuous());
  await walk(121, 4);
  freezeIncline();
  await walk(100, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · ajuste a esteira aos alvos');
  expect(changes(session)).toEqual([]);
});

it('acima da faixa corrige na hora, leva aos blocos seguintes e espera 60 s antes de corrigir de novo', async () => {
  const { session, walk } = setup();
  // Aquecimento de 120 s, depois blocos de esforço de 120 s nas etapas 1 e 3.
  session.start(intervals());
  await walk(121, 4);
  expect(session.snapshot().guidance?.index).toBe(1);
  session.minimizeCue('1');
  await walk(5, 5, null, 1);
  // Com 5 leituras ainda não há as 4 que valem depois das 2 primeiras da pegada.
  await walk(5, 5, 125, 1);
  expect(changes(session)).toEqual([]);
  // Na primeira medida, com 11 s na carga e a FC ainda subindo do aquecimento, o app já alivia, sem a IA.
  await walk(1, 5, 125, 1);
  const { active, guidance, minimizedCue } = session.snapshot();
  expect(coach(session)).toBe('Acima da faixa · 125 BPM · carga reduzida');
  expect(reviewLoad).not.toHaveBeenCalled();
  // 8 bpm acima de 117 a 15 bpm por MET: 0,53 METs a menos, que saem da rampa e da velocidade.
  expect(loads(active?.plan)).toEqual([[4, 0], [4.8, 0], [4, 0], [4.8, 0], [4, 0], [4, 0]]);
  expect(active?.changes).toEqual([
    { second: 131, stage: 1, decision: 'reduzir velocidade', bpm: 125, from: [5, 1], to: [4.8, 0], by: 'app' },
  ]);
  expect(active?.totals.movingMs).toBe(131000);
  expect(saveWorkout).toHaveBeenLastCalledWith(expect.objectContaining({ changes: active?.changes }));
  // O aviso de ajuste reabre, na frente do resto.
  expect(guidance?.adjusted).toBe(false);
  expect(pendingAction(guidance!)).toBe('adjust');
  expect(minimizedCue).toBeNull();
  // A FC ainda está respondendo ao ajuste: nada de nova correção no minuto seguinte.
  await walk(30, 4.8, null, 0);
  await walk(10, 4.8, 125, 0);
  expect(changes(session)).toHaveLength(1);
  // Passado o minuto, a pegada seguinte, ainda 5 bpm acima do teto, corrige de novo.
  await walk(15, 4.8, null, 0);
  await walk(10, 4.8, 125, 0);
  const all = changes(session);
  expect(all).toHaveLength(2);
  expect(all?.[1]).toMatchObject({ stage: 1, decision: 'reduzir velocidade', bpm: 125 });
  expect(all![1].second - all![0].second).toBeGreaterThanOrEqual(60);
  expect(session.snapshot().active?.plan?.stages[1].speed).toBeLessThan(4.8);
});

it('pede os batimentos a cada 3 minutos de treino, num relógio que atravessa a troca de etapa', async () => {
  const { session, walk } = setup();
  // Aquecimento de 300 s e um bloco de esforço de 1200 s a 5 km/h e 1%.
  session.start(short(5, 1, 20, 0));
  const guidance = () => session.snapshot().guidance!;
  // Sem segurar o sensor, o pedido da FC de repouso caduca aos 90 s e o guia volta a pedir aos 3:00.
  await walk(100, 4);
  expect(guidance().bpmRequestedAt).toBeNull();
  await walk(81, 4);
  expect(guidance()).toMatchObject({ index: 0, bpmSlot: 1, bpmReceived: false });
  const first = guidance().bpmRequestedAt!;
  expect(first).toBe(T0 + 181000);
  // O pedido sem resposta continua o mesmo na etapa nova, mas o ajuste da esteira vem antes dele.
  await walk(120, 4);
  expect(guidance()).toMatchObject({ index: 1, bpmSlot: 1, bpmRequestedAt: first, bpmReceived: false });
  expect(pendingAction(guidance())).toBe('adjust');
  await walk(1, 5, null, 1);
  expect(pendingAction(guidance())).toBe('bpm');
  // Aos 6:00 do treino o pedido é trocado por um novo, 60 s depois de a etapa começar.
  await walk(58, 5, null, 1);
  expect(guidance().bpmRequestedAt).toBe(first);
  await walk(1, 5, null, 1);
  expect(guidance()).toMatchObject({ index: 1, bpmSlot: 2, bpmCount: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).toBe(first + 180000);
  await walk(6, 5, 110, 1);
  expect(guidance()).toMatchObject({ bpmRequestedAt: first + 180000, bpmReceived: true });
  expect(pendingAction(guidance())).toBeNull();
  // Atendido, ele fica fechado até os 9:00, e aí abre outro do zero.
  await walk(173, 5, null, 1);
  expect(guidance()).toMatchObject({ bpmSlot: 2, bpmRequestedAt: first + 180000, bpmReceived: true });
  await walk(1, 5, null, 1);
  expect(guidance()).toMatchObject({ bpmSlot: 3, bpmCount: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).toBe(first + 360000);
  expect(pendingAction(guidance())).toBe('bpm');
});

it('dentro da faixa e longe do teto o app sobe a carga; junto do teto mantém', async () => {
  const { session, walk } = setup();
  // Aquecimento de 120 s e um bloco de esforço de 6 min a 5 km/h e 1%, com a faixa de 101 a 120 BPM.
  session.start(continuous());
  await walk(121, 4);
  // Com os alvos atingidos há menos de 90 s o BPM ainda é o da carga anterior.
  await walk(60, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · menos de 90 s nesta carga');
  expect(changes(session)).toEqual([]);
  // Com 2 minutos na carga, 3 dos 10 bpm ficam reservados e 1 é a folga até o teto: os 6 que
  // sobram, a 15 bpm por MET, valem 0,4 MET. Cabem 0,2 km/h e meio ponto de rampa.
  await walk(60, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(changes(session)).toEqual([
    { second: 252, stage: 1, decision: 'aumentar inclinação', bpm: 110, from: [5, 1], to: [5.2, 1.5], by: 'app' },
  ]);
  expect(pendingAction(session.snapshot().guidance)).toBe('adjust');
  // Na carga nova, a 2 bpm do teto: o alvo foi atingido e nada muda.
  await walk(125, 5.2, null, 1.5);
  await walk(6, 5.2, 118, 1.5);
  expect(coach(session)).toBe('Sem IA · No alvo · 118 BPM');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(changes(session)).toHaveLength(1);
});

it('o ajuste fino sobe pela velocidade até 5,2 km/h e não dá o degrau que passaria do teto', async () => {
  const { session, walk } = setup();
  session.start(long());
  await walk(121, 4);
  // 116 BPM com a carga estabilizada (4 min): cabem 3 bpm, 0,2 MET. São 0,2 km/h.
  await walk(245, 5, null, 1);
  await walk(6, 5, 116, 1);
  expect(coach(session)).toBe('Sem IA · 4 bpm abaixo do teto · 116 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1 });
  expect(changes(session)).toEqual([
    expect.objectContaining({ decision: 'aumentar velocidade', from: [5, 1], to: [5.2, 1] }),
  ]);
  // Na velocidade máxima da caminhada só resta a rampa, e meio ponto (0,22 MET) passaria dos 3 bpm que cabem.
  await walk(245, 5.2, null, 1);
  await walk(6, 5.2, 116, 1);
  expect(coach(session)).toBe('Sem IA · 4 bpm abaixo do teto · 116 BPM · o próximo degrau passaria do teto');
  expect(changes(session)).toHaveLength(1);
  // Com 7 bpm de folga o meio ponto cabe.
  await walk(60, 5.2, null, 1);
  await walk(6, 5.2, 113, 1);
  expect(coach(session)).toBe('Sem IA · 7 bpm abaixo do teto · 113 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  // Carga nova há 2 minutos, a 5 bpm do teto: a FC ainda sobe sozinha, e o app espera.
  await walk(125, 5.2, null, 1.5);
  await walk(6, 5.2, 115, 1.5);
  expect(coach(session)).toBe('Sem IA · 5 bpm abaixo do teto · 115 BPM · BPM ainda se ajustando à carga');
  expect(changes(session)).toHaveLength(2);
});

it('nos 2 últimos minutos do último bloco a carga não sobe mais', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(121, 4);
  // O bloco de 6 min vai de 2:00 a 8:00: aos 6:10 faltam menos de 2 minutos.
  await walk(245, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(coach(session)).toBe('Sem IA · 10 bpm abaixo do teto · 110 BPM · fim do bloco');
  expect(changes(session)).toEqual([]);
});

it('não mexe na carga onde não há o que ajustar: etapa leve abaixo da faixa e BPM na faixa', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(3, 4);
  await walk(8, 4, 90);
  expect(coach(session)).toBe('Sem IA · Etapa leve · 90 BPM');
  await walk(25, 4);
  await walk(8, 4, 112);
  expect(coach(session)).toBe('Sem IA · Na faixa · 112 BPM');
  // No bloco de esforço, exatamente no teto da faixa (120 BPM) não há o que decidir.
  await walk(80, 4);
  await walk(100, 5, null, 1);
  await walk(8, 5, 120, 1);
  expect(session.snapshot().guidance?.index).toBe(1);
  expect(coach(session)).toBe('Sem IA · No teto da faixa · 120 BPM');
  expect(changes(session)).toEqual([]);
});

it('em dia de recuperação a faixa é teto: abaixo dela a carga não sobe', async () => {
  const { session, walk } = setup();
  // Faixa de 50–60% da FC máxima: 92 a 110 BPM aos 36 anos.
  session.start({ ...continuous(), objective: 'Recuperação', zone: [50, 60] });
  await walk(121, 4);
  await walk(120, 5, null, 1);
  await walk(8, 5, 85, 1);
  expect(coach(session)).toBe('Sem IA · Abaixo do teto · 85 BPM');
  await walk(30, 5, null, 1);
  await walk(8, 5, 100, 1);
  expect(coach(session)).toBe('Sem IA · Na faixa · 100 BPM');
  expect(changes(session)).toEqual([]);
  // Nem a IA pode aumentar.
  for (const [input] of jest.mocked(reviewLoad).mock.calls) expect(input.allowed).toEqual(['manter', 'reduzir']);
});

it('depois de um alívio, 1 bpm acima do teto espera 3 minutos antes de aliviar de novo', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(121, 4);
  await walk(5, 5, null, 1);
  await walk(6, 5, 125, 1);
  expect(changes(session)).toHaveLength(1);
  // Um minuto depois a FC ainda está descendo: 121, a 1 do teto, não pede outro corte.
  await walk(60, 4.8, null, 0);
  await walk(6, 4.8, 121, 0);
  expect(coach(session)).toBe('Sem IA · Acima da faixa · 121 BPM · aguardando o efeito da redução');
  expect(changes(session)).toHaveLength(1);
  // Três minutos depois do alívio, se continua acima, a carga desce de novo.
  await walk(115, 4.8, null, 0);
  await walk(6, 4.8, 121, 0);
  expect(coach(session)).toBe('Acima da faixa · 121 BPM · carga reduzida');
  expect(changes(session)).toHaveLength(2);
});

it('acima da faixa também corrige em etapa leve, com poucos segundos de pegada', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  // Aos 3 s do aquecimento, a 4 km/h: a sexta leitura já basta.
  await walk(3, 4);
  await walk(5, 4, 125);
  expect(changes(session)).toEqual([]);
  await walk(1, 4, 125);
  expect(coach(session)).toBe('Acima da faixa · 125 BPM · carga reduzida');
  // Etapa leve não leva o ajuste a outras etapas: o bloco e a volta à calma ficam como estavam.
  // 11 bpm até 3 abaixo do teto pediriam 2,8 km/h: a etapa leve para em 3.
  expect(loads(session.snapshot().active?.plan)).toEqual([[3, 0], [5, 1], [4, 0]]);
  expect(changes(session)).toEqual([
    expect.objectContaining({ stage: 0, decision: 'reduzir velocidade', bpm: 125 }),
  ]);
});

it('quanto mais longe do teto, maior a redução, e nenhum alvo exige aumento no painel', async () => {
  const reduced = async (bpm: number, speed = 5, incline = 1) => {
    const { session, walk } = setup();
    session.start(continuous());
    await walk(121, 4);
    await walk(5, speed, null, incline);
    await walk(6, speed, bpm, incline);
    return session.snapshot().active!.plan!.stages[1];
  };
  // 8, 13 e 33 bpm acima de 117: 0,53, 0,87 e 2,2 METs a menos.
  const stages = [];
  for (const bpm of [125, 130, 150]) stages.push(await reduced(bpm));
  expect(stages).toEqual([
    expect.objectContaining({ speed: 4.8, incline: 0 }),
    expect.objectContaining({ speed: 4.1, incline: 0 }),
    expect.objectContaining({ speed: 1.3, incline: 0 }),
  ]);
  // A pessoa já anda abaixo dos alvos (4,5 km/h e 0,5% no lugar de 5 e 1%): a conta parte do
  // medido, 3,34 METs, e tira dali os mesmos 0,53 METs.
  const slower = await reduced(125, 4.5, 0.5);
  expect(slower.speed).toBeLessThanOrEqual(4.5);
  expect(slower.incline).toBeLessThanOrEqual(0.5);
  expect(slower).toMatchObject({ speed: 3.8, incline: 0 });
});

it('abaixo do piso sobe a carga num bloco de esforço com 90 s nos alvos', async () => {
  const { session, walk } = setup();
  session.start(continuous());
  await walk(121, 4);
  // Com menos de 90 s na carga o BPM ainda é o da carga anterior: nada muda.
  await walk(60, 5, null, 1);
  await walk(6, 5, 95, 1);
  expect(coach(session)).toBe('Sem IA · 25 bpm abaixo do teto · 95 BPM · menos de 90 s nesta carga');
  expect(changes(session)).toEqual([]);
  await walk(30, 5, null, 1);
  await walk(6, 5, 95, 1);
  // 16 bpm até o meio da faixa (111) a 15 bpm por MET dariam 1,07 METs: a correção para em 1.
  expect(coach(session)).toBe('Sem IA · Abaixo da faixa · 95 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.1, incline: 3 });
  expect(changes(session)).toEqual([
    expect.objectContaining({ stage: 1, decision: 'aumentar inclinação', bpm: 95 }),
  ]);
  expect(pendingAction(session.snapshot().guidance)).toBe('adjust');
  // A IA podia subir até o meio da faixa: os 16 bpm da regra local.
  const calls = jest.mocked(reviewLoad).mock.calls;
  expect(calls[calls.length - 1][0]).toMatchObject({ allowed: ['manter', 'reduzir', 'aumentar'], maxRaiseBpm: 16 });
});

it('abaixo do piso não sobe a carga fora dos alvos nem com a FC ainda subindo', async () => {
  // A esteira fora dos alvos do bloco (4,5 km/h no lugar de 5).
  const off = setup();
  off.session.start(continuous());
  await off.walk(121, 4);
  await off.walk(100, 4.5, null, 1);
  await off.walk(6, 4.5, 95, 1);
  expect(coach(off.session)).toBe('Sem IA · 25 bpm abaixo do teto · 95 BPM · ajuste a esteira aos alvos');
  expect(changes(off.session)).toEqual([]);
  // Nos alvos há tempo, mas a FC ainda subindo: subir a carga agora a levaria acima do teto.
  const rising = setup();
  rising.session.start(continuous());
  await rising.walk(121, 4);
  await rising.walk(100, 5, null, 1);
  await rising.hold(5, [80, 80, 84, 85, 86, 88, 89, 90], 1);
  expect(coach(rising.session)).toMatch(/ bpm abaixo do teto · \d+ BPM · BPM ainda subindo$/);
  expect(rising.session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5, incline: 1 });
  expect(changes(rising.session)).toEqual([]);
});

it('mostra que a carga já está no limite quando não há o que corrigir', async () => {
  // Lona a 0,5 km/h: não há velocidade para tirar.
  const slow = setup();
  slow.session.start(continuous());
  await slow.walk(3, 0.5);
  await slow.walk(6, 0.5, 130);
  expect(coach(slow.session)).toBe('Acima da faixa · 130 BPM · carga já no mínimo');
  expect(changes(slow.session)).toEqual([]);
  // Caminhada a 5,2 km/h e 15%: não há rampa nem velocidade de caminhada para pôr.
  const steep = setup();
  steep.session.start({ ...continuous(), stages: continuous().stages.map((s) => (s.measure ? s : { ...s, speed: 5.2, incline: 15 })) });
  await steep.walk(121, 4);
  await steep.walk(100, 5.2, null, 15);
  await steep.walk(6, 5.2, 95, 15);
  expect(coach(steep.session)).toBe('Sem IA · Abaixo da faixa · 95 BPM · carga já no máximo');
  expect(changes(steep.session)).toEqual([]);
});

it('descarta a decisão da IA que chega depois de encerrar e começar outra sessão', async () => {
  const { session, walk } = setup();
  const pending = pendingReviews();
  const plan = continuous();
  session.start(plan);
  await walk(121, 4);
  await walk(100, 5, null, 1);
  await walk(6, 5, 110, 1);
  expect(reviewLoad).toHaveBeenCalledTimes(1);
  session.finish('Encerrado no app');
  expect(jest.mocked(reviewLoad).mock.calls[0][1]?.signal?.aborted).toBe(true);
  session.start(plan);
  pending[0]({ decision: 'aumentar', bpm: 6, reason: '' });
  await flush();
  expect(session.snapshot().active?.plan).toEqual(plan);
  expect(coach(session)).toBe('');
});

it('descarta as demonstrações ao abrir e apaga um registro do histórico a pedido', async () => {
  const { session, walk, snapshot, notify } = setup();
  // As sessões da esteira simulada não ficam guardadas de uma abertura para a outra.
  expect(clearSource).toHaveBeenCalledWith('demo');
  jest.mocked(assess).mockResolvedValue({ level: 'Em adaptação', summary: 'ok', maxBpm: 184 });
  await walk(200, 4, 105);
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
  await walk(200, 4, 105);
  snapshot.phase = 'idle';
  notify();
  expect(assess).toHaveBeenCalledTimes(1);
  snapshot.phase = 'connected';
  await walk(5, 4, 105);
  expect(session.snapshot().active).not.toBeNull();
  jest.mocked(saveWorkout).mockClear();
  session.reset();
  expect(clearData).toHaveBeenCalledTimes(1);
  expect(session.snapshot()).toMatchObject({ profile: null, active: null, history: [] });
  // A resposta da IA chega depois: nada volta para o banco.
  resolve({ level: 'Em adaptação', summary: 'ok', maxBpm: 180 });
  await flush();
  await walk(5, 4, 105);
  expect(saveWorkout).not.toHaveBeenCalled();
  expect(session.snapshot()).toMatchObject({ active: null, history: [] });
});
