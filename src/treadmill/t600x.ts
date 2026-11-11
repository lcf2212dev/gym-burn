import type { RangeInfo } from './types';

/**
 * Faixas da ficha técnica da Matrix T600X (220 V): 0,8 a 22 km/h e 0 a 15 %.
 * Só valem quando a esteira não expõe Supported Speed Range (0x2AD4) ou
 * Supported Inclination Range (0x2AD5); o que ela informa tem precedência.
 */
export const T600X_SPEED_RANGE: RangeInfo = {
  min: 0.8,
  max: 22,
  step: 0.1,
  source: 'assumed',
};

/**
 * Nomes com que consoles da Matrix e da Vision se anunciam, segundo capturas de
 * scanner BLE publicadas por donos desses aparelhos: `CTM` + número de série
 * (uma Vision T600E aparece como `CTM780…`; o número de série desta
 * T600X começa com `TM781`), `MX-TM xxxx` (Matrix T50) e `MATRIX…`. Serve para
 * mostrar a esteira na lista mesmo que ela não anuncie o serviço FTMS.
 */
export function looksLikeMatrixConsole(name: string | null): boolean {
  return name !== null && /^(CTM|MX-TM|MATRIX)/i.test(name.trim());
}

export const T600X_INCLINATION_RANGE: RangeInfo = {
  min: 0,
  max: 15,
  step: 0.5,
  source: 'assumed',
};
