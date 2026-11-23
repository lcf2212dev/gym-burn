import { createBleManagerTransport } from '@/ble/ble-manager-transport';
import { HeartStrapSession } from '@/heart/strap-session';
import {
  SIMULATED_DEVICE_ID,
  SimulatedTreadmillTransport,
} from '@/simulator/simulated-treadmill';
import { TreadmillSession } from '@/treadmill/treadmill-session';
import { readStrap, saveStrap } from '@/workouts/storage';

/** Os serviços que vivem durante toda a execução do app. */
export interface AppServices {
  /** A sessão com a esteira: rádio de verdade, com a esteira simulada para o modo demonstração. */
  session: TreadmillSession;
  /** A cinta de batimentos pareada, de onde vêm os batimentos enquanto ela tem leitura. */
  strap: HeartStrapSession;
}

export function createAppServices(): AppServices {
  // Um rádio só para os dois: a busca da esteira e a da cinta dividem a mesma busca nativa.
  const ble = createBleManagerTransport();
  const strap = new HeartStrapSession({ ble, storage: { read: readStrap, write: saveStrap } });
  const session = new TreadmillSession({
    ble,
    demo: { transport: new SimulatedTreadmillTransport(), deviceId: SIMULATED_DEVICE_ID },
    heartRate: strap.reading,
  });

  // A cinta acompanha a esteira: é procurada enquanto o app busca, conecta ou
  // usa uma esteira (inclusive a simulada), e solta quando não há mais nenhuma.
  let release: (() => void) | null = null;
  session.subscribe(() => {
    const { phase, scan, metrics } = session.getSnapshot();
    const busy = phase !== 'idle' || scan !== 'idle';
    // Com a lona andando a cinta não começa a sincronizar o perfil: o treino pode começar a qualquer instante.
    strap.setBeltMoving(phase === 'connected' && (metrics.speedKmh ?? 0) > 0);
    // A conexão da esteira tem a vez: a busca pela cinta espera ela terminar.
    strap.setQuiet(phase === 'connecting');
    if (busy && !release) {
      release = strap.hold();
    } else if (!busy && release) {
      release();
      release = null;
    }
  });
  return { session, strap };
}
