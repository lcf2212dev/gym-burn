import { createBleManagerTransport } from './ble-manager-transport';
import { bridgeAvailable, createBridgeTransport } from './bridge-transport';
import type { BleTransport } from './transport';

/**
 * Escolhe o caminho até a esteira no momento de `prepare()`:
 *
 * - **Ponte** (`bridge-app/`): se o app-ponte estiver instalado e ativo, o BLE
 *   fica preso no processo dele. Reinstalar o GymBurn não derruba a conexão.
 * - **Direto** (`react-native-ble-manager`): comportamento antigo, usado quando
 *   a ponte não está por perto.
 *
 * A escolha é refeita a cada `prepare()`: abrir a ponte com o app já aberto
 * passa a valer na próxima tentativa de conexão, sem reiniciar o GymBurn.
 */
export function createTreadmillTransport(): BleTransport {
  let delegate: BleTransport | null = null;
  let route: 'bridge' | 'direct' | null = null;

  function current(): BleTransport {
    if (!delegate) {
      throw new Error('Transporte BLE usado antes de prepare()');
    }
    return delegate;
  }

  return {
    async prepare() {
      if (route !== 'bridge' && (await bridgeAvailable())) {
        delegate = createBridgeTransport();
        route = 'bridge';
        await delegate.prepare();
        return;
      }
      if (route !== 'direct') {
        delegate = createBleManagerTransport();
        route = 'direct';
      }
      await current().prepare();
    },

    scan(onDevice, onError) {
      return current().scan(onDevice, onError);
    },

    connect(deviceId) {
      return current().connect(deviceId);
    },
  };
}
