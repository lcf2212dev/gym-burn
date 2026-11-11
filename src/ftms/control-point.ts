/** Op codes do Fitness Machine Control Point (0x2AD9) usados por uma esteira (FTMS 1.0, tabela 4.15). */
export const ControlPointOp = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetSpeed: 0x02,
  SetTargetInclination: 0x03,
  StartOrResume: 0x07,
  StopOrPause: 0x08,
  ResponseCode: 0x80,
} as const;

/** Result codes da indication de resposta (FTMS 1.0, tabela 4.24). */
export const ControlPointResult = {
  Success: 0x01,
  OpCodeNotSupported: 0x02,
  InvalidParameter: 0x03,
  OperationFailed: 0x04,
  ControlNotPermitted: 0x05,
} as const;

// Parâmetro Control Information do op code Stop or Pause (tabela 4.16).
const STOP = 0x01;
const PAUSE = 0x02;

export interface ControlPointResponse {
  /** Op code do pedido ao qual esta resposta se refere. */
  requestOpCode: number;
  resultCode: number;
  /** Parâmetro de resposta, quando existe (só o Spin Down usa). */
  parameter: Uint8Array;
}

export function encodeRequestControl(): Uint8Array {
  return Uint8Array.of(ControlPointOp.RequestControl);
}

export function encodeReset(): Uint8Array {
  return Uint8Array.of(ControlPointOp.Reset);
}

/** Set Target Speed: uint16 com resolução de 0,01 km/h. */
export function encodeSetTargetSpeed(kmh: number): Uint8Array {
  const raw = Math.round(kmh * 100);
  if (!Number.isFinite(kmh) || raw < 0 || raw > 0xffff) {
    throw new RangeError(`Velocidade fora do intervalo codificável: ${kmh} km/h`);
  }
  return Uint8Array.of(ControlPointOp.SetTargetSpeed, raw & 0xff, raw >> 8);
}

/** Set Target Inclination: sint16 com resolução de 0,1 %. */
export function encodeSetTargetInclination(percent: number): Uint8Array {
  const raw = Math.round(percent * 10);
  if (!Number.isFinite(percent) || raw < -0x8000 || raw > 0x7fff) {
    throw new RangeError(`Inclinação fora do intervalo codificável: ${percent} %`);
  }
  const unsigned = raw & 0xffff;
  return Uint8Array.of(ControlPointOp.SetTargetInclination, unsigned & 0xff, unsigned >> 8);
}

export function encodeStartOrResume(): Uint8Array {
  return Uint8Array.of(ControlPointOp.StartOrResume);
}

export function encodeStop(): Uint8Array {
  return Uint8Array.of(ControlPointOp.StopOrPause, STOP);
}

export function encodePause(): Uint8Array {
  return Uint8Array.of(ControlPointOp.StopOrPause, PAUSE);
}

/**
 * Decodifica a indication do Control Point. Devolve `null` se o valor não for
 * uma resposta (op code diferente de 0x80) ou vier incompleto.
 */
export function parseControlPointResponse(bytes: Uint8Array): ControlPointResponse | null {
  if (bytes.length < 3 || bytes[0] !== ControlPointOp.ResponseCode) {
    return null;
  }
  return {
    requestOpCode: bytes[1],
    resultCode: bytes[2],
    parameter: bytes.slice(3),
  };
}

const OP_NAMES: Record<number, string> = {
  [ControlPointOp.RequestControl]: 'Request Control',
  [ControlPointOp.Reset]: 'Reset',
  [ControlPointOp.SetTargetSpeed]: 'Set Target Speed',
  [ControlPointOp.SetTargetInclination]: 'Set Target Inclination',
  [ControlPointOp.StartOrResume]: 'Start or Resume',
  [ControlPointOp.StopOrPause]: 'Stop or Pause',
  [ControlPointOp.ResponseCode]: 'Response Code',
};

const RESULT_NAMES: Record<number, string> = {
  [ControlPointResult.Success]: 'Success',
  [ControlPointResult.OpCodeNotSupported]: 'Op Code Not Supported',
  [ControlPointResult.InvalidParameter]: 'Invalid Parameter',
  [ControlPointResult.OperationFailed]: 'Operation Failed',
  [ControlPointResult.ControlNotPermitted]: 'Control Not Permitted',
};

function hexByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Nome do op code como na especificação, para o log de diagnóstico. */
export function controlPointOpName(opCode: number): string {
  return OP_NAMES[opCode] ?? `Op Code ${hexByte(opCode)}`;
}

/** Nome do result code como na especificação, para o log de diagnóstico. */
export function controlPointResultName(resultCode: number): string {
  return RESULT_NAMES[resultCode] ?? `Result Code ${hexByte(resultCode)}`;
}
