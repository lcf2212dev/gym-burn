import { parseHeartRateMeasurement } from '../heart-rate';

it('lê o BPM de 8 bits e ignora os intervalos RR', () => {
  // Pacote real da XOSS X2 Pro: flags 0x10 (só RR), 71 bpm, RR de 0x0352.
  expect(parseHeartRateMeasurement(Uint8Array.of(0x10, 0x47, 0x52, 0x03))).toEqual({
    bpm: 71,
    contact: null,
  });
});

it('lê o BPM de 16 bits quando o bit 0 das flags está ligado', () => {
  expect(parseHeartRateMeasurement(Uint8Array.of(0x01, 0x2c, 0x01)).bpm).toBe(300);
});

it('informa o contato com a pele só quando o sensor sabe detectar', () => {
  expect(parseHeartRateMeasurement(Uint8Array.of(0x06, 80)).contact).toBe(true);
  expect(parseHeartRateMeasurement(Uint8Array.of(0x04, 0)).contact).toBe(false);
  // Bit de contato ligado sem o de suporte não quer dizer nada.
  expect(parseHeartRateMeasurement(Uint8Array.of(0x02, 80)).contact).toBeNull();
});

it('recusa pacote curto demais', () => {
  expect(() => parseHeartRateMeasurement(Uint8Array.of())).toThrow();
  expect(() => parseHeartRateMeasurement(Uint8Array.of(0x00))).toThrow();
  expect(() => parseHeartRateMeasurement(Uint8Array.of(0x01, 0x2c))).toThrow();
});
