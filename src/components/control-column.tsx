import { Platform, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Fonts, Spacing } from '@/constants/theme';
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
  /** Cor dos botões e do número. */
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
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>

      <View style={styles.stepRow}>
        {stepButton(steps.big)}
        {stepButton(steps.small)}
      </View>

      <View
        style={styles.readout}
        accessible
        accessibilityLabel={`${title}: ${formatDecimal(value, 1)} ${spokenUnit}`}>
        <View style={[styles.meterTrack, { backgroundColor: theme.backgroundSelected }]}>
          <View
            style={[
              styles.meterFill,
              { height: `${fraction * 100}%`, backgroundColor: meterColor },
            ]}
          />
        </View>
        <View style={styles.numberBlock}>
          <Text
            style={[styles.number, { color: accentColor }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.4}>
            {formatDecimal(value, 1)}
          </Text>
          <Text style={[styles.unit, { color: theme.textSecondary }]}>{unit}</Text>
        </View>
      </View>

      {/* A linha fica reservada para o número não pular quando o alvo aparece. */}
      <View style={styles.targetSlot}>
        {showsTarget(target, value, steps.small) ? (
          <Text style={[styles.target, { color: theme.textSecondary }]}>
            alvo {formatDecimal(target, 1)}
          </Text>
        ) : null}
      </View>

      <View style={styles.stepRow}>
        {stepButton(-steps.big)}
        {stepButton(-steps.small)}
      </View>

      {hint ? <Text style={[styles.note, { color: theme.textSecondary }]}>{hint}</Text> : null}
      {warning ? (
        <Text style={[styles.note, { color: theme.noticeWarning }]}>{warning}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    flex: 1,
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  title: {
    fontSize: 17,
    fontWeight: 600,
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
    fontFamily: Fonts.numeral,
    fontSize: 24,
    fontWeight: 'normal',
    fontVariant: ['tabular-nums'],
  },
  readout: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.two,
    minHeight: 120,
  },
  meterTrack: {
    width: 6,
    borderRadius: 3,
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
    fontFamily: Fonts.numeral,
    fontSize: 104,
    // Altura fixa: o número pode encolher para caber (`adjustsFontSizeToFit`)
    // sem que a coluna mude de altura.
    lineHeight: 108,
    height: 108,
    fontVariant: ['tabular-nums'],
    // Sem o respiro extra do Android, o algarismo fica alinhado ao medidor.
    includeFontPadding: Platform.OS === 'android' ? false : undefined,
  },
  unit: {
    fontSize: 16,
    fontWeight: 600,
  },
  targetSlot: {
    minHeight: 22,
  },
  target: {
    fontSize: 16,
    fontWeight: 600,
  },
  note: {
    fontSize: 14,
    lineHeight: 19,
  },
});
