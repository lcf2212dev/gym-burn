import { characteristicName } from '@/ftms';
import type {
  LogEntry,
  RangeInfo,
  SessionMode,
  TreadmillCapabilities,
  TreadmillSnapshot,
} from '@/treadmill/types';

import { formatClock, formatHex32, formatTrimmed } from './format';
import { LOG_KIND_LABELS, MODE_LABELS, RANGE_SOURCE_LABELS } from './labels';

/** Faixa em uma linha: "0,8 a 22 km/h, passo 0,1, informada pela esteira". */
export function describeRange(range: RangeInfo, unit: string): string {
  const min = formatTrimmed(range.min, 2);
  const max = formatTrimmed(range.max, 2);
  const step = formatTrimmed(range.step, 2);
  return `${min} a ${max} ${unit}, passo ${step} ${unit}, ${RANGE_SOURCE_LABELS[range.source]}`;
}

/** Um item do registro em texto puro: hora, direção, rótulo e bytes. */
export function describeLogEntry(entry: LogEntry): string {
  const parts = [formatClock(entry.at), LOG_KIND_LABELS[entry.kind], entry.label];
  if (entry.hex) {
    parts.push(entry.hex);
  }
  return parts.join('  ');
}

export interface DiagnosticsReportInput {
  mode: SessionMode;
  device: TreadmillSnapshot['device'];
  capabilities: TreadmillCapabilities | null;
  log: LogEntry[];
}

/**
 * Texto compartilhado pelo botão "Compartilhar registro": um cabeçalho com o
 * que a esteira informou e, depois, o registro do mais antigo para o mais novo.
 */
export function buildDiagnosticsReport({
  mode,
  device,
  capabilities,
  log,
}: DiagnosticsReportInput): string {
  const lines = [
    `Esteira: ${device?.name ?? 'sem nome'}`,
    `Identificador: ${device?.id ?? 'nenhum'}`,
    `Modo: ${MODE_LABELS[mode]}`,
  ];
  if (capabilities) {
    lines.push(
      `Velocidade: ${describeRange(capabilities.speedRange, 'km/h')}`,
      `Inclinação: ${describeRange(capabilities.inclinationRange, '%')}`,
      `Control Point: ${capabilities.hasControlPoint ? 'sim' : 'não'}`,
    );
    const { feature } = capabilities;
    if (feature) {
      lines.push(
        `Machine Features: ${formatHex32(feature.machineFeaturesRaw)}`,
        `Target Settings: ${formatHex32(feature.targetSettingsRaw)}`,
      );
    } else {
      lines.push('Fitness Machine Feature: não informada');
    }
    const names = capabilities.characteristics.map(characteristicName);
    lines.push(`Características: ${names.length > 0 ? names.join(', ') : 'nenhuma'}`);
  }
  lines.push('', ...log.map(describeLogEntry));
  return lines.join('\n');
}
