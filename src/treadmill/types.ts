import type { ScannedDevice } from '@/ble/transport';
import type { FitnessMachineFeature, MachineStatusEvent, SupportedRange, TrainingStatus } from '@/ftms';

/** De onde vêm os batimentos: a cinta no peito ou o sensor de mão da esteira. */
export type HeartRateSource = 'strap' | 'treadmill';

/** De onde vem a esteira: o rádio de verdade ou a esteira simulada. */
export type SessionMode = 'ble' | 'demo';

export type ScanState = 'idle' | 'starting' | 'scanning';

export type ConnectionPhase =
  | 'idle' // sem esteira
  | 'connecting' // conectando, descobrindo serviços e lendo a identidade
  | 'connected' // dados chegando
  | 'disconnecting';

export interface RangeInfo extends SupportedRange {
  /**
   * `device`: lida da esteira. `assumed`: a esteira não informou, então vale a
   * ficha técnica da Matrix T600X.
   */
  source: 'device' | 'assumed';
}

/**
 * Identidade do equipamento, lida do Device Information Service (0x180A) ao
 * conectar. Nesta família de esteiras não é o modelo da máquina que aparece:
 * o módulo BLE se identifica aqui.
 */
export interface EquipmentInfo {
  manufacturer: string | null;
  /** Model Number (0x2A24). Na T600X vem `000000`, o placeholder do firmware. */
  model: string | null;
  serial: string | null;
  /** Firmware Revision (0x2A26): o firmware do módulo BLE. */
  firmware: string | null;
  /** Software Revision (0x2A28). */
  software: string | null;
  hardware: string | null;
  /** System ID (0x2A23) em hexadecimal. */
  systemId: string | null;
}

/**
 * O que o FTMS declara sobre a esteira. `feature` fica `null` quando a
 * característica Fitness Machine Feature não pôde ser lida.
 */
export interface TreadmillCapabilities {
  feature: FitnessMachineFeature | null;
  speedRange: RangeInfo;
  /** Faixa declarada pelo FTMS. Na T600X é template do firmware (0–50 %/3 %). */
  inclinationRange: RangeInfo;
  /** UUIDs das características FTMS encontradas, para a seção de detalhes. */
  characteristics: string[];
}

/**
 * Últimos valores recebidos em Treadmill Data (0x2ACD). `null` = a esteira
 * ainda não enviou aquele campo (ou o firmware não o implementa).
 *
 * Nesta T600X o firmware manda velocidade, distância, inclinação, energia, FC,
 * MET e tempo decorrido; os demais campos da especificação nunca aparecem e
 * ficam `null` — a tela de detalhes mostra isso com honestidade.
 */
export interface TreadmillMetrics {
  speedKmh: number | null;
  averageSpeedKmh: number | null;
  distanceM: number | null;
  /**
   * Inclinação do painel, em %. O firmware desta família informa o contador
   * interno no campo de 0,1 % da especificação (raw×0,015 = percentual real);
   * a sessão já entrega o valor corrigido para exibição.
   */
  inclinationPercent: number | null;
  /** Ângulo de rampa declarado pela esteira. Campo morto nesta T600X (0,5° fixo). */
  rampAngleDeg: number | null;
  positiveElevationGainM: number | null;
  negativeElevationGainM: number | null;
  /** Ritmo cru: a esteira declara o recurso, mas não o enviou nesta unidade. */
  instantaneousPaceRaw: number | null;
  averagePaceRaw: number | null;
  /** Energia total do treino, em kcal. */
  totalEnergyKcal: number | null;
  energyPerHourKcal: number | null;
  energyPerMinuteKcal: number | null;
  /**
   * Os batimentos em uso: os da cinta enquanto ela manda leituras, senão os do
   * sensor de mão da esteira. `null` quando a esteira manda 0 (sem contato nas
   * alças) e não há cinta.
   */
  heartRateBpm: number | null;
  /** De onde veio `heartRateBpm`; `null` sem leitura. */
  heartRateSource: HeartRateSource | null;
  /** METs calculados pelo firmware; 1,0 com a lona parada. */
  metabolicEquivalent: number | null;
  elapsedTimeS: number | null;
  remainingTimeS: number | null;
  forceOnBeltN: number | null;
  powerOutputW: number | null;
  /** `Date.now()` da última notificação; `null` se nenhuma chegou. */
  updatedAt: number | null;
  /** Bitmask de flags do último pacote, para saber o que o firmware manda. */
  flags: number | null;
}

/** Uma amostra da telemetria, guardada para o gráfico ao vivo. */
export interface TreadmillSample {
  /** Horário da leitura do campo, inclusive quando o registro FTMS vem dividido. */
  speedAt?: number | null;
  inclineAt?: number | null;
  at: number;
  speedKmh: number | null;
  inclinationPercent: number | null;
  /**
   * A leitura de batimentos que chegou com esta amostra. Com a cinta em uso,
   * cada leitura dela aparece numa amostra só; as amostras entre duas leituras
   * ficam com `null`.
   */
  heartRateBpm: number | null;
  /**
   * De onde vêm os batimentos neste instante. `'strap'` vale para toda amostra
   * feita com a cinta em uso, inclusive as que ficaram sem leitura: com ela a
   * leitura é contínua e ninguém precisa segurar o sensor.
   */
  heartRateSource?: HeartRateSource | null;
  energyKcal: number | null;
  distanceM: number | null;
}

/** Um evento do Fitness Machine Status (0x2ADA), com a hora em que chegou. */
export interface ConsoleEvent {
  at: number;
  event: MachineStatusEvent;
}

/** Estado do treino do ponto de vista do console. */
export interface TreadmillStatus {
  /** Training Status (0x2AD3). Nesta família é "pegajoso": não serve para saber se a lona anda. */
  training: TrainingStatus | null;
  /** Últimos eventos do console, do mais novo para o mais antigo (lista limitada). */
  consoleEvents: ConsoleEvent[];
  /** O console avisou que parou pela chave de segurança ou pelo Emergency Stop. */
  stoppedBySafetyKey: boolean;
}

/** Saúde do enlace BLE, para a tela poder avisar quando a esteira emudece. */
export interface LinkInfo {
  /** `Date.now()` do último pacote recebido da esteira. */
  lastPacketAt: number | null;
  /** Pacotes recebidos nesta conexão. */
  packets: number;
  /** Intervalo mediano entre pacotes, em ms; `null` até haver amostras. */
  intervalMs: number | null;
  /** RSSI do anúncio no momento da conexão. */
  rssi: number | null;
}

export interface Notice {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  /** Texto pronto para exibir. */
  message: string;
}

/**
 * Estado completo da sessão. É imutável: cada mudança gera um objeto novo, e
 * as partes que não mudaram mantêm a mesma referência (é o que permite os
 * seletores de `useTreadmill` não renderizarem à toa).
 */
export interface TreadmillSnapshot {
  mode: SessionMode;
  scan: ScanState;
  /** Equipamentos encontrados na busca atual, FTMS primeiro. */
  devices: ScannedDevice[];
  phase: ConnectionPhase;
  device: { id: string; name: string | null } | null;
  /** Preenchido depois de ler o Device Information ao conectar. */
  equipment: EquipmentInfo | null;
  /** Preenchido enquanto `phase` é `connected`. */
  capabilities: TreadmillCapabilities | null;
  metrics: TreadmillMetrics;
  /** Amostras recentes para o gráfico ao vivo (mais antiga primeiro). */
  samples: TreadmillSample[];
  status: TreadmillStatus;
  link: LinkInfo;
  /** Aviso mais recente para o usuário; some com `dismissNotice()`. */
  notice: Notice | null;
}

/**
 * Ações disponíveis para a interface. Nenhuma devolve resultado: o efeito
 * aparece no snapshot (e erros viram `notice`).
 *
 * O app é 100% leitura: não existe ação que mande comando para a esteira.
 */
export interface TreadmillActions {
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string): void;
  /** Conecta na esteira simulada, sem usar o rádio (modo demonstração). */
  openDemo(): void;
  disconnect(): void;
  dismissNotice(): void;
}
