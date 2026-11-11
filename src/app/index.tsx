import { ConnectScreen } from '@/screens/connect-screen';
import { DashboardScreen } from '@/screens/dashboard-screen';
import { useTreadmill } from '@/treadmill/treadmill-context';

/** Uma rota só: o painel enquanto há esteira conectada, senão a tela de conexão. */
export default function Index() {
  const phase = useTreadmill((s) => s.phase);
  const connected = phase === 'connected' || phase === 'disconnecting';
  return connected ? <DashboardScreen /> : <ConnectScreen />;
}
