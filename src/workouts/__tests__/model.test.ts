import {
  accumulate,
  currentCue,
  evidence,
  goals,
  insufficient,
  logStage,
  makePlan,
  newWorkout,
  validProfile,
  validSession,
  type StageLog,
} from '../model';
import type { TreadmillSample } from '@/treadmill/types';

const profile = { age: 35, heightCm: 175, weightKg: 75 };
const sample = (at: number, speedKmh: number, heartRateBpm: number | null): TreadmillSample => ({
  at,
  speedKmh,
  heartRateBpm,
  distanceM: null,
  energyKcal: null,
  inclinationPercent: 2,
});

it.each(goals)('mantém a duração e pede BPM no momento certo em %s', (goal) => {
  for (const minutes of [5, 45, 180]) {
    const plan = makePlan(goal, minutes, 5, 1);
    expect(plan.stages.reduce((n, s) => n + s.seconds, 0)).toBe(minutes * 60);
    // A primeira etapa pede a FC de repouso logo no início, só enquanto a janela está aberta.
    const first = plan.stages[0];
    expect(currentCue(plan, 0)).toMatchObject({ index: 0, into: 0, measure: true });
    expect(currentCue(plan, 0)?.stage.name).toBe('Aquecimento');
    if (first.seconds > 90) expect(currentCue(plan, 90)?.measure).toBe(false);
    // As demais esperam a FC acompanhar a carga: 60 s nas leves, 120 s nas principais.
    const second = currentCue(plan, first.seconds)!;
    expect(second).toMatchObject({ index: 1, into: 0, measure: false });
    const wait = Math.min(second.stage.measure ? 60 : 120, Math.floor(second.stage.seconds / 2));
    expect(currentCue(plan, first.seconds + wait - 1)?.measure).toBe(false);
    expect(currentCue(plan, first.seconds + wait)).toMatchObject({ into: wait, measure: true });
    expect(currentCue(plan, minutes * 60)).toBeNull();
  }
});

it('ignora pausa e lacuna BLE e calcula apenas o esforço observado', () => {
  const w = newWorkout(profile, 'ble', makePlan('Intervalado', 45, 8, 4));
  const samples = [
    sample(0, 3.6, 110),
    sample(1000, 3.6, null),
    sample(12000, 3.6, 130),
    sample(13000, 0, 88),
    sample(14000, 4, null),
  ];
  samples.forEach((s, i) => {
    w.totals = accumulate(w.totals, s, samples[i - 1] ?? null);
  });
  expect(evidence(w)).toMatchObject({
    movingSeconds: 1,
    distanceMeters: 1,
    averageKmh: 3.6,
    averageIncline: 2,
    bpmReadings: 2,
    averageBpm: 120,
    peakBpm: 130,
  });
});

it('registra por etapa a posição na faixa, o fim do bloco, a recuperação e o pico validado', () => {
  const zone = { low: 100, high: 120 };
  let log: StageLog | undefined;
  let previous: TreadmillSample | null = null;
  const feed = (into: number, bpm: number | null, speed = 5) => {
    const s = sample(into * 1000, speed, bpm);
    log = logStage(log, s, previous, zone, into);
    previous = s;
  };
  feed(0, null);
  feed(1, 95);
  feed(2, 110);
  feed(3, 180); // leitura solta: não vira pico
  feed(4, 112);
  feed(50, 125); // depois de uma lacuna do rádio: a leitura conta, o tempo não
  feed(51, 126);
  feed(52, 127);
  feed(53, 0, 0); // lona parada não entra
  expect(log).toMatchObject({
    ms: 6000,
    bpmCount: 7,
    zone: [1, 2, 4],
    tail: [95, 110, 180, 112, 125, 126, 127],
    early: [125, 126, 127],
    top: 126,
  });
  expect(log!.inclineMs / log!.inclineDurationMs).toBe(2);
});

it('separa sessão válida de fragmento e de sessão sem leituras', () => {
  const w = newWorkout(profile, 'ble', null);
  const short = { ...w, totals: { ...w.totals, movingMs: 179000, bpmCount: 50 } };
  const blind = { ...w, totals: { ...w.totals, movingMs: 600000, bpmCount: 9 } };
  const good = { ...w, totals: { ...w.totals, movingMs: 180000, bpmCount: 10 } };
  expect([short, blind, good].map(validSession)).toEqual([false, true, true]);
  expect([short, blind, good].map(insufficient)).toEqual([true, true, false]);
});

it('rejeita alvos inválidos e perfil incompleto', () => {
  expect(validProfile({ ...profile, heightCm: 0 })).toBe(false);
  expect(validProfile({ ...profile, activity: 'Ativo' })).toBe(true);
  expect(validProfile({ ...profile, activity: 'Atleta' as never })).toBe(false);
  expect(() => makePlan('Resistência', 45, 40, 1)).toThrow();
  expect(() => makePlan('Resistência', 45, 4, NaN)).toThrow();
});
