import { acceptRr, bpmFromRr, createRrFilter, rmssd, RR_RESEED_AFTER } from '../rr';

describe('filtro de artefatos dos RR', () => {
  it('recusa o que está fora de 300 a 2000 ms', () => {
    const filter = createRrFilter();
    expect(acceptRr(filter, 299)).toBe(false);
    expect(acceptRr(filter, 2001)).toBe(false);
    expect(acceptRr(filter, NaN)).toBe(false);
    expect(acceptRr(filter, 300)).toBe(true);
  });

  it('recusa um salto de mais de 20% sobre a mediana recente', () => {
    const filter = createRrFilter();
    [800, 810, 790, 805].forEach((rr) => expect(acceptRr(filter, rr)).toBe(true));
    // Um batimento perdido (o dobro) e um extra (a metade).
    expect(acceptRr(filter, 1600)).toBe(false);
    expect(acceptRr(filter, 400)).toBe(false);
    expect(acceptRr(filter, 950)).toBe(true);
  });

  it('depois de 5 recusas seguidas recomeça a partir delas: a FC mudou de patamar', () => {
    const filter = createRrFilter();
    [1000, 1000, 1000].forEach((rr) => acceptRr(filter, rr));
    const results = Array.from({ length: RR_RESEED_AFTER }, () => acceptRr(filter, 600));
    expect(results).toEqual([false, false, false, false, true]);
    // A referência agora é a nova.
    expect(acceptRr(filter, 610)).toBe(true);
    expect(acceptRr(filter, 1000)).toBe(false);
  });

  it('uma aceitação no meio zera a contagem de recusas', () => {
    const filter = createRrFilter();
    [1000, 1000, 1000].forEach((rr) => acceptRr(filter, rr));
    [600, 600, 600, 600].forEach((rr) => acceptRr(filter, rr));
    expect(acceptRr(filter, 1000)).toBe(true);
    expect(acceptRr(filter, 600)).toBe(false);
  });
});

describe('contas', () => {
  it('BPM médio dos RR', () => {
    expect(bpmFromRr([1000, 1000])).toBe(60);
    expect(bpmFromRr([500])).toBe(120);
    expect(bpmFromRr([])).toBeNull();
  });

  it('RMSSD', () => {
    // Diferenças 10, -20, 10: raiz de (100 + 400 + 100) / 3 = 14,14.
    expect(rmssd([800, 810, 790, 800])).toBeCloseTo(14.142, 3);
    expect(rmssd([800])).toBeNull();
  });
});
