import type { TraceSink } from '@/treadmill/types';

/** Linhas da pilha que vão para o registro. */
const STACK_LINES = 8;

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

interface HermesInternalLike {
  hasPromise?: () => boolean;
  enablePromiseRejectionTracker?: (options: {
    allRejections?: boolean;
    onUnhandled?: (id: number, rejection: unknown) => void;
    onHandled?: (id: number) => void;
  }) => void;
}

function describe(error: unknown): { message: string; stack: string[] } {
  if (error instanceof Error) {
    const message = `${error.name}: ${error.message}`;
    const stack = (error.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // A primeira linha da pilha costuma repetir a mensagem.
    if (stack.length > 0 && stack[0].includes(error.message)) {
      stack.shift();
    }
    return { message, stack: stack.slice(0, STACK_LINES) };
  }
  return { message: String(error), stack: [] };
}

function traceError(write: TraceSink, title: string, error: unknown): void {
  try {
    const { message, stack } = describe(error);
    write({ at: Date.now(), kind: 'error', text: [`${title}: ${message}`, ...stack].join('\n'), hex: null });
  } catch {
    // O registro nunca pode piorar um erro que já aconteceu.
  }
}

/**
 * Faz todo erro de JavaScript não tratado, e toda rejeição de promise sem `catch`, aparecer no
 * registro (linha `error`, com a mensagem e as primeiras linhas da pilha). O handler anterior do
 * React Native continua sendo chamado depois. Devolve a função que desfaz a instalação.
 *
 * No erro fatal, o handler anterior encerra o app (em release); por isso, depois de escrever a
 * linha, `flushSync` a grava em disco antes de ele rodar. As demais linhas seguem o caminho normal.
 *
 * Rejeições: o Hermes oferece `HermesInternal.enablePromiseRejectionTracker`, o mesmo gancho que o
 * React Native usa (só em desenvolvimento) para o aviso "Uncaught (in promise)". Instalá-lo aqui
 * o substitui; por isso, em desenvolvimento, a rejeição também sai por `console.warn`.
 */
export function installGlobalErrorTrace(write: TraceSink, flushSync?: () => void): () => void {
  let active = true;
  const root = globalThis as { ErrorUtils?: ErrorUtilsLike; HermesInternal?: HermesInternalLike | null };

  const errorUtils = root.ErrorUtils;
  let uninstallHandler = () => {};
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    const handler: GlobalErrorHandler = (error, isFatal) => {
      if (active) {
        traceError(write, isFatal ? 'Erro fatal não tratado' : 'Erro não tratado', error);
        if (isFatal) {
          try {
            flushSync?.();
          } catch {
            // O handler anterior precisa rodar de qualquer jeito.
          }
        }
      }
      previous?.(error, isFatal);
    };
    errorUtils.setGlobalHandler(handler);
    uninstallHandler = () => {
      if (errorUtils.getGlobalHandler() === handler) {
        errorUtils.setGlobalHandler(previous);
      }
    };
  }

  const hermes = root.HermesInternal;
  if (hermes?.hasPromise?.() && typeof hermes.enablePromiseRejectionTracker === 'function') {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id, rejection) => {
        if (!active) {
          return;
        }
        traceError(write, `Promise rejeitada sem tratamento (id ${id})`, rejection);
        if (__DEV__) {
          console.warn(`Promise rejeitada sem tratamento (id ${id})`, rejection);
        }
      },
      onHandled: (id) => {
        if (active) {
          write({ at: Date.now(), kind: 'info', text: `Promise ${id} foi tratada depois da rejeição`, hex: null });
        }
      },
    });
  }

  return () => {
    active = false;
    uninstallHandler();
  };
}
