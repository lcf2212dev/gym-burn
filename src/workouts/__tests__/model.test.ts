import {
  accumulate,
  currentCue,
  evidence,
  insufficient,
  logBeats,
  logStage,
  makePlan,
  newWorkout,
  validProfile,
  validSession,
  type MinuteBeats,
  type StageLog,
} from '../model';
import {
  describe as structureText,
  heartZones,
  sessionMinutes,
  sessionPlan,
  week,
  zoneSpan,
} from '../week';
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

const options = week.flatMap((entry) => (entry.session ? [[entry.day, entry.session] as const] : []));

it('a semana tem um treino de 45 minutos de segunda a sábado e o domingo de descanso', () => {
  expect(week.map((entry) => entry.session?.goal ?? null)).toEqual([
    null,
    'Base aeróbica',
    'VO₂máx',
    'Recuperação ativa',
    'Base aeróbica',
    'Limiar',
    'Base aeróbica',
  ]);
  expect(options).toHaveLength(6);
  for (const [, option] of options) expect(sessionMinutes(option)).toBe(45);
  expect(structureText(week[1].session!)).toBe('Contínuo: 5 min aquecendo, 35 min na faixa, 5 min desaquecendo');
  expect(structureText(week[2].session!)).toBe('10 min aquecendo, 4 × 4 min com 3 min leves, 7 min desaquecendo');
});

it('cada treino tem o alvo dentro das cinco zonas de frequência', () => {
  expect(heartZones.map((zone) => [zone.id, zone.name, zone.from])).toEqual([
    ['Z1', 'Recuperação', 50],
    ['Z2', 'Aeróbica base', 60],
    ['Z3', 'Aeróbica moderada', 70],
    ['Z4', 'Limiar', 80],
    ['Z5', 'Máximo (VO₂máx)', 90],
  ]);
  expect(zoneSpan('Recuperação')).toEqual({ ids: 'Z1', feel: 'muito leve' });
  // A base aeróbica, de 65 a 75%, pega o alto da Z2 e o começo da Z3.
  expect(zoneSpan('Base aeróbica')).toEqual({ ids: 'Z2–Z3', feel: 'leve a moderado' });
  expect(zoneSpan('Limiar')).toEqual({ ids: 'Z4', feel: 'forte' });
  expect(zoneSpan('VO₂máx')).toEqual({ ids: 'Z5', feel: 'máximo' });
});

it('monta as etapas de cada sessão com a estrutura do plano semanal', () => {
  const shape = (day: number) =>
    sessionPlan(week[day].session!, 9, 1).stages.map((s) => [s.name, s.seconds, s.speed, s.incline]);
  expect(shape(1)).toEqual([
    ['Aquecimento', 300, 4, 0],
    ['Base aeróbica', 2100, 9, 1],
    ['Volta à calma', 300, 4, 0],
  ]);
  expect(shape(2)).toEqual([
    ['Aquecimento', 600, 4, 0],
    ['VO₂máx 1/4', 240, 9, 1],
    ['Recuperação', 180, 4, 0],
    ['VO₂máx 2/4', 240, 9, 1],
    ['Recuperação', 180, 4, 0],
    ['VO₂máx 3/4', 240, 9, 1],
    ['Recuperação', 180, 4, 0],
    ['VO₂máx 4/4', 240, 9, 1],
    ['Recuperação', 180, 4, 0],
    ['Volta à calma', 420, 4, 0],
  ]);
  expect(shape(5).map((s) => s[1])).toEqual([600, 480, 120, 480, 120, 480, 120, 300]);
  // Em carga de caminhada lenta o trecho leve fica em 80% da velocidade.
  expect(sessionPlan(week[3].session!, 3.5, 0).stages[0].speed).toBe(2.8);
  expect(sessionPlan(week[5].session!, 9, 1)).toMatchObject({
    goal: 'Limiar',
    objective: 'Limiar',
    zone: [85, 90],
    minutes: 45,
  });
});

it.each(options)('pede BPM a cada 3 minutos de treino, num relógio fixo, em %s', (_, option) => {
  // 10 km/h: o pedido vale também correndo.
  const plan = sessionPlan(option, 10, 1);
  expect(plan.stages.reduce((n, s) => n + s.seconds, 0)).toBe(45 * 60);
  // O primeiro pedido é a FC de repouso, logo no início e só enquanto a janela está aberta.
  expect(currentCue(plan, 0)).toMatchObject({ index: 0, into: 0, pulse: 0, measure: true });
  expect(currentCue(plan, 0)?.stage.name).toBe('Aquecimento');
  expect(currentCue(plan, 0)).not.toHaveProperty('key');
  expect(currentCue(plan, 89)).toMatchObject({ pulse: 0, measure: true });
  expect(currentCue(plan, 90)).toMatchObject({ pulse: 0, measure: false });
  expect(currentCue(plan, 179)).toMatchObject({ pulse: 0, measure: false });
  // Daí em diante um pedido novo a cada 180 s de treino, sempre aberto.
  expect(currentCue(plan, 180)).toMatchObject({ pulse: 1, measure: true });
  expect(currentCue(plan, 359)).toMatchObject({ pulse: 1, measure: true });
  expect(currentCue(plan, 360)).toMatchObject({ pulse: 2, measure: true });
  // A troca de etapa não adia nem zera o pedido: o número segue o relógio do treino.
  const first = plan.stages[0].seconds;
  const before = currentCue(plan, first - 1)!;
  const second = currentCue(plan, first)!;
  expect(second).toMatchObject({ index: 1, into: 0, measure: true });
  expect(second.stage).toMatchObject({ measure: false, speed: 10 });
  expect(second.pulse).toBe(Math.floor(first / 180));
  expect(before.pulse).toBe(Math.floor((first - 1) / 180));
  // Nem nos últimos segundos de uma etapa o pedido deixa de valer.
  const off = Array.from({ length: 45 * 60 - 180 }, (_, i) => 180 + i).filter((elapsed) => {
    const cue = currentCue(plan, elapsed)!;
    return cue.pulse !== Math.floor(elapsed / 180) || !cue.measure;
  });
  expect(off).toEqual([]);
  expect(currentCue(plan, 45 * 60 - 1)).toMatchObject({ pulse: 14, left: 1, measure: true });
  expect(currentCue(plan, 45 * 60)).toBeNull();
});

it('ignora pausa e lacuna BLE e calcula apenas o esforço observado', () => {
  const w = newWorkout(profile, 'ble', sessionPlan(week[2].session!, 8, 4));
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

it('guarda os batimentos minuto a minuto, só com a lona andando', () => {
  let beats: MinuteBeats[] | undefined;
  let previous: TreadmillSample | null = null;
  const feed = (elapsed: number, bpm: number | null, speed = 5) => {
    const s = sample(elapsed * 1000, speed, bpm);
    beats = logBeats(beats, s, previous, elapsed);
    previous = s;
  };
  feed(10, 100);
  feed(11, 104);
  feed(59, null);
  expect(beats).toEqual([[204, 2]]);
  // Minutos sem leitura ficam zerados até o da leitura seguinte.
  feed(200, 130);
  feed(201, 0);
  feed(202, 140, 0);
  expect(beats).toEqual([[204, 2], [0, 0], [0, 0], [130, 1]]);
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
  expect(validProfile(profile)).toBe(true);
  expect(validProfile({ ...profile, heightCm: 0 })).toBe(false);
  const structure = { warmup: 5, reps: 1, work: 35, recovery: 0, cooldown: 5 };
  // Não há teto além do que a esteira alcança: 22 km/h e 15%.
  expect(makePlan('Base aeróbica', structure, 22, 15).stages[1]).toMatchObject({ speed: 22, incline: 15 });
  expect(() => makePlan('Base aeróbica', structure, 22.5, 1)).toThrow();
  expect(() => makePlan('Base aeróbica', structure, 6, 15.5)).toThrow();
  expect(() => makePlan('Base aeróbica', structure, 4, NaN)).toThrow();
  expect(() => makePlan('Resistência' as never, structure, 4, 1)).toThrow();
  expect(() => makePlan('Base aeróbica', { ...structure, reps: 0 }, 4, 1)).toThrow();
});
