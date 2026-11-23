import type { FitRecord } from '@/heart/xoss/fit';
import type { TreadmillSample } from '@/treadmill/types';

import { validBpm } from './model';
import { readTrackChunks, saveTrackChunk } from './storage';

/**
 * A trilha por segundo de um treino: BPM, cadência, velocidade, inclinação,
 * RR e marcas de cada segundo de relógio (contados de `workout.started`, para
 * casar com o FIT da cinta). Não cabe no JSON do treino, que é regravado
 * inteiro a cada 10 s e carregado na abertura: fica numa tabela à parte, um
 * pedaço por minuto, e só é lida sob demanda.
 */

/** As marcas de um segundo, somadas em bits. */
export const TRACK_FLAGS = {
  /** O BPM veio da cinta no peito. */
  strap: 1,
  /** A pessoa estava fora da lona (a fase B preenche). */
  offBelt: 2,
  /** O BPM ou a cadência vieram do FIT baixado da cinta. */
  fit: 4,
  /** A lona estava andando. */
  moving: 8,
} as const;

/**
 * Um minuto de trilha, em colunas de inteiros, uma posição por segundo
 * (`null` sem valor). `s` e `i` em décimos (km/h × 10, % × 10), `r` os RR em
 * ms recebidos naquele segundo.
 */
export type TrackChunk = {
  v: 1;
  b: (number | null)[];
  c: (number | null)[];
  s: (number | null)[];
  i: (number | null)[];
  r: number[][];
  f: number[];
};

/** Um segundo da trilha, já decodificado. */
export type TrackPoint = {
  /** Segundos desde o início do treino. */
  second: number;
  bpm: number | null;
  /** Passos por minuto. */
  cadence: number | null;
  speedKmh: number | null;
  inclinePercent: number | null;
  rrMs: number[];
  flags: number;
};

const emptyChunk = (): TrackChunk => ({ v: 1, b: [], c: [], s: [], i: [], r: [], f: [] });

/** Estende as colunas até a posição `slot`. */
function reach(chunk: TrackChunk, slot: number): void {
  while (chunk.f.length <= slot) {
    chunk.b.push(null);
    chunk.c.push(null);
    chunk.s.push(null);
    chunk.i.push(null);
    chunk.r.push([]);
    chunk.f.push(0);
  }
}

/** Os segundos com alguma coisa gravada, em ordem. */
export function decodeTrack(rows: { minute: number; chunk: TrackChunk }[]): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const { minute, chunk } of [...rows].sort((a, b) => a.minute - b.minute)) {
    if (chunk?.v !== 1) continue;
    for (let slot = 0; slot < chunk.f.length; slot++) {
      const point: TrackPoint = {
        second: minute * 60 + slot,
        bpm: chunk.b[slot] ?? null,
        cadence: chunk.c[slot] ?? null,
        speedKmh: chunk.s[slot] == null ? null : chunk.s[slot]! / 10,
        inclinePercent: chunk.i[slot] == null ? null : chunk.i[slot]! / 10,
        rrMs: chunk.r[slot] ?? [],
        flags: chunk.f[slot] ?? 0,
      };
      const empty =
        point.bpm === null &&
        point.cadence === null &&
        point.speedKmh === null &&
        point.inclinePercent === null &&
        point.rrMs.length === 0 &&
        point.flags === 0;
      if (!empty) points.push(point);
    }
  }
  return points;
}

/** A trilha de um treino, lida do banco. Lista vazia se não há trilha. */
export function readTrack(id: string): TrackPoint[] {
  return decodeTrack(readTrackChunks(id));
}

/** Segundos sem BPM em buracos de 5 s ou mais, dentro dos primeiros `durationS` segundos. */
export const GAP_MIN_SECONDS = 5;
export function trackGaps(points: TrackPoint[], durationS: number): number {
  const beats = new Set(points.filter((p) => p.bpm !== null).map((p) => p.second));
  let gaps = 0;
  let run = 0;
  for (let second = 0; second < Math.floor(durationS); second++) {
    if (beats.has(second)) {
      if (run >= GAP_MIN_SECONDS) gaps += run;
      run = 0;
    } else {
      run += 1;
    }
  }
  return run >= GAP_MIN_SECONDS ? gaps + run : gaps;
}

type ChunkStore = {
  save(workout: string, minute: number, chunk: TrackChunk): void;
  read(workout: string): { minute: number; chunk: TrackChunk }[];
};
const database: ChunkStore = { save: saveTrackChunk, read: readTrackChunks };

/**
 * Junta as amostras do treino em curso, segundo a segundo, fora do estado
 * React. `flush` grava os minutos que mudaram; a sessão de treino chama no
 * checkpoint de 10 s que já existe e no fim do treino. Várias amostras no mesmo
 * segundo (a esteira manda mais de um pacote por segundo) viram um ponto: o
 * último valor de cada campo, os RR somados e as marcas juntas.
 *
 * Os minutos já gravados ficam na memória (uns poucos kB por minuto): cada
 * gravação regrava o minuto inteiro, e uma marca tardia num minuto antigo não
 * pode trocar o que está no banco por um minuto vazio.
 */
export class TrackRecorder {
  private readonly chunks = new Map<number, TrackChunk>();
  private readonly dirty = new Set<number>();

  constructor(
    readonly workoutId: string,
    private readonly started: number,
    private readonly store: Pick<ChunkStore, 'save'> = database,
  ) {}

  private chunk(minute: number): TrackChunk {
    let chunk = this.chunks.get(minute);
    if (!chunk) {
      chunk = emptyChunk();
      this.chunks.set(minute, chunk);
    }
    return chunk;
  }

  add(sample: TreadmillSample): void {
    const second = Math.floor((sample.at - this.started) / 1000);
    if (second < 0) return;
    const minute = Math.floor(second / 60);
    const slot = second % 60;
    const chunk = this.chunk(minute);
    reach(chunk, slot);
    if (validBpm(sample.heartRateBpm)) chunk.b[slot] = Math.round(sample.heartRateBpm);
    if (typeof sample.cadenceSpm === 'number') chunk.c[slot] = Math.round(sample.cadenceSpm);
    if (sample.speedKmh !== null) chunk.s[slot] = Math.round(sample.speedKmh * 10);
    if (sample.inclinationPercent !== null) chunk.i[slot] = Math.round(sample.inclinationPercent * 10);
    if (sample.rrMs?.length) chunk.r[slot] = [...chunk.r[slot], ...sample.rrMs.map(Math.round)];
    let flags = chunk.f[slot];
    if (sample.heartRateSource === 'strap' && validBpm(sample.heartRateBpm)) flags |= TRACK_FLAGS.strap;
    if ((sample.speedKmh ?? 0) > 0) flags |= TRACK_FLAGS.moving;
    chunk.f[slot] = flags;
    this.dirty.add(minute);
  }

  /** Acrescenta uma marca a um segundo já gravado (a fase B marca "fora da lona"). */
  mark(second: number, flag: number): void {
    if (second < 0) return;
    const minute = Math.floor(second / 60);
    const chunk = this.chunk(minute);
    reach(chunk, second % 60);
    chunk.f[second % 60] |= flag;
    this.dirty.add(minute);
  }

  /** Grava os minutos que mudaram. Um que falha fica pendente para a próxima vez. */
  flush(): void {
    for (const minute of [...this.dirty].sort((a, b) => a - b)) {
      this.store.save(this.workoutId, minute, this.chunk(minute));
      this.dirty.delete(minute);
    }
  }
}

/**
 * Preenche a trilha de um treino encerrado com os registros do FIT da cinta:
 * só os segundos sem BPM (ou sem cadência) dentro do treino, marcados como
 * vindos do FIT. Velocidade e inclinação o FIT não traz, então os agregados do
 * treino não mudam. Devolve quantos segundos foram preenchidos.
 */
export function fillTrackFromFit(
  workoutId: string,
  started: number,
  durationS: number,
  records: FitRecord[],
  store: ChunkStore = database,
): number {
  const chunks = new Map(store.read(workoutId).map((row) => [row.minute, row.chunk]));
  const changed = new Set<number>();
  let filled = 0;
  for (const record of records) {
    // O mesmo arredondamento de `TrackRecorder.add`: o segundo de relógio em que o registro caiu.
    const second = Math.floor((record.at - started) / 1000);
    if (second < 0 || second >= durationS) continue;
    const minute = Math.floor(second / 60);
    const slot = second % 60;
    let chunk = chunks.get(minute);
    if (!chunk || chunk.v !== 1) {
      chunk = emptyChunk();
      chunks.set(minute, chunk);
    }
    reach(chunk, slot);
    let used = false;
    if (chunk.b[slot] == null && validBpm(record.bpm)) {
      chunk.b[slot] = record.bpm;
      used = true;
    }
    if (chunk.c[slot] == null && record.cadence !== null) {
      chunk.c[slot] = record.cadence;
      used = true;
    }
    if (used) {
      chunk.f[slot] |= TRACK_FLAGS.fit;
      changed.add(minute);
      filled += 1;
    }
  }
  for (const minute of changed) {
    store.save(workoutId, minute, chunks.get(minute)!);
  }
  return filled;
}
