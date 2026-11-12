import { Platform, type TextStyle } from 'react-native';

/**
 * Tema do Gym Burn: "carbono + neon".
 *
 * Um único tema, escuro. O app é usado apoiado no painel de uma esteira, com a
 * academia mal iluminada, então a tela é um console: fundo quase preto,
 * superfícies de grafite, contorno fino e neon reservado ao que importa —
 * ação principal, números do treino e estados.
 *
 * Regras:
 * - `text` é conteúdo, `textSecondary` é apoio, `textMuted` é só decoração.
 *   O texto de leitura nunca usa neon puro em tamanho pequeno.
 * - Neon pode ser fundo de botão (com texto escuro), contorno, traço ou
 *   número grande — nunca corpo de texto.
 * - A cor tem significado fixo: volt = agir/iniciar, ciano = inclinação,
 *   âmbar = atenção/pausa, vermelho = parar/erro, menta = sucesso.
 */
const Carbon = {
  text: '#F4F8FF',
  textSecondary: '#9CABC0',
  textMuted: '#66758A',
  background: '#070A10',
  backgroundElement: '#0D131C',
  backgroundSelected: '#1A2433',
  border: '#243141',
  surfaceRaised: '#121A25',
  surfaceSunken: '#04060A',
  /** Tudo que é inclinação: número, medidor e botões. */
  incline: '#35E8FF',
  noticeError: '#FF5B6B',
  noticeWarning: '#FFC24B',
  noticeSuccess: '#45F0A8',
} as const;

export const Colors = {
  /** O app é sempre escuro; `light` existe para o tipo e nunca muda de fato. */
  light: Carbon,
  dark: Carbon,
} as const;

export type ThemeColor = keyof typeof Carbon;

/**
 * Acentos neon. Cada um tem um papel no app; não troque os papéis, troque a
 * matiz se precisar (todos foram escolhidos para contraste sobre `background`).
 */
export const Neon = {
  /** Ação principal, início da lona, velocidade. */
  volt: '#C6FF3D',
  /** Inclinação, dados vindos da esteira. */
  cyan: '#35E8FF',
  /** Destaque raro: roteiro, diagnóstico. */
  magenta: '#FF3D9A',
  /** Atenção, pausa. */
  amber: '#FFC24B',
  /** Parar, erro. */
  red: '#FF3B4E',
  /** Confirmação, sucesso. */
  mint: '#45F0A8',
  /** Apoio secundário: roteiro, tags. */
  violet: '#9B8CFF',
} as const;

/**
 * Cores das ações da lona: são as cores que o usuário já conhece dos botões
 * físicos da esteira. `on*` é a cor do texto sobre cada uma.
 */
export const ActionColors = {
  go: Neon.volt,
  onGo: '#0A1004',
  pause: Neon.amber,
  onPause: '#1A1200',
  stop: Neon.red,
  onStop: '#120306',
} as const;

/**
 * Escala de esforço do medidor de velocidade, da caminhada ao tiro. A cor é
 * escolhida pela posição da velocidade dentro da faixa da esteira.
 */
export const SpeedHeat = [Neon.cyan, Neon.volt, Neon.amber, Neon.red] as const;

/** Cor da escala de esforço para uma fração (0 a 1) da faixa de velocidade. */
export function speedHeatColor(fraction: number): string {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const index = Math.min(Math.floor(clamped * SpeedHeat.length), SpeedHeat.length - 1);
  return SpeedHeat[index];
}

export const Fonts = {
  /** Algarismos condensados, como os de placar e número de peito; carregada em `_layout.tsx`. */
  numeral: 'BarlowCondensed_600SemiBold',
  /** Títulos e rótulos de ação: a voz da marca. */
  display: 'BarlowCondensed_700Bold',
  /** Kickers, tags e micro-rótulos em caixa alta. */
  label: 'BarlowCondensed_500Medium',
  mono: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
} as const;

/** Rótulo miúdo em caixa alta, o "kicker" das seções. */
export const LabelType: TextStyle = {
  fontFamily: Fonts.label,
  fontSize: 12,
  lineHeight: 16,
  letterSpacing: 1.8,
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
  letterSpacing: 0.4,
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
export function neonGlow(color: string, radius = 24, opacity = 0.4): TextStyle {
  return {
    textShadowColor: withAlpha(color, opacity),
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: radius,
  };
}

export const Radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/** Menor alvo de toque: o usuário está correndo, não parado. */
export const MinTouchTarget = 56;

export const MaxContentWidth = 560;

/** Altura dos botões da lona no rodapé do painel; Parar é o mais largo deles. */
export const StopButtonHeight = 76;

/** Opacidade de botões desabilitados (o estado precisa ser lido, não sumir). */
export const DisabledOpacity = 0.42;
