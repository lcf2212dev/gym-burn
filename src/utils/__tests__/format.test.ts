import {
  EMPTY_VALUE,
  MINUS_SIGN,
  decimalsFor,
  formatClock,
  formatDecimal,
  formatDuration,
  formatHex32,
  formatInteger,
  formatKilometers,
  formatPace,
  formatSigned,
  formatTrimmed,
} from '../format';

describe('formatDecimal', () => {
  it('usa vírgula decimal e o número de casas pedido', () => {
    expect(formatDecimal(10.5, 1)).toBe('10,5');
    expect(formatDecimal(4, 1)).toBe('4,0');
    expect(formatDecimal(2.345, 2)).toBe('2,35');
  });

  it('mostra "—" sem valor', () => {
    expect(formatDecimal(null, 1)).toBe(EMPTY_VALUE);
    expect(formatDecimal(Number.NaN, 1)).toBe(EMPTY_VALUE);
  });

  it('usa o sinal de menos tipográfico e não mostra "−0,0"', () => {
    expect(formatDecimal(-3, 1)).toBe(`${MINUS_SIGN}3,0`);
    expect(formatDecimal(-0.04, 1)).toBe('0,0');
    expect(formatDecimal(-0, 1)).toBe('0,0');
  });
});

describe('formatInteger', () => {
  it('arredonda', () => {
    expect(formatInteger(186.6)).toBe('187');
    expect(formatInteger(null)).toBe(EMPTY_VALUE);
  });
});

describe('formatSigned', () => {
  it('sempre mostra o sinal', () => {
    expect(formatSigned(0.1, 1)).toBe('+0,1');
    expect(formatSigned(-1, 1)).toBe(`${MINUS_SIGN}1,0`);
    expect(formatSigned(0.25, 2)).toBe('+0,25');
  });
});

describe('decimalsFor', () => {
  it('usa 1 casa para décimos e 2 para centésimos', () => {
    expect(decimalsFor(0.1)).toBe(1);
    expect(decimalsFor(0.5)).toBe(1);
    expect(decimalsFor(1)).toBe(1);
    expect(decimalsFor(0.25)).toBe(2);
  });
});

describe('formatTrimmed', () => {
  it('tira zeros à direita', () => {
    expect(formatTrimmed(22, 2)).toBe('22');
    expect(formatTrimmed(0.8, 2)).toBe('0,8');
    expect(formatTrimmed(0.05, 2)).toBe('0,05');
    expect(formatTrimmed(-1.5, 1)).toBe(`${MINUS_SIGN}1,5`);
  });
});

describe('formatDuration', () => {
  it('mostra minutos e segundos abaixo de uma hora', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(754)).toBe('12:34');
    expect(formatDuration(59.9)).toBe('0:59');
  });

  it('inclui as horas a partir de 60 minutos', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('mostra "—" sem valor ou com valor negativo', () => {
    expect(formatDuration(null)).toBe(EMPTY_VALUE);
    expect(formatDuration(-1)).toBe(EMPTY_VALUE);
  });
});

describe('formatPace', () => {
  it('converte km/h em min/km', () => {
    expect(formatPace(10.5)).toBe('5:43');
    expect(formatPace(12)).toBe('5:00');
    expect(formatPace(1)).toBe('60:00');
  });

  it('mostra "—" abaixo de 1 km/h', () => {
    expect(formatPace(0.9)).toBe(EMPTY_VALUE);
    expect(formatPace(0)).toBe(EMPTY_VALUE);
    expect(formatPace(null)).toBe(EMPTY_VALUE);
  });
});

describe('formatKilometers', () => {
  it('converte metros em km com 2 casas', () => {
    expect(formatKilometers(2345)).toBe('2,35');
    expect(formatKilometers(0)).toBe('0,00');
    expect(formatKilometers(null)).toBe(EMPTY_VALUE);
  });
});

describe('formatClock', () => {
  it('mostra a hora local com dois dígitos', () => {
    const at = new Date(2026, 10, 10, 9, 5, 3).getTime();
    expect(formatClock(at)).toBe('09:05:03');
  });
});

describe('formatHex32', () => {
  it('mostra 8 dígitos em maiúsculas, inclusive com o bit 31 ligado', () => {
    expect(formatHex32(0x1a)).toBe('0x0000001A');
    expect(formatHex32(0x80000001)).toBe('0x80000001');
  });
});
