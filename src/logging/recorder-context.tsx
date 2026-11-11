import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { TraceSink } from '@/treadmill/types';

import type { RecorderActions, RecorderSnapshot, RecorderStore } from './types';

const RecorderContext = createContext<RecorderStore | null>(null);

export function RecorderProvider({
  store,
  children,
}: {
  store: RecorderStore;
  children: ReactNode;
}) {
  return <RecorderContext.Provider value={store}>{children}</RecorderContext.Provider>;
}

function useStore(): RecorderStore {
  const store = useContext(RecorderContext);
  if (!store) {
    throw new Error('useRecorder só funciona dentro de <RecorderProvider>');
  }
  return store;
}

/**
 * Lê uma parte do estado do gravador. Como em `useTreadmill`, o seletor precisa
 * devolver um valor primitivo ou uma referência que já está no snapshot.
 */
export function useRecorder<T>(selector: (snapshot: RecorderSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

/** Ações do gravador; o objeto é o mesmo durante toda a vida do app. */
export function useRecorderActions(): RecorderActions {
  return useStore().actions;
}

/** Função para escrever uma linha no registro a partir da interface. */
export function useTraceWriter(): TraceSink {
  return useStore().write;
}
