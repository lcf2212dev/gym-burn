import { PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

import { BleUnavailableError } from './transport';

/** API 31 (Android 12) separou o Bluetooth da localização. */
const ANDROID_12_API_LEVEL = 31;

function requiredPermissions(apiLevel: number): Permission[] {
  if (apiLevel >= ANDROID_12_API_LEVEL) {
    return [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ];
  }
  // Até o Android 11 a busca por BLE exige a permissão de localização.
  return [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

function deniedMessage(apiLevel: number): string {
  return apiLevel >= ANDROID_12_API_LEVEL
    ? 'O Gym Burn precisa da permissão "Dispositivos por perto" para encontrar e conectar na esteira. Tente de novo e permita o acesso.'
    : 'O Gym Burn precisa da permissão de Localização para procurar a esteira por Bluetooth (exigência do Android). Tente de novo e permita o acesso.';
}

function blockedMessage(apiLevel: number): string {
  const permission = apiLevel >= ANDROID_12_API_LEVEL ? '"Dispositivos por perto"' : '"Localização"';
  return `A permissão ${permission} está bloqueada para o Gym Burn. Abra as configurações do sistema, toque em Apps > Gym Burn > Permissões, libere ${permission} e tente de novo.`;
}

/**
 * Pede as permissões de runtime que o Android exige para usar o Bluetooth LE.
 * No iOS não há pedido explícito: o sistema pergunta ao criar o gerenciador
 * central e o resultado aparece como estado `unauthorized`.
 *
 * Lança `BleUnavailableError('unauthorized', …)` se alguma for negada.
 */
export async function requestBlePermissions(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const apiLevel = Number(Platform.Version);
  const results = await PermissionsAndroid.requestMultiple(requiredPermissions(apiLevel));
  const values = Object.values(results);

  if (values.includes(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) {
    throw new BleUnavailableError('unauthorized', blockedMessage(apiLevel));
  }
  if (values.some((result) => result !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new BleUnavailableError('unauthorized', deniedMessage(apiLevel));
  }
}
