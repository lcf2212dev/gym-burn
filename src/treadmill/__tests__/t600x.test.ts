import {
  correctInclinationPercent,
  looksLikeMatrixConsole,
  T600X_INCLINATION_RANGE,
} from '../t600x';

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

describe('correctInclinationPercent', () => {
  // Faixa declarada pelo template do firmware desta família: 0–50 %, passo 3 %.
  const firmwareTemplate = { min: 0, max: 50, step: 3, source: 'device' as const };

  it('devolve a leitura como veio quando a faixa declarada é plausível', () => {
    expect(correctInclinationPercent(7.5, T600X_INCLINATION_RANGE)).toBe(7.5);
    // Uma faixa dentro da ficha (outro modelo) não sofre correção.
    expect(
      correctInclinationPercent(2.5, { min: 0, max: 12, step: 0.5, source: 'device' }),
    ).toBe(2.5);
  });

  it('corrige a escala do contador interno quando a faixa denuncia o template', () => {
    // A leitura de 10,0 % é o contador interno; o percentual real é 1,5 %.
    expect(correctInclinationPercent(10, firmwareTemplate)).toBe(1.5);
    expect(correctInclinationPercent(33.3, firmwareTemplate)).toBeCloseTo(4.995, 3);
  });

  it('limita o valor corrigido à faixa real da esteira', () => {
    // 200 % × 0,15 daria 30 %; a mecânica da T600X vai só até 15 %.
    expect(correctInclinationPercent(200, firmwareTemplate)).toBe(15);
    expect(correctInclinationPercent(-10, firmwareTemplate)).toBe(0);
  });

  it('sem leitura, sem correção', () => {
    expect(correctInclinationPercent(null, firmwareTemplate)).toBeNull();
  });
});
