import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { TreadmillStore } from '@/treadmill/treadmill-context';
import { WorkoutSession } from './session';

const Context = createContext<WorkoutSession | null>(null);
export function WorkoutProvider({
  store,
  children,
}: {
  store: TreadmillStore;
  children: ReactNode;
}) {
  const [session] = useState(() => new WorkoutSession(store));
  useEffect(() => session.connect(), [session]);
  return <Context.Provider value={session}>{children}</Context.Provider>;
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
