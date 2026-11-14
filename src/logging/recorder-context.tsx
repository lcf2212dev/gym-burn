import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { DisposableRecorder } from './create-recorder';

/** Acesso ao gravador de registros em qualquer tela (usado pela Sonda). */
const RecorderContext = createContext<DisposableRecorder | null>(null);

export function RecorderProvider({
  store,
  children,
}: {
  store: DisposableRecorder;
  children: ReactNode;
}) {
  return <RecorderContext.Provider value={store}>{children}</RecorderContext.Provider>;
}

function useStore(): DisposableRecorder {
  const store = useContext(RecorderContext);
  if (!store) {
    throw new Error('useRecorder só funciona dentro de <RecorderProvider>');
  }
  return store;
}

/** Lê uma parte do estado do gravador (arquivo atual, problema, espelho…). */
export function useRecorder<T>(selector: (snapshot: ReturnType<DisposableRecorder['getSnapshot']>) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

/** Ações do gravador: compartilhar o arquivo atual, espelhar numa pasta etc. */
export function useRecorderActions(): DisposableRecorder['actions'] {
  return useStore().actions;
}
