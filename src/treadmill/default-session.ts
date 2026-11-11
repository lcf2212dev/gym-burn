import { createBleManagerTransport } from '@/ble/ble-manager-transport';
import { SIMULATED_DEVICE_ID, SimulatedTreadmillTransport } from '@/simulator/simulated-treadmill';

import { TreadmillSession } from './treadmill-session';

/** Sessão usada pelo app: rádio de verdade, com a esteira simulada para o modo demonstração. */
export function createDefaultSession(): TreadmillSession {
  return new TreadmillSession({
    ble: createBleManagerTransport(),
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
  });
}
