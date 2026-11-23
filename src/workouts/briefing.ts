// O que as telas do treino mostram, já decidido: as etapas agrupadas, os fatos
// da sessão do dia, a leitura dos batimentos contra o alvo e a carga contra o
// alvo. Aqui só há conta e texto; as telas só desenham.

import { formatDecimal, formatDuration, formatTrimmed } from '@/utils/format';
import { SHORT_BLOCK_SECONDS } from './adaptive';
import { betweenBlocks } from './intervals';
import { levels, validBpm, type MinuteBeats, type Plan, type Stage, type Workout, type Zone } from './model';
import { FATIGUE_TIP } from './gait';
import {
  BASELINE_MIN_DAYS,
  HRV_STILL_MS,
  STILL_MIN_MS,
  type HrvCheck,
  type Readiness,
  type ReadinessLock,
} from './rest';
import type { GaitView, NextBlockView, RecoveryView } from './session';
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

/**
 * O rodapé do bloco de velocidade do painel: a cadência e a passada, com a
 * cadência da X2 Pro. `null` sem cadência.
 */
export function gaitLine(gait: Pick<GaitView, 'cadenceSpm' | 'strideM'> | null) {
  if (!gait || gait.cadenceSpm === null) return null;
  const stride = gait.strideM === null ? '' : ' · ' + formatDecimal(gait.strideM, 2) + ' m';
  return gait.cadenceSpm + ' passos/min' + stride;
}

/** O mesmo rodapé para o leitor de tela. */
export function gaitSpoken(gait: Pick<GaitView, 'cadenceSpm' | 'strideM'> | null) {
  if (!gait || gait.cadenceSpm === null) return '';
  const stride = gait.strideM === null ? '' : ', passada de ' + formatDecimal(gait.strideM, 2) + ' metro';
  return ', cadência de ' + gait.cadenceSpm + ' passos por minuto' + stride;
}

/** Nos primeiros segundos do bloco, a linha de baixo diz como terminou a recuperação antes dele. */
const ENDED_NOTE_SECONDS = 30;

/**
 * A linha de baixo do cartão da etapa, quando há algo mais importante que "A
 * seguir". `spoken` é o texto inteiro para o leitor de tela, quando o da linha
 * vai encurtado.
 */
export type StageNote = { text: string; tone: 'warn' | 'info'; spoken?: string };

/**
 * A dica no cartão, curta: a linha divide o espaço com "Ver aviso", e a
 * reticência cortaria justamente o que fazer. A regra e o texto da sessão não mudam.
 */
const SHORT_TIPS: Record<string, string> = { [FATIGUE_TIP]: 'Cadência caindo · passos curtos e rápidos' };

/**
 * O que o cartão da etapa mostra no lugar de "A seguir", nesta ordem: a pessoa
 * fora da lona; a dica do momento (`tip`, a cadência caindo), num lugar que o
 * texto do guia não sobrescreve; numa recuperação, a carga do próximo bloco já
 * decidida; e, nos primeiros 30 s de um bloco, como o coração encerrou a
 * recuperação antes dele. `null` quando vale o "A seguir".
 */
export function stageNote({
  plan,
  index,
  into,
  gait,
  tip,
  recovery,
  nextBlock,
}: {
  plan: Plan;
  index: number;
  into: number;
  gait: Pick<GaitView, 'offBelt'> | null;
  tip: string;
  recovery: RecoveryView | null;
  nextBlock: NextBlockView | null;
}): StageNote | null {
  if (gait?.offBelt) return { text: 'Fora da lona · a carga não sobe', tone: 'warn' };
  if (tip) return { text: SHORT_TIPS[tip] ?? tip, tone: 'warn', spoken: tip };
  if (nextBlock && nextBlock.index > index) {
    const stage = plan.stages[nextBlock.index];
    const name = stage && stage.seconds <= SHORT_BLOCK_SECONDS ? 'Próximo tiro' : 'Próximo bloco';
    const load = formatDecimal(nextBlock.speed, 1) + ' km/h e ' + formatTrimmed(nextBlock.incline, 1) + '%';
    const verdict = !nextBlock.changed
      ? 'mesma carga'
      : nextBlock.verdict === 'reduzir'
        ? 'carga reduzida'
        : nextBlock.verdict === 'aumentar'
          ? 'carga aumentada'
          : // Um "manter" que muda a carga leva adiante a do fim do tiro anterior.
            'carga do anterior mantida';
    return { text: name + ' · ' + load + ' · ' + verdict, tone: 'info' };
  }
  if (recovery && recovery.index === index - 1 && recovery.reason !== 'plano' && into < ENDED_NOTE_SECONDS) {
    const time = formatDuration(recovery.seconds);
    return {
      text:
        recovery.seconds < recovery.planned
          ? 'Recuperação encerrada mais cedo, aos ' + time
          : 'Recuperação alongada: terminou aos ' + time,
      tone: 'info',
    };
  }
  return null;
}

/**
 * Numa recuperação entre dois blocos de esforço, o estado dela, para o
 * cartão da etapa: alongada pelo coração, encerrada mais cedo, de volta ao
 * tempo do plano (sem leitura) ou, ainda sem mudança, guiada pelo coração
 * (com a cinta) ou no tempo do plano. `null` fora dessas recuperações.
 */
export function recoveryLabel({
  plan,
  index,
  recovery,
  strap,
}: {
  plan: Plan;
  index: number;
  recovery: RecoveryView | null;
  /** Há leitura da cinta agora. */
  strap: boolean;
}) {
  if (!betweenBlocks(plan, index)) return null;
  if (recovery?.index === index) {
    if (recovery.reason === 'alongada') return 'alongada até ' + formatDuration(recovery.seconds);
    if (recovery.reason === 'cedo') return 'encerrada mais cedo';
    return 'no tempo do plano';
  }
  return strap ? 'guiada pelo coração' : 'no tempo do plano';
}

/** Como o repouso de um treino foi medido, para a Evolução: "repouso 62" parado, "1º minuto 86" andando. */
export function restLabel(w: Pick<Workout, 'restBpm' | 'restSource'>) {
  if (!validBpm(w.restBpm)) return null;
  return (w.restSource === 'parado' ? 'repouso ' : '1º minuto ') + w.restBpm;
}

/**
 * A cadência média do treino com a lona andando, em passos/min, sem os
 * segundos fora da lona (em que ela é zero). `null` sem cadência.
 */
export function averageCadence(w: Workout) {
  const t = w.totals;
  const off = (w.log ?? []).reduce((sum, l) => sum + (l?.offBeltMs ?? 0), 0);
  const ms = (t.cadenceDurationMs ?? 0) - off;
  return ms > 0 && t.cadenceMs ? Math.round(t.cadenceMs / ms) : null;
}

/**
 * Uma das duas metas da medida parado em curso, para o cartão: o rótulo, o
 * andamento em texto e a fração (`null` sem barra, quando a meta não vai ser
 * cumprida agora).
 */
export type StillGoal = { label: string; text: string; share: number | null; done: boolean };

/** Hora e minuto locais, "14:05". */
function clock(ms: number) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Por que a prontidão não vai ser gravada agora, em poucas palavras (veja `readinessLock`). */
function lockText(lock: NonNullable<ReadinessLock>) {
  return lock.reason === 'antes-do-treino'
    ? 'A prontidão de hoje só vale antes do treino'
    : 'Prontidão de novo 3 h depois do treino';
}

/**
 * As duas metas da medida parado em curso: o repouso, com 60 s, e a
 * prontidão, com 2 minutos. `restReady` diz se a janela já dá o repouso (um
 * trecho de 30 s coerente); `hrv`, o estado da HRV nela. Com a prontidão
 * travada (`lock`), a meta dela diz por quê, sem andamento.
 */
export function stillGoals({
  seconds,
  restReady,
  hrv,
  lock,
}: {
  seconds: number;
  restReady: boolean;
  hrv: 'pronta' | NonNullable<HrvCheck['reason']> | null;
  lock: ReadinessLock;
}): StillGoal[] {
  const restTarget = STILL_MIN_MS / 1000;
  const hrvTarget = HRV_STILL_MS / 1000;
  const rest: StillGoal = restReady
    ? { label: 'Repouso · 60 s', text: 'pronto', share: 1, done: true }
    : seconds >= restTarget
      ? { label: 'Repouso · 60 s', text: 'leitura instável; fique parado mais um pouco', share: 1, done: false }
      : { label: 'Repouso · 60 s', text: seconds + ' de ' + restTarget + ' s', share: seconds / restTarget, done: false };
  const label = 'Prontidão · 2 min';
  const readiness: StillGoal = lock
    ? { label, text: lockText(lock), share: null, done: false }
    : hrv === 'pronta'
      ? { label, text: 'pronta', share: 1, done: true }
      : hrv === 'instavel'
        ? { label, text: 'leitura instável: umedeça os eletrodos e repita', share: 1, done: false }
        : hrv === 'sem-rr'
          ? { label, text: 'a cinta não manda os intervalos entre batimentos', share: null, done: false }
          : seconds >= hrvTarget
            ? { label, text: 'fique parado mais um pouco', share: 1, done: false }
            : {
                label,
                text: formatDuration(seconds) + ' de ' + formatDuration(hrvTarget),
                share: seconds / hrvTarget,
                done: false,
              };
  return [rest, readiness];
}

/** Nos 10 minutos depois de um treino a janela parado não coleta: o cartão diz quanto falta. */
export function stillWaitText(waitMs: number) {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return (
    'Medida parado em espera: a FC ainda é a do treino. Volta a medir em ' +
    minutes +
    (minutes === 1 ? ' minuto.' : ' minutos.')
  );
}

/** `normal`, `up` e `down` comparam com a própria pessoa; `pending` ainda não compara. */
export type ReadinessTone = 'normal' | 'up' | 'down' | 'pending';

/**
 * O que o cartão de prontidão diz: o estado, o detalhe e a cor. Sem medida
 * hoje, o detalhe diz por que ela não vai sair agora (`lock`: depois de um
 * treino) ou por que a última tentativa foi recusada (`issue`: a leitura da
 * cinta instável, ou sem RR); senão, como medir.
 */
export function readinessCopy(
  r: Readiness,
  { lock = null, issue = null }: { lock?: ReadinessLock; issue?: 'instavel' | 'sem-rr' | null } = {},
): { title: string; detail: string; tone: ReadinessTone } {
  const days = (n: number) => n + (n === 1 ? ' dia medido' : ' dias medidos');
  if (r.state === 'sem-medida') {
    const base = r.days ? ' Sua base tem ' + days(r.days) + ' nas últimas 4 semanas.' : '';
    const detail =
      lock?.reason === 'depois-do-treino'
        ? 'Prontidão de novo 3 h depois do treino, a partir das ' +
          clock(lock.until) +
          ': logo depois do esforço a variabilidade sai deprimida.'
        : lock?.reason === 'antes-do-treino'
          ? 'A prontidão de hoje só vale antes do treino.'
          : issue === 'instavel'
            ? 'A leitura da cinta estava instável e a prontidão não foi gravada. Umedeça os eletrodos, ajuste a cinta e repita: 2 minutos parado na esteira antes de ligar a lona.'
            : issue === 'sem-rr'
              ? 'A cinta não mandou os intervalos entre batimentos (RR), e sem eles não há prontidão.'
              : 'Para medir, vista a cinta no peito, suba na esteira e fique parado por 2 minutos antes de ligar a lona (o repouso sai com 1 minuto).' +
                base;
    return { title: 'Sem medida hoje', detail, tone: 'pending' };
  }
  const rmssd = 'RMSSD de ' + Math.round(r.today.rmssd) + ' ms hoje';
  if (r.state === 'coletando')
    return {
      title: 'Coletando (' + r.days + ' de ' + BASELINE_MIN_DAYS + ' dias)',
      detail:
        rmssd +
        '. A comparação começa com ' +
        BASELINE_MIN_DAYS +
        ' dias medidos nas últimas 4 semanas, sem contar hoje.',
      tone: 'pending',
    };
  const base = ' da sua variação nos últimos ' + days(r.days) + '.';
  if (r.state === 'abaixo')
    return {
      title: 'Abaixo do seu normal',
      detail: rmssd + ', abaixo' + base + ' Sugestão: uma sessão leve hoje.',
      tone: 'down',
    };
  if (r.state === 'acima') return { title: 'Acima do seu normal', detail: rmssd + ', acima' + base, tone: 'up' };
  return { title: 'No seu normal', detail: rmssd + ', dentro' + base, tone: 'normal' };
}
