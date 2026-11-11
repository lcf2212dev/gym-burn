import type { MachineFeatureName, TargetSettingName, TrainingStatusName } from '@/ftms';
import type {
  BeltState,
  ControlState,
  LogEntry,
  RangeInfo,
  SessionMode,
} from '@/treadmill/types';

/** Textos da interface derivados do estado da sessão. */

export const CONTROL_STATE_LABELS: Record<ControlState, string> = {
  unavailable: 'Somente leitura',
  idle: 'Lendo dados',
  requesting: 'Pedindo controle…',
  granted: 'Controle liberado',
  denied: 'A esteira recusou o controle',
  lost: 'A esteira retomou o controle',
};

export const BELT_STATE_LABELS: Record<BeltState, string> = {
  unknown: 'Desconhecida',
  running: 'Em movimento',
  paused: 'Pausada',
  stopped: 'Parada',
  safetyKey: 'Parada pelo Emergency Stop ou pela chave de segurança',
};

export const MODE_LABELS: Record<SessionMode, string> = {
  ble: 'Bluetooth',
  demo: 'Demonstração',
};

export const RANGE_SOURCE_LABELS: Record<RangeInfo['source'], string> = {
  device: 'informada pela esteira',
  assumed: 'presumida pela ficha técnica da T600X',
};

/** Direção de cada item do registro, por extenso. */
export const LOG_KIND_LABELS: Record<LogEntry['kind'], string> = {
  tx: 'enviado',
  rx: 'recebido',
  info: 'info',
  error: 'erro',
};

export const TRAINING_STATUS_LABELS: Record<TrainingStatusName, string> = {
  other: 'Outro',
  idle: 'Em espera',
  warmingUp: 'Aquecimento',
  lowIntensityInterval: 'Intervalo de baixa intensidade',
  highIntensityInterval: 'Intervalo de alta intensidade',
  recoveryInterval: 'Intervalo de recuperação',
  isometric: 'Isométrico',
  heartRateControl: 'Controle por frequência cardíaca',
  fitnessTest: 'Teste de condicionamento',
  speedTooLow: 'Velocidade abaixo do esperado',
  speedTooHigh: 'Velocidade acima do esperado',
  coolDown: 'Desaquecimento',
  wattControl: 'Controle por potência',
  manualMode: 'Modo manual',
  preWorkout: 'Antes do treino',
  postWorkout: 'Depois do treino',
  reserved: 'Código reservado',
};

/** O que a esteira mede (Fitness Machine Features). */
export const MACHINE_FEATURE_LABELS: Record<MachineFeatureName, string> = {
  averageSpeed: 'Velocidade média',
  cadence: 'Cadência',
  totalDistance: 'Distância total',
  inclination: 'Inclinação',
  elevationGain: 'Ganho de elevação',
  pace: 'Ritmo',
  stepCount: 'Passos',
  resistanceLevel: 'Nível de resistência',
  strideCount: 'Passadas',
  expendedEnergy: 'Calorias gastas',
  heartRate: 'Frequência cardíaca',
  metabolicEquivalent: 'METs',
  elapsedTime: 'Tempo decorrido',
  remainingTime: 'Tempo restante',
  powerMeasurement: 'Potência',
  forceOnBeltAndPowerOutput: 'Força na lona e potência',
  userDataRetention: 'Guarda dados do usuário',
};

/** O que a esteira aceita controlar (Target Setting Features). */
export const TARGET_SETTING_LABELS: Record<TargetSettingName, string> = {
  speed: 'Velocidade',
  inclination: 'Inclinação',
  resistance: 'Resistência',
  power: 'Potência',
  heartRate: 'Frequência cardíaca',
  expendedEnergy: 'Calorias gastas',
  stepNumber: 'Número de passos',
  strideNumber: 'Número de passadas',
  distance: 'Distância',
  trainingTime: 'Tempo de treino',
  timeInTwoHeartRateZones: 'Tempo em duas zonas de frequência cardíaca',
  timeInThreeHeartRateZones: 'Tempo em três zonas de frequência cardíaca',
  timeInFiveHeartRateZones: 'Tempo em cinco zonas de frequência cardíaca',
  indoorBikeSimulation: 'Simulação de bicicleta',
  wheelCircumference: 'Circunferência da roda',
  spinDown: 'Calibração por desaceleração',
  cadence: 'Cadência',
};
