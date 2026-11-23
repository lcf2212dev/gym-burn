import type { BackfillJob, StrapBeatEvent, StrapLink, StrapWishes } from '@/heart/strap-session';
import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';

import { assess } from '../ai';
import { makePlan, type Plan, type Profile, type Workout } from '../model';
import { dailyTarget } from '../physiology';
import { dayKey, type ReadinessRecord } from '../rest';
import { WorkoutSession } from '../session';
import { readProfile, readReadiness, readWorkouts, saveReadiness, saveTrackChunk, saveWorkout } from '../storage';
import { decodeTrack, TRACK_FLAGS, type TrackChunk } from '../track';

jest.mock('../ai', () => ({
  assess: jest.fn(async () => ({ level: 'Em adaptação', summary: 'ok', maxBpm: null })),
  reviewLoad: jest.fn(async () => {
    throw new Error('sem chave');
  }),
}));

/** Um banco em memória para as trilhas; o resto do armazenamento só é observado. */
const mockTracks = new Map<string, string>();
jest.mock('../storage', () => ({
  clearData: jest.fn(),
  clearSource: jest.fn(),
  deleteWorkout: jest.fn(),
  readProfile: jest.fn(),
  readWorkouts: jest.fn(),
  saveWorkout: jest.fn(),
  saveProfile: jest.fn(),
  // A prontidão do dia, medida parado.
  readReadiness: jest.fn(() => []),
  saveReadiness: jest.fn(),
  pruneTracks: jest.fn(),
  saveTrackChunk: jest.fn((workout: string, minute: number, chunk: unknown) =>
    mockTracks.set(`${workout}|${minute}`, JSON.stringify(chunk)),
  ),
  readTrackChunks: jest.fn((workout: string) =>
    [...mockTracks.entries()]
      .filter(([key]) => key.startsWith(workout + '|'))
      .map(([key, data]) => ({ minute: Number(key.split('|')[1]), chunk: JSON.parse(data) })),
  ),
}));

const T0 = 1_800_000_000_000;
const PROFILE: Profile = { age: 36, weightKg: 75.4, heightCm: 175 };

class FakeStrap implements StrapLink {
  wishes: StrapWishes[] = [];
  private readonly backfill = new Set<(job: BackfillJob) => void>();
  private readonly recorded = new Set<(event: { workoutId: string; recordedAt: number }) => void>();
  private readonly beats = new Set<(beat: StrapBeatEvent) => void>();
  want = (wishes: StrapWishes) => void this.wishes.push(wishes);
  onBeat = (listener: (beat: StrapBeatEvent) => void) => {
    this.beats.add(listener);
    return () => void this.beats.delete(listener);
  };
  emitBeat(beat: StrapBeatEvent) {
    this.beats.forEach((listener) => listener(beat));
  }
  onBackfill = (listener: (job: BackfillJob) => void) => {
    this.backfill.add(listener);
    return () => void this.backfill.delete(listener);
  };
  onRecorded = (listener: (event: { workoutId: string; recordedAt: number }) => void) => {
    this.recorded.add(listener);
    return () => void this.recorded.delete(listener);
  };
  get last() {
    return this.wishes.at(-1)!;
  }
  get listening() {
    return this.backfill.size + this.recorded.size + this.beats.size;
  }
  emitBackfill(job: BackfillJob) {
    this.backfill.forEach((listener) => listener(job));
  }
  emitRecorded(workoutId: string, recordedAt: number) {
    this.recorded.forEach((listener) => listener({ workoutId, recordedAt }));
  }
}

function setup(history: Workout[] = [], readiness: ReadinessRecord[] = []) {
  jest.useFakeTimers({ now: T0 });
  mockTracks.clear();
  jest.mocked(readProfile).mockReturnValue(PROFILE);
  jest.mocked(readWorkouts).mockReturnValue(history);
  jest.mocked(readReadiness).mockReturnValue(readiness);
  jest.mocked(saveWorkout).mockClear();
  jest.mocked(saveTrackChunk).mockClear();
  jest.mocked(saveReadiness).mockClear();
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
  const strap = new FakeStrap();
  const session = new WorkoutSession(store, strap);
  const dispose = session.connect();
  let now = T0;
  async function packet(speedKmh: number, bpm: number | null, extra: Partial<TreadmillSample> = {}) {
    now += 1000;
    jest.advanceTimersByTime(1000);
    snapshot.samples = [
      ...snapshot.samples.slice(-299),
      {
        speedAt: now,
        inclineAt: now,
        at: now,
        speedKmh,
        inclinationPercent: 1,
        heartRateBpm: bpm,
        heartRateSource: 'strap',
        energyKcal: null,
        distanceM: null,
        ...extra,
      },
    ];
    notify();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  /**
   * Segundos de cinta sem pacote da esteira: uma notificação por segundo, com o
   * BPM dado e os RR de `rr` (por padrão, um RR por segundo a 60 bpm).
   */
  function beats(seconds: number, bpm: number | ((second: number) => number), rr: (second: number) => number[] = () => [1000]) {
    for (let i = 0; i < seconds; i++) {
      now += 1000;
      jest.advanceTimersByTime(1000);
      strap.emitBeat({ at: now, bpm: typeof bpm === 'number' ? bpm : bpm(i), rrMs: rr(i) });
    }
  }
  return { session, strap, packet, beats, snapshot, notify: () => notify(), dispose };
}

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const plan = (): Plan => ({
  ...makePlan('Base aeróbica', { warmup: 2, reps: 1, work: 6, recovery: 0, cooldown: 2 }, 5, 1),
  objective: 'Base aeróbica',
  zone: [55, 65],
});

const ended = (overrides: Partial<Workout>): Workout => ({
  id: 'w0',
  started: T0 - 3_600_000,
  source: 'ble',
  profile: PROFILE,
  plan: null,
  totals: { movingMs: 600_000, distanceM: 0, inclineMs: 0, inclineDurationMs: 0, bpmCount: 0, bpmSum: 0, peakBpm: 0 },
  ended: T0 - 3_000_000,
  reason: 'App interrompido',
  estimate: { level: 'Em adaptação', summary: '' },
  ...overrides,
});

describe('o que o treino pede à cinta', () => {
  it('ao abrir: sem treino, com o perfil em gramas e milímetros e a FC máxima em uso', () => {
    const { strap } = setup();
    expect(strap.last).toEqual({
      workout: null,
      profile: { weightG: 75400, heightMm: 1750, age: 36, maxHr: 184 },
      backfill: [],
    });
  });

  it('treino guiado: gravação e alerta no teto da faixa do dia + 5 bpm; o fim volta ao "sem treino"', () => {
    const { session, strap } = setup();
    const today = plan();
    session.start(today);
    const active = session.snapshot().active!;
    expect(strap.last.workout).toEqual({
      id: active.id,
      startedAt: active.started,
      guided: true,
      alertBpm: dailyTarget(today, PROFILE, active.hr).high + 5,
    });
    expect(strap.last.workout!.alertBpm).toBe(125);

    session.finish('Encerrado pelo painel');
    expect(strap.last.workout).toBeNull();
  });

  it('treino livre: sem gravação nem alerta', async () => {
    const { strap, packet } = setup();
    await packet(4, 100);
    expect(strap.last.workout).toMatchObject({ guided: false, alertBpm: null });
  });

  it('guarda no treino o horário em que a cinta começou a gravar', () => {
    const { session, strap } = setup();
    session.start(plan());
    const id = session.snapshot().active!.id;
    strap.emitRecorded(id, T0 + 500);
    expect(session.snapshot().active!.strap).toEqual({ recordedAt: T0 + 500 });
    expect(jest.mocked(saveWorkout).mock.calls.at(-1)![0].strap).toEqual({ recordedAt: T0 + 500 });
  });
});

describe('avaliação no meio', () => {
  it('a avaliação que volta depois não apaga o horário da gravação nem o FIT que chegaram antes', async () => {
    const { session, strap, packet } = setup();
    let answer!: (value: Awaited<ReturnType<typeof assess>>) => void;
    jest.mocked(assess).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    session.start(plan());
    const id = session.snapshot().active!.id;
    // 3 minutos e 10 leituras: a avaliação vai à IA.
    for (let s = 0; s < 190; s++) await packet(5, 110);
    session.finish('Encerrado pelo painel');
    expect(assess).toHaveBeenCalled();

    // Enquanto a IA responde, chegam o horário da gravação (atrasado) e o FIT.
    strap.emitRecorded(id, T0 + 500);
    strap.emitBackfill({ workoutId: id, file: 'a.fit', records: [{ at: T0 + 500, bpm: 100, cadence: 100 }] });
    answer({ level: 'Em adaptação', summary: 'ok', maxBpm: null });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const done = session.snapshot().history.find((w) => w.id === id)!;
    expect(done.estimate).toMatchObject({ summary: 'ok' });
    expect(done.strap).toEqual({ recordedAt: T0 + 500, file: 'a.fit', backfilledSeconds: 1 });
    expect(jest.mocked(saveWorkout).mock.calls.at(-1)![0].strap).toEqual(done.strap);
  });

  it('o primeiro horário de gravação vale: uma gravação recomeçada não o troca', () => {
    const { session, strap } = setup();
    session.start(plan());
    const id = session.snapshot().active!.id;
    strap.emitRecorded(id, T0 + 500);
    strap.emitRecorded(id, T0 + 90_000);
    expect(session.snapshot().active!.strap).toEqual({ recordedAt: T0 + 500 });
  });
});

describe('descarte', () => {
  it('a função devolvida por connect solta os avisos da cinta', () => {
    const { strap, session, dispose } = setup();
    // A gravação começada, o FIT baixado e os batimentos (o repouso parado).
    expect(strap.listening).toBe(3);
    // O efeito do React desmontando (ou o StrictMode desfazendo para refazer).
    dispose();
    expect(strap.listening).toBe(0);
    session.start(plan());
    strap.emitRecorded(session.snapshot().active!.id, T0 + 500);
    expect(session.snapshot().active!.strap).toBeUndefined();
    // Montando de novo, volta a ouvir.
    session.connect();
    expect(strap.listening).toBe(3);
  });
});

describe('trilha do treino em curso', () => {
  it('grava a trilha no checkpoint de 10 s e no fim, fora do registro do treino', async () => {
    const { session, packet } = setup();
    session.start(plan());
    const id = session.snapshot().active!.id;
    for (let s = 0; s < 12; s++) await packet(5, 110 + s, { rrMs: [540], cadenceSpm: 112 });

    expect(saveTrackChunk).toHaveBeenCalled();
    const points = decodeTrack(
      [...mockTracks.entries()].map(([key, data]) => ({ minute: Number(key.split('|')[1]), chunk: JSON.parse(data) as TrackChunk })),
    );
    expect(points.length).toBeGreaterThanOrEqual(10);
    expect(points[0]).toMatchObject({ bpm: 110, cadence: 112, rrMs: [540], speedKmh: 5 });
    expect(points[0].flags).toBe(TRACK_FLAGS.strap | TRACK_FLAGS.moving);

    await packet(5, 130);
    session.finish('Encerrado pelo painel');
    const all = decodeTrack(
      [...mockTracks.entries()].map(([key, data]) => ({ minute: Number(key.split('|')[1]), chunk: JSON.parse(data) as TrackChunk })),
    );
    expect(all.at(-1)!.bpm).toBe(130);
    // Nada da trilha vai para o registro nem para o histórico em memória.
    const done = session.snapshot().history.find((w) => w.id === id)!;
    expect(JSON.stringify(done)).not.toContain('540');
    // Com a cadência, os totais ganham a soma dela e os passos estimados.
    expect(done.totals.cadenceDurationMs).toBeGreaterThan(0);
    expect(done.totals.steps).toBeGreaterThan(0);
  });
});

describe('preenchimento pelo FIT', () => {
  it('pede o FIT dos treinos interrompidos com gravação, e preenche só a trilha quando chega', () => {
    const recordedAt = T0 - 3_600_000 + 1000;
    const interrupted = ended({ strap: { recordedAt } });
    const complete = ended({ id: 'w-ok', reason: 'Duração concluída', strap: { recordedAt: recordedAt - 86_400_000 } });
    const noRecording = ended({ id: 'w-sem' });
    const { session, strap } = setup([interrupted, complete, noRecording]);

    // O completo não tem trilha nenhuma gravada aqui: lacunas do começo ao fim.
    expect(strap.last.backfill).toEqual([
      { workoutId: 'w0', recordedAt },
      { workoutId: 'w-ok', recordedAt: recordedAt - 86_400_000 },
    ]);

    const records = Array.from({ length: 30 }, (_, i) => ({ at: recordedAt + i * 1000, bpm: 120, cadence: 110 }));
    strap.emitBackfill({ workoutId: 'w0', file: '20270115075901.fit', records });

    const saved = session.snapshot().history.find((w) => w.id === 'w0')!;
    expect(saved.strap).toEqual({ recordedAt, file: '20270115075901.fit', backfilledSeconds: 30 });
    // Os agregados não mudam: o FIT não traz velocidade nem inclinação.
    expect(saved.totals).toEqual(interrupted.totals);
    expect(strap.last.backfill).toEqual([{ workoutId: 'w-ok', recordedAt: recordedAt - 86_400_000 }]);
  });
});

describe('repouso e prontidão medidos parado, antes do treino', () => {
  /** Um coração a 60 bpm com 40 ms de variação de um batimento para o outro: RMSSD de 40 ms. */
  const alternating = (second: number) => [second % 2 ? 980 : 1020];

  it('com 60 s de cinta parado, o repouso é a menor mediana de 30 s, sem desconto, e a prontidão é gravada uma vez', async () => {
    const { session, packet, beats } = setup();
    // A esteira conectada e ainda sem leitura de velocidade: a lona conta como parada.
    beats(40, 72, alternating);
    beats(40, 61, alternating);
    expect(session.snapshot()).toMatchObject({ stillSeconds: 79, stillReady: true });

    // A lona começa a andar e o treino livre nasce com o repouso medido parado.
    await packet(4, 95);
    const active = session.snapshot().active!;
    expect(active).toMatchObject({ restBpm: 61, restSource: 'parado' });
    expect(active.hr).toMatchObject({ rest: 61, restSource: 'parado' });
    expect(session.snapshot().stillSeconds).toBeNull();
    expect(saveReadiness).toHaveBeenCalledTimes(1);
    expect(saveReadiness).toHaveBeenCalledWith({
      day: dayKey(Date.now()),
      at: Date.now(),
      restBpm: 61,
      rmssd: 40,
      lnRmssd: 3.689,
      beats: 80,
      rejectedShare: 0,
    });
    expect(session.snapshot().readiness).toHaveLength(1);

    // Andando, a cinta segue mandando batimentos: nada muda e nada é gravado de novo.
    for (let s = 0; s < 100; s++) {
      await packet(4, 95);
      beats(0, 95);
    }
    beats(5, 95, alternating);
    expect(session.snapshot().active).toMatchObject({ restBpm: 61, restSource: 'parado' });
    expect(session.snapshot().stillSeconds).toBeNull();
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('com menos de 60 s parado vale o caminho de sempre: o primeiro minuto andando, com desconto', async () => {
    const { session, packet, beats } = setup();
    beats(45, 62, alternating);
    expect(session.snapshot()).toMatchObject({ stillSeconds: 44, stillReady: false });
    for (let s = 0; s < 8; s++) await packet(4, 100);
    const active = session.snapshot().active!;
    expect(active).toMatchObject({ restBpm: 100, restSource: 'andando' });
    expect(active.hr).toMatchObject({ rest: 85, restSource: 'andando' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('o treino guiado iniciado com a lona parada segue medindo até ela andar', async () => {
    const { session, packet, beats } = setup();
    // A esteira manda a lona parada.
    await packet(0, null);
    beats(30, 64, alternating);
    session.start(plan());
    beats(40, 64, alternating);
    expect(session.snapshot().stillSeconds).toBe(69);
    await packet(4, 90);
    expect(session.snapshot().active).toMatchObject({ restBpm: 64, restSource: 'parado' });
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('quem já vinha andando num registro livre continua com a medida daquele registro', async () => {
    const { session, packet, beats } = setup();
    beats(70, 60, alternating);
    for (let s = 0; s < 5; s++) await packet(4, 95);
    await packet(0, 95);
    // Parado de novo, mas já tinha andado: a janela não volta a coletar.
    beats(70, 58, alternating);
    expect(session.snapshot().stillSeconds).toBeNull();
    session.start(plan());
    expect(session.snapshot().active).toMatchObject({ restBpm: 60, restSource: 'parado' });
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 60, restSource: 'parado' });
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('a FC de repouso em uso compara cada medida pela origem: parado vale como está, andando e antigo perdem 15', async () => {
    // Um registro antigo, sem origem: 80 no primeiro minuto andando vale 65.
    const { session, packet, beats } = setup([ended({ restBpm: 80 })]);
    expect(session.snapshot().profile).toEqual(PROFILE);
    beats(70, 68, alternating);
    await packet(4, 95);
    // A medida parado de hoje (68) é mais alta que os 65 do registro antigo.
    expect(session.snapshot().active!.hr).toMatchObject({ rest: 65, restSource: 'andando' });
  });

  it('artefatos acima de 10% dos RR não geram HRV, mas o repouso parado vale', async () => {
    const { session, packet, beats } = setup();
    // A cada 5 segundos, um batimento perdido (1500 ms): 14 de 70 RR descartados, 20%.
    beats(70, 62, (i) => (i % 5 === 3 ? [1500] : alternating(i)));
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 62, restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('a lona andando zera a janela, e depois de um treino a medida espera 10 minutos', async () => {
    const { session, packet, beats } = setup();
    beats(20, 70);
    expect(session.snapshot().stillSeconds).toBe(19);
    // 3 minutos e pouco andando: um treino que conta como esforço.
    for (let s = 0; s < 200; s++) await packet(4, 110);
    beats(3, 110);
    expect(session.snapshot().stillSeconds).toBeNull();
    session.finish('Encerrado pelo painel');
    await packet(0, 110);
    // A FC ainda é a do esforço: nos 10 minutos seguintes a janela não coleta.
    beats(598, 90);
    expect(session.snapshot().stillSeconds).toBeNull();
    beats(11, 66, alternating);
    expect(session.snapshot().stillSeconds).toBe(10);
    // Passados os 10 minutos, o repouso parado vale para o treino seguinte, mas a prontidão do
    // dia não é trocada: depois de um treino no mesmo dia a HRV ainda está deprimida.
    beats(60, 66, alternating);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 66, restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('um aquecimento curto, de 1 minuto ou mais, também conta como esforço', async () => {
    const { session, packet, beats } = setup();
    for (let s = 0; s < 75; s++) await packet(4, 140);
    session.finish('Encerrado pelo painel');
    await packet(0, 140);
    beats(70, 93, alternating);
    expect(session.snapshot().stillSeconds).toBeNull();
    await packet(4, 100);
    expect(session.snapshot().active?.restSource).not.toBe('parado');
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('uma janela que parou de receber leituras não vale: a cinta sem contato ou desligada é de outro momento', async () => {
    const { session, strap, packet, beats } = setup();
    beats(70, 61, alternating);
    expect(session.snapshot().stillReady).toBe(true);
    // A cinta perde o contato com a pele, e a lona só anda 10 s depois.
    for (let s = 0; s < 10; s++) {
      await packet(0, null);
      strap.emitBeat({ at: Date.now(), bpm: null, rrMs: [] });
    }
    for (let s = 0; s < 8; s++) await packet(4, 100);
    expect(session.snapshot().active).toMatchObject({ restBpm: 100, restSource: 'andando' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('com a lona andando sem treino (o registro acabou e ela não parou), nada entra na janela', async () => {
    const { session, packet, beats } = setup();
    await packet(4, 95);
    // Encerrado pelo painel com a lona ainda andando: um registro novo só começa depois de uma parada.
    session.finish('Encerrado pelo painel');
    await packet(4, 95);
    expect(session.snapshot().active).toBeNull();
    beats(20, 70);
    expect(session.snapshot().stillSeconds).toBeNull();
    await packet(0, 70);
    beats(5, 70);
    expect(session.snapshot().stillSeconds).toBe(4);
  });

  it('um segundo treino no mesmo dia troca a medida do dia; a esteira simulada não entra na base', async () => {
    const yesterday: ReadinessRecord = {
      day: dayKey(T0 - 86_400_000),
      at: T0 - 86_400_000,
      restBpm: 60,
      rmssd: 45,
      lnRmssd: 3.807,
      beats: 70,
      rejectedShare: 0,
    };
    const { session, packet, beats, snapshot } = setup([], [yesterday]);
    expect(session.snapshot().readiness).toEqual([yesterday]);
    beats(70, 61, alternating);
    await packet(4, 95);
    session.finish('Encerrado pelo painel');
    await packet(0, null);
    beats(70, 63, (i) => [i % 2 ? 970 : 1030]);
    await packet(4, 95);
    expect(saveReadiness).toHaveBeenCalledTimes(2);
    const [today, before] = session.snapshot().readiness;
    expect(today).toMatchObject({ day: dayKey(Date.now()), restBpm: 63, rmssd: 60 });
    expect(before).toEqual(yesterday);
    expect(session.snapshot().readiness).toHaveLength(2);

    // Na demonstração o repouso parado vale para o treino, mas não vira medida de prontidão.
    session.finish('Encerrado pelo painel');
    snapshot.mode = 'demo';
    await packet(0, null);
    beats(70, 59, alternating);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ source: 'demo', restBpm: 59, restSource: 'parado' });
    expect(saveReadiness).toHaveBeenCalledTimes(2);

    session.reset();
    expect(session.snapshot()).toMatchObject({ readiness: [], stillSeconds: null });
  });
});
