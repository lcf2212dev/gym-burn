import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { ConnectScreen } from '@/screens/connect-screen';
import { DashboardScreen } from '@/screens/dashboard-screen';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';

/**
 * Uma rota só: o cockpit enquanto há esteira conectada, senão a tela de
 * conexão. O parâmetro `demo=1` abre a esteira simulada — é o atalho de
 * desenvolvimento usado para conferir a tela sem a academia.
 */
export default function Index() {
  const phase = useTreadmill((state) => state.phase);
  const actions = useTreadmillActions();
  const { demo } = useLocalSearchParams<{ demo?: string }>();

  useEffect(() => {
    if (demo === '1' && phase === 'idle') {
      actions.openDemo();
    }
  }, [actions, demo, phase]);

  const connected = phase === 'connected' || phase === 'disconnecting';
  return connected ? <DashboardScreen /> : <ConnectScreen />;
}
