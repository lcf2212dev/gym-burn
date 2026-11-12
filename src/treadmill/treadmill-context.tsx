import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { ProbeApi, TreadmillActions, TreadmillSnapshot } from './types';

/** O que a interface precisa de uma sessão: estado observável e ações. */
export interface TreadmillStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TreadmillSnapshot;
  readonly actions: TreadmillActions;
  /** Ferramenta de diagnóstico: lê e escreve características fora do FTMS. */
  readonly probe: ProbeApi;
}

const TreadmillContext = createContext<TreadmillStore | null>(null);

export function TreadmillProvider({
  store,
  children,
}: {
  store: TreadmillStore;
  children: ReactNode;
}) {
  return <TreadmillContext.Provider value={store}>{children}</TreadmillContext.Provider>;
}

function useStore(): TreadmillStore {
  const store = useContext(TreadmillContext);
  if (!store) {
    throw new Error('useTreadmill só funciona dentro de <TreadmillProvider>');
  }
  return store;
}

/**
 * Lê uma parte do estado; o componente só renderiza de novo quando ela muda.
 *
 * O seletor precisa devolver um valor primitivo ou uma referência que já está
 * no snapshot (`s => s.metrics`, `s => s.metrics.speedKmh`). Montar um objeto
 * novo dentro do seletor causa renderização em laço.
 */
export function useTreadmill<T>(selector: (snapshot: TreadmillSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

/** Ações da sessão; o objeto é o mesmo durante toda a vida do app. */
export function useTreadmillActions(): TreadmillActions {
  return useStore().actions;
}

/** A sonda GATT da conexão atual (ver ProbeApi). */
export function useProbe(): ProbeApi {
  return useStore().probe;
}
