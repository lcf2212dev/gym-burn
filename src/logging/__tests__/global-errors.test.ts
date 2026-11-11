import type { TraceLine } from '@/treadmill/types';

import { installGlobalErrorTrace } from '../global-errors';

type Handler = (error: unknown, isFatal?: boolean) => void;

const root = globalThis as Record<string, unknown>;
const original = { ErrorUtils: root.ErrorUtils, HermesInternal: root.HermesInternal };

function fakeErrorUtils(previous: Handler) {
  let current = previous;
  const utils = {
    getGlobalHandler: () => current,
    setGlobalHandler: (handler: Handler) => {
      current = handler;
    },
  };
  root.ErrorUtils = utils;
  return utils;
}

afterEach(() => {
  root.ErrorUtils = original.ErrorUtils;
  root.HermesInternal = original.HermesInternal;
  jest.restoreAllMocks();
});

describe('erros não tratados', () => {
  it('escreve uma linha de erro com a mensagem e a pilha, e depois chama o handler anterior', () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    const lines: TraceLine[] = [];
    installGlobalErrorTrace((line) => lines.push(line));

    const error = new Error('deu ruim');
    error.stack = ['Error: deu ruim', ...Array.from({ length: 20 }, (_, i) => `    at f${i} (app.js:${i})`)].join('\n');
    utils.getGlobalHandler()(error, false);

    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('error');
    expect(lines[0].hex).toBeNull();
    const rows = lines[0].text.split('\n');
    expect(rows[0]).toBe('Erro não tratado: Error: deu ruim');
    expect(rows).toHaveLength(1 + 8); // mensagem + 8 linhas da pilha, sem repetir "Error: deu ruim"
    expect(rows[1]).toBe('at f0 (app.js:0)');
    expect(previous).toHaveBeenCalledWith(error, false);
  });

  it('marca o erro fatal e aceita valores que não são Error', () => {
    const utils = fakeErrorUtils(jest.fn());
    const lines: TraceLine[] = [];
    installGlobalErrorTrace((line) => lines.push(line));
    utils.getGlobalHandler()('texto solto', true);
    expect(lines[0].text).toBe('Erro fatal não tratado: texto solto');
  });

  it('no erro fatal, grava em disco (flushSync) depois da linha e antes do handler anterior', () => {
    const order: string[] = [];
    const previous = jest.fn(() => order.push('anterior'));
    const utils = fakeErrorUtils(previous);
    installGlobalErrorTrace(
      () => order.push('linha'),
      () => order.push('flushSync'),
    );
    utils.getGlobalHandler()(new Error('x'), true);
    expect(order).toEqual(['linha', 'flushSync', 'anterior']);
  });

  it('erro não fatal não chama flushSync (a linha error já provoca a descarga normal)', () => {
    const flushSync = jest.fn();
    const utils = fakeErrorUtils(jest.fn());
    installGlobalErrorTrace(jest.fn(), flushSync);
    utils.getGlobalHandler()(new Error('x'), false);
    utils.getGlobalHandler()(new Error('y'));
    expect(flushSync).not.toHaveBeenCalled();
  });

  it('o handler anterior roda mesmo que o flushSync lance', () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    installGlobalErrorTrace(jest.fn(), () => {
      throw new Error('disco quebrado');
    });
    expect(() => utils.getGlobalHandler()(new Error('x'), true)).not.toThrow();
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('rejeição de promise não chama flushSync', () => {
    const hermes = { hasPromise: () => true, enablePromiseRejectionTracker: jest.fn() };
    root.HermesInternal = hermes;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const flushSync = jest.fn();
    installGlobalErrorTrace(jest.fn(), flushSync);
    hermes.enablePromiseRejectionTracker.mock.calls[0][0].onUnhandled(1, new Error('x'));
    expect(flushSync).not.toHaveBeenCalled();
  });

  it('o handler anterior roda mesmo que escrever no registro falhe', () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    installGlobalErrorTrace(() => {
      throw new Error('registro quebrado');
    });
    expect(() => utils.getGlobalHandler()(new Error('x'), true)).not.toThrow();
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('a função devolvida restaura o handler anterior', () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    const uninstall = installGlobalErrorTrace(jest.fn());
    expect(utils.getGlobalHandler()).not.toBe(previous);
    uninstall();
    expect(utils.getGlobalHandler()).toBe(previous);
  });

  it('sem ErrorUtils nem HermesInternal, não faz nada e não lança', () => {
    root.ErrorUtils = undefined;
    root.HermesInternal = undefined;
    expect(() => installGlobalErrorTrace(jest.fn())()).not.toThrow();
  });
});

describe('rejeições de promise sem tratamento', () => {
  function fakeHermes() {
    const hermes = { hasPromise: () => true, enablePromiseRejectionTracker: jest.fn() };
    root.HermesInternal = hermes;
    return hermes;
  }

  it('instala o rastreador do Hermes e escreve a rejeição no registro', () => {
    const hermes = fakeHermes();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const lines: TraceLine[] = [];
    installGlobalErrorTrace((line) => lines.push(line));

    const options = hermes.enablePromiseRejectionTracker.mock.calls[0][0];
    expect(options.allRejections).toBe(true);
    options.onUnhandled(7, new Error('falhou depois'));
    expect(lines[0].kind).toBe('error');
    expect(lines[0].text).toContain('Promise rejeitada sem tratamento (id 7): Error: falhou depois');
    options.onHandled(7);
    expect(lines[1]).toMatchObject({ kind: 'info', text: 'Promise 7 foi tratada depois da rejeição' });
  });

  it('não instala nada quando o Hermes não tem Promise própria', () => {
    const hermes = fakeHermes();
    hermes.hasPromise = () => false;
    installGlobalErrorTrace(jest.fn());
    expect(hermes.enablePromiseRejectionTracker).not.toHaveBeenCalled();
  });

  it('depois de desinstalar, o rastreador (que não dá para remover) fica mudo', () => {
    const hermes = fakeHermes();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const lines: TraceLine[] = [];
    const uninstall = installGlobalErrorTrace((line) => lines.push(line));
    uninstall();
    hermes.enablePromiseRejectionTracker.mock.calls[0][0].onUnhandled(1, 'x');
    expect(lines).toEqual([]);
  });
});
