import { createBleManagerTransport } from '@/ble/ble-manager-transport';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
} from '@/simulator/simulated-treadmill';
import { TreadmillSession } from '@/treadmill/treadmill-session';

/** Os serviços que vivem durante toda a execução do app. */
export interface AppServices {
  /** A sessão com a esteira: rádio de verdade, com a esteira simulada para o modo demonstração. */
  session: TreadmillSession;
}

export function createAppServices(): AppServices {
  const session = new TreadmillSession({
    ble: createBleManagerTransport(),
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
  });
  return { session };
}
