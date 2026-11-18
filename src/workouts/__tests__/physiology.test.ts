import { emptyLog, makePlan, newWorkout, type Workout } from '../model';
import {
  dailyTarget,
  heartProfile,
  maxBounds,
  observedPeak,
  restingBpm,
  zones,
} from '../physiology';

const profile = { age: 40, weightKg: 78, heightCm: 175 };
const plan = { ...makePlan('Resistência', 45, 5, 1), objective: 'Base aeróbica' as const };
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

it('sem repouso a faixa vem dos percentuais da FC máxima', () => {
  expect(dailyTarget(plan, profile)).toEqual({
    objective: 'Base aeróbica',
    low: 99,
    high: 117,
    method: 'máxima',
  });
  // Treino livre: vale a base aeróbica.
  expect(dailyTarget(null, profile).objective).toBe('Base aeróbica');
  expect(dailyTarget(makePlan('Recuperação ativa', 30, 4, 0), profile)).toMatchObject({
    objective: 'Recuperação leve',
    low: 90,
    high: 108,
  });
});

it('com repouso a faixa usa a reserva sem se afastar mais de 10 bpm da faixa pela máxima', () => {
  const zone = (rest: number) => dailyTarget(plan, profile, { rest, max: 180, maxSource: 'idade' });
  // Pessoa típica: os dois métodos dão quase a mesma faixa.
  expect(zone(70)).toMatchObject({ low: 101, high: 117, method: 'reserva' });
  // Repouso baixo desce a faixa, repouso alto sobe, os dois até o limite.
  expect(zone(50)).toMatchObject({ low: 89, high: 107 });
  expect(zone(100)).toMatchObject({ low: 109, high: 127 });
  // Repouso colado na máxima é leitura ruim.
  expect(zone(150)).toMatchObject({ low: 99, high: 117, method: 'máxima' });
  expect(zones(profile, { rest: 70, max: 180, maxSource: 'idade' })['Base aeróbica']).toEqual({
    low: 101,
    high: 117,
  });
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
