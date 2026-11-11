import { bytesToHex, hexToBytes } from '../bytes';
import {
  ControlPointOp,
  ControlPointResult,
  controlPointOpName,
  controlPointResultName,
  encodePause,
  encodeRequestControl,
  encodeReset,
  encodeSetTargetInclination,
  encodeSetTargetSpeed,
  encodeStartOrResume,
  encodeStop,
  parseControlPointResponse,
} from '../control-point';

describe('comandos do Control Point', () => {
  it('codifica os comandos sem parâmetro', () => {
    expect(bytesToHex(encodeRequestControl())).toBe('00');
    expect(bytesToHex(encodeReset())).toBe('01');
    expect(bytesToHex(encodeStartOrResume())).toBe('07');
  });

  it('codifica parar e pausar com o parâmetro Control Information', () => {
    expect(bytesToHex(encodeStop())).toBe('08 01');
    expect(bytesToHex(encodePause())).toBe('08 02');
  });

  it('codifica a velocidade alvo em centésimos de km/h, little-endian', () => {
    expect(bytesToHex(encodeSetTargetSpeed(10.5))).toBe('02 1A 04');
    expect(bytesToHex(encodeSetTargetSpeed(0.8))).toBe('02 50 00');
    expect(bytesToHex(encodeSetTargetSpeed(22))).toBe('02 98 08');
    expect(bytesToHex(encodeSetTargetSpeed(0))).toBe('02 00 00');
  });

  it('arredonda a velocidade para a resolução do protocolo', () => {
    // 10,55 * 100 = 1055,0000000000002 em ponto flutuante
    expect(bytesToHex(encodeSetTargetSpeed(10.55))).toBe('02 1F 04');
    expect(bytesToHex(encodeSetTargetSpeed(8.004))).toBe('02 20 03');
  });

  it('codifica a inclinação alvo em décimos de %, com sinal', () => {
    expect(bytesToHex(encodeSetTargetInclination(2.5))).toBe('03 19 00');
    expect(bytesToHex(encodeSetTargetInclination(15))).toBe('03 96 00');
    expect(bytesToHex(encodeSetTargetInclination(0))).toBe('03 00 00');
    expect(bytesToHex(encodeSetTargetInclination(-1.5))).toBe('03 F1 FF');
  });

  it('rejeita valores que não cabem no campo', () => {
    expect(() => encodeSetTargetSpeed(-0.1)).toThrow(RangeError);
    expect(() => encodeSetTargetSpeed(655.36)).toThrow(RangeError);
    expect(() => encodeSetTargetSpeed(Number.NaN)).toThrow(RangeError);
    expect(() => encodeSetTargetSpeed(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => encodeSetTargetInclination(3276.8)).toThrow(RangeError);
    expect(() => encodeSetTargetInclination(-3276.9)).toThrow(RangeError);
    expect(() => encodeSetTargetInclination(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseControlPointResponse', () => {
  it('lê uma resposta de sucesso', () => {
    expect(parseControlPointResponse(hexToBytes('80 02 01'))).toEqual({
      requestOpCode: ControlPointOp.SetTargetSpeed,
      resultCode: ControlPointResult.Success,
      parameter: new Uint8Array(),
    });
  });

  it('lê uma recusa de controle', () => {
    expect(parseControlPointResponse(hexToBytes('80 00 05'))).toEqual({
      requestOpCode: ControlPointOp.RequestControl,
      resultCode: ControlPointResult.ControlNotPermitted,
      parameter: new Uint8Array(),
    });
  });

  it('preserva o parâmetro de resposta', () => {
    const response = parseControlPointResponse(hexToBytes('80 13 01 AA BB'));
    expect(response?.parameter).toEqual(hexToBytes('AA BB'));
  });

  it('devolve null para o que não é resposta', () => {
    expect(parseControlPointResponse(hexToBytes('02 1A 04'))).toBeNull();
    expect(parseControlPointResponse(hexToBytes('80 02'))).toBeNull();
    expect(parseControlPointResponse(new Uint8Array())).toBeNull();
  });
});

describe('nomes para o log', () => {
  it('usa o nome da especificação quando conhece o código', () => {
    expect(controlPointOpName(0x02)).toBe('Set Target Speed');
    expect(controlPointResultName(0x05)).toBe('Control Not Permitted');
  });

  it('mostra o valor em hexadecimal quando não conhece', () => {
    expect(controlPointOpName(0x11)).toBe('Op Code 0x11');
    expect(controlPointResultName(0x0a)).toBe('Result Code 0x0A');
  });
});
