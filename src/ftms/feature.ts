import { ByteReader, FtmsParseError } from './bytes';

// A posição no array é o número do bit (FTMS 1.0, tabelas 4.3 e 4.4).
const MACHINE_FEATURE_BITS = [
  'averageSpeed',
  'cadence',
  'totalDistance',
  'inclination',
  'elevationGain',
  'pace',
  'stepCount',
  'resistanceLevel',
  'strideCount',
  'expendedEnergy',
  'heartRate',
  'metabolicEquivalent',
  'elapsedTime',
  'remainingTime',
  'powerMeasurement',
  'forceOnBeltAndPowerOutput',
  'userDataRetention',
] as const;

const TARGET_SETTING_BITS = [
  'speed',
  'inclination',
  'resistance',
  'power',
  'heartRate',
  'expendedEnergy',
  'stepNumber',
  'strideNumber',
  'distance',
  'trainingTime',
  'timeInTwoHeartRateZones',
  'timeInThreeHeartRateZones',
  'timeInFiveHeartRateZones',
  'indoorBikeSimulation',
  'wheelCircumference',
  'spinDown',
  'cadence',
] as const;

export type MachineFeatureName = (typeof MACHINE_FEATURE_BITS)[number];
export type TargetSettingName = (typeof TARGET_SETTING_BITS)[number];

/** Característica Fitness Machine Feature (0x2ACC): o que a esteira mede e o que aceita como alvo. */
export interface FitnessMachineFeature {
  machineFeaturesRaw: number;
  targetSettingsRaw: number;
  /** O que a esteira reporta (campo Fitness Machine Features). */
  machine: Record<MachineFeatureName, boolean>;
  /** O que a esteira aceita controlar (campo Target Setting Features). */
  targets: Record<TargetSettingName, boolean>;
}

function decodeBits<Name extends string>(raw: number, names: readonly Name[]): Record<Name, boolean> {
  const result = {} as Record<Name, boolean>;
  names.forEach((name, bit) => {
    // `>>>` porque `raw` é uint32 e pode ter o bit 31 ligado.
    result[name] = ((raw >>> bit) & 1) === 1;
  });
  return result;
}

export function parseFitnessMachineFeature(bytes: Uint8Array): FitnessMachineFeature {
  if (bytes.length < 4) {
    throw new FtmsParseError(
      `Fitness Machine Feature com ${bytes.length} byte(s); o mínimo são 4`,
    );
  }
  const reader = new ByteReader(bytes);
  const machineFeaturesRaw = reader.u32();
  // Equipamento que só envia o primeiro campo: assume que não aceita nenhum alvo.
  const targetSettingsRaw = reader.canRead(4) ? reader.u32() : 0;
  return {
    machineFeaturesRaw,
    targetSettingsRaw,
    machine: decodeBits(machineFeaturesRaw, MACHINE_FEATURE_BITS),
    targets: decodeBits(targetSettingsRaw, TARGET_SETTING_BITS),
  };
}
