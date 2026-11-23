import { encodeFit } from '../__fakes__/fake-xoss-strap';
import { decodeFit, FIT_EPOCH_OFFSET_S } from '../fit';

// O projeto não tem os tipos do Node; o Jest roda no Node e tem os dois módulos.
declare const __dirname: string;
const { readFileSync } = jest.requireActual<{ readFileSync(path: string): Uint8Array }>('fs');
const { join } = jest.requireActual<{ join(...parts: string[]): string }>('path');

/** O treino de teste de 79 s baixado da cinta do usuário em 22/11/2026. */
const REAL = Uint8Array.from(readFileSync(join(__dirname, 'fixtures', '20261122231840.fit')));

describe('arquivo real da XOSS X2 Pro', () => {
  const activity = decodeFit(REAL);

  it('tem 79 registros, um por segundo, a partir do início no nome do arquivo', () => {
    const start = Date.UTC(2026, 10, 22, 23, 18, 40);
    expect(activity.startMs).toBe(start);
    expect(activity.records).toHaveLength(79);
    activity.records.forEach((record, i) => expect(record.at).toBe(start + (i + 1) * 1000));
  });

  it('traz FC e cadência em todos os registros', () => {
    expect(activity.records[0]).toEqual({ at: Date.UTC(2026, 10, 22, 23, 18, 41), bpm: 69, cadence: 76 });
    expect(activity.records.every((record) => record.bpm !== null && record.bpm > 40)).toBe(true);
    expect(activity.records.every((record) => record.cadence !== null)).toBe(true);
    // A pessoa parou no fim do treino de teste: cadência 0, medida.
    expect(activity.records.at(-1)!.cadence).toBe(0);
  });
});

/** Cabeçalho de 12 bytes (sem CRC) em volta das mensagens dadas. */
function wrap(messages: number[]): Uint8Array {
  const size = messages.length;
  return Uint8Array.from([12, 0x10, 0, 0, size & 0xff, size >> 8, 0, 0, 0x2e, 0x46, 0x49, 0x54, ...messages]);
}

const stamp = (ms: number) => Math.floor(ms / 1000) - FIT_EPOCH_OFFSET_S;
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const be32 = (v: number) => le32(v).reverse();

describe('formato', () => {
  const T = Date.UTC(2026, 10, 22, 12, 0, 0);

  it('lê o que o próprio codificador dos testes escreve, com vazios como null', () => {
    const fit = encodeFit(T, [
      { bpm: 100, cadence: 120 },
      { bpm: null, cadence: 0 },
    ]);
    expect(decodeFit(fit)).toEqual({
      startMs: T,
      records: [
        { at: T + 1000, bpm: 100, cadence: 120 },
        { at: T + 2000, bpm: null, cadence: 0 },
      ],
    });
  });

  it('aceita definição big-endian e campos de desenvolvedor', () => {
    const t = stamp(T);
    const fit = wrap([
      // Definição local 2, big-endian, global 20, 3 campos e 1 de desenvolvedor de 2 bytes.
      0x62, 0, 1, 0, 20, 3, 253, 4, 0x86, 3, 1, 2, 4, 1, 2, 1, 7, 2, 0,
      0x02, ...be32(t), 90, 100, 0xaa, 0xbb,
    ]);
    expect(decodeFit(fit).records).toEqual([{ at: T, bpm: 90, cadence: 100 }]);
  });

  it('lê o carimbo comprimido a partir do último carimbo completo', () => {
    const t = stamp(T);
    const fit = wrap([
      0x40, 0, 0, 20, 0, 3, 253, 4, 0x86, 3, 1, 2, 4, 1, 2,
      0x00, ...le32(t), 80, 90,
      // Definição local 1 sem carimbo: FC e cadência.
      0x41, 0, 0, 20, 0, 2, 3, 1, 2, 4, 1, 2,
      // Cabeçalho comprimido: bit 7, tipo local 1, deslocamento (5 bits baixos + 1).
      0x80 | (1 << 5) | ((t + 1) & 0x1f), 81, 91,
      // 5 bits só alcançam 31 s à frente; a volta dos 5 bits soma 32.
      0x80 | (1 << 5) | ((t + 20) & 0x1f), 82, 92,
    ]);
    const records = decodeFit(fit).records;
    expect(records.map((r) => r.at)).toEqual([T, T + 1000, T + 20_000]);
    expect(records.map((r) => r.bpm)).toEqual([80, 81, 82]);
  });

  it('para no fim truncado sem lançar', () => {
    const fit = encodeFit(T, [{ bpm: 100, cadence: 120 }, { bpm: 101, cadence: 121 }]);
    const cut = fit.subarray(0, fit.length - 6);
    expect(decodeFit(cut).records).toHaveLength(1);
  });

  it('recusa o que não é FIT', () => {
    expect(() => decodeFit(Uint8Array.of(14, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x42, 0x43, 0x44, 0, 0))).toThrow();
  });
});
