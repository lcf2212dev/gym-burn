import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { GuideActions, GuideSnapshot } from './types';

/** O que a interface precisa do roteiro: estado observável e ações. */
export interface GuideStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): GuideSnapshot;
  readonly actions: GuideActions;
}

const GuideContext = createContext<GuideStore | null>(null);

export function GuideProvider({ store, children }: { store: GuideStore; children: ReactNode }) {
  return <GuideContext.Provider value={store}>{children}</GuideContext.Provider>;
}

function useStore(): GuideStore {
  const store = useContext(GuideContext);
  if (!store) {
    throw new Error('useGuide só funciona dentro de <GuideProvider>');
  }
  return store;
}

/**
 * Lê uma parte do estado do roteiro. Como em `useTreadmill`, o seletor precisa
 * devolver um valor primitivo ou uma referência que já está no snapshot.
 */
export function useGuide<T>(selector: (snapshot: GuideSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

/** Ações do roteiro; o objeto é o mesmo durante toda a vida do app. */
export function useGuideActions(): GuideActions {
  return useStore().actions;
}
