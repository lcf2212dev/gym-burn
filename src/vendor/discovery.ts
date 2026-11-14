import type { VendorFormat, VendorTarget } from './types';

/**
 * Varredura segura do canal proprietário.
 *
 * Cada candidato é um payload curto e "burro" (1 byte, ou o texto `AT`), escolhido
 * para responder a duas perguntas sem risco de comandar a lona:
 *  - escrever no FFF1/FFF3 muda alguma coisa? (leitura do FFF1/FFF2, notificação
 *    no FFF4, velocidade/inclinação medidas)
 *  - o canal é um eco, um AT de módulo ou um canal mudo?
 *
 * Comandos de controle (iniciar, velocidade, inclinação) ficam de fora de
 * propósito: quem quer testá-los usa o mapeamento, com o usuário avisado e o
 * Emergency Stop ao alcance.
 */
export interface VendorDiscoveryCandidate {
  label: string;
  target: VendorTarget;
  format: VendorFormat;
  /** Template literal (sem `%v`): hex separado por espaço ou texto ASCII com escapes. */
  payload: string;
}

export const VENDOR_DISCOVERY_CANDIDATES: readonly VendorDiscoveryCandidate[] = [
  { label: 'FFF3 ← 00', target: 'fff3', format: 'hex', payload: '00' },
  { label: 'FFF3 ← 01', target: 'fff3', format: 'hex', payload: '01' },
  { label: 'FFF3 ← 55', target: 'fff3', format: 'hex', payload: '55' },
  { label: 'FFF3 ← AA', target: 'fff3', format: 'hex', payload: 'AA' },
  { label: 'FFF3 ← FF', target: 'fff3', format: 'hex', payload: 'FF' },
  { label: 'FFF3 ← AT', target: 'fff3', format: 'ascii', payload: 'AT\\r\\n' },
  { label: 'FFF1 ← 00', target: 'fff1', format: 'hex', payload: '00' },
  { label: 'FFF1 ← 55', target: 'fff1', format: 'hex', payload: '55' },
  { label: 'FFF1 ← AA', target: 'fff1', format: 'hex', payload: 'AA' },
  { label: 'FFF1 ← FF', target: 'fff1', format: 'hex', payload: 'FF' },
];
