import { newWorkout, type Workout } from '../model';
import {
  addStillBeat,
  BASELINE_MIN_DAYS,
  coveredMs,
  dayKey,
  readiness,
  READINESS_SD_FLOOR,
  restToday,
  stillHrv,
  stillRest,
  stillSeconds,
  STILL_WINDOW_MS,
  type ReadinessRecord,
  type StillBeat,
} from '../rest';

/** 22/11/2026, 9 h da manhã, no fuso do aparelho. */
const NOW = new Date(2026, 10, 22, 9, 0).getTime();
const daysAgo = (days: number, hour = 8) => new Date(2026, 10, 22 - days, hour, 0).getTime();

/** Uma notificação por segundo, a partir de `start`, com o BPM de cada segundo e os RR dele. */
function series(
  seconds: number,
  bpm: number | ((second: number) => number),
  rr: (second: number) => number[] = (s) => [s % 2 ? 980 : 1020],
  start = 0,
): StillBeat[] {
  return Array.from({ length: seconds }, (_, s) => ({
    at: start + s * 1000,
    bpm: typeof bpm === 'number' ? bpm : bpm(s),
    rrMs: rr(s),
  }));
}

describe('repouso medido parado', () => {
  it('é a menor mediana de 30 s seguidos da janela', () => {
    // 40 s a 72, 40 s a 61 e 40 s a 66: a menor mediana de 30 s é 61.
    const beats = series(120, (s) => (s < 40 ? 72 : s < 80 ? 61 : 66));
    expect(stillRest(beats)).toBe(61);
    // Uma leitura solta lá embaixo não é o repouso: a mediana a ignora.
    const spike = series(90, (s) => (s === 50 ? 40 : 64));
    expect(stillRest(spike)).toBe(64);
    // Uma descida aos poucos: o fim da janela, mais calmo, é que vale.
    expect(stillRest(series(90, (s) => 80 - Math.floor(s / 6)))).toBe(68);
  });

  it('com menos de 60 s de leitura não há repouso parado', () => {
    expect(stillRest(series(60, 62))).toBeNull(); // 59 s cobertos
    expect(stillSeconds(series(60, 62))).toBe(59);
    expect(stillRest(series(61, 62))).toBe(62);
    // Lacunas de mais de 5 s não contam como tempo medido.
    const gapped = [...series(35, 62), ...series(35, 62, undefined, 45_000)];
    expect(coveredMs(gapped)).toBe(68_000);
    expect(stillRest(gapped)).toBe(62);
    // Pedaços de 20 s somam 60 s, mas nenhum trecho de 30 s seguidos: sem repouso.
    const pieces = [0, 1, 2, 3].flatMap((k) => series(21, 62, undefined, k * 30_000));
    expect(coveredMs(pieces)).toBe(80_000);
    expect(stillRest(pieces)).toBeNull();
  });

  it('a janela guarda só os últimos 5 minutos', () => {
    let beats: StillBeat[] = [];
    for (const beat of series(400, 60)) beats = addStillBeat(beats, beat);
    expect(beats[0].at).toBe(beats.at(-1)!.at - STILL_WINDOW_MS);
    expect(beats).toHaveLength(301);
  });
});

describe('HRV da janela parado', () => {
  it('é o RMSSD dos RR aceitos e o ln dele', () => {
    // RR alternando entre 980 e 1020 ms: toda diferença tem 40 ms.
    expect(stillHrv(series(70, 60))).toEqual({ rmssd: 40, lnRmssd: 3.689, beats: 70, rejectedShare: 0 });
    // Diferenças de 30, 50 e 20 ms em sequência: a raiz da média dos quadrados.
    const rr = Array.from({ length: 80 }, (_, s) => [1000, 970, 1020][s % 3]);
    const expected = Math.sqrt(rr.slice(1).reduce((n, v, i) => n + (v - rr[i]) ** 2, 0) / 79);
    const mixed = stillHrv(series(80, 60, (s) => [rr[s]]));
    expect(mixed).toMatchObject({ rmssd: Math.round(expected * 10) / 10, beats: 80, rejectedShare: 0 });
    expect(mixed!.lnRmssd).toBe(Math.round(Math.log(expected) * 1000) / 1000);
  });

  it('com mais de 10% de batimentos descartados pelo filtro de artefatos não há HRV', () => {
    // A cada 5 s, um batimento perdido (1500 ms, 50% acima da mediana): 14 de 70 RR saem, 20%.
    const noisy = series(70, 60, (s) => (s % 5 === 3 ? [1500] : [s % 2 ? 980 : 1020]));
    expect(stillHrv(noisy)).toBeNull();
    // A cada 12 s: 6 de 70, 8,6%. A HRV vale, sem os descartados.
    const some = stillHrv(series(70, 60, (s) => (s % 12 === 6 ? [1500] : [s % 2 ? 980 : 1020])));
    expect(some).toMatchObject({ beats: 70, rejectedShare: 0.086 });
  });

  it('precisa de 60 s de leitura e de RR que cubram o minuto', () => {
    expect(stillHrv(series(50, 60))).toBeNull();
    // Uma cinta que não manda RR mede o repouso, mas não a HRV.
    expect(stillHrv(series(70, 60, () => []))).toBeNull();
    expect(stillRest(series(70, 60, () => []))).toBe(60);
    // RR em só metade dos pacotes: 35 s de RR em 69 s de leitura.
    expect(stillHrv(series(70, 60, (s) => (s % 2 ? [] : [1000 + (s % 4) * 10])))).toBeNull();
  });
});

describe('prontidão do dia', () => {
  const record = (ago: number, lnRmssd: number, hour = 8): ReadinessRecord => ({
    day: dayKey(daysAgo(ago, hour)),
    at: daysAgo(ago, hour),
    lnRmssd,
    rmssd: Math.round(Math.exp(lnRmssd) * 10) / 10,
    restBpm: 60,
    beats: 70,
    rejectedShare: 0,
  });
  // Base de 5 dias com média 3,7 e desvio-padrão de 0,2 (amostral).
  const base = [3.5, 3.6, 3.7, 3.8, 3.9].map((v, i) => record(i + 1, v));
  const sd = Math.sqrt((0.04 + 0.01 + 0 + 0.01 + 0.04) / 4);

  it('sem medida hoje diz quantos dias a base tem', () => {
    expect(readiness([], NOW)).toEqual({ state: 'sem-medida', days: 0 });
    expect(readiness(base, NOW)).toEqual({ state: 'sem-medida', days: 5 });
  });

  it('com menos de 5 dias medidos nas últimas 4 semanas ainda está coletando', () => {
    const today = record(0, 3.7);
    expect(readiness([today, ...base.slice(0, BASELINE_MIN_DAYS - 1)], NOW)).toEqual({
      state: 'coletando',
      days: 4,
      today,
    });
    // Hoje não conta na base.
    expect(readiness([today], NOW)).toMatchObject({ state: 'coletando', days: 0 });
  });

  it('compara ln(RMSSD) de hoje com a média ± 1 desvio-padrão da própria pessoa', () => {
    expect(readiness([record(0, 3.75), ...base], NOW)).toMatchObject({
      state: 'normal',
      days: 5,
      mean: 3.7,
      sd: Math.round(sd * 1000) / 1000,
    });
    expect(readiness([record(0, 3.7 + sd - 0.01), ...base], NOW).state).toBe('normal');
    expect(readiness([record(0, 3.7 + sd + 0.01), ...base], NOW).state).toBe('acima');
    expect(readiness([record(0, 3.7 - sd - 0.01), ...base], NOW).state).toBe('abaixo');
  });

  it('o desvio-padrão tem piso: uma base muito regular não acusa qualquer oscilação', () => {
    const flat = [1, 2, 3, 4, 5].map((ago) => record(ago, 3.7));
    expect(readiness([record(0, 3.75), ...flat], NOW)).toMatchObject({ state: 'normal', sd: READINESS_SD_FLOOR });
    expect(readiness([record(0, 3.65), ...flat], NOW).state).toBe('normal');
    expect(readiness([record(0, 3.81), ...flat], NOW).state).toBe('acima');
    expect(readiness([record(0, 3.59), ...flat], NOW).state).toBe('abaixo');
  });

  it('a base são os dias medidos nos últimos 28, sem contar hoje, um por dia', () => {
    const today = record(0, 3.7);
    // Dia 29 fica de fora; o 28 entra.
    const old = [1, 2, 3, 4].map((ago) => record(ago, 3.7));
    expect(readiness([today, ...old, record(29, 3.7)], NOW)).toMatchObject({ state: 'coletando', days: 4 });
    expect(readiness([today, ...old, record(28, 3.7)], NOW)).toMatchObject({ state: 'normal', days: 5 });
    // Duas medidas no mesmo dia: vale a mais recente, e o dia conta uma vez.
    const twice = [record(2, 3.2, 7), record(2, 3.7, 19)];
    expect(readiness([today, record(1, 3.7), ...twice, record(3, 3.7), record(4, 3.7)], NOW)).toMatchObject({
      state: 'coletando',
      days: 4,
    });
    const morning = record(0, 3.0, 7);
    const evening = record(0, 3.72, 20);
    expect(readiness([morning, evening, ...base], new Date(2026, 10, 22, 21).getTime())).toMatchObject({
      state: 'normal',
      today: evening,
    });
  });
});

describe('repouso de hoje', () => {
  const profile = { age: 36, weightKg: 75, heightCm: 175 };
  const at = (started: number, restBpm: number | null, restSource?: Workout['restSource']): Workout => ({
    ...newWorkout(profile, 'ble', null),
    started,
    restBpm,
    restSource,
  });

  it('é a medida parado mais recente de hoje; sem ela, a lida andando mais recente', () => {
    expect(restToday([], NOW)).toBeNull();
    expect(restToday([at(daysAgo(1), 60, 'parado')], NOW)).toBeNull();
    expect(restToday([at(daysAgo(0, 7), 62, 'parado'), at(daysAgo(0, 8), null)], NOW)).toEqual({
      bpm: 62,
      source: 'parado',
    });
    // A parado da manhã vale mais que a lida andando num treino depois dela.
    expect(restToday([at(daysAgo(0, 7), 62, 'parado'), at(daysAgo(0, 8), 88, 'andando')], NOW)).toEqual({
      bpm: 62,
      source: 'parado',
    });
    // Registro sem origem é do primeiro minuto andando.
    expect(restToday([at(daysAgo(0, 6), 90), at(daysAgo(0, 8), 88)], NOW)).toEqual({
      bpm: 88,
      source: 'andando',
    });
  });
});
