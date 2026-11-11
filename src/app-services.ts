import { createBleManagerTransport } from '@/ble/ble-manager-transport';
import { FirstTestGuide } from '@/guide/first-test-guide';
import { createRecorder, type DisposableRecorder } from '@/logging/create-recorder';
import { installGlobalErrorTrace } from '@/logging/global-errors';
import { SIMULATED_DEVICE_ID, SimulatedTreadmillTransport } from '@/simulator/simulated-treadmill';
import { TreadmillSession } from '@/treadmill/treadmill-session';

/** Os serviços que vivem durante toda a execução do app. */
export interface AppServices {
  /** Grava em arquivo tudo o que a sessão e o roteiro registram. */
  recorder: DisposableRecorder;
  /** A sessão com a esteira: rádio de verdade, com a esteira simulada para o modo demonstração. */
  session: TreadmillSession;
  /** O roteiro do primeiro teste na esteira real. */
  guide: FirstTestGuide;
}

export function createAppServices(): AppServices {
  // O gravador vem primeiro: a sessão e o roteiro escrevem nele desde a primeira linha.
  const recorder = createRecorder();
  // O arquivo só nasce na primeira linha: sem esta, abrir o app e não tocar em nada não deixaria rastro.
  recorder.write({ at: Date.now(), kind: 'info', text: 'App aberto', hex: null });
  // Um erro que derrube o app na academia precisa estar no arquivo para ser entendido depois.
  installGlobalErrorTrace(recorder.write, recorder.flushSync);
  const session = new TreadmillSession({
    ble: createBleManagerTransport(),
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
    trace: recorder.write,
  });
  const guide = new FirstTestGuide({ session, trace: recorder.write });
  return { recorder, session, guide };
}
