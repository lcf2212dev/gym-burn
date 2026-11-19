import type { TreadmillSample } from '@/treadmill/types';
import {
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
 * Tempo nos alvos antes de a carga poder subir: o grosso da resposta da FC já
 * aconteceu. O guia pede a primeira leitura do bloco aos 120 s da etapa, e a
 * pessoa leva até uns 30 s para pôr a esteira nos alvos.
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

/**
 * Decisões que fazem sentido agora. Quando só resta "manter", a IA não é
 * consultada. Nos blocos de esforço o alvo é o teto da faixa: qualquer leitura
 * abaixo dele abre a opção de subir a carga, desde que os alvos estejam
 * atingidos há tempo suficiente. Aliviar é possível em qualquer etapa, com o
 * BPM acima da faixa. Entre velocidade e inclinação quem escolhe é o app, pela
 * mesma escada de cargas do plano: caminhada sobe pela velocidade até 6 km/h,
 * daí pela rampa até 8%, e correndo (7 km/h ou mais) volta a ser pela
 * velocidade.
 */
export function allowedDecisions(features: Features, load: Load): Decision[] {
  const { stage } = load;
  const running = stage.speed >= RUN_FROM_KMH;
  if (features.position === 'acima') {
    if (stage.incline >= 0.5 && !running) return ['manter', 'reduzir inclinação'];
    return stage.speed > 1 ? ['manter', 'reduzir velocidade'] : ['manter'];
  }
  if (features.belowTop > 0 && !load.easy && load.reached && load.secondsAtLoad >= STEADY_SECONDS) {
    if (stage.speed >= WALK_TOP_KMH && !running && stage.incline < HILL_TOP_PERCENT)
      return ['manter', 'aumentar inclinação'];
    return stage.speed < MAX_SPEED_KMH ? ['manter', 'aumentar velocidade'] : ['manter'];
  }
  return ['manter'];
}

/** Aplica uma decisão já validada por `allowedDecisions` aos alvos da etapa. */
export function revisedStage(stage: Stage, choice: Decision, measured: TreadmillSample): Stage {
  if (
    choice === 'manter' ||
    measured.speedKmh === null ||
    measured.inclinationPercent === null
  )
    return stage;
  let speed = stage.speed;
  let incline = stage.incline;
  if (choice.startsWith('reduzir')) {
    // Ao aliviar o esforço, nenhum dos dois alvos pode exigir um aumento no painel.
    if (measured.speedKmh < 1 || measured.inclinationPercent < 0) return stage;
    speed = Math.min(speed, Math.floor(measured.speedKmh * 10) / 10);
    incline = Math.min(incline, Math.floor(measured.inclinationPercent * 2) / 2);
    if (choice === 'reduzir velocidade' || incline < 0.5) speed -= 0.3;
    else incline -= 0.5;
  } else if (choice === 'aumentar velocidade') speed += 0.2;
  else incline += 0.5;

  speed = Math.min(MAX_SPEED_KMH, Math.max(1, Math.round(speed * 10) / 10));
  incline = Math.min(MAX_INCLINE_PERCENT, Math.max(0, Math.round(incline * 2) / 2));
  return speed === stage.speed && incline === stage.incline ? stage : { ...stage, speed, incline };
}
