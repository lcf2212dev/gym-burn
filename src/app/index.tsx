import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { useWorkout } from '@/workouts/context';
import { ConnectScreen } from '@/screens/connect-screen';
import { DashboardScreen } from '@/screens/dashboard-screen';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/**
 * Uma rota só: o cockpit enquanto há esteira conectada, senão a tela de
 * conexão. O parâmetro `demo=1` abre a esteira simulada — é o atalho de
 * desenvolvimento usado para conferir a tela sem a academia.
 */
export default function Index() {
  const profile = useWorkout(s => s.profile);
  const phase = useTreadmill((state) => state.phase);
  const actions = useTreadmillActions();
  const { demo } = useLocalSearchParams<{ demo?: string }>();

  useEffect(() => {
    if (profile && demo === '1' && phase === 'idle') {
      actions.openDemo();
    }
  }, [actions, demo, phase, profile]);

  if (!profile) return <Redirect href="/perfil" />;
  const connected = phase === 'connected' || phase === 'disconnecting';
  return connected ? <DashboardScreen /> : <ConnectScreen />;
}
