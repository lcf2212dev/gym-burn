import type { BackfillJob, StrapLink, StrapWishes } from '@/heart/strap-session';
import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TreadmillSample, TreadmillSnapshot } from '@/treadmill/types';

import { assess } from '../ai';
import { makePlan, type Plan, type Profile, type Workout } from '../model';
import { dailyTarget } from '../physiology';
import { WorkoutSession } from '../session';
import { readProfile, readWorkouts, saveTrackChunk, saveWorkout } from '../storage';
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
  want = (wishes: StrapWishes) => void this.wishes.push(wishes);
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
    return this.backfill.size + this.recorded.size;
  }
  emitBackfill(job: BackfillJob) {
    this.backfill.forEach((listener) => listener(job));
  }
  emitRecorded(workoutId: string, recordedAt: number) {
    this.recorded.forEach((listener) => listener({ workoutId, recordedAt }));
  }
}

function setup(history: Workout[] = []) {
  jest.useFakeTimers({ now: T0 });
  mockTracks.clear();
  jest.mocked(readProfile).mockReturnValue(PROFILE);
  jest.mocked(readWorkouts).mockReturnValue(history);
  jest.mocked(saveWorkout).mockClear();
  jest.mocked(saveTrackChunk).mockClear();
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
  return { session, strap, packet, dispose };
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
    expect(strap.listening).toBe(2);
    // O efeito do React desmontando (ou o StrictMode desfazendo para refazer).
    dispose();
    expect(strap.listening).toBe(0);
    session.start(plan());
    strap.emitRecorded(session.snapshot().active!.id, T0 + 500);
    expect(session.snapshot().active!.strap).toBeUndefined();
    // Montando de novo, volta a ouvir.
    session.connect();
    expect(strap.listening).toBe(2);
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
