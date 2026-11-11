import { looksLikeMatrixConsole } from '../t600x';

describe('looksLikeMatrixConsole', () => {
  it('reconhece os nomes com que consoles Matrix e Vision se anunciam', () => {
    // Formatos de Vision T600E, Matrix T75 XUR, Matrix T50 e Matrix TF50 (valores fictícios)
    expect(looksLikeMatrixConsole('CTM780000A1B2C3D4E5')).toBe(true);
    expect(looksLikeMatrixConsole('CTM1020000000001')).toBe(true);
    expect(looksLikeMatrixConsole('MX-TM 0A1B')).toBe(true);
    expect(looksLikeMatrixConsole('MATRIXTF50 1234')).toBe(true);
    expect(looksLikeMatrixConsole('  ctm781abc ')).toBe(true);
  });

  it('não confunde outros aparelhos nem a ausência de nome', () => {
    expect(looksLikeMatrixConsole(null)).toBe(false);
    expect(looksLikeMatrixConsole('')).toBe(false);
    expect(looksLikeMatrixConsole('Galaxy Watch6')).toBe(false);
    expect(looksLikeMatrixConsole('HORIZON_7.4AT')).toBe(false);
    expect(looksLikeMatrixConsole('Polar H10 CTM')).toBe(false);
  });
});
