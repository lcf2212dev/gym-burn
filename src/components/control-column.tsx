import { Platform, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { LabelType, NumeralType, Spacing, neonGlow, withAlpha } from '@/constants/theme';
import type { SupportedRange } from '@/ftms';
import { useTheme } from '@/hooks/use-theme';
import { rangeFraction, showsTarget, type ControlSteps } from '@/utils/controls';
import { decimalsFor, formatDecimal, formatSigned } from '@/utils/format';

export interface ControlColumnProps {
  /** "Inclinação", "Velocidade". */
  title: string;
  /** Unidade mostrada sob o número: "%", "km/h". */
  unit: string;
  /** Unidade lida pelo leitor de tela: "por cento", "km/h". */
  spokenUnit: string;
  /** Substantivo em minúsculas para os rótulos de acessibilidade: "inclinação". */
  noun: string;
  value: number | null;
  target: number | null;
  range: SupportedRange;
  steps: ControlSteps;
  onChange: (delta: number) => void;
  disabled: boolean;
  /** Cor dos botões, do título e do número. */
  accentColor: string;
  /** Cor do preenchimento do medidor. */
  meterColor: string;
  /** Dica neutra sob os botões (por que estão desabilitados). */
  hint?: string | null;
  /** Aviso sob os botões (a esteira pode recusar o comando). */
  warning?: string | null;
}

/**
 * Uma coluna do painel, como as teclas do console: aumentar em cima, o valor
 * medido no meio com um medidor vertical, diminuir embaixo.
 *
 * No redesign ela é só o conteúdo de um cartão `Surface`; o padding é do
 * cartão. O número é o placar da tela: condensado, tabular, com halo neon na
 * cor da coluna e altura fixa para o painel não pular a cada leitura.
 */
export function ControlColumn({
  title,
  unit,
  spokenUnit,
  noun,
  value,
  target,
  range,
  steps,
  onChange,
  disabled,
  accentColor,
  meterColor,
  hint,
  warning,
}: ControlColumnProps) {
  const theme = useTheme();
  const fraction = rangeFraction(value, range);
  const stepDigits = decimalsFor(steps.small);

  const stepButton = (delta: number) => {
    const amount = formatDecimal(Math.abs(delta), stepDigits);
    const verb = delta > 0 ? 'Aumentar' : 'Diminuir';
    return (
      <ActionButton
        variant="outline"
        color={accentColor}
        label={formatSigned(delta, stepDigits)}
        accessibilityLabel={`${verb} ${noun} em ${amount} ${spokenUnit}`}
        onPress={() => onChange(delta)}
        disabled={disabled}
        style={styles.stepButton}
        labelStyle={styles.stepLabel}
      />
    );
  };

  return (
    <View style={styles.column}>
      {/* Kicker da coluna: traço na cor do controle e micro-rótulo em caixa alta. */}
      <View style={styles.titleRow}>
        <View style={[styles.titleBar, { backgroundColor: accentColor }]} />
        <Text
          style={[styles.title, LabelType, { color: accentColor }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}>
          {title}
        </Text>
      </View>

      <View style={styles.stepRow}>
        {stepButton(steps.big)}
        {stepButton(steps.small)}
      </View>

      {/* Número, medidor e alvo apagam juntos quando o controle está bloqueado. */}
      <View style={[styles.readoutBlock, disabled && styles.readoutDisabled]}>
        <View
          style={styles.readout}
          accessible
          accessibilityLabel={`${title}: ${formatDecimal(value, 1)} ${spokenUnit}`}>
          <View
            style={[
              styles.meterTrack,
              {
                backgroundColor: withAlpha(theme.text, 0.08),
                borderColor: withAlpha(theme.text, 0.06),
              },
            ]}>
            <View
              style={[
                styles.meterFill,
                {
                  height: `${Math.max(fraction * 100, 4)}%`,
                  // Com a lona parada o medidor mostra um pingo na cor do cartão;
                  // a escala de esforço só entra quando há velocidade.
                  backgroundColor: fraction > 0 ? meterColor : accentColor,
                },
              ]}
            />
          </View>
          <View style={styles.numberBlock}>
            <Text
              style={[
                styles.number,
                NumeralType,
                { color: disabled ? theme.textMuted : accentColor },
                !disabled && neonGlow(accentColor, 15, 0.55),
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.4}>
              {formatDecimal(value, 1)}
            </Text>
            <Text style={[styles.unit, LabelType, { color: theme.textSecondary }]} numberOfLines={1}>
              {unit}
            </Text>
          </View>
        </View>

        {/* A linha fica reservada para o número não pular quando o alvo aparece. */}
        <View style={styles.targetSlot}>
          {showsTarget(target, value, steps.small) ? (
            <Text
              style={[styles.target, LabelType, { color: theme.textSecondary }]}
              numberOfLines={1}>
              alvo {formatDecimal(target, 1)}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.stepRow}>
        {stepButton(-steps.big)}
        {stepButton(-steps.small)}
      </View>

      {/* Slot sempre presente: os dois cartões terminam na mesma altura e o
          painel não pulsa quando a dica ou o aviso aparece. */}
      <View style={styles.noteSlot}>
        {hint ? <Text style={[styles.note, { color: theme.textSecondary }]}>{hint}</Text> : null}
        {warning ? (
          <Text style={[styles.note, { color: theme.noticeWarning }]}>{warning}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    flex: 1,
    gap: Spacing.two,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  titleBar: {
    width: 12,
    height: 2,
    borderRadius: 1,
  },
  title: {
    flexShrink: 1,
    letterSpacing: 2.2,
  },
  stepRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  stepButton: {
    flex: 1,
    paddingHorizontal: Spacing.one,
  },
  stepLabel: {
    ...NumeralType,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: 0.5,
  },
  readoutBlock: {
    gap: Spacing.two,
  },
  readoutDisabled: {
    opacity: 0.45,
  },
  readout: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.two,
    minHeight: 118,
  },
  meterTrack: {
    width: 5,
    borderRadius: 3,
    borderWidth: 1,
    overflow: 'hidden',
  },
  // Posição absoluta: uma altura em % num filho comum faria o trilho (e a
  // coluna inteira) crescer junto com o preenchimento.
  meterFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 3,
  },
  numberBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  number: {
    fontSize: 96,
    // Altura fixa: o número pode encolher para caber (`adjustsFontSizeToFit`)
    // sem que a coluna mude de altura. O padding interno (compensado por margem
    // negativa) dá espaço para o halo não ser recortado no Android.
    lineHeight: 100,
    height: 132,
    paddingVertical: 16,
    marginVertical: -16,
    // Sem o respiro extra do Android, o algarismo fica alinhado ao medidor.
    includeFontPadding: Platform.OS === 'android' ? false : undefined,
  },
  unit: {
    fontSize: 12,
    lineHeight: 14,
    letterSpacing: 1.4,
  },
  targetSlot: {
    minHeight: 18,
  },
  target: {
    letterSpacing: 1.6,
  },
  noteSlot: {
    minHeight: 44,
    gap: Spacing.one,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
