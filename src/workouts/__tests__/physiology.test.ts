import { emptyLog, newWorkout, type Plan, type Workout } from '../model';
import {
  ageMax,
  dailyTarget,
  heartProfile,
  loadLadder,
  maxBounds,
  maxFloor,
  mets,
  observedPeak,
  restingBpm,
} from '../physiology';
import { sessionPlan, week } from '../week';

const profile = { age: 40, weightKg: 78, heightCm: 175 };
const plan = sessionPlan(week[1].session!, 5, 1);
const pulses = (start: number, values: number[]) =>
  values.map((bpm, i) => ({ at: start + i * 1000, bpm }));
const session = (restBpm: number | null, maxBpm: number | null): Workout => ({
  ...newWorkout(profile, 'ble', null),
  restBpm,
  estimate: maxBpm ? { level: 'Base em formação', summary: '', maxBpm } : null,
});

it('lê a FC de repouso das primeiras leituras, sem as 2 iniciais de cada pegada', () => {
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88, 87]), false)).toBe(88);
  // Com a janela aberta ainda espera a quinta leitura; fechada, aceita quatro.
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88]), false)).toBeNull();
  expect(restingBpm(pulses(0, [120, 110, 88, 89, 90, 88]), true)).toBe(89);
  // Duas pegadas curtas não somam leituras aproveitáveis.
  expect(restingBpm([...pulses(0, [90, 91, 92]), ...pulses(10000, [93, 94, 95])], true)).toBeNull();
});

it('usa a menor leitura de repouso recente, com desconto, e a mediana das previsões de máxima', () => {
  expect(heartProfile(profile, [])).toEqual({ rest: null, max: 180, maxSource: 'idade' });
  const history = [
    session(92, 184),
    session(88, 181),
    session(null, null),
    session(95, 190),
    session(90, null),
    session(86, null),
    session(60, 150), // sexta leitura e quarta previsão: já ficam de fora
  ];
  expect(heartProfile(profile, history)).toEqual({ rest: 71, max: 184, maxSource: 'IA' });
});

it('a faixa de cada sessão são os percentuais do plano semanal sobre a FC máxima', () => {
  const zone = (day: number) => dailyTarget(sessionPlan(week[day].session!, 5, 1), profile);
  expect(zone(1)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  expect(zone(2)).toEqual({ objective: 'VO₂máx', low: 162, high: 171 });
  expect(zone(3)).toEqual({ objective: 'Recuperação', low: 90, high: 108 });
  expect(zone(5)).toEqual({ objective: 'Limiar', low: 153, high: 162 });
  expect(zone(6)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  // Treino livre: vale a base aeróbica.
  expect(dailyTarget(null, profile)).toEqual({ objective: 'Base aeróbica', low: 117, high: 135 });
  // A máxima prevista move a faixa; o repouso medido, não.
  expect(dailyTarget(plan, profile, { rest: 50, max: 190, maxSource: 'IA' })).toMatchObject({ low: 124, high: 143 });
});

it('planos gravados antes do plano semanal continuam com as faixas da época', () => {
  const old = (goal: string, objective?: string) =>
    dailyTarget({ goal, objective, minutes: 45, stages: [] } as unknown as Plan, profile);
  expect(old('Caminhada inclinada', 'Base aeróbica')).toEqual({ objective: 'Base aeróbica', low: 99, high: 117 });
  expect(old('Resistência', 'Resistência moderada')).toMatchObject({ low: 108, high: 126 });
  expect(old('Recuperação ativa')).toEqual({ objective: 'Recuperação leve', low: 90, high: 108 });
  expect(old('Queima de gordura')).toMatchObject({ objective: 'Base aeróbica', low: 99, high: 117 });
});

it('calcula o custo metabólico da carga e monta a escada de cargas', () => {
  // Caminhada abaixo de 7 km/h, corrida a partir daí.
  expect([mets(3.5, 2), mets(5, 0), mets(6, 0), mets(6, 8), mets(7, 1), mets(10, 1)]).toEqual([
    3.3, 3.4, 3.9, 8, 8, 11,
  ]);
  const ladder = loadLadder();
  // Caminhada plana até 5,5 km/h, rampa a 6 km/h até 8%, corrida a 1% até o máximo da esteira.
  expect(ladder.slice(0, 6).map((r) => [r.pace, r.grade])).toEqual([[3, 0], [3.5, 0], [4, 0], [4.5, 0], [5, 0], [5.5, 0]]);
  expect(ladder.filter((r) => r.pace === 6).map((r) => r.grade)).toEqual(
    Array.from({ length: 17 }, (_, i) => i / 2),
  );
  expect(ladder.filter((r) => r.pace >= 7).every((r) => r.grade === 1)).toBe(true);
  expect(ladder[ladder.length - 1]).toMatchObject({ pace: 22, grade: 1 });
  // Cada linha custa mais que a anterior: nenhum custo aparece duas vezes.
  ladder.forEach((row, i) => expect(row.mets).toBeGreaterThan(ladder[i - 1]?.mets ?? 0));
});

it('limita a FC máxima prevista às estimativas pela idade, com o pico observado como piso', () => {
  expect(maxBounds(40, null)).toEqual({ low: 170, high: 190 });
  expect(maxBounds(60, null)).toEqual({ low: 150, high: 176 });
  expect(maxBounds(40, 178)).toEqual({ low: 178, high: 190 });
  expect(maxBounds(40, 195)).toEqual({ low: 195, high: 195 });
  const peak = (top: number) => ({ ...session(null, null), log: [{ ...emptyLog(), top }] });
  expect(observedPeak([peak(150), peak(171), session(null, null)])).toBe(171);
  expect(observedPeak([session(null, null)])).toBeNull();
});

it('o piso da FC máxima soma 5 bpm ao pico de sessão levada até o fim sem redução', () => {
  expect([ageMax(40), ageMax(50)]).toEqual([180, 172]);
  const peak = (top: number, seconds: number, extra: Partial<Workout> = {}): Workout => {
    const w = session(null, null);
    return { ...w, totals: { ...w.totals, movingMs: seconds * 1000 }, log: [{ ...emptyLog(), top }], ...extra };
  };
  const change = (decision: string) => [{ second: 600, stage: 1, decision, bpm: 176 }];
  // Treino livre conta como levado até o fim com 20 min; guiado, com 90% dos 45 min do plano.
  expect(maxFloor([peak(176, 1200)])).toBe(181);
  expect(maxFloor([peak(176, 1199)])).toBe(176);
  expect(maxFloor([peak(176, 2430, { plan })])).toBe(181);
  expect(maxFloor([peak(176, 2429, { plan })])).toBe(176);
  // Quem precisou aliviar a carga pode ter chegado perto do máximo: o pico vale sem folga.
  expect(maxFloor([peak(176, 2700, { plan, changes: change('reduzir velocidade') })])).toBe(176);
  expect(maxFloor([peak(176, 2700, { plan, changes: change('aumentar velocidade') })])).toBe(181);
  // Vale o maior piso entre todas as sessões.
  expect(maxFloor([peak(180, 600), peak(170, 1800)])).toBe(180);
  expect(maxFloor([peak(178, 600), peak(176, 1800)])).toBe(181);
  expect(maxFloor([session(null, null)])).toBeNull();
});
