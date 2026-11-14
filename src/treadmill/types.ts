import type { ScannedDevice, ServiceInfo } from '@/ble/transport';
import type { FitnessMachineFeature, SupportedRange, TrainingStatus } from '@/ftms';
import type { VendorMapping, VendorState } from '@/vendor/types';

/** De onde vem a esteira: o rádio de verdade ou a esteira simulada. */
export type SessionMode = 'ble' | 'demo';

export type ScanState = 'idle' | 'starting' | 'scanning';

export type ConnectionPhase =
  | 'idle' // sem esteira
  | 'connecting' // conectando, descobrindo serviços e lendo as capacidades
  | 'connected' // dados chegando; comandos liberados se houver Control Point
  | 'disconnecting';

/** Situação da permissão de controle (FTMS 1.0, seção 4.16.2.1). */
export type ControlState =
  | 'unavailable' // a esteira não tem Control Point: só transmite dados
  | 'idle' // ainda não pedimos controle
  | 'requesting'
  | 'granted'
  | 'denied' // a esteira recusou o pedido
  | 'lost'; // a esteira revogou (console ou outro app assumiu)

export type BeltState =
  | 'unknown'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'safetyKey'; // parada pela chave de segurança

export interface RangeInfo extends SupportedRange {
  /**
   * `device`: lida da esteira. `assumed`: a esteira não informou, então vale a
   * ficha técnica da Matrix T600X.
   */
  source: 'device' | 'assumed';
}

export interface TreadmillCapabilities {
  /** `null` quando a característica Fitness Machine Feature não pôde ser lida. */
  feature: FitnessMachineFeature | null;
  hasControlPoint: boolean;
  speedRange: RangeInfo;
  inclinationRange: RangeInfo;
  /** UUIDs das características encontradas no serviço FTMS, para o diagnóstico. */
  characteristics: string[];
}

/** Últimos valores recebidos em Treadmill Data; `null` = a esteira ainda não enviou. */
export interface TreadmillMetrics {
  speedKmh: number | null;
  averageSpeedKmh: number | null;
  inclinationPercent: number | null;
  rampAngleDeg: number | null;
  distanceM: number | null;
  elapsedTimeS: number | null;
  remainingTimeS: number | null;
  energyKcal: number | null;
  energyPerHourKcal: number | null;
  heartRateBpm: number | null;
  metabolicEquivalent: number | null;
  positiveElevationGainM: number | null;
  negativeElevationGainM: number | null;
  /** `Date.now()` da última notificação; `null` se nenhuma chegou. */
  updatedAt: number | null;
}

/**
 * Resultado da última tentativa de enviar um op code proprietário no Control
 * Point do FTMS (`0x7E`/`0x7F`). Só existe para o experimento de campo da Sonda:
 * é a única forma de saber se esse firmware aceita extensões do fabricante.
 */
export interface VendorOpcodeProbe {
  opCode: number;
  /** Nome curto do op code (ex.: "Reset Console Resource (Device Update)"). */
  label: string;
  status: 'pending' | 'answered' | 'timeout' | 'failed' | 'blocked';
  /** `Date.now()` do pedido. */
  at: number;
  /** Result code da response (`Success`, `Control Not Permitted`, …); `null` se não houve. */
  resultCode: number | null;
  /** Parâmetro devolvido junto da response, em hexadecimal (ex.: o delay do 0x7E). */
  parameterHex: string | null;
  /** Explicação curta do desfecho, pronta para exibir. */
  detail: string | null;
}

/** Os comandos que o app envia à esteira. */
export type CommandKind = 'start' | 'pause' | 'stop' | 'speed' | 'inclination';

/** Pedidos e desfechos dos comandos de um tipo, desde que a conexão atual começou. */
export interface CommandTally {
  /**
   * Toques que o app aceitou para enviar. Sobe na hora do toque, antes de qualquer resposta, e
   * pode passar da soma dos desfechos: toques repetidos viram um comando só, e um Parar cancela
   * o que estava na fila.
   */
  requested: number;
  /** A esteira respondeu Success. */
  accepted: number;
  /** A esteira recusou, a escrita falhou ou o app não conseguiu o controle. */
  refused: number;
  /** A esteira não respondeu a tempo: não se sabe se obedeceu. */
  unconfirmed: number;
}

/**
 * Uma linha do registro completo da sessão. Ao contrário de `LogEntry`, que é
 * um resumo limitado para a tela de diagnóstico, estas linhas incluem todos os
 * pacotes, as mudanças de estado e os toques do usuário, e são gravadas em
 * arquivo.
 */
export interface TraceLine {
  /** `Date.now()` do evento. */
  at: number;
  /**
   * `rx`/`tx`: pacote recebido/enviado. `state`: mudança de estado da sessão.
   * `action`: ação pedida pela interface. `guide`: roteiro do primeiro teste.
   */
  kind: 'rx' | 'tx' | 'info' | 'error' | 'state' | 'action' | 'guide';
  text: string;
  /** Bytes em hexadecimal, quando a linha é um pacote. */
  hex: string | null;
}

export type TraceSink = (line: TraceLine) => void;

export interface Notice {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  /** Texto pronto para exibir. */
  message: string;
}

export interface LogEntry {
  id: number;
  /** `Date.now()` do evento. */
  at: number;
  /** `rx`: recebido da esteira. `tx`: enviado. */
  kind: 'rx' | 'tx' | 'info' | 'error';
  /** Ex.: "Treadmill Data", "Set Target Speed 10,5 km/h". */
  label: string;
  /** Bytes em hexadecimal, quando o evento é um pacote. */
  hex: string | null;
}

/**
 * Estado completo da sessão. É imutável: cada mudança gera um objeto novo, e
 * as partes que não mudaram mantêm a mesma referência.
 */
export type GizwitsProbeStatus =
  | 'idle'
  | 'running'
  | 'waitingBelt'
  | 'compatible'
  | 'incompatible'
  | 'error'
  | 'unavailable';

export type GizwitsAttemptStatus = 'pending' | 'running' | 'reply' | 'timeout' | 'error' | 'skipped';

/** Uma tentativa do plano automático de descoberta do canal alternativo. */
export interface GizwitsAttempt {
  /** Identificador curto (machine-info, fff1, seq, crc-be, ack, workout-data, stop-idle, pause-idle). */
  name: string;
  /** Texto em português para a tela. */
  label: string;
  status: GizwitsAttemptStatus;
  /** Resposta recebida (hex), quando houve. */
  replyHex: string | null;
  detail: string | null;
}

/**
 * Plano automático de teste do protocolo Gizwits no 0xFFF0 (o do app AFG Pro).
 *
 * O app tenta primeiro o pedido de “machine info”; conforme a resposta, segue
 * com consultas de leitura e, se não houver resposta, tenta variantes de canal,
 * sequência e CRC. Se precisar de uma ação do usuário (por exemplo, parar a
 * lona), `hint` traz a frase para a faixa do topo.
 */
export interface GizwitsProbeSnapshot {
  status: GizwitsProbeStatus;
  /** Tentativa em andamento, para a tela. */
  stage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Resposta crua da primeira tentativa bem-sucedida. */
  replyHex: string | null;
  replyBytes: number;
  replyCommand: string | null;
  /** O canal respondeu em pelo menos uma tentativa? `null` enquanto não terminou. */
  compatible: boolean | null;
  attempts: GizwitsAttempt[];
  /** Ação que o usuário precisa fazer; aparece na faixa discreta do topo. */
  hint: string | null;
  /** Resumo em linguagem simples. */
  detail: string | null;
}

export interface TreadmillSnapshot {
  mode: SessionMode;
  scan: ScanState;
  /** Equipamentos encontrados na busca atual, FTMS primeiro. */
  devices: ScannedDevice[];
  phase: ConnectionPhase;
  device: { id: string; name: string | null } | null;
  /** Preenchido enquanto `phase` é `connected`. */
  capabilities: TreadmillCapabilities | null;
  control: ControlState;
  /**
   * O usuário confirmou que a esteira conectada é a dele. Numa academia com
   * várias esteiras iguais dá para conectar na do vizinho; até a confirmação,
   * nenhum comando é aceito. Já vem `true` no modo demonstração e em esteira
   * que só transmite dados.
   */
  identityConfirmed: boolean;
  belt: BeltState;
  trainingStatus: TrainingStatus | null;
  metrics: TreadmillMetrics;
  /** Último alvo conhecido: o que o app pediu ou o que a esteira avisou que mudou. */
  targetSpeedKmh: number | null;
  targetInclinationPercent: number | null;
  /**
   * Iniciar/Retomar está bloqueado: a lona acabou de ser pausada ou parada e
   * ainda não parou de girar. Evita que um segundo toque no mesmo lugar a
   * recoloque em movimento.
   */
  startBlocked: boolean;
  /** Quantos comandos de cada tipo a esteira aceitou, recusou ou deixou sem resposta nesta conexão. */
  commands: Record<CommandKind, CommandTally>;
  /** Há comando na fila ou aguardando resposta da esteira. */
  busy: boolean;
  /** Aviso mais recente para o usuário; some com `dismissNotice()`. */
  notice: Notice | null;
  /** Log de diagnóstico, do mais antigo para o mais novo, limitado em tamanho. */
  log: LogEntry[];
  /**
   * Controle experimental pelo canal proprietário 0xFFF0 (o FTMS desta esteira
   * recusa comandos). Desligado por padrão: os botões continuam no FTMS até o
   * usuário ativar e configurar um protocolo na Sonda.
   */
  vendor: VendorState;
  /**
   * Último teste de op code vendor do FTMS (`0x7E`/`0x7F`) feito na Sonda.
   * Fica no snapshot depois de uma queda de conexão para o usuário poder ler o
   * resultado (o console pode reiniciar e derrubar o link justamente no 0x7E).
   */
  vendorOpcodeProbe: VendorOpcodeProbe | null;
  /** Teste automático do protocolo Gizwits no 0xFFF0 (feito logo após conectar). */
  gizwitsProbe: GizwitsProbeSnapshot;
}

/**
 * Ações disponíveis para a interface. Nenhuma devolve resultado: o efeito
 * aparece no snapshot (e erros viram `notice`).
 */
export interface TreadmillActions {
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string): void;
  /** Conecta na esteira simulada, sem usar o rádio. */
  openDemo(): void;
  disconnect(): void;
  /** O usuário conferiu no painel que esta é a esteira dele; libera os comandos. */
  confirmIdentity(): void;
  /** Soma `deltaKmh` ao alvo atual, respeitando a faixa e o passo da esteira. */
  changeSpeed(deltaKmh: number): void;
  changeInclination(deltaPercent: number): void;
  /** Inicia ou retoma a lona. Só é enviado por ação explícita do usuário. */
  start(): void;
  pause(): void;
  stop(): void;
  dismissNotice(): void;
  clearLog(): void;
  /**
   * Liga/desliga o controle experimental pelo 0xFFF0. Exige conexão, a esteira
   * confirmada, o serviço proprietário disponível e um mapeamento configurado.
   */
  setVendorMode(enabled: boolean): void;
  /** Aplica (e persiste) um mapeamento de protocolo do canal proprietário. */
  setVendorMapping(mapping: VendorMapping): void;
  /** Roda a varredura segura de bytes do 0xFFF0; tudo vai para o registro. */
  runVendorDiscovery(): void;
  /** Interrompe a varredura em andamento. */
  cancelVendorDiscovery(): void;
  /**
   * Envia um op code vendor do FTMS no Control Point (`0x7E` ou `0x7F`) e
   * guarda a resposta em `vendorOpcodeProbe`. Só aceita com a esteira parada,
   * a conexão confirmada e o controle liberado; nunca atualiza firmware.
   */
  sendVendorOpcode(opCode: number): void;
  /**
   * Roda o teste automático do protocolo Gizwits no 0xFFF0 (pede machine info e
   * escuta o FFF4). Só leitura; não mexe na lona. O painel chama sozinho uma vez
   * por conexão; a Sonda permite repetir.
   */
  runGizwitsProbe(): void;
}

/**
 * Sonda BLE para experimentos com características fora do FTMS (por exemplo o
 * serviço proprietário 0xFFF0 que a T600X expõe). Ao contrário de
 * TreadmillActions, que nunca devolve resultado, a sonda devolve o valor lido
 * e entrega as notificações por callback: é uma ferramenta de diagnóstico, não
 * um comando da esteira. Tudo o que passa por aqui vai para o registro em
 * arquivo.
 */
export interface ProbeApi {
  /** Há uma conexão BLE ativa e pronta (o modo demonstração não tem rádio). */
  available(): boolean;
  /** Inventário completo do GATT da conexão atual. */
  services(): Promise<ServiceInfo[]>;
  /** Lê a característica e devolve o valor em hexadecimal. */
  read(serviceUuid: string, characteristicUuid: string): Promise<string>;
  /** Escreve os bytes em hexadecimal na característica. */
  write(serviceUuid: string, characteristicUuid: string, hex: string): Promise<void>;
  /**
   * Assina notify/indicate e entrega cada valor em hexadecimal. Devolve a
   * função que cancela a assinatura.
   */
  subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (hex: string) => void,
  ): Promise<() => void>;
}
