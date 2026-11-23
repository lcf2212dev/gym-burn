import { newWorkout, type Workout } from '../model';
import {
  addStillBeat,
  BASELINE_MIN_DAYS,
  coveredMs,
  dayKey,
  efforts,
  readiness,
  readinessLock,
  READINESS_SD_FLOOR,
  restToday,
  stillHistory,
  stillHrv,
  stillRest,
  stillSeconds,
  stillWait,
  STILL_WINDOW_MS,
  type ReadinessRecord,
  type StillBeat,
} from '../rest';

/** 22/11/2026, 9 h da manhã, no fuso do aparelho. */
const NOW = new Date(2026, 10, 22, 9, 0).getTime();
const daysAgo = (days: number, hour = 8) => new Date(2026, 10, 22 - days, hour, 0).getTime();
const MIN = 60_000;

/** Os RR de um coração no BPM dado, 20 ms acima e abaixo alternadamente: RMSSD de 40 ms. */
const steady = (second: number, bpm: number) => [Math.round(60000 / bpm) + (second % 2 ? -20 : 20)];

/** Uma notificação por segundo, a partir de `start`, com o BPM de cada segundo e os RR dele. */
function series(
  seconds: number,
  bpm: number | ((second: number) => number),
  rr: (second: number, bpm: number) => number[] = steady,
  start = 0,
): StillBeat[] {
  return Array.from({ length: seconds }, (_, s) => {
    const value = typeof bpm === 'number' ? bpm : bpm(s);
    return { at: start + s * 1000, bpm: value, rrMs: rr(s, value) };
  });
}

describe('repouso medido parado', () => {
  it('é a menor mediana entre trechos de 30 s coerentes', () => {
    // 40 s a 72, 40 s a 61 e 40 s a 66: a menor mediana de 30 s é 61.
    expect(stillRest(series(120, (s) => (s < 40 ? 72 : s < 80 ? 61 : 66)))).toBe(61);
    // Uma descida aos poucos: o fim da janela, mais calmo, é que vale.
    expect(stillRest(series(90, (s) => 80 - Math.floor(s / 6)))).toBe(68);
  });

  it('os trechos de 30 s não se sobrepõem: uma queda de 20 s não puxa o repouso para baixo', () => {
    // A 64, com 20 s a 50 no meio. Com trechos sobrepostos, o que pega 20 s da queda daria 50.
    const dip = series(120, (s) => (s >= 80 && s < 100 ? 50 : 64));
    expect(stillRest(dip)).toBe(64);
  });

  it('um trecho de leitura baixa que os RR não confirmam (cinta mal assentada) não é candidato', () => {
    // 90 s a 64 e depois 32 s em que a cinta manda 40, com os RR ainda de quem está a 64.
    const stuck = [...series(90, 64), ...series(32, 40, (s) => steady(s, 64), 90_000)];
    expect(stillRest(stuck)).toBe(64);
    // Os RR acompanham a queda (batimentos perdidos, 1500 ms): o filtro se re-semeia no trecho.
    const missed = [...series(90, 64), ...series(32, 40, steady, 90_000)];
    expect(stillRest(missed)).toBe(64);
    // 26 bpm: RR fora da faixa do filtro, nenhum aceito no trecho.
    const dead = [...series(90, 64), ...series(32, 26, steady, 90_000)];
    expect(stillRest(dead)).toBe(64);
  });

  it('um trecho com o BPM variando mais de 15 bpm não é candidato', () => {
    expect(stillRest(series(90, (s) => (s % 2 ? 56 : 74)))).toBeNull();
    expect(stillRest(series(90, (s) => (s % 2 ? 58 : 72)))).toBe(65);
  });

  it('abaixo de 40 bpm, ou mais de 12 bpm abaixo da mediana de 3 medidas parado, não vale', () => {
    expect(stillRest(series(90, 38))).toBeNull();
    expect(stillRest(series(90, 40))).toBe(40);
    // Mediana de 65: 52 ainda vale, 52 − 1 não.
    expect(stillRest(series(90, 53), [64, 65, 66])).toBe(53);
    expect(stillRest(series(90, 52), [64, 65, 66])).toBeNull();
    // Com só duas medidas parado ainda não há referência.
    expect(stillRest(series(90, 50), [64, 65])).toBe(50);
  });

  it('a referência são as 5 últimas medidas parado do histórico', () => {
    const profile = { age: 36, weightKg: 75, heightCm: 175 };
    const w = (restBpm: number | null, restSource?: Workout['restSource']): Workout => ({
      ...newWorkout(profile, 'ble', null),
      restBpm,
      restSource,
    });
    const history = [w(60, 'parado'), w(90, 'andando'), w(null), w(61, 'parado'), w(62, 'parado'), w(63, 'parado'), w(64, 'parado'), w(65, 'parado')];
    expect(stillHistory(history)).toEqual([60, 61, 62, 63, 64]);
  });

  it('com menos de 60 s de leitura, ou sem RR, não há repouso parado', () => {
    expect(stillRest(series(60, 62))).toBeNull(); // 59 s cobertos
    expect(stillSeconds(series(60, 62))).toBe(59);
    expect(stillRest(series(61, 62))).toBe(62);
    // Lacunas de mais de 5 s não contam como tempo medido.
    const gapped = [...series(35, 62), ...series(35, 62, steady, 45_000)];
    expect(coveredMs(gapped)).toBe(68_000);
    expect(stillRest(gapped)).toBe(62);
    // Pedaços de 20 s somam 60 s, mas nenhum trecho de 30 s seguidos: sem repouso.
    const pieces = [0, 1, 2, 3].flatMap((k) => series(21, 62, steady, k * 30_000));
    expect(coveredMs(pieces)).toBe(80_000);
    expect(stillRest(pieces)).toBeNull();
    // Sem RR não há como conferir o BPM da cinta.
    expect(stillRest(series(70, 60, () => []))).toBeNull();
  });

  it('a janela guarda só os últimos 5 minutos', () => {
    let beats: StillBeat[] = [];
    for (const beat of series(400, 60)) beats = addStillBeat(beats, beat);
    expect(beats[0].at).toBe(beats.at(-1)!.at - STILL_WINDOW_MS);
    expect(beats).toHaveLength(301);
  });
});

describe('HRV da janela parado', () => {
  it('é o RMSSD dos últimos 60 s, com 2 minutos parado', () => {
    expect(stillHrv(series(130, 60))).toEqual({
      hrv: { rmssd: 40, lnRmssd: 3.689, beats: 60, rejectedShare: 0 },
      reason: null,
    });
    // Menos de 2 minutos parado: o primeiro minuto é de acomodação.
    expect(stillHrv(series(110, 60))).toEqual({ hrv: null, reason: 'curta' });
  });

  it('usa só o último minuto: a FC caindo no começo não entra', () => {
    // 70 s a 70 com muita variação (80 e 160 ms) e 60 s estáveis a 60 (20 ms).
    const settling = [
      ...series(70, 70, (s) => [[857, 777, 937][s % 3]]),
      ...series(60, 60, (s) => [1000 + (s % 2 ? -10 : 10)], 70_000),
    ];
    expect(stillHrv(settling).hrv).toMatchObject({ rmssd: 20, lnRmssd: 2.996 });
  });

  it('só soma diferenças entre RR aceitos e seguidos: o par recomeça a cada descarte', () => {
    // No último minuto, 5 batimentos perdidos (1500 ms) entre RR de 980 e 1020: 8% descartados.
    // Somando o par que pula o descarte (980 com 980), o RMSSD cairia abaixo de 40.
    const sparse = series(130, 60, (s) => (s % 12 === 6 ? [1500] : [s % 2 ? 980 : 1020]));
    expect(stillHrv(sparse).hrv).toEqual({ rmssd: 40, lnRmssd: 3.689, beats: 60, rejectedShare: 0.083 });
    // Um pacote sem RR também recomeça o par.
    const empty = series(130, 60, (s) => (s % 12 === 6 ? [] : [s % 2 ? 980 : 1020]));
    expect(stillHrv(empty).hrv?.rmssd).toBe(40);
  });

  it('com mais de 10% dos RR descartados, a leitura é instável', () => {
    const noisy = series(130, 60, (s) => (s % 5 === 3 ? [1500] : [s % 2 ? 980 : 1020]));
    expect(stillHrv(noisy)).toEqual({ hrv: null, reason: 'instavel' });
  });

  it('um artefato sustentado, que re-semeia o filtro, é instável mesmo abaixo de 10% de descartes', () => {
    // Nos 10 s finais, RR de 700 ms (um batimento a mais contado): 4 descartes (7%) e a re-semeadura.
    const sustained = [...series(120, 60), ...series(10, 60, (s) => [700 + (s % 2) * 10], 120_000)];
    expect(stillHrv(sustained)).toEqual({ hrv: null, reason: 'instavel' });
  });

  it('RR que não batem com o BPM da cinta são instáveis', () => {
    // A cinta diz 60, os RR dizem 75.
    expect(stillHrv(series(130, 60, (s) => steady(s, 75)))).toEqual({ hrv: null, reason: 'instavel' });
    expect(stillHrv(series(130, 60, (s) => steady(s, 64))).hrv).not.toBeNull();
  });

  it('sem RR não há HRV; com RR em só metade dos pacotes, a leitura é instável', () => {
    expect(stillHrv(series(130, 60, () => []))).toEqual({ hrv: null, reason: 'sem-rr' });
    expect(stillHrv(series(130, 60, (s) => (s % 2 ? [] : [1000 + (s % 4) * 10])))).toEqual({
      hrv: null,
      reason: 'instavel',
    });
  });
});

describe('trava da prontidão depois de um treino', () => {
  const profile = { age: 36, weightKg: 75, heightCm: 175 };
  const workout = (started: number, ended: number | null, movingMs: number, source: Workout['source'] = 'ble'): Workout => {
    const base = newWorkout(profile, source, null);
    return { ...base, started, ended, totals: { ...base.totals, movingMs } };
  };
  const record = (at: number): ReadinessRecord => ({
    day: dayKey(at),
    at,
    lnRmssd: 3.7,
    rmssd: 40,
    restBpm: 60,
    beats: 60,
    rejectedShare: 0,
  });

  it('esforço é um treino encerrado da esteira de verdade com 1 minuto ou mais', () => {
    const list = efforts([
      workout(NOW - 50 * MIN, NOW - 10 * MIN, 40 * MIN),
      workout(NOW - 5 * MIN, NOW - 4 * MIN, 50_000),
      workout(NOW - 5 * MIN, null, 5 * MIN),
      workout(NOW - 50 * MIN, NOW - 10 * MIN, 40 * MIN, 'demo'),
    ]);
    expect(list).toEqual([{ started: NOW - 50 * MIN, ended: NOW - 10 * MIN }]);
  });

  it('a janela parado espera 10 minutos depois do esforço', () => {
    const list = [{ started: NOW - 50 * MIN, ended: NOW - 4 * MIN }];
    expect(stillWait(list, NOW)).toBe(6 * MIN);
    expect(stillWait(list, NOW + 6 * MIN)).toBe(0);
    expect(stillWait([], NOW)).toBe(0);
  });

  it('a prontidão volta 3 horas depois do treino, mesmo na virada do dia', () => {
    const midnight = new Date(2026, 10, 23, 0, 0).getTime();
    const late = [{ started: midnight - 60 * MIN, ended: midnight - 20 * MIN }];
    expect(readinessLock(late, [], midnight)).toEqual({ reason: 'depois-do-treino', until: midnight + 160 * MIN });
    expect(readinessLock(late, [], midnight + 160 * MIN)).toBeNull();
  });

  it('a medida de hoje feita antes de um treino de hoje não é trocada', () => {
    const morning = record(daysAgo(0, 6));
    const training = [{ started: daysAgo(0, 7), ended: daysAgo(0, 7) + 40 * MIN }];
    // Às 15 h já passaram as 3 horas, mas a medida das 6 h foi antes do treino das 7 h.
    const afternoon = new Date(2026, 10, 22, 15, 0).getTime();
    expect(readinessLock(training, [morning], afternoon)).toEqual({ reason: 'antes-do-treino' });
    // Sem medida hoje, passadas as 3 horas, pode medir.
    expect(readinessLock(training, [], afternoon)).toBeNull();
    // Medida de hoje depois do treino (e das 3 horas): pode trocar por outra.
    expect(readinessLock(training, [record(daysAgo(0, 11))], afternoon)).toBeNull();
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
