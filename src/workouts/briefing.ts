// O que as telas do treino mostram, já decidido: as etapas agrupadas, os fatos
// da sessão do dia, a leitura dos batimentos contra o alvo e a carga contra o
// alvo. Aqui só há conta e texto; as telas só desenham.

import { levels, type MinuteBeats, type Stage, type Workout, type Zone } from './model';
import { describe, heartZones, sessionMinutes, week, type Session } from './week';

/** Etapas iguais do plano numa linha só, como "4 × 4:00 VO₂máx". */
export type StageGroup = {
  count: number;
  name: string;
  seconds: number;
  speed: number;
  incline: number;
  /** Bloco de esforço: é nele que a faixa de batimentos vale. */
  hard: boolean;
};

/** As etapas do plano na ordem em que aparecem, com as repetidas somadas. */
export function groupStages(stages: Stage[]) {
  const groups: StageGroup[] = [];
  for (const stage of stages) {
    // Os tiros se chamam "VO₂máx 1/4", "VO₂máx 2/4"…: o número sai do nome.
    const name = stage.name.replace(/ \d+\/\d+$/, '');
    const same = groups.find(
      (group) =>
        group.name === name &&
        group.seconds === stage.seconds &&
        group.speed === stage.speed &&
        group.incline === stage.incline &&
        group.hard === !stage.measure,
    );
    if (same) same.count++;
    else
      groups.push({
        count: 1,
        name,
        seconds: stage.seconds,
        speed: stage.speed,
        incline: stage.incline,
        hard: !stage.measure,
      });
  }
  return groups;
}

/** O rótulo da faixa, os dois fatos e a frase da estrutura da sessão do dia. */
export function structureFacts(session: Session) {
  const { warmup, reps, work, recovery, cooldown } = session.structure;
  if (reps > 1) {
    // O plano fala em "tiros" no VO₂máx e em "blocos" no limiar.
    const unit = session.percent.includes('blocos') ? 'Blocos' : 'Tiros';
    return {
      label: 'Faixa nos ' + unit.toLowerCase(),
      facts: [
        [`${reps} × ${work} min`, unit + ' na faixa'],
        [`${recovery} min`, 'Leves entre eles'],
      ],
      note: `${warmup} min aquecendo antes e ${cooldown} min desaquecendo depois.`,
    };
  }
  return {
    label: 'Faixa de batimentos',
    facts: [
      [`${work} min`, 'Na faixa'],
      [`${warmup} + ${cooldown} min`, 'Aquecer e desaquecer'],
    ],
    note: describe(session) + '.',
  };
}

/** `inside` é no alvo, `below` e `above` fora dele, `neutral` quando a faixa não se aplica. */
export type HeartTone = 'neutral' | 'inside' | 'below' | 'above';

/**
 * A leitura de agora contra a faixa do dia. Nos blocos de esforço do treino
 * guiado (`chasing`) o alvo é o alto da faixa: dentro dela, mas longe do teto,
 * ainda falta carga. Nas etapas leves (`easy`) ficar abaixo é o esperado.
 */
export function heartStatus({
  bpm,
  target,
  aimLow,
  chasing,
  easy,
}: {
  bpm: number | null;
  target: Zone;
  aimLow: number;
  chasing: boolean;
  easy: boolean;
}): { tone: HeartTone; text: string } {
  if (bpm === null) return { tone: 'neutral', text: 'Segure o sensor para ler' };
  if (bpm > target.high) return { tone: 'above', text: bpm - target.high + ' bpm acima do alvo' };
  const below = bpm < target.low;
  if (below && easy) return { tone: 'neutral', text: 'Etapa leve' };
  const tone = below ? 'below' : 'inside';
  if (chasing && !easy && bpm < aimLow) return { tone, text: target.high - bpm + ' bpm abaixo do teto' };
  return below ? { tone, text: target.low - bpm + ' bpm abaixo do alvo' } : { tone, text: 'No alvo' };
}

/** A carga lida da esteira bate com a do guia, a menos do arredondamento do painel. */
export function onTarget(actual: number | null, target: number | null) {
  return actual !== null && target !== null && Math.abs(actual - target) < 0.05 + 1e-9;
}

/** Treinos e tempo em movimento dos últimos `days` dias. */
export function recentActivity(history: Workout[], now: number, days = 21) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = history.filter((w) => w.started >= since);
  return { count: recent.length, movingMs: recent.reduce((sum, w) => sum + w.totals.movingMs, 0) };
}

/** Duração em horas e minutos, como "1 h 15 min"; abaixo de uma hora, só os minutos. */
export function formatHours(ms: number) {
  const minutes = Math.round(ms / 60000);
  const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
  return [hours ? hours + ' h' : '', rest || !hours ? rest + ' min' : ''].filter(Boolean).join(' ');
}

/**
 * O degrau do nível da IA, de 0 (em adaptação) a 2 (base consistente). Sem
 * avaliação, ou com dados insuficientes, não há degrau.
 */
export function levelStep(level: string | undefined) {
  const index = levels.indexOf(level as (typeof levels)[number]);
  return index > 0 ? index - 1 : null;
}

/** A média de BPM de cada minuto da sessão; `null` no minuto sem leitura. */
export function minuteColumns(beats: MinuteBeats[] | undefined, minutes: number) {
  return Array.from({ length: minutes }, (_, minute) => {
    const [sum, count] = beats?.[minute] ?? [0, 0];
    return count ? Math.round(sum / count) : null;
  });
}

/** A zona de um batimento, de 0 (Z1) a 4 (Z5), pela FC máxima. */
export function zoneOf(bpm: number, max: number) {
  return Math.max(0, heartZones.findLastIndex((zone) => bpm >= (max * zone.from) / 100));
}

/** Acerto dos cenários, em porcentagem inteira. */
export function scorePercent(correct: number, runs: number) {
  return runs ? Math.round((100 * correct) / runs) : 0;
}

/** O treino de hoje no plano semanal, em uma linha, para o rodapé da tela inicial. */
export function todayLine(day: number) {
  const { day: name, session } = week[day];
  return (
    'Hoje · ' + name + ' · ' + (session ? session.goal + ' · ' + sessionMinutes(session) + ' min' : 'descanso')
  );
}
