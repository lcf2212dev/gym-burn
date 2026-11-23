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

function setup(history: Workout[] = [], readiness: ReadinessRecord[] = [], start = T0) {
  jest.useFakeTimers({ now: start });
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
  let now = start;
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
   * BPM dado e os RR de `rr`. Por padrão, um RR por segundo que bate com o BPM,
   * 20 ms acima e abaixo dele alternadamente (RMSSD de 40 ms).
   */
  function beats(
    seconds: number,
    bpm: number | ((second: number) => number),
    rr: (second: number, bpm: number) => number[] = (i, b) => [Math.round(60000 / b) + (i % 2 ? -20 : 20)],
  ) {
    for (let i = 0; i < seconds; i++) {
      now += 1000;
      jest.advanceTimersByTime(1000);
      const value = typeof bpm === 'number' ? bpm : bpm(i);
      strap.emitBeat({ at: now, bpm: value, rrMs: rr(i, value) });
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
  const MIN = 60_000;
  const HOUR = 3_600_000;
  /** Um treino da esteira de verdade já encerrado, com o tempo em movimento e o repouso dados. */
  const past = (id: string, endedAgo: number, movingMs: number, patch: Partial<Workout> = {}) =>
    ended({ id, started: T0 - endedAgo - movingMs, ended: T0 - endedAgo, totals: { ...ended({}).totals, movingMs }, ...patch });

  it('com 2 minutos de cinta parado, o repouso sai dos trechos de 30 s coerentes, sem desconto, e a prontidão do último minuto é gravada uma vez', async () => {
    const { session, packet, beats } = setup();
    // A esteira conectada e ainda sem leitura de velocidade: a lona conta como parada.
    beats(59, 72);
    // 58 s: o minuto do repouso ainda não fechou.
    expect(session.snapshot()).toMatchObject({ stillSeconds: 58, stillReady: false, stillHrv: 'curta' });
    beats(2, 72);
    expect(session.snapshot()).toMatchObject({ stillSeconds: 60, stillReady: true, stillHrv: 'curta' });
    beats(69, 61);
    expect(session.snapshot()).toMatchObject({ stillSeconds: 129, stillReady: true, stillHrv: 'pronta' });

    // A lona começa a andar e o treino livre nasce com o repouso medido parado.
    await packet(4, 95);
    const active = session.snapshot().active!;
    expect(active).toMatchObject({ restBpm: 61, restSource: 'parado' });
    expect(active.hr).toMatchObject({ rest: 61, restSource: 'parado' });
    expect(session.snapshot()).toMatchObject({ stillSeconds: null, stillHrv: null });
    expect(saveReadiness).toHaveBeenCalledTimes(1);
    expect(saveReadiness).toHaveBeenCalledWith({
      day: dayKey(Date.now()),
      at: Date.now(),
      restBpm: 61,
      rmssd: 40,
      lnRmssd: 3.689,
      beats: 60,
      rejectedShare: 0,
    });
    expect(session.snapshot().readiness).toHaveLength(1);

    // Andando, a cinta segue mandando batimentos: nada muda e nada é gravado de novo.
    for (let s = 0; s < 100; s++) await packet(4, 95);
    beats(5, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 61, restSource: 'parado' });
    expect(session.snapshot().stillSeconds).toBeNull();
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('com 1 minuto parado vale o repouso, mas não a prontidão', async () => {
    const { session, packet, beats } = setup();
    beats(70, 62);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 62, restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();
    expect(session.snapshot().readinessIssue).toBeNull();
  });

  it('com menos de 60 s parado vale o caminho de sempre: o primeiro minuto andando, com desconto', async () => {
    const { session, packet, beats } = setup();
    beats(45, 62);
    expect(session.snapshot()).toMatchObject({ stillSeconds: 44, stillReady: false });
    for (let s = 0; s < 8; s++) await packet(4, 100);
    const active = session.snapshot().active!;
    expect(active).toMatchObject({ restBpm: 100, restSource: 'andando' });
    expect(active.hr).toMatchObject({ rest: 85, restSource: 'andando' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('um trecho curto de leitura baixa (cinta mal assentada) não vira o repouso do dia', async () => {
    const { session, packet, beats } = setup();
    // 90 s a 64 e depois 32 s em que a cinta manda 40, com os RR ainda de quem está a 64.
    beats(90, 64);
    beats(32, 40, (i) => [i % 2 ? 917 : 957]);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 64, restSource: 'parado' });
    // Os RR do último minuto não batem com o BPM da cinta: a prontidão não é gravada.
    expect(saveReadiness).not.toHaveBeenCalled();
    expect(session.snapshot().readinessIssue).toEqual({ day: dayKey(Date.now()), reason: 'instavel' });
  });

  it('um repouso parado bem abaixo das medidas anteriores é descartado: vale o caminho andando', async () => {
    const history = [1, 2, 3].map((d) =>
      past('p' + d, d * 86_400_000, 30 * MIN, { restBpm: 63 + d, restSource: 'parado' }),
    );
    const { session, packet, beats } = setup(history);
    // 50, coerente, mas 15 abaixo da mediana de 65 das três medidas parado.
    beats(130, 50);
    for (let s = 0; s < 8; s++) await packet(4, 100);
    expect(session.snapshot().active).toMatchObject({ restBpm: 100, restSource: 'andando' });
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('o treino guiado iniciado com a lona parada segue medindo até ela andar', async () => {
    const { session, packet, beats } = setup();
    // A esteira manda a lona parada.
    await packet(0, null);
    beats(60, 64);
    session.start(plan());
    beats(70, 64);
    expect(session.snapshot().stillSeconds).toBe(129);
    await packet(4, 90);
    expect(session.snapshot().active).toMatchObject({ restBpm: 64, restSource: 'parado' });
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('quem já vinha andando num registro livre continua com a medida daquele registro', async () => {
    const { session, packet, beats } = setup();
    beats(70, 60);
    for (let s = 0; s < 5; s++) await packet(4, 95);
    await packet(0, 95);
    // Parado de novo, mas já tinha andado: a janela não volta a coletar.
    beats(70, 58);
    expect(session.snapshot().stillSeconds).toBeNull();
    session.start(plan());
    expect(session.snapshot().active).toMatchObject({ restBpm: 60, restSource: 'parado' });
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 60, restSource: 'parado' });
  });

  it('a FC de repouso em uso: com 3 medidas parado é a mediana delas; com menos, a menor pela origem', async () => {
    // Um registro antigo, sem origem: 80 no primeiro minuto andando vale 65.
    const legacy = setup([ended({ restBpm: 80 })]);
    legacy.beats(70, 68);
    await legacy.packet(4, 95);
    // A medida parado de hoje (68) é mais alta que os 65 do registro antigo.
    expect(legacy.session.snapshot().active!.hr).toMatchObject({ rest: 65, restSource: 'andando' });

    const still = [1, 2].map((d) => past('s' + d, d * 86_400_000, 30 * MIN, { restBpm: 60 + 2 * d, restSource: 'parado' }));
    const { session, packet, beats } = setup([...still, ended({ id: 'velho', started: T0 - 4 * 86_400_000, restBpm: 70 })]);
    beats(70, 58);
    await packet(4, 95);
    // 58, 62 e 64 parado: a mediana, 62, e não a menor.
    expect(session.snapshot().active!.hr).toMatchObject({ rest: 62, restSource: 'parado' });
  });

  it('um artefato sustentado de RR, que o filtro aceita como patamar novo, não grava a prontidão', async () => {
    const { session, packet, beats } = setup();
    // 2 minutos limpos a 60; nos 10 s finais a cinta manda RR de 700 ms (um batimento a mais
    // contado): 4 descartes, a re-semeadura e o resto aceito. Os descartes são 7%, abaixo dos 10%.
    beats(120, 60);
    beats(10, 60, (i) => [700 + (i % 2) * 10]);
    expect(session.snapshot().stillHrv).toBe('instavel');
    await packet(4, 95);
    expect(saveReadiness).not.toHaveBeenCalled();
    expect(session.snapshot().readinessIssue?.reason).toBe('instavel');
  });

  it('uma janela que parou de receber leituras não vale: a cinta sem contato ou desligada é de outro momento', async () => {
    const { session, strap, packet, beats } = setup();
    beats(130, 61);
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

  it('depois de um treino a medida espera 10 minutos, e a prontidão só volta 3 horas depois', async () => {
    const { session, packet, beats } = setup();
    // 3 minutos e pouco andando: um esforço.
    for (let s = 0; s < 200; s++) await packet(4, 110);
    session.finish('Encerrado pelo painel');
    await packet(0, 110);
    // A FC ainda é a do esforço: nos 10 minutos seguintes a janela não coleta.
    beats(598, 90);
    expect(session.snapshot().stillSeconds).toBeNull();
    beats(130, 66);
    expect(session.snapshot().stillSeconds).toBe(129);
    // Passados os 10 minutos, o repouso parado vale para o treino seguinte, mas a prontidão não é
    // gravada: a HRV ainda está deprimida.
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 66, restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();
    expect(session.snapshot().readinessIssue).toBeNull();
  });

  it('um treino na véspera, às 23h40, ainda trava a prontidão à meia-noite; 3 horas depois ela volta', async () => {
    // 00h15 no fuso do aparelho; o treino da véspera terminou às 23h40 (35 min antes).
    const midnight = new Date(2027, 0, 15, 0, 15).getTime();
    const late = ended({
      id: 'noite',
      started: midnight - 75 * MIN,
      ended: midnight - 35 * MIN,
      totals: { ...ended({}).totals, movingMs: 40 * MIN },
    });
    const { session, packet, beats } = setup([late], [], midnight);
    beats(130, 60);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();

    const old = past('cedo', 3 * HOUR, 40 * MIN);
    const after = setup([old]);
    after.beats(130, 60);
    await after.packet(4, 95);
    expect(saveReadiness).toHaveBeenCalledTimes(1);
  });

  it('a medida de hoje feita antes de um treino de hoje não é trocada por outra depois dele', async () => {
    const today: ReadinessRecord = {
      day: dayKey(T0),
      at: T0 - 5 * HOUR,
      restBpm: 58,
      rmssd: 52,
      lnRmssd: 3.951,
      beats: 60,
      rejectedShare: 0,
    };
    // O treino começou depois da medida e terminou há 4 horas.
    const workout = past('manha', 4 * HOUR, 40 * MIN);
    const { session, packet, beats } = setup([workout], [today]);
    beats(130, 62);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ restBpm: 62, restSource: 'parado' });
    expect(saveReadiness).not.toHaveBeenCalled();
    expect(session.snapshot().readiness).toEqual([today]);
  });

  it('um aquecimento curto, de 1 minuto ou mais, também conta como esforço', async () => {
    const { session, packet, beats } = setup();
    for (let s = 0; s < 75; s++) await packet(4, 140);
    session.finish('Encerrado pelo painel');
    await packet(0, 140);
    beats(70, 93);
    expect(session.snapshot().stillSeconds).toBeNull();
    await packet(4, 100);
    expect(session.snapshot().active?.restSource).not.toBe('parado');
    expect(saveReadiness).not.toHaveBeenCalled();
  });

  it('um segundo treino no mesmo dia, sem esforço no meio, troca a medida do dia; a esteira simulada não entra na base', async () => {
    const yesterday: ReadinessRecord = {
      day: dayKey(T0 - 86_400_000),
      at: T0 - 86_400_000,
      restBpm: 60,
      rmssd: 45,
      lnRmssd: 3.807,
      beats: 60,
      rejectedShare: 0,
    };
    const { session, packet, beats, snapshot } = setup([], [yesterday]);
    expect(session.snapshot().readiness).toEqual([yesterday]);
    beats(130, 61);
    await packet(4, 95);
    session.finish('Encerrado pelo painel');
    await packet(0, null);
    beats(130, 63, (i, b) => [Math.round(60000 / b) + (i % 2 ? -30 : 30)]);
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
    beats(130, 59);
    await packet(4, 95);
    expect(session.snapshot().active).toMatchObject({ source: 'demo', restBpm: 59, restSource: 'parado' });
    expect(saveReadiness).toHaveBeenCalledTimes(2);

    session.reset();
    expect(session.snapshot()).toMatchObject({ readiness: [], stillSeconds: null, readinessIssue: null });
  });
});
