import { ByteReader, FtmsParseError } from './bytes';

/**
 * Evento da característica Fitness Machine Status (0x2ADA): mudanças feitas no
 * console da esteira ou por outro cliente (FTMS 1.0, tabela 4.26).
 */
export type MachineStatusEvent =
  | { type: 'reset' }
  | { type: 'stoppedOrPausedByUser'; action: 'stop' | 'pause' | 'unknown' }
  | { type: 'stoppedBySafetyKey' }
  | { type: 'startedOrResumedByUser' }
  | { type: 'targetSpeedChanged'; speedKmh: number }
  | { type: 'targetInclineChanged'; inclinationPercent: number }
  | { type: 'controlPermissionLost' }
  | { type: 'other'; opCode: number; parameter: Uint8Array };

const OP = {
  reset: 0x01,
  stoppedOrPausedByUser: 0x02,
  stoppedBySafetyKey: 0x03,
  startedOrResumedByUser: 0x04,
  targetSpeedChanged: 0x05,
  targetInclineChanged: 0x06,
  controlPermissionLost: 0xff,
} as const;

/**
 * Campo de velocidade alvo do firmware desta família (Matrix/Vision T600X).
 *
 * A especificação manda o campo em 0,01 km/h (raw/100), mas este firmware o
 * grava 16× acima: uma lona a 5,0 km/h chega como raw 8000 — que lido pela
 * especificação daria 80 km/h. O divisor abaixo (100 × 16 = 1600) é a correção
 * desse desvio, confirmada nas capturas desta T600X. O campo de inclinação
 * (0x06) não tem o problema: raw/10 já entrega o percentual.
 */
const FIRMWARE_SPEED_SCALE = 1600;

export function parseMachineStatus(bytes: Uint8Array): MachineStatusEvent {
  if (bytes.length < 1) {
    throw new FtmsParseError('Fitness Machine Status vazio');
  }
  const reader = new ByteReader(bytes);
  const opCode = reader.u8();
  switch (opCode) {
    case OP.reset:
      return { type: 'reset' };
    case OP.stoppedOrPausedByUser: {
      const control = reader.canRead(1) ? reader.u8() : 0;
      const action = control === 0x01 ? 'stop' : control === 0x02 ? 'pause' : 'unknown';
      return { type: 'stoppedOrPausedByUser', action };
    }
    case OP.stoppedBySafetyKey:
      return { type: 'stoppedBySafetyKey' };
    case OP.startedOrResumedByUser:
      return { type: 'startedOrResumedByUser' };
    case OP.targetSpeedChanged:
      if (reader.canRead(2)) {
        return { type: 'targetSpeedChanged', speedKmh: reader.u16() / FIRMWARE_SPEED_SCALE };
      }
      break;
    case OP.targetInclineChanged:
      if (reader.canRead(2)) {
        return { type: 'targetInclineChanged', inclinationPercent: reader.s16() / 10 };
      }
      break;
    case OP.controlPermissionLost:
      return { type: 'controlPermissionLost' };
  }
  return { type: 'other', opCode, parameter: reader.rest() };
}
