// O plano semanal: a sessão de cada dia, com a estrutura e a faixa de
// frequência cardíaca. A IA escolhe só a carga (velocidade e inclinação) que
// leva a pessoa a essa faixa.

import type { Objective } from './adaptive';
import { makePlan, type Goal, type Plan, type Structure } from './model';

export type Session = {
  goal: Goal;
  objective: Objective;
  structure: Structure;
  /** O treino e o percentual da FC máxima como estão escritos no plano da pessoa. */
  title: string;
  percent: string;
};

/** Faixa dos blocos de esforço de cada intensidade, em % da FC máxima. */
export const zones: Record<Objective, [number, number]> = {
  // O plano pede "abaixo de 60–65%": o teto fica em 60, e o app alivia a carga
  // assim que a FC passa dele.
  Recuperação: [50, 60],
  'Base aeróbica': [65, 75],
  Limiar: [85, 90],
  'VO₂máx': [90, 95],
};

/**
 * As cinco zonas de frequência cardíaca que a pessoa usa, de 10 em 10 pontos
 * da FC máxima. As faixas dos treinos acima são alvos dentro delas: a base
 * aeróbica (65–75%) pega o alto da Z2 e o começo da Z3.
 */
export const heartZones = [
  { id: 'Z1', name: 'Recuperação', from: 50, feel: 'muito leve', purpose: 'Aquecimento, recuperação ativa' },
  { id: 'Z2', name: 'Aeróbica base', from: 60, feel: 'leve', purpose: 'Queima de gordura, base de resistência' },
  { id: 'Z3', name: 'Aeróbica moderada', from: 70, feel: 'moderado', purpose: 'Condicionamento aeróbico, eficiência cardíaca' },
  { id: 'Z4', name: 'Limiar', from: 80, feel: 'forte', purpose: 'Aumentar o limiar de lactato, ritmo de prova' },
  { id: 'Z5', name: 'Máximo (VO₂máx)', from: 90, feel: 'máximo', purpose: 'Tiros curtos, potência e velocidade' },
] as const;

/** As zonas que a faixa de um treino atravessa, como "Z2–Z3", e a sensação delas. */
export function zoneSpan(objective: Objective) {
  const [low, high] = zones[objective];
  const crossed = heartZones.filter((zone) => zone.from < high && zone.from + 10 > low);
  const [first, last] = [crossed[0], crossed[crossed.length - 1]];
  return {
    ids: first === last ? first.id : first.id + '–' + last.id,
    feel: first === last ? first.feel : first.feel + ' a ' + last.feel,
  };
}

// Nos dias contínuos os 45 minutos incluem uma entrada e uma saída leves.
const continuous: Structure = { warmup: 5, reps: 1, work: 35, recovery: 0, cooldown: 5 };
const base: Session = {
  goal: 'Base aeróbica',
  objective: 'Base aeróbica',
  structure: continuous,
  title: 'Base aeróbica',
  percent: '65–75%',
};

/**
 * A semana no índice de `Date.getDay()`: um treino de 45 minutos de segunda a
 * sábado e o domingo de descanso, como no plano da pessoa. Onde ele escreve
 * "ou caminhada inclinada" o treino é um só: a rampa entra pela escada de
 * cargas quando a faixa pede mais do que a caminhada plana oferece.
 */
export const week: { day: string; session: Session | null }[] = [
  { day: 'Domingo', session: null },
  { day: 'Segunda', session: base },
  {
    day: 'Terça',
    session: {
      goal: 'VO₂máx',
      objective: 'VO₂máx',
      structure: { warmup: 10, reps: 4, work: 4, recovery: 3, cooldown: 7 },
      title: 'VO₂máx',
      percent: '90–95% nos tiros',
    },
  },
  {
    day: 'Quarta',
    session: {
      goal: 'Recuperação ativa',
      objective: 'Recuperação',
      structure: continuous,
      title: 'Recuperação ativa ou caminhada inclinada',
      percent: 'abaixo de 60–65%',
    },
  },
  { day: 'Quinta', session: base },
  {
    day: 'Sexta',
    session: {
      goal: 'Limiar',
      objective: 'Limiar',
      structure: { warmup: 10, reps: 3, work: 8, recovery: 2, cooldown: 5 },
      title: 'Limiar',
      percent: '85–90% nos blocos',
    },
  },
  { day: 'Sábado', session: { ...base, title: 'Base aeróbica ou caminhada inclinada' } },
];

export const sessionMinutes = ({ structure: s }: Session) =>
  s.warmup + s.reps * (s.work + s.recovery) + s.cooldown;

/** A estrutura em uma linha, como aparece na tela e vai no prompt do plano. */
export function describe({ structure: s }: Session) {
  const ends = `${s.warmup} min aquecendo, `;
  return s.reps > 1
    ? `${ends}${s.reps} × ${s.work} min com ${s.recovery} min leves, ${s.cooldown} min desaquecendo`
    : `Contínuo: ${ends}${s.work} min na faixa, ${s.cooldown} min desaquecendo`;
}

/** O plano da sessão com a carga escolhida para os blocos de esforço. */
export function sessionPlan(s: Session, pace: number, grade: number): Plan {
  return {
    ...makePlan(s.goal, s.structure, pace, grade),
    objective: s.objective,
    zone: zones[s.objective],
  };
}
