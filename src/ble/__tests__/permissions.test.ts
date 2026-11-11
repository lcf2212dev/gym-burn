import { PermissionsAndroid, Platform } from 'react-native';

import { requestBlePermissions } from '../permissions';
import { BleUnavailableError } from '../transport';

const { PERMISSIONS, RESULTS } = PermissionsAndroid;

function setPlatform(os: 'android' | 'ios', version: number | string) {
  jest.replaceProperty(Platform, 'OS', os);
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(version as never);
}

function mockResults(results: Record<string, string>) {
  return jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(results as never);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requestBlePermissions', () => {
  it('no iOS não pede nada', async () => {
    setPlatform('ios', '18.0');
    const request = mockResults({});

    await expect(requestBlePermissions()).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([31, 34, 36])('API %i: pede BLUETOOTH_SCAN e BLUETOOTH_CONNECT', async (api) => {
    setPlatform('android', api);
    const request = mockResults({
      [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.GRANTED,
      [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.GRANTED,
    });

    await expect(requestBlePermissions()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith([PERMISSIONS.BLUETOOTH_SCAN, PERMISSIONS.BLUETOOTH_CONNECT]);
  });

  it.each([23, 29, 30])('API %i: pede só ACCESS_FINE_LOCATION', async (api) => {
    setPlatform('android', api);
    const request = mockResults({ [PERMISSIONS.ACCESS_FINE_LOCATION]: RESULTS.GRANTED });

    await expect(requestBlePermissions()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith([PERMISSIONS.ACCESS_FINE_LOCATION]);
  });

  it('API 31+: basta uma permissão negada para falhar com "unauthorized"', async () => {
    setPlatform('android', 33);
    mockResults({
      [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.GRANTED,
      [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.DENIED,
    });

    const error = await requestBlePermissions().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BleUnavailableError);
    expect(error).toMatchObject({ reason: 'unauthorized' });
    expect((error as Error).message).toContain('Dispositivos por perto');
    expect((error as Error).message).toContain('Tente de novo');
  });

  it('API <= 30 negada: a mensagem fala de Localização', async () => {
    setPlatform('android', 30);
    mockResults({ [PERMISSIONS.ACCESS_FINE_LOCATION]: RESULTS.DENIED });

    const error = (await requestBlePermissions().catch((e: unknown) => e)) as BleUnavailableError;

    expect(error.reason).toBe('unauthorized');
    expect(error.message).toContain('Localização');
  });

  it('never_ask_again orienta a liberar nas configurações do sistema', async () => {
    setPlatform('android', 33);
    mockResults({
      [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.NEVER_ASK_AGAIN,
      [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.GRANTED,
    });

    const error = (await requestBlePermissions().catch((e: unknown) => e)) as BleUnavailableError;

    expect(error).toBeInstanceOf(BleUnavailableError);
    expect(error.reason).toBe('unauthorized');
    expect(error.message).toContain('configurações do sistema');
    expect(error.message).toContain('Dispositivos por perto');
  });

  it('never_ask_again no Android 11 cita a Localização', async () => {
    setPlatform('android', 30);
    mockResults({ [PERMISSIONS.ACCESS_FINE_LOCATION]: RESULTS.NEVER_ASK_AGAIN });

    const error = (await requestBlePermissions().catch((e: unknown) => e)) as BleUnavailableError;

    expect(error.message).toContain('configurações do sistema');
    expect(error.message).toContain('Localização');
  });
});
