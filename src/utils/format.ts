/**
 * Formatação dos números da interface em português do Brasil, sem `Intl`: o
 * Hermes nem sempre traz os dados de localidade, e o resultado precisa ser o
 * mesmo em qualquer aparelho.
 */

/** Mostrado no lugar de um valor que a esteira ainda não enviou. */
export const EMPTY_VALUE = '—';

/** Sinal de menos tipográfico (U+2212), mais legível que o hífen nos números grandes. */
export const MINUS_SIGN = '−';

/** `toFixed` com vírgula decimal e sinal de menos tipográfico; nunca devolve "−0,0". */
function fixed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits).replace('.', ',');
  // O arredondamento pode zerar um valor negativo pequeno (−0,04 → "0,0").
  const isZero = Number(Math.abs(value).toFixed(digits)) === 0;
  return value < 0 && !isZero ? MINUS_SIGN + text : text;
}

/** Número com `digits` casas e vírgula decimal; `null` vira "—". */
export function formatDecimal(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return fixed(value, digits);
}

/** Inteiro arredondado; `null` vira "—". */
export function formatInteger(value: number | null): string {
  return formatDecimal(value, 0);
}

/** Casas decimais suficientes para mostrar um passo: 1 para 0,5 ou 1,0; 2 para 0,25. */
export function decimalsFor(step: number): number {
  const tenths = step * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-9 ? 1 : 2;
}

/** Variação com sinal sempre visível, para os botões: "+0,1", "−1,0". */
export function formatSigned(delta: number, digits: number): string {
  const text = fixed(Math.abs(delta), digits);
  return (delta < 0 ? MINUS_SIGN : '+') + text;
}

/** Até `maxDigits` casas, sem zeros à direita: 22 → "22", 0,80 → "0,8". */
export function formatTrimmed(value: number, maxDigits: number): string {
  const text = fixed(value, maxDigits);
  return text.includes(',') ? text.replace(/0+$/, '').replace(/,$/, '') : text;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** Duração em "12:34" ou, a partir de uma hora, "1:02:03". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return EMPTY_VALUE;
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${twoDigits(minutes)}:${twoDigits(secs)}`;
  }
  return `${minutes}:${twoDigits(secs)}`;
}

/** Ritmo em min/km a partir da velocidade; abaixo de 1 km/h não faz sentido e vira "—". */
export function formatPace(speedKmh: number | null): string {
  if (speedKmh === null || !Number.isFinite(speedKmh) || speedKmh < 1) {
    return EMPTY_VALUE;
  }
  // Ritmo é sempre "min:ss", mesmo acima de 60 minutos por km.
  const secondsPerKm = Math.round(3600 / speedKmh);
  return `${Math.floor(secondsPerKm / 60)}:${twoDigits(secondsPerKm % 60)}`;
}

/** Distância em km com 2 casas, a partir de metros. */
export function formatKilometers(meters: number | null): string {
  return meters === null ? EMPTY_VALUE : formatDecimal(meters / 1000, 2);
}

/** Hora local "HH:MM:SS" de um instante em milissegundos. */
export function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

/** Valor inteiro em hexadecimal com 8 dígitos, como os campos de 32 bits do FTMS. */
export function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * Quantas barras de sinal acender: 0 (o rádio não informou) a 4 (forte).
 *
 * Os limites são de proximidade — o celular fica apoiado no painel da esteira —,
 * então um anúncio a −60 dBm é o esperado e abaixo de −80 dBm já é distância
 * ou corpo no meio do caminho.
 */
export type SignalLevel = 0 | 1 | 2 | 3 | 4;

export function signalLevel(rssi: number | null): SignalLevel {
  if (rssi === null || !Number.isFinite(rssi)) {
    return 0;
  }
  if (rssi >= -60) {
    return 4;
  }
  if (rssi >= -70) {
    return 3;
  }
  if (rssi >= -80) {
    return 2;
  }
  return 1;
}

/**
 * Rótulo do sinal para acessibilidade e para a linha de apoio do aparelho.
 * Três palavras para quatro barras: 4 e 3 são "forte", 2 é "médio", 1 é "fraco".
 */
export function signalLabel(level: SignalLevel): string {
  switch (level) {
    case 4:
    case 3:
      return 'Sinal forte';
    case 2:
      return 'Sinal médio';
    case 1:
      return 'Sinal fraco';
    default:
      return 'Sinal desconhecido';
  }
}
