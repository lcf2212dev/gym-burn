import { createTreadmillTransport } from '@/ble/treadmill-transport';
import { createRecorder, type DisposableRecorder } from '@/logging/create-recorder';
import { installGlobalErrorTrace } from '@/logging/global-errors';
import { SIMULATED_DEVICE_ID, SimulatedTreadmillTransport } from '@/simulator/simulated-treadmill';
import { TreadmillSession } from '@/treadmill/treadmill-session';
import { createVendorMappingStorage } from '@/vendor/mapping-storage';

/** Os serviços que vivem durante toda a execução do app. */
export interface AppServices {
  /** Grava em arquivo tudo o que a sessão e o roteiro registram. */
  recorder: DisposableRecorder;
  /** A sessão com a esteira: rádio de verdade, com a esteira simulada para o modo demonstração. */
  session: TreadmillSession;
}

export function createAppServices(): AppServices {
  // O gravador vem primeiro: a sessão escreve nele desde a primeira linha.
  const recorder = createRecorder();
  // O arquivo só nasce na primeira linha: sem esta, abrir o app e não tocar em nada não deixaria rastro.
  recorder.write({ at: Date.now(), kind: 'info', text: 'App aberto', hex: null });
  // Um erro que derrube o app na academia precisa estar no arquivo para ser entendido depois.
  installGlobalErrorTrace(recorder.write, recorder.flushSync);
  const session = new TreadmillSession({
    ble: createTreadmillTransport(),
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
    trace: recorder.write,
    // O protocolo do 0xFFF0 descoberto na academia fica salvo entre execuções.
    vendorStorage: createVendorMappingStorage(),
  });
  // Carrega o mapeamento salvo sem atrasar a abertura do app. Numa execução nova o
  // controle experimental já nasce com o último protocolo configurado.
  void Promise.resolve()
    .then(() => session.restoreVendorMapping())
    .catch(() => undefined);
  return { recorder, session };
}
