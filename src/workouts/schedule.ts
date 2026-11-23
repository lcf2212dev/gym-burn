// Qual sessão fazer hoje. O plano não é mais preso ao dia da semana: a pessoa
// pode treinar nos 7 dias e pode faltar em qualquer um, e o dia sem treino
// conta como descanso. A sugestão sai dos treinos dos últimos dias: quando foi
// o último treino forte, quantos houve na semana e se já houve um dia de
// recuperação. Código puro; a tela deixa escolher outra sessão.

import type { Objective } from './adaptive';
import type { Workout } from './model';
import { planObjective } from './physiology';
import { sessions, type Session, type SessionKey } from './week';

/** Um treino só conta para a sugestão com isto de lona andando: menos é um teste ou uma desistência. */
export const COUNTED_MS = 15 * 60_000;
/**
 * Dias de calendário entre dois treinos fortes (VO₂máx ou limiar): com 3, há
 * pelo menos dois dias leves ou de descanso entre eles.
 */
export const HARD_GAP_DAYS = 3;
/** No máximo tantos treinos fortes em 7 dias seguidos, contando hoje. */
export const HARD_PER_WEEK = 2;
/** Depois de um treino forte vem a recuperação ativa, se não houve uma nestes dias. */
const RECOVERY_EVERY_DAYS = 6;

const DAY_MS = 86_400_000;
const hard = (objective: string) => objective === 'VO₂máx' || objective === 'Limiar';
const midnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Um treino que conta: há quantos dias de calendário foi (0 = hoje) e a intensidade dele. */
export type Trained = { ago: number; objective: Objective | string; started: number };

/** Os treinos que contam para a sugestão, do mais novo para o mais antigo. */
export function trained(history: readonly Workout[], now: number): Trained[] {
  return history
    .filter((w) => w.totals.movingMs >= COUNTED_MS && w.started <= now)
    .map((w) => ({
      // Arredondado: no dia em que o horário de verão muda, a meia-noite não fica a 24 h da outra.
      ago: Math.round((midnight(now) - midnight(w.started)) / DAY_MS),
      objective: planObjective(w.plan),
      started: w.started,
    }))
    .sort((a, b) => b.started - a.started);
}

export type Suggestion = { key: SessionKey; session: Session; reason: string };

const ago = (days: number) => (days === 0 ? 'hoje' : days === 1 ? 'ontem' : 'há ' + days + ' dias');
const name = (objective: string) => (objective === 'Limiar' ? 'limiar' : objective);

/**
 * A sessão sugerida para hoje, com o porquê em uma frase.
 *
 * - Treino forte (VO₂máx ou limiar) só com 3 dias de calendário desde o último
 *   e menos de 2 nos últimos 7 dias. Os dois se alternam: vem o que foi feito
 *   há mais tempo; sem nenhum no histórico, o VO₂máx.
 * - Senão o dia é leve: recuperação ativa no dia seguinte a um treino forte,
 *   se não houve uma nos últimos 6 dias; base aeróbica nos demais.
 *
 * Um dia sem treino não precisa de regra própria: ele só aumenta a distância
 * até o último treino forte. Treinando todo dia, a semana fica VO₂máx,
 * recuperação, base, limiar, base, base, base.
 */
export function suggest(history: readonly Workout[], now: number): Suggestion {
  const list = trained(history, now);
  const week = list.filter((t) => t.ago <= 6);
  const lastHard = list.find((t) => hard(t.objective)) ?? null;
  const hardCount = week.filter((t) => hard(t.objective)).length;
  const pick = (key: SessionKey, reason: string): Suggestion => ({ key, session: sessions[key], reason });

  if ((!lastHard || lastHard.ago >= HARD_GAP_DAYS) && hardCount < HARD_PER_WEEK) {
    const key: SessionKey = lastHard?.objective === 'VO₂máx' ? 'threshold' : 'vo2';
    const next = key === 'vo2' ? 'VO₂máx' : 'limiar';
    return pick(
      key,
      lastHard
        ? 'O último treino forte foi ' + ago(lastHard.ago) + ' (' + name(lastHard.objective) + '): hoje cabe ' + next + '.'
        : 'Sem treino forte no histórico: hoje cabe ' + next + '.',
    );
  }

  // O dia é leve. Aqui sempre há um treino forte recente: sem ele o ramo de cima teria valido.
  const last = lastHard!;
  const what = name(last.objective);
  const why =
    last.ago === 0
      ? 'Hoje já teve ' + what + ': se for treinar de novo, que seja leve.'
      : last.ago === 1
        ? 'Ontem foi ' + what + ': hoje é dia leve.'
        : last.ago < HARD_GAP_DAYS
          ? 'O último treino forte foi ' + ago(last.ago) + ' (' + what + '): mais um dia leve antes do próximo.'
          : 'Já foram ' + hardCount + ' treinos fortes nos últimos 7 dias: hoje é dia leve.';
  const recovered = week.some((t) => t.objective === 'Recuperação' && t.ago < RECOVERY_EVERY_DAYS);
  return pick(last.ago <= 1 && !recovered ? 'recovery' : 'base', why);
}

/** Há quantos dias cada sessão foi feita pela última vez (`null` = não está no histórico). */
export function lastDone(history: readonly Workout[], now: number): Record<SessionKey, number | null> {
  const list = trained(history, now);
  const since = (match: (t: Trained) => boolean) => list.find(match)?.ago ?? null;
  const vo2 = since((t) => t.objective === 'VO₂máx');
  return {
    base: since((t) => t.objective === 'Base aeróbica'),
    recovery: since((t) => t.objective === 'Recuperação'),
    threshold: since((t) => t.objective === 'Limiar'),
    // Os dois formatos de VO₂máx gravam a mesma intensidade: o registro não diz qual foi.
    vo2,
    vo2Long: vo2,
  };
}

/** "feito ontem", "feito há 3 dias", "ainda não feito": para a lista de sessões. */
export function lastDoneText(days: number | null) {
  return days === null ? 'ainda não feito' : 'feito ' + ago(days);
}
