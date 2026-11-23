import type { TreadmillSample } from '@/treadmill/types';
import {
  cadenceChange,
  smoothCadence,
  stepGait,
  strideM,
  trackBelt,
  trackCadence,
  type Belt,
  type CadenceTrend,
  type GaitInput,
} from '../gait';
import { accumulate, acsm, energyCost, metabolicCost, newWorkout, type Totals } from '../model';

const sample = (at: number, cadenceSpm: number | null | undefined, speedKmh = 6.5): TreadmillSample => ({
  at,
  speedKmh,
  inclinationPercent: 1,
  heartRateBpm: null,
  ...(cadenceSpm !== undefined && { cadenceSpm }),
  energyKcal: null,
  distanceM: null,
});

it('a cadência do momento é a mediana dos últimos 10 s, com os zeros e sem as consultas sem valor', () => {
  const samples = [100, 150, 152, null, 151, 0, 149].map((spm, i) => sample(i * 1000, spm));
  // Aos 6 s entram todas as medidas (o zero inclusive), e a mediana não liga para o 100 nem para o 0.
  expect(smoothCadence(samples, 6000)).toBe(150);
  // Aos 10 s a de 0 s já tem 10 s e sai da janela.
  expect(smoothCadence(samples, 10000)).toBe(150);
  expect(smoothCadence(samples.slice(0, 2), 10000)).toBe(150);
  expect(smoothCadence([sample(0, null), sample(1000, undefined)], 1000)).toBeNull();
  expect(smoothCadence([sample(0, 0), sample(1000, 0)], 1000)).toBe(0);
});

it('andar ou correr sai da cadência com histerese de 135 a 145 passos/min', () => {
  // Corre de 145 em diante, anda abaixo de 135, e entre os dois fica como estava.
  const path = [150, 140, 136, 134, 140, 144, 145, 140].reduce<(boolean | null)[]>(
    (states, spm) => [...states, stepGait(states.at(-1) ?? null, spm)],
    [],
  );
  expect(path).toEqual([true, true, true, false, false, false, true, true]);
  // Sem estado anterior, o meio da faixa decide; sem cadência, `null`: vale a regra por velocidade.
  expect([stepGait(null, 139), stepGait(null, 141), stepGait(true, null)]).toEqual([false, true, null]);
  // A passada é a velocidade sobre a cadência: 9 km/h a 165 passos/min são 0,91 m por passo.
  expect(strideM(9, 165)).toBe(0.91);
  expect([strideM(9, 0), strideM(0, 160), strideM(null, 160), strideM(9, null)]).toEqual([null, null, null, null]);
});

it('as kcal usam a equação do passo medido, na mesma velocidade, e sem cadência a regra por velocidade', () => {
  // 6,5 km/h a 1%: correndo são 7,47 METs, andando 4,64.
  expect(energyCost(6.5, 1, true)).toBeCloseTo(acsm(6.5, 1, true), 9);
  expect(energyCost(6.5, 1, false)).toBeCloseTo(acsm(6.5, 1, false), 9);
  expect(energyCost(6.5, 1)).toBe(metabolicCost(6.5, 1));
  // Quem trota a 5,6 km/h gasta como quem corre; sem cadência, o trecho interpolado de antes.
  expect(energyCost(5.6, 0, true)).toBeCloseTo(acsm(5.6, 0, true), 9);
  expect(energyCost(5.6, 0)).toBeCloseTo(5.1, 1);
  // Dez minutos a 6,5 km/h, com a cadência passando por 140: a histerese não troca a equação a cada segundo.
  const run = (cadences: number[]) => {
    let totals: Totals = newWorkout({ age: 40, weightKg: 80, heightCm: 178 }, 'ble', null).totals;
    let running: boolean | null = null;
    let previous: TreadmillSample | null = null;
    cadences.forEach((spm, t) => {
      const s = sample(t * 1000, spm);
      running = stepGait(running, spm);
      totals = accumulate(totals, s, previous, { running });
      previous = s;
    });
    return totals.metMs! / (totals.movingMs || 1);
  };
  const seconds = (spm: number, n: number) => Array.from({ length: n }, () => spm);
  expect(run(seconds(160, 601))).toBeCloseTo(acsm(6.5, 1, true), 6);
  expect(run(seconds(125, 601))).toBeCloseTo(acsm(6.5, 1, false), 6);
  // Começa correndo e cai para 140: segue correndo. Abaixo de 135 passa a andar, e volta a 140 andando.
  expect(run([...seconds(150, 1), ...seconds(140, 600)])).toBeCloseTo(acsm(6.5, 1, true), 6);
  const mixed = run([...seconds(150, 1), ...seconds(134, 300), ...seconds(140, 300)]);
  expect(mixed).toBeCloseTo(acsm(6.5, 1, false), 6);
});

describe('fora da lona', () => {
  const at = (t: number, spm: number | null | undefined, extra: Partial<GaitInput> = {}): GaitInput => ({
    stage: 1,
    effort: true,
    at: t * 1000,
    kmh: 6.6,
    spm,
    ...extra,
  });
  const run = (inputs: GaitInput[]) =>
    inputs.reduce<Belt[]>((states, input) => [...states, trackBelt(states.at(-1) ?? null, input)], []);

  it('liga com 10 s de cadência em zero depois de passos na etapa, e desliga quando ela volta', () => {
    const states = run([at(0, 160), ...Array.from({ length: 11 }, (_, t) => at(t + 1, 0)), at(12, 158)]);
    expect(states.map((s) => s.off)).toEqual([false, false, false, false, false, false, false, false, false, false, false, true, false]);
  });

  it('não liga com a cadência sem valor, sem passos antes na etapa, devagar ou numa etapa leve', () => {
    const zeros = (extra: Partial<GaitInput> = {}) => Array.from({ length: 15 }, (_, t) => at(t + 1, 0, extra));
    // `null` (consulta atrasada) e `undefined` (sem fonte) nunca contam como zero, e interrompem a contagem.
    const gaps = run([at(0, 160), ...Array.from({ length: 30 }, (_, t) => at(t + 1, t % 5 === 4 ? null : 0))]);
    expect(gaps.some((s) => s.off)).toBe(false);
    expect(run([at(0, 160), ...Array.from({ length: 15 }, (_, t) => at(t + 1, undefined))]).some((s) => s.off)).toBe(false);
    // Sem nenhum passo na etapa a contagem da cinta pode nem ter começado.
    expect(run(zeros()).some((s) => s.off)).toBe(false);
    // Abaixo de 5 km/h, ou fora de um bloco de esforço, não vale.
    expect(run([at(0, 160), ...zeros({ kmh: 4.9 })]).some((s) => s.off)).toBe(false);
    expect(run([at(0, 160, { effort: false }), ...zeros({ effort: false })]).some((s) => s.off)).toBe(false);
    // Uma etapa nova recomeça do zero: os passos da anterior não contam.
    expect(run([at(0, 160, { stage: 0 }), ...zeros()]).some((s) => s.off)).toBe(false);
    // Já fora da lona, a cadência sem valor devolve o estado normal.
    const lost = run([at(0, 160), ...zeros(), at(16, null)]);
    expect([lost.at(-2)!.off, lost.at(-1)!.off]).toEqual([true, false]);
  });
});

describe('cadência caindo', () => {
  const feed = (points: { spm: number | null; kmh?: number; effort?: boolean }[], start: CadenceTrend | null = null) => {
    let trend = start;
    const warns: number[] = [];
    points.forEach((p, t) => {
      const out = trackCadence(trend, { stage: 1, effort: p.effort ?? true, at: t * 1000, kmh: p.kmh ?? 6.6, spm: p.spm });
      trend = out.trend;
      if (out.warn) warns.push(t);
    });
    return { trend, warns };
  };
  const flat = (n: number, spm: number | null, kmh = 6.6) => Array.from({ length: n }, () => ({ spm, kmh }));

  it('avisa uma vez quando a média de 30 s cai 8% abaixo do primeiro minuto do bloco, na mesma velocidade', () => {
    // A lona ainda acelera nos primeiros segundos: a base recomeça a cada velocidade nova.
    const { trend, warns } = feed([...flat(5, 140, 5), ...flat(5, 150, 6), ...flat(60, 165), ...flat(60, 160), ...flat(60, 150), ...flat(60, 140)]);
    // 165 na base; 150 é 9% a menos: o aviso sai uma vez só, mesmo com a cadência caindo mais.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBeGreaterThan(130);
    expect(warns[0]).toBeLessThan(190);
    expect(trend!.base).toMatchObject({ kmh: 6.6 });
    expect(cadenceChange(trend, 249_000)).toBeCloseTo(140 / 165 - 1, 3);
  });

  it('não avisa com outra velocidade, com a queda pequena, nem fora do bloco de esforço', () => {
    // Depois de um corte para 6,1 km/h a cadência cai sozinha: não é fadiga.
    expect(feed([...flat(60, 165), ...flat(90, 150, 6.1)]).warns).toEqual([]);
    expect(cadenceChange(feed([...flat(60, 165), ...flat(40, 150, 6.1)]).trend, 99_000)).toBeNull();
    // 7% a menos ainda não é queda.
    expect(feed([...flat(60, 165), ...flat(90, 154)]).warns).toEqual([]);
    expect(feed([...flat(60, 165, 6.6), ...flat(90, 140)].map((p) => ({ ...p, effort: false }))).warns).toEqual([]);
    // Zeros (fora da lona) e consultas sem valor não entram na média.
    expect(feed([...flat(60, 165), ...flat(20, 0), ...flat(20, null), ...flat(40, 163)]).warns).toEqual([]);
  });
});
