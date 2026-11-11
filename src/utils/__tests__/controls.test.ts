import {
  inclinationSteps,
  isBeltMoving,
  rangeFraction,
  showsTarget,
  signalLabel,
  speedSteps,
} from '../controls';

describe('passos dos botões', () => {
  it('velocidade: no mínimo 0,1 e 1,0', () => {
    expect(speedSteps({ min: 0.8, max: 22, step: 0.01 })).toEqual({ small: 0.1, big: 1 });
    expect(speedSteps({ min: 0.8, max: 22, step: 0.2 })).toEqual({ small: 0.2, big: 1 });
  });

  it('inclinação: no mínimo 0,5 e o dobro, com mínimo de 1', () => {
    expect(inclinationSteps({ min: 0, max: 15, step: 0.1 })).toEqual({ small: 0.5, big: 1 });
    expect(inclinationSteps({ min: 0, max: 15, step: 1 })).toEqual({ small: 1, big: 2 });
  });
});

describe('rangeFraction', () => {
  const range = { min: 0, max: 20, step: 0.1 };

  it('calcula a posição na faixa', () => {
    expect(rangeFraction(5, range)).toBe(0.25);
  });

  it('limita a 0 e 1 e trata a falta de valor', () => {
    expect(rangeFraction(-1, range)).toBe(0);
    expect(rangeFraction(25, range)).toBe(1);
    expect(rangeFraction(null, range)).toBe(0);
    expect(rangeFraction(3, { min: 5, max: 5, step: 1 })).toBe(0);
  });
});

describe('showsTarget', () => {
  it('só mostra o alvo quando ele difere em mais de meio passo', () => {
    expect(showsTarget(null, 10, 0.1)).toBe(false);
    expect(showsTarget(10.04, 10, 0.1)).toBe(false);
    expect(showsTarget(11, 10.5, 0.1)).toBe(true);
    expect(showsTarget(5, null, 0.5)).toBe(true);
  });
});

describe('isBeltMoving', () => {
  it('considera parada sem velocidade ou com zero', () => {
    expect(isBeltMoving(null)).toBe(false);
    expect(isBeltMoving(0)).toBe(false);
    expect(isBeltMoving(0.8)).toBe(true);
  });
});

describe('signalLabel', () => {
  it('classifica o RSSI', () => {
    expect(signalLabel(-55)).toBe('sinal forte');
    expect(signalLabel(-60)).toBe('sinal forte');
    expect(signalLabel(-80)).toBe('sinal médio');
    expect(signalLabel(-81)).toBe('sinal fraco');
    expect(signalLabel(null)).toBeNull();
  });
});
