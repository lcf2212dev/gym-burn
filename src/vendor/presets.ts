import type { VendorMapping } from './types';

/**
 * Protocolos candidatos para o canal 0xFFF0.
 *
 * Nenhum deles foi confirmado no equipamento: são hipóteses de trabalho para a
 * próxima ida à academia, escolhidas pelo que já se sabe (o 0xFFF0 é o perfil de
 * demonstração da TI; o FTMS da esteira usa km/h×100 e %×10; o alvo de
 * velocidade notificado pelo firmware vem ×16). A Sonda deixa editar qualquer
 * payload, então um protocolo descoberto por captura do app oficial entra sem
 * mudar código.
 */
export const VENDOR_PRESETS: readonly VendorMapping[] = [
  {
    version: 1,
    name: 'Túnel FTMS (candidato)',
    target: 'fff3',
    format: 'hex',
    speedEncoding: 'u16le-x100',
    inclineEncoding: 's16le-x10',
    actions: {
      start: '07',
      pause: '08 02',
      stop: '08 01',
      speedUp: '02 %v',
      speedDown: '02 %v',
      inclineUp: '03 %v',
      inclineDown: '03 %v',
    },
  },
  {
    version: 1,
    name: 'Túnel FTMS, velocidade ×16',
    target: 'fff3',
    format: 'hex',
    speedEncoding: 'u16le-x1600',
    inclineEncoding: 's16le-x10',
    actions: {
      start: '07',
      pause: '08 02',
      stop: '08 01',
      speedUp: '02 %v',
      speedDown: '02 %v',
      inclineUp: '03 %v',
      inclineDown: '03 %v',
    },
  },
  {
    version: 1,
    name: 'Linhas ASCII (exemplo)',
    target: 'fff3',
    format: 'ascii',
    speedEncoding: 'ascii1',
    inclineEncoding: 'ascii1',
    actions: {
      start: 'START\\r\\n',
      pause: 'PAUSE\\r\\n',
      stop: 'STOP\\r\\n',
      speedUp: 'SPEED %v\\r\\n',
      speedDown: 'SPEED %v\\r\\n',
      inclineUp: 'INCLINE %v\\r\\n',
      inclineDown: 'INCLINE %v\\r\\n',
    },
  },
];

/** Cópia editável de um preset (a Sonda altera o objeto antes de aplicar). */
export function cloneVendorMapping(mapping: VendorMapping): VendorMapping {
  return {
    ...mapping,
    actions: { ...mapping.actions },
  };
}

/** Primeiro preset, usado como rascunho inicial da Sonda. */
export const DEFAULT_VENDOR_MAPPING = VENDOR_PRESETS[0];
