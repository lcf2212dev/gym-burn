import { createFileStorage } from '../file-storage';

// Um expo-file-system mínimo, em memória: só o que o armazenamento usa.
const mockFs = {
  files: new Map<string, string>(),
  directories: new Set<string>(),
  pick: null as null | { uri: string } | Error,
  syncWrites: [] as { uri: string; append: boolean | undefined }[],
  listCalls: 0,
  failWrite: null as Error | null,
};

jest.mock('expo-file-system', () => {
  const join = (...parts: (string | { uri: string })[]) =>
    parts
      .map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/+$/, ''))
      .join('/');

  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists() {
      return mockFs.files.has(this.uri);
    }
    get size() {
      return mockFs.files.get(this.uri)?.length ?? 0;
    }
    get lastModified() {
      return 1234;
    }
    async write(text: string, options?: { append?: boolean }) {
      mockFs.files.set(this.uri, (options?.append ? (mockFs.files.get(this.uri) ?? '') : '') + text);
    }
    writeSync(text: string, options?: { append?: boolean }) {
      mockFs.syncWrites.push({ uri: this.uri, append: options?.append });
      if (mockFs.failWrite) {
        throw mockFs.failWrite;
      }
      // Como o nativo: cria o arquivo se faltar.
      mockFs.files.set(this.uri, (options?.append ? (mockFs.files.get(this.uri) ?? '') : '') + text);
    }
    async text() {
      return mockFs.files.get(this.uri) ?? '';
    }
    delete() {
      mockFs.files.delete(this.uri);
    }
  }

  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    create() {
      mockFs.directories.add(this.uri);
    }
    list() {
      mockFs.listCalls += 1;
      return [...mockFs.files.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes('/'))
        .map((uri) => new File(uri));
    }
    createFile(name: string) {
      const file = new File(this, name);
      mockFs.files.set(file.uri, '');
      return file;
    }
    static async pickDirectoryAsync() {
      if (mockFs.pick instanceof Error || mockFs.pick === null) {
        throw mockFs.pick ?? new Error('sem resposta');
      }
      return new Directory(mockFs.pick.uri);
    }
  }

  return { File, Directory, Paths: { document: new Directory('file:///data/files') } };
});

const mockShareAsync = jest.fn();
jest.mock('expo-sharing', () => ({ shareAsync: (...args: unknown[]) => mockShareAsync(...args) }));

const LOG = 'gym-burn-2026-11-10_21-30-05.txt';
const LOG_URI = `file:///data/files/registros/${LOG}`;

beforeEach(() => {
  mockFs.files.clear();
  mockFs.directories.clear();
  mockFs.pick = null;
  mockFs.syncWrites.length = 0;
  mockFs.listCalls = 0;
  mockFs.failWrite = null;
  mockShareAsync.mockReset();
});

describe('arquivos internos', () => {
  it('cria a pasta, anexa, lê, lista, compartilha e apaga', async () => {
    const storage = createFileStorage();
    await storage.append(LOG, 'um\n');
    await storage.append(LOG, 'dois\n');
    expect(mockFs.directories.has('file:///data/files/registros')).toBe(true);
    expect(mockFs.files.get(LOG_URI)).toBe('um\ndois\n');
    expect(await storage.read(LOG)).toBe('um\ndois\n');
    expect(await storage.list()).toEqual([{ name: LOG, sizeBytes: 8, modifiedAt: 1234 }]);

    await storage.share(LOG);
    expect(mockShareAsync).toHaveBeenCalledWith(LOG_URI, {
      mimeType: 'text/plain',
      dialogTitle: 'Compartilhar registro',
    });

    await storage.remove(LOG);
    expect(await storage.list()).toEqual([]);
  });
});

describe('configuração da pasta de cópia', () => {
  const folder = { uri: 'content://x/tree/primary%3ADocuments', label: 'Documents' };

  it('grava no JSON da pasta de registros, relê e apaga', async () => {
    const storage = createFileStorage();
    expect(await storage.loadMirror()).toBeNull();
    await storage.saveMirror(folder);
    expect(mockFs.files.has('file:///data/files/registros/copia.json')).toBe(true);
    expect(await createFileStorage().loadMirror()).toEqual(folder);
    await storage.saveMirror(null);
    expect(await storage.loadMirror()).toBeNull();
  });

  it('um JSON inválido vale como "sem pasta"; um JSON corrompido rejeita', async () => {
    mockFs.files.set('file:///data/files/registros/copia.json', '{"uri":1}');
    expect(await createFileStorage().loadMirror()).toBeNull();
    mockFs.files.set('file:///data/files/registros/copia.json', '{quebrado');
    await expect(createFileStorage().loadMirror()).rejects.toThrow();
  });
});

describe('seletor de pastas', () => {
  it('devolve a URI e um nome legível', async () => {
    mockFs.pick = { uri: 'content://x/tree/primary%3ADocuments%2FGymBurn' };
    expect(await createFileStorage().pickMirrorFolder()).toEqual({
      uri: 'content://x/tree/primary%3ADocuments%2FGymBurn',
      label: 'Documents/GymBurn',
    });
  });

  it('cancelar devolve null; outro erro é repassado', async () => {
    mockFs.pick = Object.assign(new Error('cancelado'), { code: 'ERR_PICKER_CANCELLED' });
    expect(await createFileStorage().pickMirrorFolder()).toBeNull();
    mockFs.pick = new Error('outro');
    await expect(createFileStorage().pickMirrorFolder()).rejects.toThrow('outro');
  });
});

describe('escrita na pasta de cópia', () => {
  const folder = { uri: 'content://x/tree/primary%3ADocuments', label: 'Documents' };
  const target = `${folder.uri}/${LOG}`;

  it('cria o arquivo na primeira vez e depois anexa ao mesmo, sem listar de novo a pasta', async () => {
    const storage = createFileStorage();
    await storage.mirrorWrite(folder, LOG, 'a\n', { append: true });
    await storage.mirrorWrite(folder, LOG, 'b\n', { append: true });
    expect(mockFs.files.get(target)).toBe('a\nb\n');
  });

  it('acha um arquivo que já existe com o mesmo nome em vez de criar outro', async () => {
    mockFs.files.set(target, 'antigo\n');
    await createFileStorage().mirrorWrite(folder, LOG, 'novo\n', { append: true });
    expect(mockFs.files.get(target)).toBe('antigo\nnovo\n');
    expect(mockFs.files.size).toBe(1);
  });

  it('sem append, substitui o conteúdo inteiro', async () => {
    mockFs.files.set(target, 'conteúdo antigo e comprido\n');
    await createFileStorage().mirrorWrite(folder, LOG, 'curto\n', { append: false });
    expect(mockFs.files.get(target)).toBe('curto\n');
  });
});

describe('escrita síncrona', () => {
  const folder = { uri: 'content://x/tree/primary%3ADocuments', label: 'Documents' };
  const target = `${folder.uri}/${LOG}`;

  it('anexa com append, cria o arquivo que falta e preserva acentos e símbolos', () => {
    const storage = createFileStorage();
    storage.appendSync?.(LOG, 'gravação\n');
    storage.appendSync?.(LOG, 'ação ⏎\n');
    expect(mockFs.files.get(LOG_URI)).toBe('gravação\nação ⏎\n');
    expect(mockFs.directories.has('file:///data/files/registros')).toBe(true);
    expect(mockFs.syncWrites.map((write) => write.append)).toEqual([true, true]);
  });

  it('repassa o erro quando a escrita falha', () => {
    const storage = createFileStorage();
    mockFs.failWrite = new Error('disco cheio');
    expect(() => storage.appendSync?.(LOG, 'x\n')).toThrow('disco cheio');
    expect(mockFs.syncWrites).toHaveLength(1);
  });

  it('na cópia: anexa ao arquivo da pasta, sem listá-la de novo na segunda vez', async () => {
    const storage = createFileStorage();
    await storage.mirrorWrite(folder, LOG, 'a\n', { append: true });
    const listed = mockFs.listCalls;
    storage.mirrorWriteSync?.(folder, LOG, 'b ç\n');
    storage.mirrorWriteSync?.(folder, LOG, 'c\n');
    expect(mockFs.files.get(target)).toBe('a\nb ç\nc\n');
    expect(mockFs.listCalls).toBe(listed);
    expect(mockFs.syncWrites.slice(-2).every((write) => write.uri === target && write.append === true)).toBe(true);
  });

  it('na cópia: acha o arquivo que já existe e cria um se faltar, sem duplicar', () => {
    mockFs.files.set(target, 'antigo\n');
    createFileStorage().mirrorWriteSync?.(folder, LOG, 'novo\n');
    expect(mockFs.files.get(target)).toBe('antigo\nnovo\n');
    expect(mockFs.files.size).toBe(1);

    mockFs.files.clear();
    createFileStorage().mirrorWriteSync?.(folder, LOG, 'primeiro\n');
    expect(mockFs.files.get(target)).toBe('primeiro\n');
  });

  it('na cópia: depois de uma falha, a próxima escrita procura o arquivo de novo', () => {
    const storage = createFileStorage();
    storage.mirrorWriteSync?.(folder, LOG, 'a\n');
    mockFs.failWrite = new Error('sem permissão');
    expect(() => storage.mirrorWriteSync?.(folder, LOG, 'b\n')).toThrow('sem permissão');
    mockFs.failWrite = null;
    const listed = mockFs.listCalls;
    storage.mirrorWriteSync?.(folder, LOG, 'c\n');
    expect(mockFs.listCalls).toBeGreaterThan(listed);
    expect(mockFs.files.get(target)).toBe('a\nc\n');
  });
});
