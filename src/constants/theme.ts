import { Platform } from 'react-native';

/**
 * Cores do app nos modos claro e escuro. A base é um azul-ardósia (a cor de um
 * console de esteira), não preto: os números grandes precisam de contraste, mas
 * a tela fica ao lado do painel iluminado da máquina.
 */
export const Colors = {
  light: {
    text: '#111A24',
    textSecondary: '#56667A',
    background: '#EEF2F5',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#DDE5EC',
    border: '#CBD5DF',
    /** Tudo que é inclinação: número, medidor e botões. */
    incline: '#2563EB',
    noticeError: '#B4232F',
    noticeWarning: '#8A6100',
    noticeSuccess: '#17734A',
  },
  dark: {
    text: '#F4F7FA',
    textSecondary: '#A3B3C4',
    background: '#16202B',
    backgroundElement: '#1F2C3A',
    backgroundSelected: '#2A3A4C',
    border: '#34465A',
    incline: '#6EA8FE',
    noticeError: '#FF8A94',
    noticeWarning: '#F4C430',
    noticeSuccess: '#5FD896',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Cores das ações da lona, iguais nos dois modos: são as cores que o usuário já
 * conhece dos botões físicos da esteira. `on*` é a cor do texto sobre cada uma.
 */
export const ActionColors = {
  go: '#2FBF71',
  onGo: '#06140C',
  pause: '#F4C430',
  onPause: '#1A1400',
  stop: '#D62839',
  onStop: '#FFFFFF',
} as const;

/**
 * Escala de esforço do medidor de velocidade, da caminhada ao tiro. A cor é
 * escolhida pela posição da velocidade dentro da faixa da esteira.
 */
export const SpeedHeat = ['#2EC4B6', '#F4C430', '#FF8A3D', '#FF4D6D'] as const;

/** Cor da escala de esforço para uma fração (0 a 1) da faixa de velocidade. */
export function speedHeatColor(fraction: number): string {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const index = Math.min(Math.floor(clamped * SpeedHeat.length), SpeedHeat.length - 1);
  return SpeedHeat[index];
}

export const Fonts = {
  /** Algarismos condensados, como os de placar e número de peito; carregada em `_layout.tsx`. */
  numeral: 'BarlowCondensed_600SemiBold',
  mono: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
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

/** Opacidade de botões desabilitados. */
export const DisabledOpacity = 0.35;
