import { bytesToHex } from '@/ftms';

import { VENDOR_DISCOVERY_CANDIDATES } from '../discovery';
import {
  buildLiteralPayload,
  buildVendorPayload,
  encodeVendorValue,
  formatVendorValue,
} from '../payload';
import { DEFAULT_VENDOR_MAPPING, VENDOR_PRESETS, cloneVendorMapping } from '../presets';
import { INCLINE_ENCODINGS, SPEED_ENCODINGS, type VendorMapping } from '../types';

const mapping = (index: number): VendorMapping => cloneVendorMapping(VENDOR_PRESETS[index]);

describe('codificação de valores do 0xFFF0', () => {
  it('codifica a velocidade nas escalas que o firmware usa', () => {
    expect(encodeVendorValue(5.1, 'u16le-x100')).toEqual([0xfe, 0x01]);
    expect(encodeVendorValue(5.0, 'u16le-x1600')).toEqual([0x40, 0x1f]);
    expect(encodeVendorValue(12.0, 's16le-x10')).toEqual([0x78, 0x00]);
    expect(encodeVendorValue(-2.5, 's16le-x10')).toEqual([0xe7, 0xff]);
    expect(encodeVendorValue(300, 'u8')).toEqual([0xff]);
  });

  it('formata o texto do valor com 1 decimal', () => {
    expect(formatVendorValue(5.123, 'ascii1')).toBe('5.1');
    expect(formatVendorValue(2.5, 'u16le-x100')).toBe('3');
  });
});

describe('templates de payload', () => {
  it('monta o túnel FTMS com velocidade em 0,01 km/h e inclinação em 0,1 %', () => {
    const tunnel = mapping(0);
    expect(bytesToHex(buildVendorPayload(tunnel, 'speedUp', 5.1))).toBe('02 FE 01');
    expect(bytesToHex(buildVendorPayload(tunnel, 'inclineUp', 2.5))).toBe('03 19 00');
    expect(bytesToHex(buildVendorPayload(tunnel, 'start', null))).toBe('07');
    expect(bytesToHex(buildVendorPayload(tunnel, 'stop', null))).toBe('08 01');
  });

  it('monta o túnel FTMS com a escala ×16 do targetSpeedChanged', () => {
    expect(bytesToHex(buildVendorPayload(mapping(1), 'speedDown', 5.0))).toBe('02 40 1F');
  });

  it('monta linhas ASCII com escapes', () => {
    const ascii = mapping(2);
    expect(bytesToHex(buildVendorPayload(ascii, 'speedUp', 5.1))).toBe('53 50 45 45 44 20 35 2E 31 0D 0A');
    expect(bytesToHex(buildVendorPayload(ascii, 'stop', null))).toBe('53 54 4F 50 0D 0A');
  });

  it('aceita template literal de hex e de ASCII', () => {
    expect(bytesToHex(buildLiteralPayload('hex', '08 02'))).toBe('08 02');
    expect(bytesToHex(buildLiteralPayload('ascii', 'AT\\r\\n'))).toBe('41 54 0D 0A');
  });

  it('recusa template inválido com mensagem para a tela', () => {
    expect(() => buildLiteralPayload('hex', 'GG')).toThrow(/não é um byte hexadecimal/);
    expect(() => buildLiteralPayload('ascii', 'AÁ')).toThrow(/texto imprimível/);
    expect(() => buildLiteralPayload('ascii', 'A\\q')).toThrow(/Escape desconhecido/);
  });

  it('recusa codificação numérica num template ASCII', () => {
    const ascii = mapping(2);
    const misto: VendorMapping = { ...ascii, speedEncoding: 'u16le-x100' };
    expect(() => buildVendorPayload(misto, 'speedUp', 5)).toThrow(/No formato ASCII/);
  });

  it('recusa comando sem valor, sem template ou com codificação incompatível', () => {
    const tunnel = mapping(0);
    expect(() => buildVendorPayload(tunnel, 'speedUp', null)).toThrow(/precisa de um valor/);
    const semAcao: VendorMapping = { ...tunnel, actions: {} };
    expect(() => buildVendorPayload(semAcao, 'speedUp', 5)).toThrow(/não está mapeado/);
    const hexComTexto: VendorMapping = { ...tunnel, speedEncoding: 'ascii1' };
    expect(() => buildVendorPayload(hexComTexto, 'speedUp', 5)).toThrow(/não aceita a codificação/);
    const semValor: VendorMapping = { ...tunnel, actions: { start: '07 %v' } };
    expect(() => buildVendorPayload(semValor, 'start', null)).toThrow(/precisa de um valor/);
  });

  it('todos os candidatos da varredura geram bytes', () => {
    for (const candidate of VENDOR_DISCOVERY_CANDIDATES) {
      const bytes = buildLiteralPayload(candidate.format, candidate.payload);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it('os presets usam as codificações declaradas', () => {
    for (const preset of VENDOR_PRESETS) {
      expect(SPEED_ENCODINGS).toContain(preset.speedEncoding);
      expect(INCLINE_ENCODINGS).toContain(preset.inclineEncoding);
    }
  });
});

describe('mapeamento padrão', () => {
  it('tem os sete comandos do controle experimental', () => {
    expect(Object.keys(DEFAULT_VENDOR_MAPPING.actions).sort()).toEqual(
      ['inclineDown', 'inclineUp', 'pause', 'speedDown', 'speedUp', 'start', 'stop'].sort(),
    );
  });
});
