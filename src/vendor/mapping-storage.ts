import { File, Paths } from 'expo-file-system';

import {
  INCLINE_ENCODINGS,
  SPEED_ENCODINGS,
  VENDOR_ACTIONS,
  type VendorMapping,
} from './types';

/**
 * Persistência do mapeamento do 0xFFF0. O protocolo descoberto na academia
 * precisa sobreviver a fechar o app, senão teria que ser digitado de novo a cada
 * visita. Arquivo simples em `Paths.document`, como os registros.
 */
const MAPPING_FILE = 'controle-0xfff0.json';

export interface VendorMappingStorage {
  load(): Promise<VendorMapping | null>;
  save(mapping: VendorMapping): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Confere o JSON gravado antes de usa-lo: um arquivo velho não pode quebrar a tela. */
export function isVendorMapping(value: unknown): value is VendorMapping {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (value.target !== 'fff1' && value.target !== 'fff3') return false;
  if (value.format !== 'hex' && value.format !== 'ascii') return false;
  if (!includes(SPEED_ENCODINGS, value.speedEncoding)) return false;
  if (!includes(INCLINE_ENCODINGS, value.inclineEncoding)) return false;
  if (!isRecord(value.actions)) return false;
  for (const [key, template] of Object.entries(value.actions)) {
    if (!includes(VENDOR_ACTIONS, key)) return false;
    if (typeof template !== 'string') return false;
  }
  return true;
}

export function createVendorMappingStorage(): VendorMappingStorage {
  return {
    async load() {
      try {
        const file = new File(Paths.document, MAPPING_FILE);
        if (!file.exists) return null;
        const parsed: unknown = JSON.parse(await file.text());
        return isVendorMapping(parsed) ? parsed : null;
      } catch {
        // Arquivo corrompido ou sem permissão: melhor começar sem mapeamento.
        return null;
      }
    },
    async save(mapping) {
      try {
        await new File(Paths.document, MAPPING_FILE).write(JSON.stringify(mapping));
      } catch {
        // A gravação é acessório: o mapeamento continua valendo nesta execução.
      }
    },
  };
}
