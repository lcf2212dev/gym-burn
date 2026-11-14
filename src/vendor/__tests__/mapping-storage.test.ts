import { createVendorMappingStorage, isVendorMapping } from '../mapping-storage';
import { DEFAULT_VENDOR_MAPPING } from '../presets';

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    async text() {
      return mockFiles.get(this.uri) ?? '';
    }
    async write(text: string) {
      mockFiles.set(this.uri, text);
    }
  }
  return { File, Paths: { document: '/doc' } };
});

beforeEach(() => {
  mockFiles.clear();
});

describe('persistência do mapeamento do 0xFFF0', () => {
  it('grava e relê o mapeamento', async () => {
    const storage = createVendorMappingStorage();
    await storage.save(DEFAULT_VENDOR_MAPPING);
    await expect(storage.load()).resolves.toEqual(DEFAULT_VENDOR_MAPPING);
  });

  it('sem arquivo, não há mapeamento', async () => {
    await expect(createVendorMappingStorage().load()).resolves.toBeNull();
  });

  it('arquivo corrompido ou de versão antiga é ignorado', async () => {
    mockFiles.set('/doc/controle-0xfff0.json', '{não é json');
    await expect(createVendorMappingStorage().load()).resolves.toBeNull();
    mockFiles.set('/doc/controle-0xfff0.json', JSON.stringify({ version: 99, name: 'x' }));
    await expect(createVendorMappingStorage().load()).resolves.toBeNull();
  });

  it('valida a forma do mapeamento antes de aceitar', () => {
    expect(isVendorMapping(DEFAULT_VENDOR_MAPPING)).toBe(true);
    expect(isVendorMapping(null)).toBe(false);
    expect(isVendorMapping({ ...DEFAULT_VENDOR_MAPPING, target: 'fff9' })).toBe(false);
    expect(isVendorMapping({ ...DEFAULT_VENDOR_MAPPING, format: 'bin' })).toBe(false);
    expect(isVendorMapping({ ...DEFAULT_VENDOR_MAPPING, speedEncoding: 'x' })).toBe(false);
    expect(isVendorMapping({ ...DEFAULT_VENDOR_MAPPING, actions: { start: 7 } })).toBe(false);
    expect(isVendorMapping({ ...DEFAULT_VENDOR_MAPPING, actions: { subir: '07' } })).toBe(false);
  });
});
