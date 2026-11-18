import { objectives, type Objective } from './adaptive';
import {
  median,
  validBpm,
  type HeartProfile,
  type Plan,
  type Profile,
  type Workout,
  type Zone,
} from './model';

export type Pulse = { at: number; bpm: number };

/** Duas leituras separadas por mais que isto pertencem a pegadas diferentes no sensor. */
export const CONTACT_GAP_MS = 3000;

export const foxMax = (age: number) => 220 - age;
export const tanakaMax = (age: number) => Math.round(208 - 0.7 * age);

/**
 * Limites aceitos para a FC máxima prevista pela IA. Caminhada submáxima não
 * mede a máxima: o erro típico de qualquer previsão é de ±10 bpm. O pico já
 * observado é o único dado duro, e vale como piso.
 */
export function maxBounds(age: number, peak: number | null) {
  const estimates = [foxMax(age), tanakaMax(age)];
  const low = Math.max(Math.min(...estimates) - 10, peak ?? 0);
  return { low, high: Math.max(Math.max(...estimates) + 10, low) };
}

/** Maior pico validado (mediana de 3 leituras seguidas) entre as sessões. */
export function observedPeak(history: Workout[]) {
  const top = Math.max(0, ...history.flatMap((w) => (w.log ?? []).map((l) => l?.top ?? 0)));
  return top || null;
}

/**
 * Leitura de repouso do dia. A esteira só lê batimentos com a lona andando,
 * então vale a leitura mais cedo possível: as primeiras do treino, sem as 2
 * iniciais de cada pegada (o sensor de mão ainda está estabilizando). Fica de
 * 10 a 20 bpm acima do repouso real; `heartProfile` desconta isso. `closed`
 * indica que a janela inicial acabou.
 */
export function restingBpm(readings: Pulse[], closed: boolean): number | null {
  const kept: number[] = [];
  let contact = 0;
  let last = -Infinity;
  for (const r of readings) {
    contact = r.at - last > CONTACT_GAP_MS ? 1 : contact + 1;
    last = r.at;
    if (contact > 2) kept.push(r.bpm);
  }
  if (kept.length >= 5) return median(kept.slice(0, 5));
  return closed && kept.length >= 4 ? median(kept) : null;
}

/**
 * Quanto a leitura do primeiro minuto fica acima do repouso real: a pessoa já
 * está em pé e andando devagar. Sem esse desconto a faixa pela reserva subiria
 * mais de 10 bpm para uma pessoa típica.
 */
export const WALKING_OFFSET_BPM = 15;

/**
 * Repouso e máxima em uso, a partir do histórico da mesma origem (mais novo
 * primeiro). O repouso é a menor das 5 últimas leituras de início de treino,
 * menos o desconto de quem já está andando. A máxima é a mediana das 3 últimas
 * previsões da IA, para uma resposta ruim não deslocar a faixa sozinha.
 */
export function heartProfile(profile: Profile, history: Workout[]): HeartProfile {
  const rests = history
    .map((w) => w.restBpm)
    .filter(validBpm)
    .slice(0, 5);
  const predicted = history
    .map((w) => w.estimate?.maxBpm)
    .filter(validBpm)
    .slice(0, 3);
  return {
    rest: rests.length ? Math.min(...rests) - WALKING_OFFSET_BPM : null,
    max: predicted.length ? median(predicted) : foxMax(profile.age),
    maxSource: predicted.length ? 'IA' : 'idade',
  };
}

// Percentuais da FC máxima (método sem repouso) e da reserva (com repouso). Os
// da reserva são os equivalentes dos primeiros para uma pessoa típica (repouso
// 70, máxima 180): trocar de método não aumenta a intensidade pedida.
const bands: Record<Objective, { max: [number, number]; reserve: [number, number] }> = {
  'Recuperação leve': { max: [50, 60], reserve: [20, 35] },
  'Base aeróbica': { max: [55, 65], reserve: [28, 43] },
  'Resistência moderada': { max: [60, 70], reserve: [35, 50] },
};

/** O repouso individualiza a faixa, mas só a desloca até este tanto da faixa pela máxima. */
const MAX_SHIFT_BPM = 10;

function zoneFor(objective: Objective, profile: Profile, hr?: HeartProfile) {
  const max = hr?.max ?? foxMax(profile.age);
  const rest = hr?.rest ?? null;
  const byMax = bands[objective].max.map((percent) => (max * percent) / 100);
  // Um repouso colado na máxima é leitura ruim: a reserva não serve de base.
  if (rest === null || max - rest < 40)
    return { low: Math.round(byMax[0]), high: Math.round(byMax[1]), method: 'máxima' } as const;
  // A leitura de repouso vem de um sensor de mão, com a pessoa já andando. O
  // limite impede que uma leitura ruim leve a faixa para longe da estimativa.
  const [low, high] = bands[objective].reserve.map((percent, i) => {
    const value = rest + ((max - rest) * percent) / 100;
    return Math.round(Math.min(byMax[i] + MAX_SHIFT_BPM, Math.max(byMax[i] - MAX_SHIFT_BPM, value)));
  });
  return { low, high, method: 'reserva' } as const;
}

export function planObjective(plan: Plan | null): Objective {
  return (
    plan?.objective ??
    (plan?.goal === 'Recuperação ativa'
      ? objectives[0]
      : plan?.goal === 'Resistência'
        ? objectives[2]
        : objectives[1])
  );
}

/** Faixa orientativa de BPM do treino. Sem plano (treino livre) vale a base aeróbica. */
export function dailyTarget(plan: Plan | null, profile: Profile, hr?: HeartProfile) {
  const objective = planObjective(plan);
  return { objective, ...zoneFor(objective, profile, hr) };
}

/** A faixa de cada objetivo para esta pessoa, como vai no prompt do plano. */
export function zones(profile: Profile, hr?: HeartProfile) {
  return Object.fromEntries(
    objectives.map((o) => {
      const { low, high } = zoneFor(o, profile, hr);
      return [o, { low, high }];
    }),
  ) as Record<Objective, Zone>;
}
