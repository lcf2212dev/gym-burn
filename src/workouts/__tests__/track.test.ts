import type { TreadmillSample } from '@/treadmill/types';

import { decodeTrack, fillTrackFromFit, TRACK_FLAGS, TrackRecorder, trackGaps, type TrackChunk } from '../track';

jest.mock('../storage', () => ({ saveTrackChunk: jest.fn(), readTrackChunks: jest.fn(() => []) }));

const T0 = 1_800_000_000_000;

/** Um banco em memória, no formato da tabela `tracks` (o JSON vai e volta como no SQLite). */
function memory() {
  const rows = new Map<string, string>();
  return {
    rows,
    save: (workout: string, minute: number, chunk: TrackChunk) =>
      void rows.set(`${workout}|${minute}`, JSON.stringify(chunk)),
    read: (workout: string) =>
      [...rows.entries()]
        .filter(([key]) => key.startsWith(workout + '|'))
        .map(([key, data]) => ({ minute: Number(key.split('|')[1]), chunk: JSON.parse(data) as TrackChunk })),
  };
}

const sample = (second: number, overrides: Partial<TreadmillSample> = {}): TreadmillSample => ({
  at: T0 + second * 1000,
  speedKmh: 5.2,
  inclinationPercent: 1.5,
  heartRateBpm: 110,
  heartRateSource: 'strap',
  energyKcal: null,
  distanceM: null,
  ...overrides,
});

describe('trilha por segundo', () => {
  it('sobrevive ao checkpoint e à releitura, em colunas de inteiros', () => {
    const db = memory();
    const recorder = new TrackRecorder('w1', T0, db);
    recorder.add(sample(0, { rrMs: [540, 545], cadenceSpm: 112 }));
    // Dois pacotes da esteira no mesmo segundo: um ponto só, RR somados.
    recorder.add(sample(1, { rrMs: [550] }));
    recorder.add(sample(1.5, { rrMs: [548], heartRateBpm: null, cadenceSpm: null }));
    recorder.add(sample(3, { speedKmh: 0, heartRateSource: 'treadmill', heartRateBpm: 95 }));
    recorder.flush();
    // O minuto seguinte, e o checkpoint de novo.
    recorder.add(sample(61, { inclinationPercent: 2 }));
    recorder.flush();

    const stored = JSON.parse(db.rows.get('w1|0')!);
    expect(stored).toEqual({
      v: 1,
      b: [110, 110, null, 95],
      c: [112, null, null, null],
      s: [52, 52, null, 0],
      i: [15, 15, null, 15],
      r: [[540, 545], [550, 548], [], []],
      f: [TRACK_FLAGS.strap | TRACK_FLAGS.moving, TRACK_FLAGS.strap | TRACK_FLAGS.moving, 0, 0],
    });

    const points = decodeTrack(db.read('w1'));
    expect(points.map((p) => p.second)).toEqual([0, 1, 3, 61]);
    expect(points[0]).toEqual({
      second: 0,
      bpm: 110,
      cadence: 112,
      speedKmh: 5.2,
      inclinePercent: 1.5,
      rrMs: [540, 545],
      flags: TRACK_FLAGS.strap | TRACK_FLAGS.moving,
    });
    expect(points[3]).toMatchObject({ second: 61, inclinePercent: 2 });
  });

  it('o minuto corrente segue crescendo e é regravado inteiro a cada checkpoint', () => {
    const db = memory();
    const recorder = new TrackRecorder('w1', T0, db);
    recorder.add(sample(0));
    recorder.flush();
    recorder.add(sample(10));
    recorder.flush();
    expect(decodeTrack(db.read('w1')).map((p) => p.second)).toEqual([0, 10]);
    // Sem nada novo, nada é gravado.
    const save = jest.spyOn(db, 'save');
    const quiet = new TrackRecorder('w2', T0, db);
    quiet.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('marca "fora da lona" num segundo já gravado, mesmo num minuto antigo, sem perder o resto', () => {
    const db = memory();
    const recorder = new TrackRecorder('w1', T0, db);
    recorder.add(sample(5));
    recorder.add(sample(70));
    recorder.flush();
    recorder.mark(5, TRACK_FLAGS.offBelt);
    recorder.flush();
    const points = decodeTrack(db.read('w1'));
    expect(points.map((p) => p.second)).toEqual([5, 70]);
    expect(points[0]).toMatchObject({ bpm: 110, speedKmh: 5.2 });
    expect(points[0].flags & TRACK_FLAGS.offBelt).toBeTruthy();
  });

  it('um minuto que falha ao gravar fica pendente para o próximo checkpoint', () => {
    const db = memory();
    let fail = true;
    const recorder = new TrackRecorder('w1', T0, {
      save: (workout, minute, chunk) => {
        if (fail) throw new Error('disco cheio');
        db.save(workout, minute, chunk);
      },
    });
    recorder.add(sample(1));
    expect(() => recorder.flush()).toThrow('disco cheio');
    fail = false;
    recorder.flush();
    expect(decodeTrack(db.read('w1')).map((p) => p.second)).toEqual([1]);
  });

  it('conta as lacunas de 5 s ou mais sem BPM', () => {
    const db = memory();
    const recorder = new TrackRecorder('w1', T0, db);
    // Batimento a cada segundo, faltando um (normal: a cinta manda a cada ~1,02 s) e depois 6 seguidos.
    for (let s = 0; s < 30; s++) if (s !== 4 && (s < 10 || s > 15)) recorder.add(sample(s));
    recorder.flush();
    const points = decodeTrack(db.read('w1'));
    expect(trackGaps(points, 30)).toBe(6);
    // O fim que falta também conta.
    expect(trackGaps(points, 40)).toBe(16);
    expect(trackGaps([], 3)).toBe(0);
  });

  it('o FIT cai no mesmo segundo de relógio que a amostra ao vivo (o mesmo arredondamento)', () => {
    const db = memory();
    // O treino começou no meio de um segundo; amostra e registro chegam 1,7 s depois.
    const started = T0 + 300;
    const recorder = new TrackRecorder('w1', started, db);
    recorder.add({ ...sample(0), at: started + 1700, heartRateBpm: null });
    recorder.flush();
    fillTrackFromFit('w1', started, 60, [{ at: started + 1700, bpm: 130, cadence: 115 }], db);
    const points = decodeTrack(db.read('w1'));
    expect(points.map((p) => [p.second, p.bpm, p.speedKmh])).toEqual([[1, 130, 5.2]]);
  });

  it('o FIT preenche só as lacunas, marca a origem e não passa do fim do treino', () => {
    const db = memory();
    const recorder = new TrackRecorder('w1', T0, db);
    recorder.add(sample(0, { heartRateBpm: 100 }));
    recorder.add(sample(1, { heartRateBpm: null }));
    recorder.flush();

    const records = [0, 1, 2, 65, 200].map((s) => ({ at: T0 + s * 1000, bpm: 130, cadence: 115 }));
    const filled = fillTrackFromFit('w1', T0, 120, records, db);

    expect(filled).toBe(4);
    const points = decodeTrack(db.read('w1'));
    expect(points.map((p) => [p.second, p.bpm, p.cadence, p.flags & TRACK_FLAGS.fit])).toEqual([
      // O BPM da cinta ao vivo fica; a cadência que faltava vem do FIT.
      [0, 100, 115, TRACK_FLAGS.fit],
      [1, 130, 115, TRACK_FLAGS.fit],
      [2, 130, 115, TRACK_FLAGS.fit],
      [65, 130, 115, TRACK_FLAGS.fit],
    ]);
    // Velocidade e inclinação não vêm do FIT.
    expect(points[2]).toMatchObject({ speedKmh: null, inclinePercent: null });
  });
});
