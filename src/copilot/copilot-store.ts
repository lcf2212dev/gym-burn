import { advanceCopilot, createCopilot, type CopilotInput, type CopilotState } from './copilot';

export interface CopilotStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CopilotState | null;
  /** Avança o copiloto com os dados mais recentes; só notifica quando o estado muda. */
  update(input: CopilotInput): void;
}

/**
 * Guarda o estado do copiloto fora do React (como a sessão da esteira), para
 * os tiques de dados poderem atualizá-lo sem `setState` dentro de efeito.
 */
export function createCopilotStore(): CopilotStore {
  let state: CopilotState | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state;
    },
    update(input) {
      if (state === null) {
        state = createCopilot(input.now);
        notify();
        return;
      }
      const next = advanceCopilot(state, input);
      if (next !== state) {
        state = next;
        notify();
      }
    },
  };
}
