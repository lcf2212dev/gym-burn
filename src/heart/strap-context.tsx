import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { StrapActions, StrapSnapshot, StrapStore } from './strap-session';

const StrapContext = createContext<StrapStore | null>(null);

export function StrapProvider({ store, children }: { store: StrapStore; children: ReactNode }) {
  return <StrapContext.Provider value={store}>{children}</StrapContext.Provider>;
}

function useStore(): StrapStore {
  const store = useContext(StrapContext);
  if (!store) {
    throw new Error('useStrap só funciona dentro de <StrapProvider>');
  }
  return store;
}

/**
 * Lê uma parte do estado da cinta; o componente só renderiza de novo quando
 * ela muda. Como em `useTreadmill`, o seletor devolve um valor primitivo ou
 * uma referência que já está no snapshot.
 */
export function useStrap<T>(selector: (snapshot: StrapSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

export function useStrapActions(): StrapActions {
  return useStore().actions;
}

/** Mantém a cinta procurada e conectada enquanto a tela estiver aberta. */
export function useStrapHold(): void {
  const store = useStore();
  useEffect(() => store.hold(), [store]);
}

/** Na XOSS X2 Pro, mantém a contagem de passos ligada e consultada enquanto a tela estiver aberta. */
export function useStrapCadence(): void {
  const store = useStore();
  useEffect(() => store.watchCadence(), [store]);
}
