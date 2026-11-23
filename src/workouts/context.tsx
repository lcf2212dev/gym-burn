import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { StrapLink } from '@/heart/strap-session';
import type { TreadmillStore } from '@/treadmill/treadmill-context';
import { WorkoutSession } from './session';

const Context = createContext<WorkoutSession | null>(null);
export function WorkoutProvider({
  store,
  strap,
  children,
}: {
  store: TreadmillStore;
  /** A cinta de batimentos, a quem o treino declara o que quer dela. */
  strap?: StrapLink;
  children: ReactNode;
}) {
  const [session] = useState(() => new WorkoutSession(store, strap));
  useEffect(() => session.connect(), [session]);
  return <Context.Provider value={session}>{children}</Context.Provider>;
}
/**
 * Troca o estado do treino por um fixo, para a prévia do painel. As telas leem
 * `state` como leriam a sessão; o resto da sessão de verdade continua por trás.
 */
export function WorkoutPreviewProvider({
  state,
  children,
}: {
  state: ReturnType<WorkoutSession['snapshot']>;
  children: ReactNode;
}) {
  const live = useWorkoutSession();
  const [frozen] = useState((): WorkoutSession =>
    Object.create(live, {
      snapshot: { value: () => state },
      subscribe: { value: () => () => {} },
    }),
  );
  return <Context.Provider value={frozen}>{children}</Context.Provider>;
}
export function useWorkoutSession() {
  const session = useContext(Context);
  if (!session) throw new Error('Sessão de treino indisponível.');
  return session;
}
export function useWorkout<T>(select: (state: ReturnType<WorkoutSession['snapshot']>) => T) {
  const session = useWorkoutSession();
  return useSyncExternalStore(session.subscribe, () => select(session.snapshot()));
}
