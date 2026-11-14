import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import { LabelType, Neon, Spacing, withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { plausibleInclinationRange } from '@/treadmill/t600x';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import { cloneVendorMapping, VENDOR_PRESETS } from '@/vendor/presets';
import { formatDecimal } from '@/utils/format';

const CONTROL_LABELS: Record<string, string> = {
  unavailable: 'não disponível nesta esteira',
  idle: 'ainda não pedido',
  requesting: 'pedindo à esteira…',
  granted: 'liberado',
  denied: 'recusado pela esteira',
  lost: 'a esteira retomou o controle',
};

function formatStep(step: number): string {
  return formatDecimal(step, 2);
}

/**
 * Botões de controle do app, para o caso de a esteira aceitar comandos.
 *
 * O FTMS desta T600X recusa tudo (Target Setting Features só de FC), então os
 * botões são uma tentativa: cada toque passa pela sessão, que pede o controle,
 * envia e mostra a resposta no aviso. Quando a sessão sabe que a esteira não
 * declara aquele alvo, o cartão avisa antes.
 */
export function ControlPanel() {
  const theme = useTheme();
  const actions = useTreadmillActions();
  const identityConfirmed = useTreadmill((s) => s.identityConfirmed);
  const capabilities = useTreadmill((s) => s.capabilities);
  const control = useTreadmill((s) => s.control);
  const belt = useTreadmill((s) => s.belt);
  const busy = useTreadmill((s) => s.busy);
  const startBlocked = useTreadmill((s) => s.startBlocked);
  const metrics = useTreadmill((s) => s.metrics);
  const targetSpeed = useTreadmill((s) => s.targetSpeedKmh);
  const targetInclination = useTreadmill((s) => s.targetInclinationPercent);
  const vendor = useTreadmill((s) => s.vendor);
  const gizwitsCompatible = useTreadmill((s) => s.gizwitsProbe.status === 'compatible');
  const [advanced, setAdvanced] = useState(false);

  const hasControlPoint = capabilities?.hasControlPoint ?? false;
  const vendorActive = vendor.enabled;
  const canCommand = identityConfirmed && hasControlPoint;
  const speedStep = capabilities?.speedRange.step ?? 0.1;
  const inclineRange = plausibleInclinationRange(
    capabilities?.inclinationRange ?? { min: 0, max: 15, step: 0.5, source: 'assumed' },
  );
  const inclineStep = inclineRange.step;

  const beltRunning = belt === 'running';
  const speedValue = targetSpeed ?? metrics.speedKmh;
  const inclineValue = targetInclination ?? metrics.inclinationPercent;

  const controlsUnavailable = !canCommand && !vendorActive && !gizwitsCompatible;
  const speedDisabled = controlsUnavailable || busy || !beltRunning;
  const inclineDisabled = controlsUnavailable || busy;
  // No canal alternativo, Iniciar/Pausar/Parar também são enviados pelo 0xFFF0;
  // os três ficam liberados (a sessão avisa se o protocolo não responder).
  const startDisabled = controlsUnavailable || busy || (!vendorActive && beltRunning) ||
    (!vendorActive && startBlocked);
  const pauseDisabled = controlsUnavailable || busy || (!vendorActive && !beltRunning);
  const stopDisabled = controlsUnavailable || busy;

  // Aviso honesto: nesta unidade o próprio FTMS declara que não aceita alvo.
  const speedUndeclared = capabilities?.feature?.targets?.speed === false;
  const inclineUndeclared = capabilities?.feature?.targets?.inclination === false;

  const toggleVendor = () => {
    if (vendor.enabled) {
      actions.setVendorMode(false);
      return;
    }
    if (!vendor.mapping) {
      actions.setVendorMapping(cloneVendorMapping(VENDOR_PRESETS[0]));
    }
    actions.setVendorMode(true);
  };

  return (
    <Surface tone="raised" style={styles.card}>
      <View style={styles.headerRow}>
        <SectionLabel label="Controles do app" accent={Neon.amber} />
        <Text style={[styles.status, { color: theme.textSecondary }]} numberOfLines={1}>
          {gizwitsCompatible ? 'canal alternativo' : (CONTROL_LABELS[control] ?? control)}
        </Text>
      </View>

      {!gizwitsCompatible && (speedUndeclared || inclineUndeclared) ? (
        <Text style={[styles.warning, { color: theme.noticeWarning }]}>
          Esta esteira informou que não aceita alvos de {speedUndeclared ? 'velocidade' : 'inclinação'}
          {speedUndeclared && inclineUndeclared ? ' nem de inclinação' : ''} pelo app. Os botões
          podem ser recusados — o painel continua sendo o controle de verdade.
        </Text>
      ) : null}

      {gizwitsCompatible ? (
        <Text style={[styles.warning, { color: Neon.mint }]}>
          Controles pelo canal alternativo: o protocolo do AFG Pro respondeu. A esteira não confirma
          cada comando; o app confere o efeito nos dados e avisa se não mudar.
        </Text>
      ) : null}

      <View style={styles.beltRow}>
        <ActionButton
          variant="outline"
          color={Neon.volt}
          label="Iniciar"
          onPress={actions.start}
          disabled={startDisabled}
          style={styles.beltButton}
          labelStyle={styles.beltLabel}
        />
        <ActionButton
          variant="outline"
          color={Neon.amber}
          label="Pausar"
          onPress={actions.pause}
          disabled={pauseDisabled}
          style={styles.beltButton}
          labelStyle={styles.beltLabel}
        />
        <ActionButton
          variant="solid"
          color={Neon.red}
          label="Parar"
          onPress={actions.stop}
          disabled={stopDisabled}
          style={styles.beltButton}
          labelStyle={styles.beltLabel}
        />
      </View>

      <View style={styles.stepRows}>
        <Stepper
          label="Velocidade"
          unit="km/h"
          value={speedValue}
          step={speedStep}
          onMinus={() => actions.changeSpeed(-speedStep)}
          onPlus={() => actions.changeSpeed(speedStep)}
          disabled={speedDisabled}
          hint={
            speedDisabled && !beltRunning && !controlsUnavailable
              ? 'Inicie a lona para ajustar a velocidade.'
              : null
          }
        />
        <Stepper
          label="Inclinação"
          unit="%"
          value={inclineValue}
          step={inclineStep}
          onMinus={() => actions.changeInclination(-inclineStep)}
          onPlus={() => actions.changeInclination(inclineStep)}
          disabled={inclineDisabled}
        />
      </View>

      <Pressable
        onPress={() => setAdvanced((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel="Mostrar opções avançadas de controle"
        style={styles.advancedToggle}>
        <Text style={[styles.advancedText, { color: theme.textSecondary }]}>
          {advanced ? 'Ocultar canal alternativo' : 'Canal alternativo (experimental)'}
        </Text>
      </Pressable>

      {advanced ? (
        <View style={styles.advancedBox}>
          <Text style={[styles.advancedDetail, { color: theme.textSecondary }]}>
            Se os botões acima forem recusados, tente mandar os mesmos comandos pelo canal
            proprietário 0xFFF0. O protocolo é desconhecido: pode não fazer nada. A esteira não
            confirma; confira o painel a cada toque.
          </Text>
          <ActionButton
            variant={vendorActive ? 'outline' : 'primary'}
            color={vendorActive ? Neon.red : Neon.violet}
            label={vendorActive ? 'Desligar canal alternativo' : 'Ligar canal alternativo'}
            onPress={toggleVendor}
            disabled={!vendor.available || busy}
            labelStyle={styles.advancedButtonLabel}
          />
          {vendorActive ? (
            <Text style={[styles.advancedDetail, { color: theme.textSecondary }]}>
              Canal alternativo ligado
              {vendor.mapping ? ` (${vendor.mapping.name})` : ''}. Os botões agora escrevem no
              0xFFF0; o Iniciar/Pausar ficam desligados nesse modo.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Surface>
  );
}

function Stepper({
  label,
  unit,
  value,
  step,
  onMinus,
  onPlus,
  disabled,
  hint,
}: {
  label: string;
  unit: string;
  value: number | null;
  step: number;
  onMinus: () => void;
  onPlus: () => void;
  disabled: boolean;
  hint?: string | null;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stepper}>
      <View style={styles.stepperHeader}>
        <Text style={[styles.stepperLabel, LabelType, { color: theme.textSecondary }]}>{label}</Text>
        <Text style={[styles.stepperValue, { color: theme.text }]} numberOfLines={1}>
          {value === null ? '—' : formatDecimal(value, 1)} {unit}
        </Text>
      </View>
      <View style={styles.stepperButtons}>
        <ActionButton
          variant="outline"
          color={Neon.cyan}
          label={`− ${formatStep(step)}`}
          onPress={onMinus}
          disabled={disabled}
          style={styles.stepperButton}
          labelStyle={styles.stepperButtonLabel}
        />
        <ActionButton
          variant="outline"
          color={Neon.cyan}
          label={`+ ${formatStep(step)}`}
          onPress={onPlus}
          disabled={disabled}
          style={styles.stepperButton}
          labelStyle={styles.stepperButtonLabel}
        />
      </View>
      {hint ? (
        <Text style={[styles.stepperHint, { color: theme.textSecondary }]} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two + Spacing.half,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  status: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
  },
  warning: {
    fontSize: 13,
    lineHeight: 18,
  },
  beltRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  beltButton: {
    flex: 1,
    minHeight: 52,
  },
  beltLabel: {
    fontSize: 17,
  },
  stepRows: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  stepper: {
    flex: 1,
    gap: Spacing.one,
  },
  stepperHeader: {
    gap: 2,
  },
  stepperLabel: {
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 1.2,
  },
  stepperValue: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: 700,
  },
  stepperButtons: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  stepperButton: {
    flex: 1,
    minHeight: 44,
  },
  stepperButtonLabel: {
    fontSize: 14,
  },
  stepperHint: {
    fontSize: 11,
    lineHeight: 15,
    paddingTop: 2,
  },
  advancedToggle: {
    paddingTop: Spacing.one,
  },
  advancedText: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
    textDecorationLine: 'underline',
  },
  advancedBox: {
    gap: Spacing.two,
    borderTopWidth: 1,
    borderTopColor: withAlpha('#FFFFFF', 0.08),
    paddingTop: Spacing.two,
  },
  advancedDetail: {
    fontSize: 12,
    lineHeight: 17,
  },
  advancedButtonLabel: {
    fontSize: 15,
  },
});
