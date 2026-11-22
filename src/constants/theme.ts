import { Platform, type TextStyle } from 'react-native';

/**
 * Identidade visual do Gym Burn: "cockpit de academia".
 *
 * O app é usado com o celular apoiado no painel da esteira, na academia mal
 * iluminada. A tela é um painel de instrumentos: fundo quase preto, cartões de
 * vidro escuro com contorno fino, e cor só onde há dado — velocidade, inclinação
 * e batimentos têm cor própria e constante, para o olho aprender onde olhar.
 *
 * Regras:
 * - `text` é conteúdo; `textSecondary` é apoio; `textMuted` é só o que não veio.
 * - Cor saturada é para número grande, medidor, gráfico e estado — nunca para
 *   corpo de texto pequeno.
 * - Cada série do gráfico usa a mesma cor do seu cartão. Não troque os papéis.
 */
const Carbon = {
  text: '#F3F7FF',
  textSecondary: '#9AA7B8',
  textMuted: '#5C687A',
  /** Fundo da janela. */
  background: '#06080D',
  /** Fundo de cartão. */
  backgroundElement: '#0B0F16',
  /** Cartão acima de cartão. */
  surfaceRaised: '#121823',
  /** Poço: gráfico, medidor, barras. */
  surfaceSunken: '#04060A',
  backgroundSelected: '#1A2433',
  border: '#222B38',
  /** Contorno de cartão em destaque (hero). */
  borderStrong: '#2E3A4B',
  /** Inclinação: número, medidor e série. */
  incline: '#3DDBFF',
  noticeError: '#FF5B6B',
  noticeWarning: '#FFC24B',
  noticeSuccess: '#3DE8A0',
} as const;

export const Colors = {
  /** O app é sempre escuro; `light` existe para o tipo e nunca muda de fato. */
  light: Carbon,
  dark: Carbon,
} as const;

export type ThemeColor = keyof typeof Carbon;

/**
 * Cor de cada grandeza. É o que amarra o cartão, o número e a série do gráfico:
 * velocidade é volt, inclinação é ciano, batimentos são rosa.
 */
export const Metric = {
  speed: '#C8FF3D',
  incline: '#3DDBFF',
  heart: '#FF4D6D',
  distance: '#8B7CFF',
  energy: '#FFB020',
  time: '#DCE6F5',
} as const;

export type MetricKey = keyof typeof Metric;

/** Acentos de interface: estado, ação e alerta. */
export const Neon = {
  /** Ação principal e identidade da marca: lima. */
  volt: Metric.speed,
  cyan: Metric.incline,
  /** Destaque raro: demonstração, detalhes. */
  magenta: '#FF3D9A',
  amber: Metric.energy,
  red: '#FF3B4E',
  mint: Carbon.noticeSuccess,
  violet: Metric.distance,
} as const;

/**
 * A cor de cada zona de frequência cardíaca, da Z1 à Z5: do frio ao quente. É
 * a mesma no medidor, na lista da semana e no gráfico por minuto.
 */
export const ZoneColors = ['#8FA3BF', Metric.incline, '#3DE8A0', '#FFC24B', '#FF5B6B'] as const;

/** A mira dentro da faixa do dia: um vermelho mais vivo que o da Z5, para não se confundir com ela. */
export const AimColor = '#FF1F4F';

/** Cor do texto sobre um fundo saturado. */
export const OnAccent = '#080B0F';

/** Opacidades padrão de superfícies de vidro. */
export const Glass = {
  /** Fundo de cartão comum. */
  card: 'rgba(18, 24, 35, 0.72)',
  /** Fundo do cartão principal. */
  hero: 'rgba(20, 27, 39, 0.86)',
  /** Fundo de poço (gráfico, medidor). */
  well: 'rgba(4, 6, 10, 0.66)',
} as const;

export const Fonts = {
  /** Algarismos condensados, como os de placar; carregada em `_layout.tsx`. */
  numeral: 'BarlowCondensed_600SemiBold',
  /** Títulos: a voz da marca. */
  display: 'BarlowCondensed_700Bold',
  /** Kickers, tags e micro-rótulos em caixa alta. */
  label: 'BarlowCondensed_500Medium',
  /** Corpo de texto: fonte do sistema (Roboto no Android), para leitura. */
  body: Platform.select({ ios: 'System', default: 'sans-serif' }),
  mono: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
} as const;

/** Rótulo miúdo em caixa alta, o "kicker" das seções. */
export const LabelType: TextStyle = {
  fontFamily: Fonts.label,
  fontSize: 11,
  lineHeight: 14,
  letterSpacing: 1.6,
  textTransform: 'uppercase',
};

/** Número de placar: condensado, tabular, sem peso sintético. */
export const NumeralType: TextStyle = {
  fontFamily: Fonts.numeral,
  fontVariant: ['tabular-nums'],
};

/** Título de tela na fonte de display, com um respiro entre as letras. */
export const TitleType: TextStyle = {
  fontFamily: Fonts.display,
  letterSpacing: 0.2,
};

/** Corpo de leitura. */
export const BodyType: TextStyle = {
  fontFamily: Fonts.body,
  fontSize: 14,
  lineHeight: 20,
};

/** Adiciona transparência a uma cor `#RRGGBB` (as cores do tema são todas hex). */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '');
  if (hex.length !== 6) {
    return color;
  }
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  const clamped = Math.min(Math.max(alpha, 0), 1);
  return `rgba(${red}, ${green}, ${blue}, ${clamped})`;
}

/**
 * Halo de neon para números e títulos grandes. Funciona nos dois sistemas
 * (`textShadow*` no Android e no iOS); use com parcimônia: é o que dá o efeito
 * de letreiro sem precisar de gradiente.
 */
export function neonGlow(color: string, radius = 20, opacity = 0.45): TextStyle {
  return {
    textShadowColor: withAlpha(color, opacity),
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: radius,
  };
}

export const Radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  /** Cartão principal: canto bem arredondado, cara de painel. */
  hero: 30,
  pill: 999,
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 12,
  four: 16,
  five: 24,
  six: 32,
  seven: 48,
} as const;

/** Altura mínima de alvo de toque: o usuário está ofegante, não parado. */
export const MinTouchTarget = 48;

export const MaxContentWidth = 560;
