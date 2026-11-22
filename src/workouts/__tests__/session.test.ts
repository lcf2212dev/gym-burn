import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';
import { WorkoutSession } from '../session';
import { pendingAction } from '../guidance';
import { makePlan, type Plan } from '../model';
import { dailyTarget } from '../physiology';
import { assess } from '../ai';
import {
  clearData,
  clearSource,
  deleteWorkout,
  readProfile,
  readWorkouts,
  saveWorkout,
} from '../storage';

jest.mock('../ai', () => ({ assess: jest.fn() }));
jest.mock('../storage', () => ({
  clearData: jest.fn(),
  clearSource: jest.fn(),
  deleteWorkout: jest.fn(),
  readProfile: jest.fn(),
  readWorkouts: jest.fn(),
  saveWorkout: jest.fn(),
}));

const T0 = 1_800_000_000_000;

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
  function packet(speedKmh: number, bpm: number | null = null, incline = 0, strap = false) {
    now += 1000;
    jest.setSystemTime(now);
    snapshot.samples = [
      ...snapshot.samples.slice(-299),
      {
        speedAt: now,
        inclineAt: now,
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
  }
  const walk = (seconds: number, speedKmh: number, bpm: number | null = null, incline = 0) => {
    for (let i = 0; i < seconds; i++) packet(speedKmh, bpm, incline);
  };
  /** Segundos de esteira com a leitura contínua da cinta em cada amostra. `each` roda depois de cada um. */
  const strap = (seconds: number, speedKmh: number, bpm: number, incline = 0, each = () => {}) => {
    for (let i = 0; i < seconds; i++) {
      packet(speedKmh, bpm, incline, true);
      each();
    }
  };
  /** Uma pegada no sensor com as leituras dadas, uma por segundo. */
  const hold = (speedKmh: number, values: number[], incline = 0) => {
    for (const bpm of values) packet(speedKmh, bpm, incline);
  };
  return { session, snapshot, notify: () => notify(), walk, hold, strap };
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
// Aquecimento de 120 s e um bloco de esforço de 20 min: dá tempo de a carga estabilizar.
const long = () => short(2, 1, 20, 0);
const loads = (plan: Plan | null | undefined) => plan?.stages.map((s) => [s.speed, s.incline]);

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
  // 5 min a 5 km/h no plano custam 3,38 METs: 16,9 MET·min × 0,0175 × 75 kg.
  expect(session.snapshot().coach).toBe('Treino encerrado · cerca de 22 kcal');
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
  // E a carga medida: km/h × ms, % × ms e os ms de cada minuto em movimento.
  expect(saved.loads).toEqual([[236000, 0, 59000], [240000, 0, 60000], [240000, 0, 60000], [80000, 0, 20000]]);
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

it('com a cinta no peito o treino corre sem pedido de batimentos, mede o repouso e ajusta a carga', () => {
  const { session, strap } = setup();
  // Aquecimento de 120 s a 4 km/h e um bloco de esforço de 6 min a 5 km/h e 1%.
  session.start(continuous());
  let asked = 0;
  const count = () => {
    if (pendingAction(session.snapshot().guidance) === 'bpm') asked++;
  };
  strap(120, 4, 80, 0, count);
  // A FC de repouso sai das primeiras leituras, sem ninguém segurar o sensor.
  expect(session.snapshot().active?.restBpm).toBe(80);
  expect(session.snapshot().coach).toBe('Etapa leve · 80 BPM');
  // No bloco de esforço, 10 bpm abaixo do teto. A primeira revisão ainda pega menos de 90 s na carga.
  strap(70, 5, 110, 1, count);
  expect(session.snapshot().coach).toBe('10 bpm abaixo do teto · 110 BPM · menos de 90 s nesta carga');
  expect(session.snapshot().active?.changes).toEqual([]);
  // Um minuto depois a carga sobe, sem consultar ninguém. Com repouso de 65, são 16 bpm por
  // MET: os 6 bpm que cabem (3 ficam reservados, a carga é nova) valem 0,37 MET.
  strap(60, 5, 110, 1, count);
  expect(asked).toBe(0);
  expect(session.snapshot().coach).toBe('10 bpm abaixo do teto · 110 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(session.snapshot().active?.changes).toEqual([
    expect.objectContaining({ stage: 1, decision: 'aumentar inclinação', bpm: 110, from: [5, 1], to: [5.2, 1.5] }),
  ]);
  // As leituras da cinta ficam contadas à parte no registro.
  const totals = session.snapshot().active!.totals;
  expect(totals.bpmCount).toBe(250);
  expect(totals.strapCount).toBe(250);
});

it('com a cinta, segundos acima do teto não aliviam a carga; um minuto acima, sim', () => {
  const { session, strap } = setup();
  session.start(continuous());
  strap(120, 4, 80);
  // 119 BPM, a 1 do teto de 120: no alvo.
  strap(100, 5, 119, 1);
  expect(session.snapshot().coach).toBe('No alvo · 119 BPM');
  // 9 segundos em 123 e de volta a 119: a mediana do minuto não sai da faixa.
  strap(9, 5, 123, 1);
  strap(60, 5, 119, 1);
  expect(session.snapshot().active?.changes).toEqual([]);
  expect(session.snapshot().coach).toBe('No alvo · 119 BPM');
  // 123 de verdade, por mais de meio minuto: aí a carga é aliviada.
  strap(70, 5, 123, 1);
  expect(session.snapshot().coach).toBe('Acima da faixa · 123 BPM · carga reduzida');
  // 6 bpm até 3 abaixo do teto, a 20,6 bpm por MET: 0,29 MET, que são 0,1 km/h e meio ponto de rampa.
  expect(session.snapshot().active?.changes).toEqual([
    expect.objectContaining({ stage: 1, decision: 'reduzir velocidade', bpm: 123, from: [5, 1], to: [4.9, 0.5] }),
  ]);
});

it('pede os batimentos a cada 3 minutos de treino, num relógio que atravessa a troca de etapa', () => {
  const { session, walk } = setup();
  // Aquecimento de 300 s e um bloco de esforço de 1200 s a 5 km/h e 1%.
  session.start(short(5, 1, 20, 0));
  const guidance = () => session.snapshot().guidance!;
  // Sem segurar o sensor, o pedido da FC de repouso caduca aos 90 s e o guia volta a pedir aos 3:00.
  walk(100, 4);
  expect(guidance().bpmRequestedAt).toBeNull();
  walk(81, 4);
  expect(guidance()).toMatchObject({ index: 0, bpmSlot: 1, bpmReceived: false });
  const first = guidance().bpmRequestedAt!;
  expect(first).toBe(T0 + 181000);
  // O pedido sem resposta continua o mesmo na etapa nova, mas o ajuste da esteira vem antes dele.
  walk(120, 4);
  expect(guidance()).toMatchObject({ index: 1, bpmSlot: 1, bpmRequestedAt: first, bpmReceived: false });
  expect(pendingAction(guidance())).toBe('adjust');
  walk(1, 5, null, 1);
  expect(pendingAction(guidance())).toBe('bpm');
  // Aos 6:00 do treino o pedido é trocado por um novo, 60 s depois de a etapa começar.
  walk(58, 5, null, 1);
  expect(guidance().bpmRequestedAt).toBe(first);
  walk(1, 5, null, 1);
  expect(guidance()).toMatchObject({ index: 1, bpmSlot: 2, bpmCount: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).toBe(first + 180000);
  walk(6, 5, 110, 1);
  expect(guidance()).toMatchObject({ bpmRequestedAt: first + 180000, bpmReceived: true });
  expect(pendingAction(guidance())).toBeNull();
  // Atendido, ele fica fechado até os 9:00, e aí abre outro do zero.
  walk(173, 5, null, 1);
  expect(guidance()).toMatchObject({ bpmSlot: 2, bpmRequestedAt: first + 180000, bpmReceived: true });
  walk(1, 5, null, 1);
  expect(guidance()).toMatchObject({ bpmSlot: 3, bpmCount: 0, bpmReceived: false });
  expect(guidance().bpmRequestedAt).toBe(first + 360000);
  expect(pendingAction(guidance())).toBe('bpm');
});

it('dentro da faixa e longe do teto o app sobe a carga; junto do teto mantém', () => {
  const { session, walk } = setup();
  // Aquecimento de 120 s e um bloco de esforço de 6 min a 5 km/h e 1%, com a faixa de 101 a 120 BPM.
  session.start(continuous());
  walk(121, 4);
  // Com os alvos atingidos há menos de 90 s o BPM ainda é o da carga anterior.
  walk(60, 5, null, 1);
  walk(6, 5, 110, 1);
  expect(session.snapshot().coach).toBe('10 bpm abaixo do teto · 110 BPM · menos de 90 s nesta carga');
  expect(session.snapshot().active?.changes).toEqual([]);
  // Com 2 minutos na carga, 3 dos 10 bpm ficam reservados e 1 é a folga até o teto: os 6 que
  // sobram, a 15 bpm por MET, valem 0,4 MET. Cabem 0,2 km/h e meio ponto de rampa.
  walk(60, 5, null, 1);
  walk(6, 5, 110, 1);
  expect(session.snapshot().coach).toBe('10 bpm abaixo do teto · 110 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(session.snapshot().active?.changes).toEqual([
    { second: 252, stage: 1, decision: 'aumentar inclinação', bpm: 110, from: [5, 1], to: [5.2, 1.5] },
  ]);
  expect(pendingAction(session.snapshot().guidance)).toBe('adjust');
  // Na carga nova, a 2 bpm do teto: o alvo foi atingido e nada muda.
  walk(125, 5.2, null, 1.5);
  walk(6, 5.2, 118, 1.5);
  expect(session.snapshot().coach).toBe('No alvo · 118 BPM');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  expect(session.snapshot().active?.changes).toHaveLength(1);
});

it('o ajuste fino sobe pela velocidade até 5,2 km/h e não dá o degrau que passaria do teto', () => {
  const { session, walk } = setup();
  session.start(long());
  walk(121, 4);
  // 116 BPM com a carga estabilizada (4 min): cabem 3 bpm, 0,2 MET. São 0,2 km/h.
  walk(245, 5, null, 1);
  walk(6, 5, 116, 1);
  expect(session.snapshot().coach).toBe('4 bpm abaixo do teto · 116 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1 });
  expect(session.snapshot().active?.changes).toEqual([
    expect.objectContaining({ decision: 'aumentar velocidade', from: [5, 1], to: [5.2, 1] }),
  ]);
  // Na velocidade máxima da caminhada só resta a rampa, e meio ponto (0,22 MET) passaria dos 3 bpm que cabem.
  walk(245, 5.2, null, 1);
  walk(6, 5.2, 116, 1);
  expect(session.snapshot().coach).toBe('4 bpm abaixo do teto · 116 BPM · o próximo degrau passaria do teto');
  expect(session.snapshot().active?.changes).toHaveLength(1);
  // Com 7 bpm de folga o meio ponto cabe.
  walk(60, 5.2, null, 1);
  walk(6, 5.2, 113, 1);
  expect(session.snapshot().coach).toBe('7 bpm abaixo do teto · 113 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.2, incline: 1.5 });
  // Carga nova há 2 minutos, a 5 bpm do teto: a FC ainda sobe sozinha, e o app espera.
  walk(125, 5.2, null, 1.5);
  walk(6, 5.2, 115, 1.5);
  expect(session.snapshot().coach).toBe('5 bpm abaixo do teto · 115 BPM · BPM ainda se ajustando à carga');
  expect(session.snapshot().active?.changes).toHaveLength(2);
});

it('nos 2 últimos minutos do último bloco a carga não sobe mais', () => {
  const { session, walk } = setup();
  session.start(continuous());
  walk(121, 4);
  // O bloco de 6 min vai de 2:00 a 8:00: aos 6:10 faltam menos de 2 minutos.
  walk(245, 5, null, 1);
  walk(6, 5, 110, 1);
  expect(session.snapshot().coach).toBe('10 bpm abaixo do teto · 110 BPM · fim do bloco');
  expect(session.snapshot().active?.changes).toEqual([]);
});

it('não mexe na carga onde não há o que ajustar: etapa leve abaixo da faixa e BPM na faixa', () => {
  const { session, walk } = setup();
  session.start(continuous());
  walk(3, 4);
  walk(8, 4, 90);
  expect(session.snapshot().coach).toBe('Etapa leve · 90 BPM');
  walk(25, 4);
  walk(8, 4, 112);
  expect(session.snapshot().coach).toBe('Na faixa · 112 BPM');
  // No bloco de esforço, exatamente no teto da faixa (120 BPM) não há o que decidir.
  walk(80, 4);
  walk(100, 5, null, 1);
  walk(8, 5, 120, 1);
  expect(session.snapshot().guidance?.index).toBe(1);
  expect(session.snapshot().coach).toBe('No teto da faixa · 120 BPM');
  expect(session.snapshot().active?.changes).toEqual([]);
});

it('em dia de recuperação a faixa é teto: abaixo dela a carga não sobe', () => {
  const { session, walk } = setup();
  // Faixa de 50–60% da FC máxima: 92 a 110 BPM aos 36 anos.
  session.start({ ...continuous(), objective: 'Recuperação', zone: [50, 60] });
  walk(121, 4);
  walk(120, 5, null, 1);
  walk(8, 5, 85, 1);
  expect(session.snapshot().coach).toBe('Abaixo do teto · 85 BPM');
  walk(30, 5, null, 1);
  walk(8, 5, 100, 1);
  expect(session.snapshot().coach).toBe('Na faixa · 100 BPM');
  expect(session.snapshot().active?.changes).toEqual([]);
});

it('acima da faixa corrige na hora, leva aos blocos iguais e espera 60 s antes de corrigir de novo', () => {
  const { session, walk } = setup();
  // Aquecimento de 120 s, depois blocos de esforço de 120 s nas etapas 1 e 3.
  session.start(intervals());
  walk(121, 4);
  expect(session.snapshot().guidance?.index).toBe(1);
  session.minimizeCue('1');
  walk(5, 5, null, 1);
  // Com 5 leituras ainda não há as 4 que valem depois das 2 primeiras da pegada.
  walk(5, 5, 125, 1);
  expect(session.snapshot().active?.changes).toEqual([]);
  // Na primeira medida, com 11 s na carga e a FC ainda subindo do aquecimento, o app já alivia.
  walk(1, 5, 125, 1);
  const { active, guidance, coach, minimizedCue } = session.snapshot();
  expect(coach).toBe('Acima da faixa · 125 BPM · carga reduzida');
  // 8 bpm acima de 117 a 15 bpm por MET: 0,53 METs a menos, que saem da rampa e da velocidade.
  expect(loads(active?.plan)).toEqual([[4, 0], [4.8, 0], [4, 0], [4.8, 0], [4, 0], [4, 0]]);
  expect(active?.changes).toEqual([
    { second: 131, stage: 1, decision: 'reduzir velocidade', bpm: 125, from: [5, 1], to: [4.8, 0] },
  ]);
  expect(active?.totals.movingMs).toBe(131000);
  expect(saveWorkout).toHaveBeenLastCalledWith(expect.objectContaining({ changes: active?.changes }));
  // O aviso de ajuste reabre, na frente do resto.
  expect(guidance?.adjusted).toBe(false);
  expect(pendingAction(guidance!)).toBe('adjust');
  expect(minimizedCue).toBeNull();
  // A FC ainda está respondendo ao ajuste: nada de nova correção no minuto seguinte.
  walk(30, 4.8, null, 0);
  walk(10, 4.8, 125, 0);
  expect(session.snapshot().active?.changes).toHaveLength(1);
  // Passado o minuto, a pegada seguinte, ainda 5 bpm acima do teto, corrige de novo.
  walk(15, 4.8, null, 0);
  walk(10, 4.8, 125, 0);
  const changes = session.snapshot().active?.changes;
  expect(changes).toHaveLength(2);
  expect(changes?.[1]).toMatchObject({ stage: 1, decision: 'reduzir velocidade', bpm: 125 });
  expect(changes![1].second - changes![0].second).toBeGreaterThanOrEqual(60);
  expect(session.snapshot().active?.plan?.stages[1].speed).toBeLessThan(4.8);
});

it('depois de um alívio, 1 bpm acima do teto espera 3 minutos antes de aliviar de novo', () => {
  const { session, walk } = setup();
  session.start(continuous());
  walk(121, 4);
  walk(5, 5, null, 1);
  walk(6, 5, 125, 1);
  expect(session.snapshot().active?.changes).toHaveLength(1);
  // Um minuto depois a FC ainda está descendo: 121, a 1 do teto, não pede outro corte.
  walk(60, 4.8, null, 0);
  walk(6, 4.8, 121, 0);
  expect(session.snapshot().coach).toBe('Acima da faixa · 121 BPM · aguardando o efeito da redução');
  expect(session.snapshot().active?.changes).toHaveLength(1);
  // Três minutos depois do alívio, se continua acima, a carga desce de novo.
  walk(115, 4.8, null, 0);
  walk(6, 4.8, 121, 0);
  expect(session.snapshot().coach).toBe('Acima da faixa · 121 BPM · carga reduzida');
  expect(session.snapshot().active?.changes).toHaveLength(2);
});

it('acima da faixa também corrige em etapa leve, com poucos segundos de pegada', () => {
  const { session, walk } = setup();
  session.start(continuous());
  // Aos 3 s do aquecimento, a 4 km/h: a sexta leitura já basta.
  walk(3, 4);
  walk(5, 4, 125);
  expect(session.snapshot().active?.changes).toEqual([]);
  walk(1, 4, 125);
  expect(session.snapshot().coach).toBe('Acima da faixa · 125 BPM · carga reduzida');
  // Etapa leve não leva o ajuste a outras etapas: o bloco e a volta à calma ficam como estavam.
  // 11 bpm até 3 abaixo do teto pediriam 2,8 km/h: a etapa leve para em 3.
  expect(loads(session.snapshot().active?.plan)).toEqual([[3, 0], [5, 1], [4, 0]]);
  expect(session.snapshot().active?.changes).toEqual([
    expect.objectContaining({ stage: 0, decision: 'reduzir velocidade', bpm: 125 }),
  ]);
});

it('quanto mais longe do teto, maior a redução, e nenhum alvo exige aumento no painel', () => {
  const reduced = (bpm: number, speed = 5, incline = 1) => {
    const { session, walk } = setup();
    session.start(continuous());
    walk(121, 4);
    walk(5, speed, null, incline);
    walk(6, speed, bpm, incline);
    return session.snapshot().active!.plan!.stages[1];
  };
  // 8, 13 e 33 bpm acima de 117: 0,53, 0,87 e 2,2 METs a menos.
  expect([125, 130, 150].map((bpm) => reduced(bpm))).toEqual([
    expect.objectContaining({ speed: 4.8, incline: 0 }),
    expect.objectContaining({ speed: 4.1, incline: 0 }),
    expect.objectContaining({ speed: 1.3, incline: 0 }),
  ]);
  // A pessoa já anda abaixo dos alvos (4,5 km/h e 0,5% no lugar de 5 e 1%): a conta parte do
  // medido, 3,34 METs, e tira dali os mesmos 0,53 METs.
  const slower = reduced(125, 4.5, 0.5);
  expect(slower.speed).toBeLessThanOrEqual(4.5);
  expect(slower.incline).toBeLessThanOrEqual(0.5);
  expect(slower).toMatchObject({ speed: 3.8, incline: 0 });
});

it('abaixo do piso sobe a carga num bloco de esforço com 90 s nos alvos', () => {
  const { session, walk } = setup();
  session.start(continuous());
  walk(121, 4);
  // Com menos de 90 s na carga o BPM ainda é o da carga anterior: nada muda.
  walk(60, 5, null, 1);
  walk(6, 5, 95, 1);
  expect(session.snapshot().coach).toBe('25 bpm abaixo do teto · 95 BPM · menos de 90 s nesta carga');
  expect(session.snapshot().active?.changes).toEqual([]);
  walk(30, 5, null, 1);
  walk(6, 5, 95, 1);
  // 16 bpm até o meio da faixa (111) a 15 bpm por MET dariam 1,07 METs: a correção para em 1.
  expect(session.snapshot().coach).toBe('Abaixo da faixa · 95 BPM · carga aumentada');
  expect(session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5.1, incline: 3 });
  expect(session.snapshot().active?.changes).toEqual([
    expect.objectContaining({ stage: 1, decision: 'aumentar inclinação', bpm: 95 }),
  ]);
  expect(pendingAction(session.snapshot().guidance)).toBe('adjust');
});

it('abaixo do piso não sobe a carga fora dos alvos nem com a FC ainda subindo', () => {
  // A esteira fora dos alvos do bloco (4,5 km/h no lugar de 5).
  const off = setup();
  off.session.start(continuous());
  off.walk(121, 4);
  off.walk(100, 4.5, null, 1);
  off.walk(6, 4.5, 95, 1);
  expect(off.session.snapshot().coach).toBe('25 bpm abaixo do teto · 95 BPM · ajuste a esteira aos alvos');
  expect(off.session.snapshot().active?.changes).toEqual([]);
  // Nos alvos há tempo, mas a FC ainda subindo: subir a carga agora a levaria acima do teto.
  const rising = setup();
  rising.session.start(continuous());
  rising.walk(121, 4);
  rising.walk(100, 5, null, 1);
  rising.hold(5, [80, 80, 84, 85, 86, 88, 89, 90], 1);
  expect(rising.session.snapshot().coach).toMatch(/ bpm abaixo do teto · \d+ BPM · BPM ainda subindo$/);
  expect(rising.session.snapshot().active?.plan?.stages[1]).toMatchObject({ speed: 5, incline: 1 });
  expect(rising.session.snapshot().active?.changes).toEqual([]);
});

it('mostra que a carga já está no limite quando não há o que corrigir', () => {
  // Lona a 0,5 km/h: não há velocidade para tirar.
  const slow = setup();
  slow.session.start(continuous());
  slow.walk(3, 0.5);
  slow.walk(6, 0.5, 130);
  expect(slow.session.snapshot().coach).toBe('Acima da faixa · 130 BPM · carga já no mínimo');
  expect(slow.session.snapshot().active?.changes).toEqual([]);
  // Caminhada a 5,2 km/h e 15%: não há rampa nem velocidade de caminhada para pôr.
  const steep = setup();
  steep.session.start({ ...continuous(), stages: continuous().stages.map((s) => (s.measure ? s : { ...s, speed: 5.2, incline: 15 })) });
  steep.walk(121, 4);
  steep.walk(100, 5.2, null, 15);
  steep.walk(6, 5.2, 95, 15);
  expect(steep.session.snapshot().coach).toBe('Abaixo da faixa · 95 BPM · carga já no máximo');
  expect(steep.session.snapshot().active?.changes).toEqual([]);
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
