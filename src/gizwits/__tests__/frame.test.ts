import { bytesToHex } from '@/ftms';

import {
  crc16Ccitt,
  encodeGizwitsFrame,
  encodeGizwitsPause,
  encodeGizwitsSetIncline,
  encodeGizwitsSetSpeed,
  encodeGizwitsStartWorkout,
  encodeGizwitsStop,
  GIZWITS_MACHINE_INFO_REQUEST,
  gizwitsCommandName,
  isGizwitsFrame,
  parseGizwitsFrame,
} from '../frame';

const ascii = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));

describe('protocolo Gizwits', () => {
  it('CRC16-CCITT-FALSE bate com o vetor “123456789” (0x29B1)', () => {
    expect(crc16Ccitt(ascii('123456789'))).toBe(0x29b1);
  });

  it('pedido de machine info é exatamente 55 AA 00 00 01 02 00 00 00 00', () => {
    expect(bytesToHex(GIZWITS_MACHINE_INFO_REQUEST)).toBe('55 AA 00 00 01 02 00 00 00 00');
  });

  it('monta um frame com sequência, lingo, comando, tamanho e CRC do payload', () => {
    const frame = encodeGizwitsFrame(2, 5, Uint8Array.of(0, 0x64, 0), 1);
    expect(bytesToHex(frame)).toBe('55 AA 01 00 02 05 03 00 ' + bytesToHex(crcBytes()) + ' 00 64 00');
    expect(parseGizwitsFrame(frame)).toEqual({
      sequence: 1,
      lingo: 2,
      command: 5,
      payload: Uint8Array.of(0, 0x64, 0),
    });
  });

  it('reconhece só frames que começam com 55 AA', () => {
    expect(isGizwitsFrame(Uint8Array.of(0x55, 0xaa, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(true);
    expect(isGizwitsFrame(Uint8Array.of(0xaa, 0x55, 0, 0))).toBe(false);
    expect(parseGizwitsFrame(Uint8Array.of(0x55, 0xaa))).toBeNull();
  });

  it('monta o start workout com 17 bytes de payload (27 no frame)', () => {
    const frame = encodeGizwitsStartWorkout({ speedKmh: 0.8, inclinePercent: 0 });
    const parsed = parseGizwitsFrame(frame)!;
    expect(frame).toHaveLength(27);
    expect(parsed.lingo).toBe(3);
    expect(parsed.command).toBe(2);
    expect(parsed.payload).toHaveLength(17);
    expect(parsed.payload[0]).toBe(0); // programa manual
    expect(parsed.payload[9]).toBe(8); // 0,8 km/h ×10
    expect(parsed.payload[11]).toBe(0); // inclinação 0
  });

  it('monta velocidade, inclinação, pausa/continuar e parar', () => {
    const speed = parseGizwitsFrame(encodeGizwitsSetSpeed(5.4))!;
    expect(speed.lingo).toBe(3);
    expect(speed.command).toBe(5);
    expect(speed.payload[0]).toBe(0);
    expect(speed.payload[1] | (speed.payload[2] << 8)).toBe(54);

    const incline = parseGizwitsFrame(encodeGizwitsSetIncline(3.5))!;
    expect(incline.command).toBe(6);
    expect(incline.payload[0] | (incline.payload[1] << 8)).toBe(35);

    expect(parseGizwitsFrame(encodeGizwitsPause(false))!.payload[0]).toBe(0);
    expect(parseGizwitsFrame(encodeGizwitsPause(true))!.payload[0]).toBe(1);

    const stop = parseGizwitsFrame(encodeGizwitsStop())!;
    expect(stop.lingo).toBe(1);
    expect(stop.command).toBe(20);
    expect(stop.payload).toHaveLength(0);
  });

  it('nomeia os comandos conhecidos', () => {
    expect(gizwitsCommandName(1, 2)).toBe('machine info');
    expect(gizwitsCommandName(3, 5)).toBe('velocidade');
    expect(gizwitsCommandName(3, 6)).toBe('inclinação');
    expect(gizwitsCommandName(9, 9)).toBeNull();
  });
});

/** CRC16-CCITT-FALSE do payload [0, 0x64, 0], calculado à parte. */
function crcBytes(): Uint8Array {
  const crc = crc16Ccitt(Uint8Array.of(0, 0x64, 0));
  return Uint8Array.of(crc & 0xff, (crc >> 8) & 0xff);
}
