import { ByteReader, FtmsParseError, bytesToHex, hexToBytes, utf8Decode } from '../bytes';
import { FTMS, characteristicName, normalizeUuid, sameUuid, shortUuid, uuid16 } from '../uuids';

describe('ByteReader', () => {
  it('lê inteiros little-endian em sequência', () => {
    const reader = new ByteReader(hexToBytes('2A 34 12 F1 FF 56 34 12 78 56 34 92'));
    expect(reader.u8()).toBe(0x2a);
    expect(reader.u16()).toBe(0x1234);
    expect(reader.s16()).toBe(-15);
    expect(reader.u24()).toBe(0x123456);
    expect(reader.u32()).toBe(0x92345678);
    expect(reader.remaining).toBe(0);
  });

  it('lança erro ao ler além do fim', () => {
    const reader = new ByteReader(hexToBytes('01'));
    expect(reader.canRead(2)).toBe(false);
    expect(() => reader.u16()).toThrow(FtmsParseError);
  });

  it('devolve o restante sem compartilhar o buffer original', () => {
    const source = hexToBytes('01 02 03');
    const reader = new ByteReader(source);
    reader.u8();
    const rest = reader.rest();
    expect(rest).toEqual(hexToBytes('02 03'));
    expect(reader.remaining).toBe(0);
    rest[0] = 0xff;
    expect(source[1]).toBe(0x02);
  });
});

describe('hexadecimal', () => {
  it('converte nos dois sentidos', () => {
    expect(bytesToHex(Uint8Array.of(0x02, 0x1a, 0x04))).toBe('02 1A 04');
    expect(bytesToHex([0, 255], ':')).toBe('00:FF');
    expect(hexToBytes('021a04')).toEqual(Uint8Array.of(0x02, 0x1a, 0x04));
    expect(hexToBytes('02:1A:04')).toEqual(Uint8Array.of(0x02, 0x1a, 0x04));
    expect(hexToBytes('')).toEqual(new Uint8Array());
  });

  it('rejeita texto que não é hexadecimal', () => {
    expect(() => hexToBytes('0G')).toThrow(FtmsParseError);
    expect(() => hexToBytes('012')).toThrow(FtmsParseError);
  });
});

describe('utf8Decode', () => {
  it('decodifica sequências de 1 a 4 octetos', () => {
    expect(utf8Decode(hexToBytes('49 6E 63 6C 69 6E 61 C3 A7 C3 A3 6F'))).toBe('Inclinação');
    expect(utf8Decode(hexToBytes('E2 9C 93'))).toBe('✓');
    expect(utf8Decode(hexToBytes('F0 9F 8F 83'))).toBe('🏃');
  });

  it('troca sequências inválidas por U+FFFD em vez de falhar', () => {
    expect(utf8Decode(hexToBytes('41 FF 42'))).toBe('A�B');
    expect(utf8Decode(hexToBytes('41 C3'))).toBe('A�');
  });
});

describe('UUIDs', () => {
  it('expande UUIDs de 16 bits', () => {
    expect(uuid16(0x1826)).toBe('00001826-0000-1000-8000-00805f9b34fb');
    expect(FTMS.machineStatus).toBe('00002ada-0000-1000-8000-00805f9b34fb');
  });

  it('normaliza os formatos que cada plataforma devolve', () => {
    const full = '00001826-0000-1000-8000-00805f9b34fb';
    expect(normalizeUuid('1826')).toBe(full);
    expect(normalizeUuid('0x1826')).toBe(full);
    expect(normalizeUuid('00001826')).toBe(full);
    expect(normalizeUuid('00001826-0000-1000-8000-00805F9B34FB')).toBe(full);
    expect(sameUuid('2ACD', FTMS.treadmillData)).toBe(true);
    expect(sameUuid('2ACD', FTMS.machineStatus)).toBe(false);
  });

  it('encurta para exibição só os UUIDs do Bluetooth SIG', () => {
    expect(shortUuid(FTMS.treadmillData)).toBe('0x2ACD');
    expect(shortUuid('fff0')).toBe('0xFFF0');
    expect(shortUuid('0000FD00-EBAE-4526-9511-8357C35D7BE2')).toBe(
      '0000fd00-ebae-4526-9511-8357c35d7be2',
    );
  });

  it('dá nome às características conhecidas', () => {
    expect(characteristicName('2ACD')).toBe('Treadmill Data');
    expect(characteristicName('FFF1')).toBe('0000fff1-0000-1000-8000-00805f9b34fb');
  });
});
