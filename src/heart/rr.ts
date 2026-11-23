/**
 * Intervalos entre batimentos (RR), em ms. Código puro: a sessão da cinta só
 * repassa os RR crus que a cinta manda; quem mede o repouso ou a variabilidade
 * (HRV) filtra os artefatos com `acceptRr` antes de fazer a conta.
 */

/** Fora disto não é batimento: 300 ms são 200 bpm e 2000 ms, 30 bpm. */
export const RR_MIN_MS = 300;
export const RR_MAX_MS = 2000;
/** Um salto maior que isto sobre a mediana recente é batimento perdido ou extra. */
export const RR_MAX_JUMP = 0.2;
/**
 * Depois de tantas rejeições seguidas o problema é a referência, não o RR: a
 * FC mudou de patamar (ou a referência nasceu de um artefato). O filtro
 * recomeça a partir das rejeitadas.
 */
export const RR_RESEED_AFTER = 5;
/** Quantos RR aceitos entram na mediana de referência. */
const RECENT_SIZE = 9;

/** Estado do filtro de artefatos. Um por fluxo de RR (por treino, por medição). */
export interface RrFilter {
  /** Os últimos RR aceitos, do mais antigo ao mais novo. */
  recent: number[];
  /** As rejeições seguidas por salto, para a re-semeadura. */
  rejected: number[];
}

export function createRrFilter(): RrFilter {
  return { recent: [], rejected: [] };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * O que o filtro fez com um RR: `aceito`; `recusado`; ou `resemeado`, aceito
 * na quinta recusa seguida, quando a referência passou a ser as recusadas.
 */
export type RrVerdict = 'aceito' | 'recusado' | 'resemeado';

/**
 * Classifica um RR e atualiza o filtro. Fora de 300 a 2000 ms ele é sempre
 * recusado (e não conta para a re-semeadura: não é mudança de FC, é ruído).
 * Dentro da faixa, um salto de mais de 20% sobre a mediana dos últimos aceitos
 * é recusado; na quinta recusa seguida a referência passa a ser as recusadas,
 * e o RR atual é aceito (`resemeado`). Quem mede o repouso e a HRV parado
 * precisa saber da re-semeadura: um artefato sustentado vira o novo patamar.
 */
export function classifyRr(filter: RrFilter, rrMs: number): RrVerdict {
  if (!Number.isFinite(rrMs) || rrMs < RR_MIN_MS || rrMs > RR_MAX_MS) {
    return 'recusado';
  }
  if (filter.recent.length > 0) {
    const reference = median(filter.recent);
    if (Math.abs(rrMs - reference) > RR_MAX_JUMP * reference) {
      filter.rejected.push(rrMs);
      if (filter.rejected.length < RR_RESEED_AFTER) {
        return 'recusado';
      }
      filter.recent = filter.rejected.slice(-RECENT_SIZE);
      filter.rejected = [];
      return 'resemeado';
    }
  }
  filter.rejected = [];
  filter.recent.push(rrMs);
  if (filter.recent.length > RECENT_SIZE) {
    filter.recent.shift();
  }
  return 'aceito';
}

/**
 * Diz se um RR é batimento de verdade e atualiza o filtro: o RR `aceito` ou
 * `resemeado` por `classifyRr`. É o que a leitura do momento da trava usa.
 */
export function acceptRr(filter: RrFilter, rrMs: number): boolean {
  return classifyRr(filter, rrMs) !== 'recusado';
}

/** BPM médio de uma série de RR (60000 / RR médio), inteiro; `null` sem RR. */
export function bpmFromRr(rrMs: readonly number[]): number | null {
  if (rrMs.length === 0) {
    return null;
  }
  const mean = rrMs.reduce((sum, rr) => sum + rr, 0) / rrMs.length;
  return mean > 0 ? Math.round(60000 / mean) : null;
}

/**
 * RMSSD em ms: a raiz da média dos quadrados das diferenças entre RR
 * seguidos, a medida de variabilidade de curto prazo. `null` com menos de 2 RR.
 * A série deve vir já filtrada (`acceptRr`): um batimento perdido no meio vira
 * uma diferença enorme.
 */
export function rmssd(rrMs: readonly number[]): number | null {
  if (rrMs.length < 2) {
    return null;
  }
  let sum = 0;
  for (let i = 1; i < rrMs.length; i++) {
    const delta = rrMs[i] - rrMs[i - 1];
    sum += delta * delta;
  }
  return Math.sqrt(sum / (rrMs.length - 1));
}
