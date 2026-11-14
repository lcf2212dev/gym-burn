import { createAppServices } from '@/app-services';
import { createRecorder } from '@/logging/create-recorder';
import { installGlobalErrorTrace } from '@/logging/global-errors';

// Só a ligação entre os serviços interessa aqui: o resto é substituído.
jest.mock('@/ble/ble-manager-transport', () => ({ createBleManagerTransport: jest.fn() }));
jest.mock('@/simulator/simulated-treadmill', () => ({
  SIMULATED_DEVICE_ID: 'simulado',
  SimulatedTreadmillTransport: jest.fn(),
}));
jest.mock('@/treadmill/treadmill-session', () => ({ TreadmillSession: jest.fn() }));
jest.mock('@/logging/create-recorder', () => ({ createRecorder: jest.fn() }));
jest.mock('@/logging/global-errors', () => ({ installGlobalErrorTrace: jest.fn() }));

describe('createAppServices', () => {
  it('registra "App aberto" logo depois de criar o gravador, antes de qualquer outra linha', () => {
    const order: string[] = [];
    const recorder = {
      write: jest.fn(() => order.push('write')),
      flushSync: jest.fn(),
    };
    jest.mocked(createRecorder).mockImplementation(() => {
      order.push('createRecorder');
      return recorder as unknown as ReturnType<typeof createRecorder>;
    });
    jest.mocked(installGlobalErrorTrace).mockImplementation(() => {
      order.push('installGlobalErrorTrace');
      return () => {};
    });

    createAppServices();

    expect(order.slice(0, 3)).toEqual(['createRecorder', 'write', 'installGlobalErrorTrace']);
    expect(recorder.write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info', text: 'App aberto', hex: null }));
  });

  it('entrega o flushSync do gravador ao rastreio de erros globais', () => {
    const recorder = { write: jest.fn(), flushSync: jest.fn() };
    jest.mocked(createRecorder).mockReturnValue(recorder as unknown as ReturnType<typeof createRecorder>);
    createAppServices();
    expect(installGlobalErrorTrace).toHaveBeenLastCalledWith(recorder.write, recorder.flushSync);
  });
});
