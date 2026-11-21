import type { TreadmillSample } from '@/treadmill/types';
import {
  acsm,
  HILL_TOP_PERCENT,
  MAX_INCLINE_PERCENT,
  MAX_SPEED_KMH,
  median,
  RUN_FROM_KMH,
  validBpm,
  WALK_TOP_KMH,
  type Stage,
  type Zone,
} from './model';
import { AIM_SPAN_BPM } from './physiology';

/** As intensidades do plano semanal; cada uma tem a sua faixa de FC. */
export const objectives = ['Recuperação', 'Base aeróbica', 'Limiar', 'VO₂máx'] as const;
export type Objective = (typeof objectives)[number];
export const decisions = [
  'manter',
  'reduzir velocidade',
  'reduzir inclinação',
  'aumentar velocidade',
  'aumentar inclinação',
] as const;
export type Decision = (typeof decisions)[number];
export type Reading = { bpm: number; at: number; kmh: number | null; incline: number | null };

/** Leituras que uma revisão exige, já sem as 2 primeiras de cada pegada. */
export const REVIEW_READINGS = 4;
/**
 * Tempo nos alvos antes de a carga poder subir: antes disso o BPM ainda é o da
 * carga anterior, e subir por ele levaria a pessoa acima da faixa. Vale só
 * para aumentos: aliviar a carga com o BPM acima da faixa não espera nada.
 */
export const STEADY_SECONDS = 90;
/** Tempo nos alvos a partir do qual a FC conta como estabilizada. */
export const SETTLED_SECONDS = 240;
/** Antes disso, a carga só sobe com o BPM pelo menos este tanto abaixo do teto. */
export const EARLY_GAP_BPM = 8;
const CONTACT_GAP_MS = 3000;

/**
 * Leituras válidas da etapa com a lona andando, a partir de `since`. As 2
 * primeiras de cada pegada no sensor de mão ficam de fora: são as menos
 * confiáveis.
 */
export function pulseWindow(samples: TreadmillSample[], stageSince: number, since: number) {
  const kept: Reading[] = [];
  let contact = 0;
  let last = -Infinity;
  for (const s of samples) {
    if (s.at < stageSince || (s.speedKmh ?? 0) <= 0 || !validBpm(s.heartRateBpm)) continue;
    contact = s.at - last > CONTACT_GAP_MS ? 1 : contact + 1;
    last = s.at;
    if (contact > 2 && s.at >= since)
      kept.push({
        bpm: s.heartRateBpm,
        at: s.at,
        kmh: s.speedKmh,
        incline: s.inclinationPercent,
      });
  }
  return kept.slice(-10);
}

export type Features = {
  count: number;
  spanSeconds: number;
  median: number;
  latest: number;
  min: number;
  max: number;
  /** Mediana da segunda metade das leituras menos a da primeira. */
  change: number;
  trend: 'caindo' | 'estável' | 'subindo';
  position: 'abaixo' | 'na faixa' | 'acima';
  /** Distância da mediana até a borda da faixa; 0 dentro dela. */
  margin: number;
  /** Quantos bpm a mediana está abaixo do teto da faixa; negativo acima dele. */
  belowTop: number;
};

/** O que a IA e as regras locais precisam saber das leituras, já calculado. */
export function pulseFeatures(readings: Reading[], zone: Zone): Features | null {
  if (!readings.length) return null;
  const bpm = readings.map((r) => r.bpm);
  const center = median(bpm);
  const span = (readings[readings.length - 1].at - readings[0].at) / 1000;
  // A janela tem poucos segundos e o sensor oscila 1 bpm: uma reta ajustada
  // às leituras transforma esse ruído em "5 bpm por minuto". Comparar as
  // metades só acusa tendência quando a mudança passa do ruído.
  const half = bpm.length >> 1;
  const change = half >= 2 ? median(bpm.slice(-half)) - median(bpm.slice(0, half)) : 0;
  const position = center > zone.high ? 'acima' : center < zone.low ? 'abaixo' : 'na faixa';
  return {
    count: bpm.length,
    spanSeconds: Math.round(span),
    median: center,
    latest: bpm[bpm.length - 1],
    min: Math.min(...bpm),
    max: Math.max(...bpm),
    change,
    trend: change >= 2 ? 'subindo' : change <= -2 ? 'caindo' : 'estável',
    position,
    margin: position === 'acima' ? center - zone.high : position === 'abaixo' ? zone.low - center : 0,
    belowTop: zone.high - center,
  };
}

export type Load = {
  stage: Stage;
  /** Aquecimento, recuperação, volta à calma e toda sessão de recuperação. */
  easy: boolean;
  /** A esteira está nos dois alvos da etapa. */
  reached: boolean;
  secondsAtLoad: number;
};

/** A carga pode subir: bloco de esforço, com a esteira nos alvos há tempo suficiente. */
const raisable = (load: Load) =>
  !load.easy && load.reached && load.secondsAtLoad >= STEADY_SECONDS;

/** O que o app faz sozinho com uma leitura fora da faixa. */
export type Correction = 'aliviar' | 'subir';

/**
 * Fora da faixa quem corrige a carga é o app, na primeira medida e sem
 * consultar a IA. Acima do teto ele alivia em qualquer etapa, sem esperar a
 * frequência cardíaca estabilizar. Abaixo do piso ele sobe a carga nos blocos
 * de esforço, com a esteira nos alvos há 90 s e o BPM sem disparar: subir a
 * carga com a frequência cardíaca ainda subindo é o que a leva acima do teto.
 */
export function correction(features: Features, load: Load): Correction | null {
  if (features.position === 'acima') return 'aliviar';
  const below = features.position === 'abaixo' && features.trend !== 'subindo';
  return below && raisable(load) ? 'subir' : null;
}

/**
 * Quantos bpm a correção busca tirar ou pôr. Ao aliviar, o BPM volta para 3
 * bpm abaixo do teto, o meio do alvo da sessão. Ao subir, vai só até o meio da
 * faixa: a frequência cardíaca ainda pode estar subindo sozinha, e o ajuste
 * fino até o teto fica com a revisão seguinte.
 */
export function correctionBpm(kind: Correction, features: Features, zone: Zone) {
  return kind === 'aliviar'
    ? features.median - (zone.high - AIM_SPAN_BPM)
    : Math.round((zone.low + zone.high) / 2) - features.median;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Maior aumento de uma correção, em METs (cerca de 2 pontos de rampa a 5,6
 * km/h). Passar do teto é o erro mais caro: o que faltar vem na leitura
 * seguinte, 3 minutos depois.
 */
export const MAX_RAISE_METS = 1;
/** Uma etapa leve não é aliviada abaixo disto: é a linha mais leve da escada do plano. */
const EASY_FLOOR_KMH = 3;

/**
 * De onde parte um alívio: o alvo da etapa, ou a carga medida quando a esteira
 * está abaixo dele, para o alvo novo não exigir um aumento no painel. Dentro
 * da tolerância com que o guia dá o alvo por atingido vale o alvo: a esteira
 * informa 4,995% quando está em 5%.
 */
function relief(measured: number, target: number, steps: number, tolerance: number) {
  if (Math.abs(measured - target) < tolerance) return target;
  return Math.min(target, Math.floor(measured * steps + 1e-6) / steps);
}

/**
 * Os alvos da etapa depois de uma correção de `mets` METs. A carga anda pela
 * mesma escada do plano, em degraus de 0,1 km/h e 0,5%. Ao aliviar, a
 * caminhada perde primeiro a rampa e depois a velocidade, até o custo cair
 * pelo menos `mets`; a corrida perde velocidade até 7 km/h e, se ainda não
 * bastar, passa para o alto da caminhada (5,6 km/h com até 8% de rampa: só
 * nesse salto a rampa pode subir). Nenhum alvo fica entre 5,6 e 7 km/h. Ao subir, a caminhada ganha velocidade
 * até 5,6 km/h e daí rampa, sem passar de `mets` nem de 1 MET por correção
 * (mas com um degrau no mínimo); correndo, só a velocidade sobe. Devolve a
 * própria etapa quando não há o que mudar.
 */
export function correctedStage(
  stage: Stage,
  kind: Correction,
  mets: number,
  measured: TreadmillSample,
): Stage {
  if (!(mets > 0) || measured.speedKmh === null || measured.inclinationPercent === null)
    return stage;
  let running = stage.speed >= RUN_FROM_KMH;
  let { speed, incline } = stage;
  if (kind === 'aliviar') {
    if (measured.speedKmh < 1) return stage;
    speed = relief(measured.speedKmh, speed, 10, 0.051);
    incline = Math.max(0, relief(measured.inclinationPercent, incline, 2, 0.251));
    // Quem já baixou a esteira para andar num bloco de corrida está caminhando:
    // a conta parte dessa carga, pela equação de caminhada.
    running = speed >= RUN_FROM_KMH;
    const target = acsm(speed, incline, running) - mets;
    if (running) {
      while (speed > RUN_FROM_KMH && acsm(speed, incline, true) > target) speed = round1(speed - 0.1);
      if (acsm(speed, incline, true) > target) {
        // Nem o começo da corrida basta: a carga desce para a linha de baixo
        // da escada, o alto da caminhada, e segue por ela.
        running = false;
        speed = WALK_TOP_KMH;
        incline = HILL_TOP_PERCENT;
      }
    }
    if (!running) {
      // Um alvo antigo acima do teto da caminhada volta a ele.
      speed = Math.min(speed, WALK_TOP_KMH);
      const floor = Math.min(speed, stage.measure ? EASY_FLOOR_KMH : 1);
      while (incline > 0 && acsm(speed, incline, false) > target) incline -= 0.5;
      while (speed > floor && acsm(speed, incline, false) > target) speed = round1(speed - 0.1);
    }
  } else {
    const cost = (kmh: number, percent: number) => acsm(kmh, percent, running);
    const target = cost(speed, incline) + Math.min(mets, MAX_RAISE_METS);
    const top = running ? MAX_SPEED_KMH : WALK_TOP_KMH;
    while (speed < top && cost(round1(speed + 0.1), incline) <= target) speed = round1(speed + 0.1);
    if (!running && speed >= top)
      while (incline < MAX_INCLINE_PERCENT && cost(speed, incline + 0.5) <= target) incline += 0.5;
    if (speed === stage.speed && incline === stage.incline) {
      if (speed < top) speed = round1(speed + 0.1);
      else if (!running && incline < MAX_INCLINE_PERCENT) incline += 0.5;
    }
  }
  speed = Math.min(MAX_SPEED_KMH, Math.max(1, speed));
  incline = Math.min(MAX_INCLINE_PERCENT, Math.max(0, incline));
  return speed === stage.speed && incline === stage.incline ? stage : { ...stage, speed, incline };
}

/** O nome do ajuste que levou a etapa de `before` a `after`, como fica no registro do treino. */
export function changeLabel(before: Stage, after: Stage): Decision {
  if (after.speed < before.speed) return 'reduzir velocidade';
  if (after.incline < before.incline) return 'reduzir inclinação';
  return after.incline > before.incline ? 'aumentar inclinação' : 'aumentar velocidade';
}

/**
 * Decisões que a IA pode tomar agora. Ela só é consultada com o BPM dentro da
 * faixa e abaixo do teto, num bloco de esforço com os alvos atingidos há tempo
 * suficiente: decide se a carga sobe um degrau para chegar ao teto. Fora da
 * faixa o app corrige sozinho (`correction`). Quando só resta "manter", a IA
 * não é consultada. Entre velocidade e inclinação quem escolhe é o app, pela
 * mesma escada de cargas do plano: a caminhada sobe pela velocidade até
 * 5,6 km/h e daí pela rampa, e correndo (7 km/h ou
 * mais) volta a ser pela velocidade.
 */
export function allowedDecisions(features: Features, load: Load): Decision[] {
  const { stage } = load;
  if (features.position !== 'na faixa' || features.belowTop <= 0 || !raisable(load))
    return ['manter'];
  if (stage.speed >= WALK_TOP_KMH && stage.speed < RUN_FROM_KMH)
    return stage.incline < MAX_INCLINE_PERCENT ? ['manter', 'aumentar inclinação'] : ['manter'];
  return stage.speed < MAX_SPEED_KMH ? ['manter', 'aumentar velocidade'] : ['manter'];
}

/** Aplica um aumento já validado por `allowedDecisions` aos alvos da etapa. */
export function revisedStage(stage: Stage, choice: Decision): Stage {
  let { speed, incline } = stage;
  if (choice === 'aumentar velocidade') {
    // Um alvo de caminhada nunca passa do teto da caminhada.
    const top = stage.speed < RUN_FROM_KMH ? Math.max(stage.speed, WALK_TOP_KMH) : MAX_SPEED_KMH;
    speed = Math.min(top, round1(speed + 0.2));
  } else if (choice === 'aumentar inclinação') incline = Math.min(MAX_INCLINE_PERCENT, incline + 0.5);
  return speed === stage.speed && incline === stage.incline ? stage : { ...stage, speed, incline };
}
