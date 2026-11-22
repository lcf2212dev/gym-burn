import type { TreadmillSample } from '@/treadmill/types';
import {
  acsm,
  HILL_TOP_PERCENT,
  MAX_INCLINE_PERCENT,
  MAX_SPEED_KMH,
  median,
  RUN_FROM_KMH,
  RUN_MAX_INCLINE_PERCENT,
  validBpm,
  WALK_TOP_KMH,
  type Stage,
  type Zone,
} from './model';
import { AIM_SPAN_BPM } from './physiology';

/** As intensidades do plano semanal; cada uma tem a sua faixa de FC. */
export const objectives = ['Recuperação', 'Base aeróbica', 'Limiar', 'VO₂máx'] as const;
export type Objective = (typeof objectives)[number];
/** Os nomes com que um ajuste de carga fica no registro do treino. */
export const decisions = [
  'reduzir velocidade',
  'reduzir inclinação',
  'aumentar velocidade',
  'aumentar inclinação',
] as const;
export type Decision = (typeof decisions)[number];
export type Reading = { bpm: number; at: number; kmh: number | null; incline: number | null };

/** Leituras do sensor de mão que uma revisão exige, já sem as 2 primeiras de cada pegada. */
export const REVIEW_READINGS = 4;
/**
 * Tempo nos alvos antes de a carga poder subir: antes disso o BPM ainda é o da
 * carga anterior, e subir por ele levaria a pessoa acima da faixa. Vale só
 * para aumentos: aliviar a carga com o BPM acima da faixa não espera nada.
 */
export const STEADY_SECONDS = 90;
/** Tempo nos alvos a partir do qual a FC conta como estabilizada. */
export const SETTLED_SECONDS = 240;
/** Quanto a FC ainda sobe sozinha numa carga em que está há menos de 4 minutos. */
export const PENDING_RISE_BPM = 3;
/**
 * Folga que um aumento deixa até o teto: 1 bpm, ou um quinto da distância
 * quando ela é grande. A reta de FC por MET costuma subestimar o efeito de um
 * degrau, e o erro cresce com o tamanho do aumento.
 */
export const RAISE_MARGIN_BPM = 1;
export const RAISE_MARGIN_SHARE = 0.2;
/**
 * Depois de um alívio a FC leva de 2 a 3 minutos para descer. Até lá um
 * segundo alívio só sai se o excesso for claro; senão os dois se somam e o BPM
 * cai abaixo do alvo.
 */
export const RELIEF_SETTLE_SECONDS = 180;
/** Excesso sobre o teto que justifica um segundo alívio antes desse prazo, se a FC não estiver caindo. */
export const URGENT_EXCESS_BPM = 3;

const CONTACT_GAP_MS = 3000;
/** O sensor de mão é lido em pegadas curtas: valem as leituras dos últimos 12 s. */
const GRIP_WINDOW_MS = 12_000;
/**
 * A cinta no peito lê o tempo todo, e 10 segundos dela são um piscar: um 135
 * de passagem não é o BPM da carga. Vale a mediana do último minuto.
 */
export const STRAP_WINDOW_MS = 60_000;
/** O mínimo de cinta para uma revisão: 20 leituras espalhadas por 40 s. */
const STRAP_READINGS = 20;
const STRAP_SPAN_MS = 40_000;

/**
 * As leituras que valem para rever a carga agora, da mais antiga para a mais
 * nova; lista vazia quando ainda não bastam. Só entram leituras da etapa com a
 * lona andando. Com a cinta é o último minuto inteiro. Com o sensor de mão são
 * as 10 últimas dos últimos 12 s, sem as 2 primeiras de cada pegada, que são
 * as menos confiáveis.
 */
export function pulseWindow(samples: TreadmillSample[], stageSince: number, now: number) {
  const valid = samples.filter(
    (s) => s.at >= stageSince && s.at <= now && (s.speedKmh ?? 0) > 0 && validBpm(s.heartRateBpm),
  );
  const reading = (s: TreadmillSample): Reading => ({
    bpm: s.heartRateBpm as number,
    at: s.at,
    kmh: s.speedKmh,
    incline: s.inclinationPercent,
  });
  const last = valid[valid.length - 1];
  if (!last || now - last.at > GRIP_WINDOW_MS) return [];
  if (last.heartRateSource === 'strap') {
    const kept = valid
      .filter((s) => s.heartRateSource === 'strap' && s.at >= now - STRAP_WINDOW_MS)
      .map(reading);
    const span = kept[kept.length - 1].at - kept[0].at;
    return kept.length >= STRAP_READINGS && span >= STRAP_SPAN_MS ? kept : [];
  }
  // A cinta acabou de cair: as leituras dela não abrem nem continuam uma pegada.
  const kept: Reading[] = [];
  let contact = 0;
  let previous = -Infinity;
  for (const s of valid) {
    if (s.heartRateSource === 'strap') continue;
    contact = s.at - previous > CONTACT_GAP_MS ? 1 : contact + 1;
    previous = s.at;
    if (contact > 2 && s.at >= now - GRIP_WINDOW_MS) kept.push(reading(s));
  }
  return kept.length >= REVIEW_READINGS ? kept.slice(-10) : [];
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

/** O que as regras de ajuste precisam saber das leituras, já calculado. */
export function pulseFeatures(readings: Reading[], zone: Zone): Features | null {
  if (!readings.length) return null;
  const bpm = readings.map((r) => r.bpm);
  const center = median(bpm);
  const span = (readings[readings.length - 1].at - readings[0].at) / 1000;
  // O sensor oscila 1 bpm: uma reta ajustada às leituras transforma esse ruído
  // em tendência. Comparar as metades só acusa mudança que passa do ruído.
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
  /** Faltam 2 minutos ou menos e não há outro bloco de esforço depois: um aumento não teria tempo de fazer efeito. */
  closing?: boolean;
};

/** A carga pode subir: bloco de esforço, com a esteira nos alvos há tempo suficiente. */
const raisable = (load: Load) =>
  !load.easy && load.reached && load.secondsAtLoad >= STEADY_SECONDS;

/** O que o app faz com uma leitura fora da faixa. */
export type Correction = 'aliviar' | 'subir';

/**
 * Fora da faixa a carga é corrigida já na primeira medida. Acima do teto o app
 * alivia em qualquer etapa, sem esperar a frequência cardíaca estabilizar; só
 * não empilha alívios: nos 3 minutos depois de um (`sinceRelief`, em
 * segundos), outro só sai com 3 bpm ou mais de excesso e a FC sem cair. Abaixo
 * do piso ele sobe a carga nos blocos de esforço, com a esteira nos alvos há
 * 90 s e o BPM sem disparar: subir a carga com a frequência cardíaca ainda
 * subindo é o que a leva acima do teto.
 */
export function correction(
  features: Features,
  load: Load,
  sinceRelief = Infinity,
): Correction | null {
  if (features.position === 'acima') {
    const responding =
      sinceRelief < RELIEF_SETTLE_SECONDS &&
      (features.margin < URGENT_EXCESS_BPM || features.trend === 'caindo');
    return responding ? null : 'aliviar';
  }
  const below = features.position === 'abaixo' && features.trend !== 'subindo';
  return below && raisable(load) ? 'subir' : null;
}

/**
 * Quantos bpm a correção busca tirar ou pôr. Ao aliviar, o BPM volta para 3
 * bpm abaixo do teto, o começo do alvo da sessão. Ao subir, vai só até o meio
 * da faixa: a frequência cardíaca ainda pode estar subindo sozinha, e o ajuste
 * fino até o teto vem nas revisões seguintes.
 */
export function correctionBpm(kind: Correction, features: Features, zone: Zone) {
  return kind === 'aliviar'
    ? features.median - (zone.high - AIM_SPAN_BPM)
    : Math.round((zone.low + zone.high) / 2) - features.median;
}

/**
 * O ajuste fino dentro da faixa: quantos bpm a carga pode ganhar agora sem
 * passar do teto, ou 0 quando é hora de manter. Só vale num bloco de esforço
 * com a esteira nos alvos há 90 s e a FC sem subir; com a cinta, 1 bpm de
 * diferença entre as duas metades do minuto já conta como subida. Com menos de
 * 4 minutos na carga, 3 bpm ficam reservados para o que a FC ainda sobe sozinha. Se o que
 * sobra já está no alvo (até 3 bpm do teto), nada muda; senão a carga sobe o
 * que couber, deixando até o teto 1 bpm ou um quinto da distância. Um degrau
 * que passaria disso não é dado: é `correctedStage` que procura um que caiba.
 */
export function raiseRoom(features: Features, load: Load) {
  // Com o minuto inteiro da cinta a mediana de cada metade é firme: 1 bpm entre
  // elas são 2 bpm por minuto, e a FC ainda chega mais perto do teto sozinha.
  const climbing = features.count >= STRAP_READINGS && features.change >= 1;
  if (features.position !== 'na faixa' || features.trend === 'subindo' || climbing) return 0;
  if (!raisable(load) || load.closing) return 0;
  const pending = load.secondsAtLoad < SETTLED_SECONDS ? PENDING_RISE_BPM : 0;
  const gap = features.belowTop - pending;
  if (gap <= AIM_SPAN_BPM) return 0;
  return gap - Math.max(RAISE_MARGIN_BPM, Math.round(gap * RAISE_MARGIN_SHARE));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Maior aumento de uma correção, em METs (cerca de 2 pontos de rampa a 5,2
 * km/h). Passar do teto é o erro mais caro: o que faltar vem na revisão
 * seguinte.
 */
export const MAX_RAISE_METS = 1;
/** Uma etapa leve não é aliviada abaixo disto: é a linha mais leve da escada do plano. */
const EASY_FLOOR_KMH = 3;
/**
 * Meio ponto de rampa vale uns 5 bpm, mais que os 3 do alvo. O ajuste fino é
 * a velocidade: com rampa, a caminhada usa de 4,9 a 5,2 km/h, e cada 0,1 km/h
 * vale pouco mais de 1 bpm.
 */
const VERNIER_KMH = 0.3;
/** Entre duas cargas de custo quase igual vale a mais rápida: o normal da caminhada é o teto dela. */
const SPEED_BIAS_METS_PER_KMH = 0.1;
/**
 * Um alívio pode ficar isto aquém do pedido (meio bpm, mais ou menos). Sem essa
 * folga, um degrau que tira 0,21 MET é recusado para um pedido de 0,23, e a
 * carga desce dois degraus onde bastava um.
 */
const RELIEF_TOLERANCE_METS = 0.03;
const EPSILON = 1e-9;

type Point = { speed: number; incline: number };
const walkCost = (p: Point) => acsm(p.speed, p.incline, false);

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
 * As cargas de caminhada a que um ajuste pode chegar a partir de `from`, em
 * degraus de 0,1 km/h e 0,5%. Um alívio nunca sobe nenhum dos dois alvos e um
 * aumento nunca desce. Com rampa, a velocidade só anda entre 4,9 km/h e o teto
 * da caminhada; abaixo disso a caminhada é plana, e é plana que ela desce até
 * `floor`. A rampa só sobe com a velocidade já nesse trecho de cima.
 */
function walkSteps(from: Point, direction: -1 | 1, floor: number) {
  const band = round1(WALK_TOP_KMH - VERNIER_KMH);
  const points: Point[] = [];
  if (direction < 0) {
    for (let incline = from.incline; incline > -EPSILON; incline -= 0.5) {
      const grade = Math.max(0, incline);
      const low = grade > 0 ? Math.max(floor, Math.min(band, from.speed)) : floor;
      for (let speed = from.speed; speed > low - EPSILON; speed = round1(speed - 0.1))
        points.push({ speed, incline: grade });
    }
  } else {
    for (let incline = from.incline; incline < MAX_INCLINE_PERCENT + EPSILON; incline += 0.5)
      for (let speed = from.speed; speed < WALK_TOP_KMH + EPSILON; speed = round1(speed + 0.1))
        if (incline === from.incline || speed > band - EPSILON) points.push({ speed, incline });
  }
  return points;
}

/**
 * A carga de custo mais perto de `target` sem passar dele por mais que
 * `tolerance`; entre quase iguais, a mais rápida.
 */
function closest(points: Point[], target: number, tolerance = 0) {
  let best: Point | null = null;
  let bestScore = Infinity;
  for (const p of points) {
    const cost = walkCost(p);
    if (cost > target + tolerance + EPSILON) continue;
    const score = Math.abs(target - cost) + SPEED_BIAS_METS_PER_KMH * (WALK_TOP_KMH - p.speed);
    if (score < bestScore - EPSILON) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

const cheapest = (points: Point[]) =>
  points.reduce<Point | null>((low, p) => (!low || walkCost(p) < walkCost(low) ? p : low), null);

/**
 * Os alvos da etapa depois de um ajuste de `mets` METs. A carga anda em
 * degraus de 0,1 km/h e 0,5%, e nenhum alvo fica entre o teto da caminhada
 * (5,2 km/h) e o começo da corrida (6 km/h).
 *
 * Ao aliviar, o custo cai `mets`, ou 0,03 MET a menos que isso, com o corte
 * que chegar mais perto. A caminhada combina rampa e velocidade (veja
 * `walkSteps`). A corrida perde
 * velocidade até 6 km/h e, se ainda não bastar, passa para o alto da caminhada
 * (5,2 km/h com até 7,5% de rampa: só nesse salto a rampa pode subir) e segue
 * por ela.
 *
 * Ao subir, o custo cresce no máximo `mets`, e nunca mais que 1 MET por
 * ajuste. A caminhada ganha velocidade até o teto e daí rampa; correndo, só a
 * velocidade sobe. A rampa de uma corrida nunca passa de 2%: um alvo antigo
 * acima disso volta a 2% no primeiro ajuste, e a velocidade compensa. Uma correção fora da faixa dá pelo menos um degrau; no
 * ajuste fino (`exact`), se nenhum degrau cabe em `mets`, a etapa fica como
 * está. Devolve a própria etapa quando não há o que mudar.
 */
export function correctedStage(
  stage: Stage,
  kind: Correction,
  mets: number,
  measured: TreadmillSample,
  exact = false,
): Stage {
  if (!(mets > 0) || measured.speedKmh === null || measured.inclinationPercent === null)
    return stage;
  let { speed, incline } = stage;
  if (kind === 'aliviar') {
    if (measured.speedKmh < 1) return stage;
    speed = relief(measured.speedKmh, speed, 10, 0.051);
    incline = Math.max(0, relief(measured.inclinationPercent, incline, 2, 0.251));
    // Quem já baixou a esteira para andar num bloco de corrida está caminhando:
    // a conta parte dessa carga, pela equação de caminhada.
    let running = speed >= RUN_FROM_KMH;
    const target = acsm(speed, incline, running) - mets;
    if (running) {
      // Correndo a rampa não passa de 2%: um alvo antigo acima disso volta a ele.
      incline = Math.min(incline, RUN_MAX_INCLINE_PERCENT);
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
      const points = walkSteps({ speed, incline }, -1, floor);
      const cut = closest(points, target, RELIEF_TOLERANCE_METS);
      ({ speed, incline } = cut ?? cheapest(points) ?? { speed, incline });
    }
  } else {
    const running = speed >= RUN_FROM_KMH;
    const budget = Math.min(mets, MAX_RAISE_METS);
    if (running) {
      const target = acsm(speed, incline, true) + budget;
      incline = Math.min(incline, RUN_MAX_INCLINE_PERCENT);
      while (speed < MAX_SPEED_KMH && acsm(round1(speed + 0.1), incline, true) <= target)
        speed = round1(speed + 0.1);
      const unchanged = speed === stage.speed && incline === stage.incline;
      if (unchanged && !exact && speed < MAX_SPEED_KMH) speed = round1(speed + 0.1);
    } else {
      const target = walkCost({ speed, incline }) + budget;
      // Um alvo antigo acima do teto da caminhada volta a ele também aqui.
      const from = { speed: Math.min(speed, WALK_TOP_KMH), incline };
      const points = walkSteps(from, 1, from.speed).slice(1);
      const fit = closest(points, target) ?? (exact ? null : cheapest(points));
      if (fit) ({ speed, incline } = fit);
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
