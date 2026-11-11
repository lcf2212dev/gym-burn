import { ByteReader } from './bytes';

// A posição no array é o número do bit do campo Fitness Machine Type (FTMS 1.0, tabela 3.3).
const MACHINE_TYPE_BITS = [
  'treadmill',
  'crossTrainer',
  'stepClimber',
  'stairClimber',
  'rower',
  'indoorBike',
] as const;

export type MachineTypeName = (typeof MACHINE_TYPE_BITS)[number];

/** Service Data que um equipamento FTMS inclui no anúncio BLE (FTMS 1.0, seção 3.1). */
export interface FtmsAdvertisement {
  /** Bit "Fitness Machine Available": o equipamento aceita conexão agora. */
  available: boolean;
  machineTypes: Record<MachineTypeName, boolean>;
}

/**
 * Decodifica o Service Data do serviço 0x1826, já sem o UUID na frente: 1 octeto
 * de flags e 2 de tipo de equipamento. Devolve `null` se vier incompleto.
 */
export function parseFtmsServiceData(bytes: Uint8Array): FtmsAdvertisement | null {
  if (bytes.length < 3) {
    return null;
  }
  const reader = new ByteReader(bytes);
  const flags = reader.u8();
  const types = reader.u16();
  const machineTypes = {} as Record<MachineTypeName, boolean>;
  MACHINE_TYPE_BITS.forEach((name, bit) => {
    machineTypes[name] = ((types >> bit) & 1) === 1;
  });
  return { available: (flags & 1) === 1, machineTypes };
}
