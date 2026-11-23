import { parseHeartRateMeasurement } from '../heart-rate';

it('lê o BPM de 8 bits e o intervalo RR em ms', () => {
  // Pacote real da XOSS X2 Pro: flags 0x10 (só RR), 71 bpm, RR de 0x0352 (850/1024 s).
  expect(parseHeartRateMeasurement(Uint8Array.of(0x10, 0x47, 0x52, 0x03))).toEqual({
    bpm: 71,
    contact: null,
    rrMs: [830],
  });
});

it('lê dois RR no mesmo pacote, na ordem', () => {
  // 1024/1024 s = 1000 ms e 512/1024 s = 500 ms.
  expect(parseHeartRateMeasurement(Uint8Array.of(0x10, 60, 0x00, 0x04, 0x00, 0x02)).rrMs).toEqual([
    1000, 500,
  ]);
});

it('pula os 2 bytes da energia gasta antes dos RR', () => {
  // Flags 0x18: energia (0x08) e RR (0x10); BPM de 16 bits (0x01) também desloca.
  const bytes = Uint8Array.of(0x19, 0x2c, 0x01, 0x34, 0x12, 0x00, 0x04);
  expect(parseHeartRateMeasurement(bytes)).toEqual({ bpm: 300, contact: null, rrMs: [1000] });
});

it('sem a flag de RR não há RR, mesmo com bytes sobrando', () => {
  expect(parseHeartRateMeasurement(Uint8Array.of(0x00, 70, 0x00, 0x04)).rrMs).toEqual([]);
  // Um byte solto no fim não vira RR.
  expect(parseHeartRateMeasurement(Uint8Array.of(0x10, 70, 0x00, 0x04, 0x01)).rrMs).toEqual([1000]);
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
