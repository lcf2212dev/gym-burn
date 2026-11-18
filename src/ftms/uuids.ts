const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** UUID de 16 bits atribuído pelo Bluetooth SIG, expandido para 128 bits. */
export function uuid16(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}${BASE_UUID_SUFFIX}`;
}

/**
 * Normaliza um UUID para 128 bits em minúsculas. As bibliotecas BLE devolvem
 * formatos diferentes por plataforma: `"1826"` no iOS, `"00001826-0000-…"` no
 * Android.
 */
export function normalizeUuid(uuid: string): string {
  const value = uuid.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(value)) {
    return `0000${value}${BASE_UUID_SUFFIX}`;
  }
  if (/^[0-9a-f]{8}$/.test(value)) {
    return `${value}${BASE_UUID_SUFFIX}`;
  }
  return value;
}

/** Forma curta para exibir: `0x1826` se for um UUID do Bluetooth SIG, senão os 128 bits. */
export function shortUuid(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  const match = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(normalized);
  return match ? `0x${match[1].toUpperCase()}` : normalized;
}

export function sameUuid(a: string, b: string): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}

/**
 * Fitness Machine Service e as características que uma esteira expõe. O Control
 * Point (0x2AD9) não está aqui de propósito: este app só lê a esteira, e
 * nenhuma característica de comando é assinada nem escrita.
 */
export const FTMS = {
  service: uuid16(0x1826),
  feature: uuid16(0x2acc),
  treadmillData: uuid16(0x2acd),
  trainingStatus: uuid16(0x2ad3),
  supportedSpeedRange: uuid16(0x2ad4),
  supportedInclinationRange: uuid16(0x2ad5),
  machineStatus: uuid16(0x2ada),
} as const;

const CHARACTERISTIC_NAMES: Record<string, string> = {
  [FTMS.feature]: 'Fitness Machine Feature',
  [FTMS.treadmillData]: 'Treadmill Data',
  [FTMS.trainingStatus]: 'Training Status',
  [FTMS.supportedSpeedRange]: 'Supported Speed Range',
  [FTMS.supportedInclinationRange]: 'Supported Inclination Range',
  [FTMS.machineStatus]: 'Fitness Machine Status',
  [uuid16(0x2ace)]: 'Cross Trainer Data',
  [uuid16(0x2acf)]: 'Step Climber Data',
  [uuid16(0x2ad0)]: 'Stair Climber Data',
  [uuid16(0x2ad1)]: 'Rower Data',
  [uuid16(0x2ad2)]: 'Indoor Bike Data',
  [uuid16(0x2ad6)]: 'Supported Resistance Level Range',
  [uuid16(0x2ad7)]: 'Supported Heart Rate Range',
  [uuid16(0x2ad8)]: 'Supported Power Range',
};

/** Nome oficial da característica FTMS, ou o próprio UUID se for desconhecida. */
export function characteristicName(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  return CHARACTERISTIC_NAMES[normalized] ?? normalized;
}
