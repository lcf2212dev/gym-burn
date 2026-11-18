import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Kicker } from '@/components/card';
import {
  Fonts,
  LabelType,
  Metric,
  NumeralType,
  Radius,
  Spacing,
  withAlpha,
} from '@/constants/theme';
import type { MachineStatusEvent } from '@/ftms';
import type {
  EquipmentInfo,
  TreadmillCapabilities,
  TreadmillMetrics,
  TreadmillStatus,
} from '@/treadmill/types';
import {
  EMPTY_VALUE,
  formatClock,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatKilometers,
  formatTrimmed,
} from '@/utils/format';

// --- Console -----------------------------------------------------------------

const TRAINING_NAMES: Record<string, string> = {
  other: 'Outro',
  idle: 'Em espera',
  warmingUp: 'Aquecendo',
  lowIntensityInterval: 'Intervalo leve',
  highIntensityInterval: 'Intervalo forte',
  recoveryInterval: 'Recuperação',
  isometric: 'Isométrico',
  heartRateControl: 'Por FC',
  fitnessTest: 'Teste físico',
  speedTooLow: 'Velocidade baixa',
  speedTooHigh: 'Velocidade alta',
  coolDown: 'Desaquecendo',
  wattControl: 'Por potência',
  manualMode: 'Manual',
  preWorkout: 'Antes do treino',
  postWorkout: 'Depois do treino',
  reserved: 'Reservado',
};

interface EventText {
  text: string;
  color: string;
}

/** Traduz o evento do console para o que aconteceu no painel. */
function describeEvent(event: MachineStatusEvent): EventText {
  switch (event.type) {
    case 'reset':
      return { text: 'Console reiniciou', color: Metric.energy };
    case 'stoppedOrPausedByUser':
      return {
        text:
          event.action === 'pause'
            ? 'Lona pausada no painel'
            : event.action === 'stop'
              ? 'Lona parada no painel'
              : 'Lona parada ou pausada no painel',
        color: Metric.energy,
      };
    case 'stoppedBySafetyKey':
      return { text: 'Parada pela chave de segurança', color: '#FF3B4E' };
    case 'startedOrResumedByUser':
      return { text: 'Lona iniciada no painel', color: '#3DE8A0' };
    case 'targetSpeedChanged':
      return {
        text: `Velocidade ajustada no painel: ${formatDecimal(event.speedKmh, 1)} km/h`,
        color: Metric.speed,
      };
    case 'targetInclineChanged':
      return {
        text: `Inclinação ajustada no painel: ${formatDecimal(event.inclinationPercent, 1)} %`,
        color: Metric.incline,
      };
    case 'controlPermissionLost':
      return { text: 'Console liberou o controle', color: '#9AA7B8' };
    default:
      return {
        text: `Evento do console (0x${event.opCode.toString(16).toUpperCase().padStart(2, '0')})`,
        color: '#9AA7B8',
      };
  }
}

/**
 * O que o painel andou fazendo: mudanças de velocidade e inclinação, paradas e
 * a chave de segurança. É a leitura "do outro lado" do treino.
 */
export function ConsoleCard({ status }: { status: TreadmillStatus }) {
  const training = status.training;
  const events = status.consoleEvents.slice(0, 3);

  return (
    <Card>
      <View style={styles.header}>
        <Kicker>Console</Kicker>
        {training ? (
          <View style={styles.trainingPill}>
            <Text style={styles.trainingText}>
              {TRAINING_NAMES[training.name] ?? training.name}
            </Text>
          </View>
        ) : null}
      </View>

      {events.length === 0 ? (
        <Text style={styles.empty}>
          Nada ainda. Mexa no painel da esteira e cada mudança aparece aqui.
        </Text>
      ) : (
        <View style={styles.events}>
          {events.map((event, index) => {
            const described = describeEvent(event.event);
            return (
              <View
                key={`${event.at}-${index}`}
                style={[styles.eventRow, index > 0 ? styles.eventDivider : null]}>
                <Text style={[styles.eventTime, NumeralType]}>{formatClock(event.at)}</Text>
                <View style={[styles.eventDot, { backgroundColor: described.color }]} />
                <Text style={styles.eventText} numberOfLines={2}>
                  {described.text}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

// --- Equipamento -------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, value === null ? styles.infoEmpty : null]} numberOfLines={1}>
        {value ?? EMPTY_VALUE}
      </Text>
    </View>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  averageSpeed: 'vel. média',
  cadence: 'cadência',
  totalDistance: 'distância',
  inclination: 'inclinação',
  elevationGain: 'elevação',
  pace: 'ritmo',
  stepCount: 'passos',
  resistanceLevel: 'resistência',
  strideCount: 'passadas',
  expendedEnergy: 'energia',
  heartRate: 'FC',
  metabolicEquivalent: 'MET',
  elapsedTime: 'tempo',
  remainingTime: 'restante',
  powerMeasurement: 'potência',
  forceOnBeltAndPowerOutput: 'força',
  userDataRetention: 'dados do usuário',
};

function rangeText(min: number, max: number, step: number, unit: string): string {
  return `${formatTrimmed(min, 2)} – ${formatTrimmed(max, 2)} ${unit} · passo ${formatTrimmed(step, 2)}`;
}

/** Quem é o módulo e o que o FTMS declara sobre ele. */
export function EquipmentCard({
  equipment,
  capabilities,
}: {
  equipment: EquipmentInfo | null;
  capabilities: TreadmillCapabilities | null;
}) {
  const [open, setOpen] = useState(false);
  const summary = equipment
    ? [equipment.manufacturer, equipment.firmware].filter(Boolean).join(' · ')
    : null;

  const features = capabilities?.feature
    ? Object.entries(capabilities.feature.machine)
        .filter(([, supported]) => supported)
        .map(([name]) => FEATURE_LABELS[name] ?? name)
    : [];

  return (
    <Card padded={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Equipamento: mostrar detalhes"
        onPress={() => setOpen((value) => !value)}
        style={styles.collapseHeader}>
        <View style={styles.collapseTitle}>
          <Kicker>Equipamento</Kicker>
          <Text style={styles.collapseSummary} numberOfLines={1}>
            {summary || (equipment ? 'identidade sem nome' : 'lendo identidade…')}
          </Text>
        </View>
        <Text style={styles.collapseIcon}>{open ? '−' : '+'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.collapseBody}>
          <InfoRow label="Fabricante" value={equipment?.manufacturer ?? null} />
          <InfoRow label="Modelo" value={equipment?.model ?? null} />
          <InfoRow label="Serial" value={equipment?.serial ?? null} />
          <InfoRow label="Firmware" value={equipment?.firmware ?? null} />
          <InfoRow label="Software" value={equipment?.software ?? null} />
          <InfoRow label="Hardware" value={equipment?.hardware ?? null} />
          <InfoRow label="System ID" value={equipment?.systemId ?? null} />

          {capabilities ? (
            <>
              <View style={styles.sectionDivider} />
              <Text style={styles.groupLabel}>FAIXAS DECLARADAS</Text>
              <InfoRow
                label="Velocidade"
                value={rangeText(
                  capabilities.speedRange.min,
                  capabilities.speedRange.max,
                  capabilities.speedRange.step,
                  'km/h',
                )}
              />
              <InfoRow
                label="Inclinação"
                value={
                  capabilities.inclinationRange.max > 15
                    ? `${formatTrimmed(capabilities.inclinationRange.min, 2)} – ${formatTrimmed(
                        capabilities.inclinationRange.max,
                        2,
                      )} % (template; a leitura é corrigida)`
                    : rangeText(
                        capabilities.inclinationRange.min,
                        capabilities.inclinationRange.max,
                        capabilities.inclinationRange.step,
                        '%',
                      )
                }
              />

              <View style={styles.sectionDivider} />
              <Text style={styles.groupLabel}>O QUE O FTMS DECLARA MEDIR</Text>
              {features.length === 0 ? (
                <Text style={styles.empty}>O FTMS desta esteira não informou os recursos.</Text>
              ) : (
                <View style={styles.chips}>
                  {features.map((feature) => (
                    <View key={feature} style={styles.chip}>
                      <Text style={styles.chipText}>{feature}</Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// --- Todos os dados ----------------------------------------------------------

interface DataField {
  label: string;
  value: string;
  sent: boolean;
}

function buildDataFields(metrics: TreadmillMetrics): DataField[] {
  const text = (
    label: string,
    value: number | null,
    format: (input: number) => string,
    unit = '',
  ): DataField => ({
    label,
    value: value === null ? EMPTY_VALUE : `${format(value)}${unit ? ` ${unit}` : ''}`,
    sent: value !== null,
  });

  return [
    text('Velocidade instantânea', metrics.speedKmh, (v) => formatDecimal(v, 1), 'km/h'),
    text('Velocidade média', metrics.averageSpeedKmh, (v) => formatDecimal(v, 1), 'km/h'),
    text('Distância total', metrics.distanceM, (v) => formatKilometers(v), 'km'),
    text('Inclinação', metrics.inclinationPercent, (v) => formatDecimal(v, 1), '%'),
    text('Ângulo de rampa', metrics.rampAngleDeg, (v) => formatDecimal(v, 1), '°'),
    text('Ganho de elevação', metrics.positiveElevationGainM, (v) => formatDecimal(v, 1), 'm'),
    text('Perda de elevação', metrics.negativeElevationGainM, (v) => formatDecimal(v, 1), 'm'),
    text('Ritmo instantâneo', metrics.instantaneousPaceRaw, (v) => formatInteger(v)),
    text('Ritmo médio', metrics.averagePaceRaw, (v) => formatInteger(v)),
    text('Energia total', metrics.totalEnergyKcal, (v) => formatInteger(v), 'kcal'),
    text('Energia por hora', metrics.energyPerHourKcal, (v) => formatInteger(v), 'kcal/h'),
    text('Energia por minuto', metrics.energyPerMinuteKcal, (v) => formatInteger(v), 'kcal/min'),
    text('Batimentos', metrics.heartRateBpm, (v) => formatInteger(v), 'bpm'),
    text('MET', metrics.metabolicEquivalent, (v) => formatDecimal(v, 1)),
    text('Tempo decorrido', metrics.elapsedTimeS, (v) => formatDuration(v)),
    text('Tempo restante', metrics.remainingTimeS, (v) => formatDuration(v)),
    text('Força na lona', metrics.forceOnBeltN, (v) => formatInteger(v), 'N'),
    text('Potência', metrics.powerOutputW, (v) => formatInteger(v), 'W'),
  ];
}

/**
 * A lista honesta: todo campo do Treadmill Data, com o valor quando a esteira
 * manda e "—" quando o firmware desta unidade simplesmente não envia.
 */
export function DataFieldsCard({ metrics }: { metrics: TreadmillMetrics }) {
  const [open, setOpen] = useState(false);
  const fields = buildDataFields(metrics);
  const sentCount = fields.filter((field) => field.sent).length;

  return (
    <Card padded={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Dados da esteira: mostrar todos os campos"
        onPress={() => setOpen((value) => !value)}
        style={styles.collapseHeader}>
        <View style={styles.collapseTitle}>
          <Kicker>Dados da esteira</Kicker>
          <Text style={styles.collapseSummary}>
            {sentCount} de {fields.length} campos chegando
          </Text>
        </View>
        <Text style={styles.collapseIcon}>{open ? '−' : '+'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.collapseBody}>
          {fields.map((field) => (
            <View key={field.label} style={styles.infoRow}>
              <Text style={[styles.infoLabel, field.sent ? null : styles.infoLabelMuted]}>
                {field.label}
              </Text>
              <Text
                style={[
                  styles.infoValue,
                  field.sent ? null : styles.infoEmpty,
                  field.sent ? NumeralType : null,
                ]}>
                {field.value}
              </Text>
            </View>
          ))}
          <Text style={styles.footnote}>
            O firmware desta esteira não envia velocidade média, ritmo, elevação, tempo restante,
            força nem potência. O ângulo de rampa vem fixo em 0,5° e não acompanha a inclinação.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  trainingPill: {
    borderWidth: 1,
    borderColor: withAlpha('#FFFFFF', 0.12),
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 2,
  },
  trainingText: {
    ...LabelType,
    fontSize: 10,
    letterSpacing: 1,
    color: '#9AA7B8',
  },
  empty: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: '#5C687A',
    marginTop: Spacing.two,
  },
  events: {
    marginTop: Spacing.two,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  eventDivider: {
    borderTopWidth: 1,
    borderTopColor: withAlpha('#FFFFFF', 0.06),
  },
  eventTime: {
    fontSize: 12,
    lineHeight: 14,
    color: '#5C687A',
    fontVariant: ['tabular-nums'],
  },
  eventDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  eventText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 17,
    color: '#DCE6F5',
  },
  collapseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three + 2,
    minHeight: 56,
  },
  collapseTitle: {
    flex: 1,
    gap: 2,
  },
  collapseSummary: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: '#5C687A',
  },
  collapseIcon: {
    fontFamily: Fonts.body,
    fontSize: 20,
    color: '#9AA7B8',
    paddingLeft: Spacing.two,
  },
  collapseBody: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: 2,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.one + 2,
  },
  infoLabel: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: '#9AA7B8',
    flexShrink: 1,
  },
  infoLabelMuted: {
    color: '#5C687A',
  },
  infoValue: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: '#F3F7FF',
    textAlign: 'right',
    flexShrink: 1,
  },
  infoEmpty: {
    color: '#5C687A',
  },
  sectionDivider: {
    height: 1,
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    marginVertical: Spacing.three,
  },
  groupLabel: {
    ...LabelType,
    fontSize: 9,
    letterSpacing: 1.2,
    color: '#5C687A',
    marginBottom: Spacing.one,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one + 2,
  },
  chip: {
    borderWidth: 1,
    borderColor: withAlpha('#3DE8A0', 0.35),
    backgroundColor: withAlpha('#3DE8A0', 0.1),
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 3,
  },
  chipText: {
    ...LabelType,
    fontSize: 10,
    letterSpacing: 0.8,
    color: '#3DE8A0',
    textTransform: 'none',
  },
  footnote: {
    fontFamily: Fonts.body,
    fontSize: 11,
    lineHeight: 16,
    color: '#5C687A',
    marginTop: Spacing.three,
  },
});
