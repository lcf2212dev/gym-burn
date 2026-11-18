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

export const T600X_INCLINATION_RANGE: RangeInfo = {
  min: 0,
  max: 15,
  step: 0.5,
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

/**
 * Fator de conversão do contador interno de inclinação desta família de firmware
 * (raw×0,015 = percentual real). O app lê o campo do 0x2ACD como 0,1 % (raw/10),
 * então a leitura sai 6,667× maior; este fator converte a leitura exibida.
 */
export const T600X_INCLINATION_READING_FACTOR = 0.15;

/**
 * Corrige a inclinação do 0x2ACD para exibição quando a faixa declarada pelo FTMS
 * denuncia o template do firmware (0–50 %/3 % na T600X). Com faixa plausível, a
 * leitura é devolvida como veio.
 */
export function correctInclinationPercent(percent: number | null, range: RangeInfo): number | null {
  if (percent === null) return null;
  const implausible =
    range.max > T600X_INCLINATION_RANGE.max || range.step > T600X_INCLINATION_RANGE.step;
  if (!implausible) return percent;
  const corrected = percent * T600X_INCLINATION_READING_FACTOR;
  return Math.min(Math.max(corrected, 0), T600X_INCLINATION_RANGE.max);
}
