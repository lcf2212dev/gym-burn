import { utf8Decode } from './bytes';
import { uuid16 } from './uuids';

/**
 * Device Information Service (0x180A): quem fabricou o aparelho e qual é o
 * modelo. A esteira não diz isso no anúncio (só o nome, no formato `VISION ID nnnn`),
 * então a única fonte do modelo exato é ler estas características.
 */
export const DEVICE_INFORMATION_SERVICE = uuid16(0x180a);

export interface DeviceInformationField {
  uuid: string;
  /** Nome oficial da característica, como aparece no registro. */
  name: string;
  /** O valor é texto (UTF-8); senão é binário e só o hexadecimal interessa. */
  text: boolean;
}

/**
 * O que ler ao conectar, na ordem do registro. O modelo vem primeiro: é o que
 * interessa, e uma leitura que trava faz as seguintes serem abandonadas. O
 * aparelho que não tiver uma característica simplesmente não a anuncia, e ela é
 * pulada.
 */
export const DEVICE_INFORMATION_FIELDS: readonly DeviceInformationField[] = [
  { uuid: uuid16(0x2a24), name: 'Model Number', text: true },
  { uuid: uuid16(0x2a29), name: 'Manufacturer Name', text: true },
  { uuid: uuid16(0x2a25), name: 'Serial Number', text: true },
  { uuid: uuid16(0x2a27), name: 'Hardware Revision', text: true },
  { uuid: uuid16(0x2a26), name: 'Firmware Revision', text: true },
  { uuid: uuid16(0x2a28), name: 'Software Revision', text: true },
  { uuid: uuid16(0x2a23), name: 'System ID', text: false },
  { uuid: uuid16(0x2a50), name: 'PnP ID', text: false },
];

/**
 * Texto de uma característica do Device Information para exibição: termina no
 * primeiro byte nulo (preenchimento de string em C), perde os espaços do fim e
 * decodifica os octetos como UTF-8, como o GATT Specification Supplement manda
 * para estas características.
 */
export function decodeDeviceInformationText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8Decode(end === -1 ? bytes : bytes.subarray(0, end)).trimEnd();
}
