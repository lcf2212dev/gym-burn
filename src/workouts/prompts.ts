// Prompts enviados à DeepSeek e validação das respostas. Tudo aqui é função
// pura, sem Expo, para ser testado direto e usado pelos cenários de diagnóstico.
//
// Três regras valem para os três prompts: o modelo recebe números já
// calculados pelo app (não precisa comparar nem fazer conta), cada opção tem
// definição escrita, e o formato de saída é descrito por tipo, sem exemplo
// preenchido que puxe a resposta para um valor.

import {
  decisions,
  objectives,
  type Decision,
  type Features,
  type Load,
  type Objective,
  type Reading,
} from './adaptive';
import {
  evidence,
  goals,
  inRange,
  levels,
  median,
  validSession,
  type Estimate,
  type Goal,
  type Profile,
  type StageLog,
  type Workout,
  type Zone,
} from './model';
import {
  dailyTarget,
  foxMax,
  heartProfile,
  maxBounds,
  observedPeak,
  tanakaMax,
  zones,
} from './physiology';

export const PROMPT_VERSION = '2';
export type Prompt = { system: string; user: object };

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = <T>(items: T[], pick: (item: T) => number) => items.reduce((a, b) => a + pick(b), 0);
const list = (items: readonly string[]) => items.map((i) => `"${i}"`).join(', ');
// Alguns modelos devolvem número entre aspas ou com vírgula decimal.
const num = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN;
const position = (bpm: number, zone: Zone) =>
  bpm > zone.high ? 'acima' : bpm < zone.low ? 'abaixo' : 'na faixa';

function localTime(now: number) {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  const day = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getDay()];
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} (${day})`;
}

// --- Resumos das sessões ---------------------------------------------------

function group(w: Workout, indexes: number[]) {
  const logs = indexes.map((i) => w.log?.[i]).filter((l): l is StageLog => !!l && l.ms > 0);
  if (!logs.length) return null;
  const ms = sum(logs, (l) => l.ms);
  const inclineDuration = sum(logs, (l) => l.inclineDurationMs);
  const ends = logs.filter((l) => l.tail.length >= 3).map((l) => median(l.tail));
  const planned = w.plan?.stages[indexes[indexes.length - 1]];
  return {
    seconds: Math.round(ms / 1000),
    kmh: round1((sum(logs, (l) => l.distanceM) * 3600) / ms),
    inclinePercent: inclineDuration
      ? round1(sum(logs, (l) => l.inclineMs) / inclineDuration)
      : null,
    plannedKmh: planned?.speed ?? null,
    plannedInclinePercent: planned?.incline ?? null,
    bpmEnd: ends.length ? median(ends) : null,
    bpmReadings: sum(logs, (l) => l.bpmCount),
  };
}

/** Tudo o que foi medido numa sessão, no formato que os prompts recebem. */
export function summarize(w: Workout) {
  const base = evidence(w);
  const zone = dailyTarget(w.plan, w.profile, w.hr);
  const stages = w.plan?.stages ?? [];
  const logs = w.log ?? [];
  const done = logs.map((_, i) => i).filter((i) => (logs[i]?.ms ?? 0) > 0);
  // No treino livre não há etapas: o registro único conta como bloco principal.
  const work = w.plan ? done.filter((i) => stages[i] && !stages[i].measure) : done;
  const easy = w.plan ? done.filter((i) => stages[i]?.measure) : [];
  const counts = [0, 1, 2].map((k) => sum(logs, (l) => l?.zone[k] ?? 0));
  const total = counts[0] + counts[1] + counts[2];
  const drops: number[] = [];
  for (const i of easy) {
    const before = logs[i - 1];
    if (i > 0 && !stages[i - 1].measure && before?.tail.length >= 3 && logs[i].early.length >= 2)
      drops.push(median(before.tail) - median(logs[i].early));
  }
  const changes = w.changes ?? [];
  return {
    ...base,
    objective: zone.objective,
    completionPercent: w.plan
      ? Math.min(100, Math.round((100 * base.movingSeconds) / (w.plan.minutes * 60)))
      : null,
    bpmCoveragePercent: base.movingSeconds
      ? Math.min(100, Math.round((100 * base.bpmReadings) / base.movingSeconds))
      : 0,
    zone: { low: zone.low, high: zone.high, method: zone.method },
    zoneSharePercent: total
      ? {
          below: Math.round((100 * counts[0]) / total),
          inside: Math.round((100 * counts[1]) / total),
          above: Math.round((100 * counts[2]) / total),
        }
      : null,
    work: group(w, work),
    easy: group(w, easy),
    recoveryDrops: drops.slice(0, 6),
    reductions: changes.filter((c) => c.decision.startsWith('reduzir')).length,
    increases: changes.filter((c) => c.decision.startsWith('aumentar')).length,
    restBpm: w.restBpm ?? null,
    validatedPeakBpm: observedPeak([w]),
  };
}

function stageList(w: Workout) {
  const rows = (w.plan?.stages ?? []).flatMap((stage, i) => {
    const s = group(w, [i]);
    return s
      ? [{ name: stage.name, kind: stage.measure ? 'leve' : 'principal', ...s }]
      : [];
  });
  // Uma lista longa de blocos iguais só dilui o que importa: o resumo basta.
  return rows.length && rows.length <= 14 ? rows : undefined;
}

/** Uma sessão anterior em poucas linhas. `now` é o instante de referência de `daysAgo`. */
export function historyItem(w: Workout, now: number) {
  const s = summarize(w);
  // Registros anteriores à 2.1 não têm dados por etapa: sobram as médias da sessão.
  const work = s.work ?? { kmh: s.averageKmh, inclinePercent: s.averageIncline, bpmEnd: s.averageBpm };
  return {
    daysAgo: Math.max(0, Math.floor((now - w.started) / 86400000)),
    goal: s.goal,
    objective: s.objective,
    plannedMinutes: s.plannedMinutes,
    movingMinutes: Math.round(s.movingSeconds / 60),
    completionPercent: s.completionPercent,
    work: { kmh: work.kmh, inclinePercent: work.inclinePercent, bpmEnd: work.bpmEnd },
    zone: { low: s.zone.low, high: s.zone.high },
    position: work.bpmEnd === null ? null : position(work.bpmEnd, s.zone),
    recoveryDrops: s.recoveryDrops,
    reductions: s.reductions,
    increases: s.increases,
    restBpm: s.restBpm,
    level: w.estimate?.level ?? null,
    maxBpm: w.estimate?.maxBpm ?? null,
    endedBy: s.endedBy,
    ...(s.work ? {} : { approximate: true }),
  };
}

/** As 5 sessões válidas mais recentes. Fragmentos de segundos ficam de fora. */
export const recentValid = (history: Workout[]) => history.filter(validSession).slice(0, 5);

// --- Plano do dia ----------------------------------------------------------

/**
 * Até onde o plano de hoje pode ir. Com histórico: meio km/h e 1% acima da
 * maior carga principal recente. Sem histórico: o teto do nível de atividade.
 */
export function progressionCeiling(profile: Profile, history: Workout[], now: number) {
  const done = recentValid(history)
    .map((w) => historyItem(w, now).work)
    .filter((w) => w.kmh !== null);
  if (!done.length) {
    const [pace, grade] =
      profile.activity === 'Treinado' ? [7, 4] : profile.activity === 'Ativo' ? [6, 3] : [5, 2];
    return { pace, grade };
  }
  return {
    pace: Math.min(9, round1(Math.max(...done.map((w) => w.kmh ?? 0)) + 0.5)),
    grade: Math.min(5, Math.ceil((Math.max(...done.map((w) => w.inclinePercent ?? 0)) + 1) * 2) / 2),
  };
}

const PLAN = `Você escolhe os parâmetros do treino de esteira de hoje para uma pessoa, a partir do perfil, das faixas de batimentos e do histórico medido pelo app. A esteira é ajustada à mão no painel pela própria pessoa; o app só orienta.

ENTRADA (json)
- today: data e hora locais.
- profile: age (anos), weightKg, heightCm e activity (nível de atividade declarado; null se não informado).
- hr: restBpm (FC de repouso estimada: a menor leitura do primeiro minuto dos últimos treinos, menos 15 bpm porque a pessoa já está andando; null se nunca medida), maxBpm (FC máxima estimada) e maxSource ("idade" = 220 − idade; "IA" = previsão a partir de sessões anteriores).
- zones: faixa de BPM desta pessoa para cada objetivo fisiológico.
- minutes: duração total pedida. goal: modo escolhido pela pessoa, ou null.
- ceiling: maiores pace e grade que o app aceita hoje. Valores acima são cortados.
- recent: sessões válidas mais recentes, da mais nova para a mais antiga. Cada uma traz daysAgo (0 = menos de 24 h), goal, objective, plannedMinutes, movingMinutes, completionPercent, work (carga principal realmente feita: kmh, inclinePercent, e bpmEnd = BPM no fim dos blocos de esforço), zone (faixa daquele dia), position (bpmEnd em relação à faixa: "abaixo", "na faixa", "acima" ou null sem leitura), recoveryDrops (queda de BPM em 1 min de recuperação), reductions e increases (ajustes de carga pedidos durante a sessão), restBpm, level (avaliação daquela sessão) e endedBy (como terminou). Sessões com approximate = true vêm de registros antigos sem dados por etapa: work traz médias da sessão inteira, que ficam abaixo da carga principal real.

COMO O APP MONTA A SESSÃO A PARTIR DA SUA RESPOSTA
- Aquecimento e volta à calma: cada um dura min(5, minutes ÷ 5) minutos, a 0% de inclinação, no ritmo leve.
- Ritmo leve = o menor entre pace, 4 km/h e 80% de pace.
- Parte principal: alterna blocos de esforço (pace e grade) de cerca de workMinutes com blocos de recuperação (ritmo leve, 0%) de cerca de recoveryMinutes. O app arredonda a quantidade de blocos para caber em minutes.
- No modo "Intervalado" há recuperação depois de todo bloco de esforço. Nos outros modos, só entre blocos.
- No modo "Recuperação ativa" o app limita pace a 4,5 km/h e grade a 1%.
- Cada troca de bloco obriga a pessoa a ajustar velocidade e inclinação no painel. Fora do "Intervalado", prefira blocos longos (workMinutes de 8 a 20) com recuperação curta (recoveryMinutes 1 ou 2).

MODOS (goal)
- "Intervalado": blocos de esforço curtos (workMinutes 2 a 5) com recuperação de 1 a 3 minutos.
- "Recuperação ativa": caminhada leve e contínua, para o dia seguinte a um esforço ou para a volta depois de uma pausa.
- "Queima de gordura": caminhada contínua e longa em intensidade leve a moderada.
- "Resistência": caminhada rápida e sustentada.
- "Caminhada inclinada": velocidade moderada com grade de 2 a 5.
Se goal vier preenchido na entrada, a pessoa já escolheu: devolva exatamente esse modo.

OBJETIVO FISIOLÓGICO (objective)
O app usa a faixa de BPM do objetivo escolhido (veja zones) para acompanhar o treino.
- "Recuperação leve": esforço muito leve. Use no modo "Recuperação ativa", em pessoa sedentária sem histórico, depois de uma sessão dura ou com menos de 24 h de descanso.
- "Base aeróbica": esforço leve a moderado, que dá para sustentar conversando. É o padrão.
- "Resistência moderada": esforço moderado. Só quando recent tem 3 ou mais sessões concluídas (completionPercent ≥ 90) sem reductions.

COMO ESCOLHER pace E grade
1. Sem sessões em recent, parta do nível de atividade. "Sedentário" ou null: pace de 3,5 a 4,5 e grade de 0 a 1. "Ativo": pace de 4,5 a 5,5 e grade de 0 a 2. "Treinado": pace de 5,5 a 6,5 e grade de 1 a 3. Com mais de 55 anos, fique na metade de baixo dessas faixas.
2. Com sessões em recent, parta da carga principal realmente feita (work.kmh e work.inclinePercent) na sessão mais recente de modo parecido, não do que estava planejado.
- Suba um único passo (pace +0,2 ou +0,3, ou grade +0,5; nunca os dois) só se aquela sessão foi concluída (completionPercent ≥ 90), sem reductions, e com position "abaixo".
- Mantenha a carga se position foi "na faixa" ou null.
- Recue um passo (pace −0,3 ou grade −0,5) se position foi "acima", se houve reductions ou se a sessão parou antes de 70%.
- Com mais de 14 dias desde a última sessão, recue um passo.
- Se a última sessão foi há menos de 24 h (daysAgo = 0) com objetivo "Resistência moderada", escolha hoje um objetivo mais leve.
3. O modo muda a forma, não a regra: em "Caminhada inclinada" a progressão vai para grade; em "Intervalado" o pace do bloco de esforço pode ficar até 0,5 acima da carga contínua recente.
4. Na dúvida entre dois valores, escolha o mais conservador.

SAÍDA
Responda somente com um objeto json, neste formato:
{"why": "<frase>", "goal": "<modo>", "objective": "<objetivo>", "pace": <número>, "grade": <número>, "workMinutes": <inteiro>, "recoveryMinutes": <inteiro>}
- why: uma frase em português do Brasil, com até 160 caracteres, dizendo em que dados da entrada a escolha se apoia. Sem promessa de emagrecimento ou de saúde.
- goal: um de ${list(goals)}.
- objective: um de ${list(objectives)}.
- pace: de 1 a 9, em km/h, com uma casa decimal.
- grade: de 0 a 5, em %, múltiplo de 0,5.
- workMinutes: inteiro de 1 a 20. recoveryMinutes: inteiro de 1 a 10.`;

export type PlanInput = {
  profile: Profile;
  minutes: number;
  goal: Goal | null;
  history: Workout[];
  now: number;
};

export function planPrompt({ profile, minutes, goal, history, now }: PlanInput): Prompt {
  const hr = heartProfile(profile, history);
  return {
    system: PLAN,
    user: {
      today: localTime(now),
      profile: { ...profile, activity: profile.activity ?? null },
      hr: { restBpm: hr.rest, maxBpm: hr.max, maxSource: hr.maxSource },
      zones: zones(profile, hr),
      minutes,
      goal,
      ceiling: progressionCeiling(profile, history, now),
      recent: recentValid(history).map((w) => historyItem(w, now)),
    },
  };
}

export type PlanChoice = {
  why: string;
  goal: Goal;
  objective: Objective;
  pace: number;
  grade: number;
  workMinutes: number;
  recoveryMinutes: number;
};

export function parsePlan(raw: unknown): PlanChoice {
  const r = (raw ?? {}) as Record<string, unknown>;
  const choice = {
    why: typeof r.why === 'string' ? r.why.trim().slice(0, 240) : '',
    goal: r.goal as Goal,
    objective: r.objective as Objective,
    pace: num(r.pace),
    grade: num(r.grade),
    workMinutes: Math.round(num(r.workMinutes)),
    recoveryMinutes: Math.round(num(r.recoveryMinutes)),
  };
  if (
    !goals.includes(choice.goal) ||
    !objectives.includes(choice.objective) ||
    !inRange(choice.pace, 1, 9) ||
    !inRange(choice.grade, 0, 5) ||
    !inRange(choice.workMinutes, 1, 20) ||
    !inRange(choice.recoveryMinutes, 1, 10)
  )
    throw new Error('A IA retornou alvos fora da faixa do guia.');
  return choice;
}

// --- Revisão durante o treino ----------------------------------------------

const REVIEW = `Você acompanha um treino de esteira em andamento e decide se a carga da etapa atual deve mudar agora. A pessoa ajusta a esteira à mão no painel: cada mudança que você pedir interrompe a caminhada com um aviso sonoro. Peça mudança só quando os dados sustentam.

ENTRADA (json)
- zone: objective, low e high em BPM (faixa orientativa de hoje) e method ("reserva" = calculada com FC de repouso e máxima estimadas; "máxima" = só com a máxima estimada). É uma estimativa com erro de vários bpm, não um limiar medido.
- stage: name, kind ("principal" = bloco de esforço; "leve" = aquecimento, recuperação ou volta à calma), targetKmh, targetInclinePercent, secondsInStage, secondsRemaining, targetsReached (a esteira está nos dois alvos) e secondsAtLoad (há quanto tempo está neles; 0 se não está).
- bpm: resumo das leituras válidas do sensor de mão. count, spanSeconds, median, latest, min, max, trend ("subindo", "estável" ou "caindo": compara a segunda metade das leituras com a primeira e só acusa mudança de 2 bpm ou mais), changeBpm (essa diferença), position (mediana em relação à faixa: "acima", "na faixa" ou "abaixo") e marginBpm (distância da mediana até a borda da faixa).
- readings: as mesmas leituras, da mais antiga para a mais nova, com secondsAgo, bpm, kmh e inclinePercent medidos.
- session: mode, plannedMinutes, elapsedSeconds, restBpm (FC do primeiro minuto de hoje, ou null) e changes (ajustes de carga já aplicados hoje, com secondsAgo, decision e o bpm que os motivou).
- profile: age e activity.
- allowed: as decisões que o app aceita neste momento.

EFEITO DE CADA DECISÃO
- "manter": nada muda.
- "reduzir velocidade": alvo de velocidade −0,3 km/h. "reduzir inclinação": alvo de inclinação −0,5%.
- "aumentar velocidade": alvo de velocidade +0,2 km/h. "aumentar inclinação": alvo de inclinação +0,5%.

COMO DECIDIR
A frequência cardíaca leva de 2 a 3 minutos para se estabilizar depois de uma mudança de carga, e leituras de sensor de mão oscilam 1 ou 2 bpm sem que isso seja tendência.
1. Com position "acima", siga a primeira regra que servir:
- Mantenha se session.changes tem uma redução com secondsAgo < 120: o efeito dela ainda não apareceu.
- Em etapa "leve" com secondsInStage < 120, BPM acima da faixa é a recuperação normal depois do esforço: mantenha, a menos que trend seja "subindo" e marginBpm ≥ 10.
- Reduza se marginBpm ≥ 10.
- Reduza se marginBpm ≥ 5 e trend não é "caindo".
- Nos demais casos (marginBpm ≤ 4, ou trend "caindo"), mantenha.
- Qual reduzir: com targetInclinePercent ≥ 1, prefira "reduzir inclinação"; senão "reduzir velocidade".
2. Com position "abaixo" (o app só oferece aumento em etapa principal com os alvos atingidos há 120 s ou mais), siga a primeira regra que servir:
- Mantenha se session.changes tem um aumento com secondsAgo < 180, se secondsRemaining ≤ 120 ou se trend é "subindo".
- Aumente se marginBpm ≥ 5.
- Nos demais casos, mantenha.
- Qual aumentar: com targetKmh < 6, prefira "aumentar velocidade"; senão "aumentar inclinação".

SAÍDA
Responda somente com um objeto json, neste formato:
{"reason": "<motivo>", "decision": "<decisão>"}
- reason: até 12 palavras em português do Brasil, citando o dado decisivo.
- decision: exatamente uma das opções de allowed.`;

export type ReviewInput = {
  workout: Workout;
  /** Índice da etapa atual e segundos que faltam nela. */
  index: number;
  left: number;
  load: Load;
  readings: Reading[];
  features: Features;
  allowed: Decision[];
  now: number;
};

export function reviewPrompt(i: ReviewInput): Prompt {
  const w = i.workout;
  const { stage } = i.load;
  const zone = dailyTarget(w.plan, w.profile, w.hr);
  const elapsed = Math.round(w.totals.movingMs / 1000);
  const f = i.features;
  return {
    system: REVIEW,
    user: {
      zone,
      stage: {
        name: stage.name,
        kind: stage.measure ? 'leve' : 'principal',
        targetKmh: stage.speed,
        targetInclinePercent: stage.incline,
        secondsInStage: stage.seconds - i.left,
        secondsRemaining: i.left,
        targetsReached: i.load.reached,
        secondsAtLoad: Math.round(i.load.secondsAtLoad),
      },
      bpm: {
        count: f.count,
        spanSeconds: f.spanSeconds,
        median: f.median,
        latest: f.latest,
        min: f.min,
        max: f.max,
        trend: f.trend,
        changeBpm: f.change,
        position: f.position,
        marginBpm: f.margin,
      },
      readings: i.readings.map((r) => ({
        secondsAgo: Math.max(0, Math.round((i.now - r.at) / 1000)),
        bpm: r.bpm,
        kmh: r.kmh,
        inclinePercent: r.incline,
      })),
      session: {
        mode: w.plan?.goal ?? 'Livre',
        plannedMinutes: w.plan?.minutes ?? null,
        elapsedSeconds: elapsed,
        restBpm: w.restBpm ?? null,
        changes: (w.changes ?? []).map((c) => ({
          secondsAgo: Math.max(0, elapsed - c.second),
          decision: c.decision,
          bpm: c.bpm,
        })),
      },
      profile: { age: w.profile.age, activity: w.profile.activity ?? null },
      allowed: i.allowed,
    },
  };
}

export const parseReview = (allowed: Decision[]) => (raw: unknown) => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const decision = r.decision as Decision;
  if (!decisions.includes(decision) || !allowed.includes(decision))
    throw new Error('Resposta de ajuste inválida.');
  return { decision, reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 120) : '' };
};

// --- Avaliação ao fim do treino --------------------------------------------

const ASSESS = `Você avalia uma sessão de esteira já encerrada a partir das medições do app. Devolve o nível de condicionamento observado, um resumo curto e uma previsão da frequência cardíaca máxima da pessoa.

ENTRADA (json)
- profile: age e activity (nível de atividade declarado; null se não informado).
- session: a sessão avaliada.
  - goal (modo; "Livre" = sem plano), objective, plannedMinutes, movingSeconds, completionPercent (null no treino livre), distanceMeters, averageKmh, averageIncline, endedBy (como terminou).
  - bpmReadings (leituras válidas do sensor de mão, cerca de uma por segundo de contato), bpmCoveragePercent, averageBpm, peakBpm (maior leitura isolada) e validatedPeakBpm (maior mediana de 3 leituras seguidas).
  - zone: low, high e method da faixa orientativa do dia. zoneSharePercent: parcela das leituras below, inside e above dessa faixa.
  - work e easy: resumo dos blocos de esforço e dos blocos leves (aquecimento, recuperações e volta à calma). Cada um traz seconds, kmh e inclinePercent realizados, plannedKmh e plannedInclinePercent, bpmEnd (mediana das últimas leituras dos blocos, o valor mais próximo do BPM estabilizado) e bpmReadings. null quando não houve o bloco.
  - stages: o mesmo por etapa, quando a lista é curta.
  - recoveryDrops: queda em bpm entre o fim de um bloco de esforço e cerca de 1 minuto de recuperação.
  - reductions e increases: ajustes de carga pedidos durante a sessão.
  - restBpm: FC lida no primeiro minuto de hoje. Fica de 10 a 20 bpm acima do repouso real.
- recent: sessões válidas anteriores, da mais nova para a mais antiga, resumidas: daysAgo (em relação a esta sessão), goal, objective, completionPercent, work (kmh, inclinePercent, bpmEnd), zone, position, recoveryDrops, reductions, increases, restBpm, level e maxBpm. approximate = true marca registros antigos em que work traz médias da sessão inteira.
- heart: foxMaxBpm (220 − idade), tanakaMaxBpm (208 − 0,7 × idade), observedPeakBpm (maior pico validado de todas as sessões, ou null), previousMaxBpm (previsões anteriores, da mais nova para a mais antiga) e bounds (limites que o app aceita para maxBpm).

NÍVEL (level)
Aplique na ordem. Vale o primeiro critério atendido.
1. "Em adaptação" se ocorrer qualquer um destes:
- recent tem menos de 2 sessões (ainda não há base para comparar);
- work.bpmEnd acima de zone.high com work.kmh ≤ 5 e work.inclinePercent ≤ 2;
- reductions ≥ 1;
- sessão guiada com completionPercent < 70;
- zoneSharePercent.above ≥ 40.
2. "Base consistente" se ocorrerem todos estes:
- recent tem 4 ou mais sessões com daysAgo ≤ 21;
- a sessão foi concluída (completionPercent ≥ 90, ou treino livre com movingSeconds ≥ 1200) sem reductions;
- work.bpmEnd dentro ou abaixo da faixa;
- há sinal de eficiência em relação a recent: mesma carga principal (até 0,2 km/h e 0,5% de diferença) com bpmEnd igual ou menor, com tolerância de 3 bpm, ou carga maior com bpmEnd na mesma faixa;
- se houver recoveryDrops, a mediana é ≥ 20.
3. "Base em formação" nos demais casos.
Sem work.bpmEnd (nenhuma leitura nos blocos de esforço), julgue por zoneSharePercent e averageBpm, diga isso no resumo e não passe de "Base em formação".
Nunca use "${levels[0]}": o app trata esse caso sem consultar você.

RESUMO (summary)
Uma ou duas frases em português do Brasil, com até 300 caracteres, citando números medidos: carga principal, BPM, faixa, recuperação. Sem diagnóstico, sem VO2max, sem inferência por peso ou altura, sem conselho médico e sem promessa.

FC MÁXIMA (maxBpm)
A FC máxima é uma característica da pessoa e muda pouco de uma sessão para outra. Caminhada submáxima não a mede: só confirma um piso, porque a pessoa atinge pelo menos o maior pico já observado.
- Ponto de partida: a média de foxMaxBpm e tanakaMaxBpm.
- Piso: maxBpm nunca fica abaixo de observedPeakBpm nem de validatedPeakBpm.
- Se o maior pico validado passa de 95% do ponto de partida numa sessão concluída sem reductions, aquele esforço não era o máximo da pessoa: use pico + 5.
- BPM alto em carga leve indica pouco condicionamento, e BPM baixo em carga alta indica bom condicionamento. Nenhum dos dois muda a FC máxima.
- Havendo previousMaxBpm, fique a no máximo 3 bpm da previsão mais recente, a menos que o piso exija mais.
- Fique dentro de heart.bounds.

SAÍDA
Responda somente com um objeto json, neste formato:
{"level": "<nível>", "summary": "<resumo>", "maxBpm": <inteiro>}
- level: um de ${list(levels.slice(1))}.`;

export type AssessInput = { workout: Workout; history: Workout[] };

/** Limites da FC máxima para esta sessão, dados os picos já observados. */
export function assessBounds({ workout, history }: AssessInput) {
  return maxBounds(workout.profile.age, observedPeak([workout, ...history]));
}

export function assessPrompt(input: AssessInput): Prompt {
  const { workout: w, history } = input;
  const valid = history.filter(validSession);
  return {
    system: ASSESS,
    user: {
      profile: { age: w.profile.age, activity: w.profile.activity ?? null },
      session: { ...summarize(w), stages: stageList(w) },
      recent: valid.slice(0, 5).map((h) => historyItem(h, w.started)),
      heart: {
        foxMaxBpm: foxMax(w.profile.age),
        tanakaMaxBpm: tanakaMax(w.profile.age),
        observedPeakBpm: observedPeak([w, ...history]),
        previousMaxBpm: valid
          .map((h) => h.estimate?.maxBpm)
          .filter((n): n is number => typeof n === 'number')
          .slice(0, 5),
        bounds: assessBounds(input),
      },
    },
  };
}

export const parseAssess =
  (bounds: Zone) =>
  (raw: unknown): Estimate => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const maxBpm = Math.round(num(r.maxBpm));
    if (
      !levels.slice(1).includes(r.level as (typeof levels)[number]) ||
      !summary ||
      summary.length > 1000 ||
      !Number.isFinite(maxBpm)
    )
      throw new Error('Avaliação incompleta. Tente novamente.');
    return {
      level: r.level as string,
      summary,
      // A previsão fica presa aos limites: uma resposta ruim não desloca a faixa.
      maxBpm: Math.min(bounds.high, Math.max(bounds.low, maxBpm)),
    };
  };
