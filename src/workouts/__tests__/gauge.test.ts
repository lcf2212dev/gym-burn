import { arcPath, arrowPoints, gaugeAngle, gaugePieces, gaugeShare, polar } from '../gauge';

const max = 185;
const band = { low: 167, high: 176 };

describe('escala do medidor', () => {
  it('vai de 50% a 100% da FC máxima e não passa das pontas', () => {
    expect(gaugeShare(92.5, max)).toBe(0);
    expect(gaugeShare(185, max)).toBe(1);
    expect(gaugeShare(60, max)).toBe(0);
    expect(gaugeShare(200, max)).toBe(1);
    expect(gaugeShare(138.75, max)).toBeCloseTo(0.5);
  });

  it('abre o arco em 220 graus, de −200 a 20', () => {
    expect(gaugeAngle(0)).toBe(-200);
    expect(gaugeAngle(1)).toBe(20);
    expect(gaugeAngle(0.5)).toBe(-90);
  });
});

describe('trechos do arco', () => {
  const kinds = (pieces: ReturnType<typeof gaugePieces>) =>
    pieces.map((p) => `Z${p.zone + 1}:${p.kind}`);

  it('cobre a escala inteira sem buraco', () => {
    const pieces = gaugePieces(max, band);
    expect(pieces[0].from).toBe(50);
    expect(pieces[pieces.length - 1].to).toBe(100);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].from).toBe(pieces[i - 1].to);
  });

  it('acende só a faixa do dia quando não há leitura', () => {
    const pieces = gaugePieces(max, band);
    expect(kinds(pieces)).toEqual(['Z1:idle', 'Z2:idle', 'Z3:idle', 'Z4:idle', 'Z5:band', 'Z5:idle']);
  });

  it('gruda na fronteira da zona a faixa que começa a menos de meio ponto dela', () => {
    // 167 de 185 é 90,27%: sem isto sobraria uma lasca apagada entre 90% e a faixa.
    const lit = gaugePieces(max, band).find((p) => p.kind === 'band')!;
    expect(lit.from).toBe(90);
    expect(lit.to).toBeCloseTo((176 / 185) * 100);
  });

  it('separa a mira do resto da faixa', () => {
    const pieces = gaugePieces(max, band, { low: 173, high: 176 });
    expect(kinds(pieces)).toEqual([
      'Z1:idle',
      'Z2:idle',
      'Z3:idle',
      'Z4:idle',
      'Z5:band',
      'Z5:aim',
      'Z5:idle',
    ]);
    const aim = pieces.find((p) => p.kind === 'aim')!;
    expect(aim.from).toBeCloseTo((173 / 185) * 100);
    expect(aim.to).toBeCloseTo((176 / 185) * 100);
  });

  it('pinta cada zona com a própria cor quando a faixa atravessa duas', () => {
    const pieces = gaugePieces(max, { low: 120, high: 139 });
    expect(kinds(pieces)).toEqual([
      'Z1:idle',
      'Z2:idle',
      'Z2:band',
      'Z3:band',
      'Z3:idle',
      'Z4:idle',
      'Z5:idle',
    ]);
  });

  it('acende o que já ficou abaixo da leitura de agora', () => {
    // 140 bpm de 185 é 75,7%: no meio da Z3.
    const pieces = gaugePieces(max, band, { low: 173, high: 176 }, 140);
    expect(kinds(pieces)).toEqual([
      'Z1:passed',
      'Z2:passed',
      'Z3:passed',
      'Z3:idle',
      'Z4:idle',
      'Z5:band',
      'Z5:aim',
      'Z5:idle',
    ]);
    expect(pieces[2].to).toBeCloseTo((140 / 185) * 100);
  });

  it('deixa a faixa e a mira inteiras mesmo com a leitura no meio delas', () => {
    const pieces = gaugePieces(max, band, { low: 173, high: 176 }, 172);
    expect(kinds(pieces)).toEqual([
      'Z1:passed',
      'Z2:passed',
      'Z3:passed',
      'Z4:passed',
      'Z5:band',
      'Z5:aim',
      'Z5:idle',
    ]);
  });

  it('ignora leitura que não existe', () => {
    expect(gaugePieces(max, band, null, null).some((p) => p.kind === 'passed')).toBe(false);
  });
});

describe('desenho', () => {
  it('põe o ângulo zero à direita do centro e o −90 em cima', () => {
    expect(polar(100, 100, 50, 0)).toEqual({ x: 150, y: 100 });
    const top = polar(100, 100, 50, -90);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(50);
  });

  it('traça o arco no sentido horário', () => {
    expect(arcPath(100, 100, 50, -90, 0)).toBe('M 100.00 50.00 A 50 50 0 0 1 150.00 100.00');
  });

  it('marca o arco grande quando ele passa de meia volta', () => {
    expect(arcPath(100, 100, 50, -200, 20)).toContain('A 50 50 0 1 1');
  });

  it('aponta a seta para o arco, com a ponta do lado de dentro', () => {
    const [tip, , notch] = arrowPoints(100, 100, 60, 0, 20)
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(tip).toEqual([160, 100]);
    expect(notch[0]).toBeGreaterThan(tip[0]);
    expect(notch[1]).toBe(100);
  });
});
