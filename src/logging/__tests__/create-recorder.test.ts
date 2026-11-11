import { AppState, Platform } from 'react-native';

import { createRecorder } from '../create-recorder';

// Sistema de arquivos mínimo em memória (o mesmo contrato de file-storage.test.ts).
const mockFs = { files: new Map<string, string>(), broken: false };

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
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
      return 1;
    }
    async write(text: string, options?: { append?: boolean }) {
      mockFs.files.set(this.uri, (options?.append ? (mockFs.files.get(this.uri) ?? '') : '') + text);
    }
    writeSync(text: string, options?: { append?: boolean }) {
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
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    create() {}
    list() {
      return [...mockFs.files.keys()].filter((uri) => uri.startsWith(`${this.uri}/`)).map((uri) => new File(uri));
    }
  }
  return {
    File,
    Directory,
    Paths: {
      get document() {
        if (mockFs.broken) {
          throw new Error('módulo nativo ausente');
        }
        return new Directory('file:///data/files');
      },
    },
  };
});
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { name: 'Gym Burn', version: '1.2.3' } },
}));
jest.mock('expo-device', () => ({
  manufacturer: 'Google',
  modelName: 'Pixel 7',
  osName: 'Android',
  osVersion: '15',
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockFs.files.clear();
  mockFs.broken = false;
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(35);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const logText = () => [...mockFs.files.values()].join('');

describe('createRecorder', () => {
  it('cria o store, escreve, faz flush e lista, com o cabeçalho do app e do aparelho', async () => {
    const recorder = createRecorder();
    recorder.write({ at: Date.now(), kind: 'rx', text: 'Treadmill Data', hex: '0C 00' });
    await recorder.flush();

    const text = logText();
    expect(text).toContain('# App: Gym Burn 1.2.3\n');
    expect(text).toContain('# Aparelho: Google Pixel 7\n');
    expect(text).toContain('# Sistema: Android 15 (API 35)\n');
    expect(text).toContain('Treadmill Data  hex=0C 00\n');
    const snapshot = recorder.getSnapshot();
    expect(snapshot.problem).toBeNull();
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].current).toBe(true);
    expect(snapshot.currentFileName).toBe(snapshot.files[0].name);
    recorder.dispose();
  });

  it('flushSync grava na hora, sem esperar o prazo nem a fila assíncrona', () => {
    const recorder = createRecorder();
    recorder.write({ at: Date.now(), kind: 'error', text: 'Erro fatal não tratado: x', hex: null });
    expect(logText()).toBe('');
    recorder.flushSync();
    expect(logText()).toContain('# App: Gym Burn 1.2.3\n');
    expect(logText()).toContain('Erro fatal não tratado: x\n');
    recorder.dispose();
  });

  it('flushSync do gravador indisponível não faz nada e não lança', () => {
    mockFs.broken = true;
    const recorder = createRecorder();
    expect(() => recorder.flushSync()).not.toThrow();
  });

  it('grava o que está pendente quando o app vai para segundo plano', async () => {
    let onChange: (state: string) => void = () => {};
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: (s: string) => void) => {
      onChange = handler;
      return { remove };
    }) as unknown as typeof AppState.addEventListener);

    const recorder = createRecorder();
    recorder.write({ at: Date.now(), kind: 'info', text: 'antes de sair', hex: null });
    onChange('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(logText()).toBe('');
    onChange('background');
    await jest.advanceTimersByTimeAsync(0);
    expect(logText()).toContain('antes de sair');

    recorder.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('sem sistema de arquivos, devolve um store que guarda o problema e descarta as linhas', async () => {
    mockFs.broken = true;
    const recorder = createRecorder();
    const listener = jest.fn();
    expect(() => recorder.subscribe(listener)()).not.toThrow();
    expect(() => recorder.write({ at: 1, kind: 'info', text: 'x', hex: null })).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    recorder.actions.refresh();
    recorder.actions.chooseMirrorFolder();
    expect(recorder.getSnapshot()).toEqual({
      currentFileName: null,
      files: [],
      mirror: null,
      problem: 'O registro em arquivo não está disponível: módulo nativo ausente',
    });
    expect(recorder.getSnapshot()).toBe(recorder.getSnapshot());
    expect(() => recorder.dispose()).not.toThrow();
    expect(mockFs.files.size).toBe(0);
  });
});
