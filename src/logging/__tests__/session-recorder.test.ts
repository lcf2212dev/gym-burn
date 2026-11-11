import type { TraceLine } from '@/treadmill/types';

import { logFileName } from '../format';
import {
  FLUSH_DELAY_MS,
  MAX_FILES,
  MAX_PENDING_LINES,
  MAX_TOTAL_BYTES,
  SessionRecorder,
} from '../session-recorder';
import { FakeStorage } from '../testing/fake-storage';
import type { MirrorFolder } from '../types';

const START = new Date(2026, 10, 10, 21, 30, 5, 0);
const NAME = logFileName(START);
const INFO = { app: 'Gym Burn 1.0.0', device: 'Google Pixel 7', system: 'Android 15 (API 35)' };
const FOLDER: MirrorFolder = { uri: 'content://x/tree/primary%3ADocuments', label: 'Documents' };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
});

afterEach(() => {
  jest.useRealTimers();
});

function make(storage = new FakeStorage()) {
  const recorder = new SessionRecorder({ storage, headerInfo: INFO });
  return { recorder, storage };
}

const line = (text: string, kind: TraceLine['kind'] = 'info'): TraceLine => ({
  at: Date.now(),
  kind,
  text,
  hex: null,
});

/** Deixa as tarefas assíncronas pendentes terminarem, sem avançar o relógio. */
const settle = () => jest.advanceTimersByTimeAsync(0);

/** Nome de arquivo de registro do dia `n` (quanto maior, mais novo). */
const nameOfDay = (n: number) => logFileName(new Date(2026, 0, n, 12, 0, 0));

describe('estado inicial', () => {
  it('conhece o arquivo da execução, mas ainda não o criou', async () => {
    const { recorder, storage } = make();
    await settle();
    expect(recorder.getSnapshot()).toEqual({
      currentFileName: NAME,
      files: [],
      mirror: null,
      problem: null,
    });
    expect(storage.appendAttempts).toBe(0);
  });
});

describe('descarga', () => {
  it('por tempo: 2 s depois da primeira linha pendente, com o cabeçalho antes', async () => {
    const { recorder, storage } = make();
    recorder.write(line('primeira'));
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
    expect(storage.appendAttempts).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(storage.appends).toHaveLength(1);
    const text = storage.textOf(NAME);
    expect(text.startsWith('# Gym Burn — registro de execução\n')).toBe(true);
    expect(text).toContain('# Aparelho: Google Pixel 7\n');
    expect(text.endsWith('21:30:05.000 info   primeira\n')).toBe(true);
  });

  it('o prazo conta da primeira linha: linhas seguintes não o adiam', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await jest.advanceTimersByTimeAsync(1500);
    recorder.write(line('b'));
    await jest.advanceTimersByTimeAsync(500);
    expect(storage.appends).toHaveLength(1);
    expect(storage.textOf(NAME)).toMatch(/a\n.*b\n$/);
  });

  it('por quantidade: 100 linhas gravam na hora, 99 não', async () => {
    const { recorder, storage } = make();
    for (let i = 0; i < 99; i++) {
      recorder.write(line(`l${i}`));
    }
    await settle();
    expect(storage.appendAttempts).toBe(0);
    recorder.write(line('l99'));
    await settle();
    expect(storage.appends).toHaveLength(1);
    expect(storage.textOf(NAME).split('\n').filter((l) => / info {3}l\d+$/.test(l))).toHaveLength(100);
  });

  it('por linha de erro: grava na hora, junto com o que estava pendente', async () => {
    const { recorder, storage } = make();
    recorder.write(line('antes'));
    recorder.write(line('quebrou', 'error'));
    await settle();
    expect(storage.appends).toHaveLength(1);
    expect(storage.textOf(NAME)).toMatch(/antes\n.*error {2}quebrou\n$/);
  });

  it('por flush(): grava o pendente; sem nada pendente, não faz nada', async () => {
    const { recorder, storage } = make();
    await recorder.flush();
    expect(storage.appendAttempts).toBe(0);
    recorder.write(line('x'));
    await recorder.flush();
    expect(storage.textOf(NAME)).toContain('info   x\n');
    // o prazo de 2 s foi cancelado: nada é gravado de novo
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
    expect(storage.appends).toHaveLength(1);
  });

  it('o cabeçalho vai só na primeira gravação', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    recorder.write(line('b'));
    await recorder.flush();
    expect(storage.appends).toHaveLength(2);
    expect(storage.appends[1].text).not.toContain('#');
    expect(storage.textOf(NAME).match(/^# Gym Burn/gm)).toHaveLength(1);
  });

  it('nunca há duas gravações ao mesmo tempo e a ordem das linhas é preservada', async () => {
    const { recorder, storage } = make();
    const release = storage.hold();
    for (let i = 0; i < 100; i++) {
      recorder.write(line(`a${i}`));
    }
    await settle();
    for (let i = 0; i < 100; i++) {
      recorder.write(line(`b${i}`));
    }
    recorder.write(line('c', 'error'));
    await settle();
    expect(storage.appends).toHaveLength(0); // a primeira ainda espera
    release();
    await recorder.flush();
    expect(storage.maxConcurrentAppends).toBe(1);
    const order = storage
      .textOf(NAME)
      .split('\n')
      .map((l) => l.match(/ (?:info|error) +([abc]\d*)$/)?.[1])
      .filter(Boolean);
    expect(order).toEqual([
      ...Array.from({ length: 100 }, (_, i) => `a${i}`),
      ...Array.from({ length: 100 }, (_, i) => `b${i}`),
      'c',
    ]);
  });
});

describe('falhas de gravação', () => {
  it('vira problem, mantém as linhas e regrava na próxima descarga', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('disco cheio');
    recorder.write(line('a'));
    recorder.write(line('b'));
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(recorder.getSnapshot().problem).toBe('Não foi possível gravar o registro: disco cheio');
    expect(recorder.getSnapshot().currentFileName).toBeNull();
    expect(storage.files.size).toBe(0);

    recorder.write(line('c'));
    storage.failAppend = null;
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(recorder.getSnapshot().problem).toBeNull();
    expect(recorder.getSnapshot().currentFileName).toBe(NAME);
    const text = storage.textOf(NAME);
    expect(text.startsWith('# Gym Burn')).toBe(true);
    expect(text.match(/info {3}[abc]$/gm)).toEqual(['info   a', 'info   b', 'info   c']);
  });

  it('insiste a cada 2 s, e uma sequência de erros não martela o armazenamento', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('sem permissão');
    for (let i = 0; i < 10; i++) {
      recorder.write(line(`e${i}`, 'error'));
    }
    await settle();
    expect(storage.appendAttempts).toBe(1);
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(storage.appendAttempts).toBe(2);
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(storage.appendAttempts).toBe(3);
  });

  it('com o arquivo já criado, a falha não apaga o nome do arquivo atual', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    storage.failAppend = new Error('x');
    recorder.write(line('b'));
    await recorder.flush();
    expect(recorder.getSnapshot().currentFileName).toBe(NAME);
    expect(recorder.getSnapshot().problem).not.toBeNull();
  });

  it(`guarda até ${MAX_PENDING_LINES} linhas; descarta as mais antigas e registra quantas`, async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('sem espaço');
    const total = MAX_PENDING_LINES + 120;
    for (let i = 0; i < total; i++) {
      recorder.write(line(`n${i}`));
    }
    await settle();
    storage.failAppend = null;
    await recorder.flush();

    const text = storage.textOf(NAME);
    const kept = text.match(/info {3}n\d+$/gm) ?? [];
    expect(kept).toHaveLength(MAX_PENDING_LINES);
    expect(kept[0]).toBe('info   n120');
    expect(kept[kept.length - 1]).toBe(`info   n${total - 1}`);
    expect(text).toContain('120 linhas foram descartadas da memória');
    // o aviso fica antes das linhas que sobraram
    expect(text.indexOf('120 linhas')).toBeLessThan(text.indexOf('info   n120'));
    expect(recorder.getSnapshot().problem).toBeNull();
  });

  it('uma exceção síncrona do armazenamento também vira problem', async () => {
    const { recorder, storage } = make();
    storage.append = () => {
      throw new Error('falha síncrona');
    };
    recorder.write(line('a'));
    await recorder.flush();
    expect(recorder.getSnapshot().problem).toBe('Não foi possível gravar o registro: falha síncrona');
  });
});

describe('write', () => {
  it('nunca lança, nem com linha malformada nem depois de dispose()', async () => {
    const { recorder } = make();
    expect(() => recorder.write(null as unknown as TraceLine)).not.toThrow();
    expect(() => recorder.write({ at: 1, kind: 'rx', text: undefined, hex: null } as unknown as TraceLine)).not.toThrow();
    recorder.dispose();
    expect(() => recorder.write(line('depois'))).not.toThrow();
    await settle();
  });

  it('não bloqueia: devolve antes de qualquer gravação acontecer', () => {
    const { recorder, storage } = make();
    storage.hold();
    const result = recorder.write(line('a', 'error'));
    expect(result).toBeUndefined();
  });

  it('dispose() cancela o prazo e grava o que sobrou', async () => {
    const { recorder, storage } = make();
    recorder.write(line('última'));
    recorder.dispose();
    await settle();
    expect(storage.textOf(NAME)).toContain('última');
  });
});

describe('retenção', () => {
  it(`deixa no máximo ${MAX_FILES} arquivos, contando o da execução; apaga os mais antigos`, async () => {
    const storage = new FakeStorage();
    for (let day = 1; day <= 40; day++) {
      storage.seed(nameOfDay(day));
    }
    make(storage);
    await settle();
    const left = [...storage.files.keys()].sort();
    expect(left).toHaveLength(MAX_FILES - 1);
    expect(left[0]).toBe(nameOfDay(12));
    expect(left[left.length - 1]).toBe(nameOfDay(40));
  });

  it('por tamanho: ao estourar 30 MB, apaga esse e todos os mais antigos', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(5), { size: 20 * 1024 * 1024 });
    storage.seed(nameOfDay(4), { size: 15 * 1024 * 1024 });
    storage.seed(nameOfDay(3), { size: 10 });
    storage.seed(nameOfDay(2), { size: 10 });
    make(storage);
    await settle();
    expect([...storage.files.keys()]).toEqual([nameOfDay(5)]);
  });

  it('exatamente 30 MB cabem', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(2), { size: MAX_TOTAL_BYTES / 2 });
    storage.seed(nameOfDay(1), { size: MAX_TOTAL_BYTES / 2 });
    make(storage);
    await settle();
    expect(storage.files.size).toBe(2);
  });

  it('nunca apaga o arquivo atual nem arquivos que não são registros', async () => {
    const storage = new FakeStorage();
    storage.seed(NAME, { size: MAX_TOTAL_BYTES * 2, text: 'em uso' });
    storage.seed('copia.json', { text: '{}' });
    for (let day = 1; day <= 40; day++) {
      storage.seed(nameOfDay(day));
    }
    make(storage);
    await settle();
    expect(storage.files.has(NAME)).toBe(true);
    expect(storage.files.has('copia.json')).toBe(true);
  });
});

describe('lista de arquivos', () => {
  it('do mais novo para o mais antigo, com o atual marcado, sem o JSON de configuração', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(1), { text: 'abc', modifiedAt: 111 });
    storage.seed(nameOfDay(3), { text: 'de', modifiedAt: 222 });
    storage.seed('copia.json');
    const { recorder } = make(storage);
    await settle();
    expect(recorder.getSnapshot().files).toEqual([
      { name: nameOfDay(3), sizeBytes: 2, modifiedAt: 222, current: false },
      { name: nameOfDay(1), sizeBytes: 3, modifiedAt: 111, current: false },
    ]);

    recorder.write(line('x'));
    await recorder.flush();
    const files = recorder.getSnapshot().files;
    expect(files.map((f) => f.name)).toEqual([NAME, nameOfDay(3), nameOfDay(1)].sort().reverse());
    expect(files.filter((f) => f.current).map((f) => f.name)).toEqual([NAME]);
  });

  it('refresh() relê os tamanhos', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    const before = recorder.getSnapshot().files[0].sizeBytes;
    recorder.write(line('b'));
    await recorder.flush();
    expect(recorder.getSnapshot().files[0].sizeBytes).toBe(before); // só muda no refresh
    recorder.actions.refresh();
    await settle();
    expect(recorder.getSnapshot().files[0].sizeBytes).toBe(storage.textOf(NAME).length);
    expect(recorder.getSnapshot().files[0].sizeBytes).toBeGreaterThan(before);
  });
});

describe('apagar', () => {
  it('remove() apaga um arquivo antigo e atualiza a lista', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(1));
    storage.seed(nameOfDay(2));
    const { recorder } = make(storage);
    await settle();
    recorder.actions.remove(nameOfDay(1));
    await settle();
    expect(storage.files.has(nameOfDay(1))).toBe(false);
    expect(recorder.getSnapshot().files.map((f) => f.name)).toEqual([nameOfDay(2)]);
  });

  it('remove() do arquivo atual, ou de um nome que não é registro, é ignorado', async () => {
    const storage = new FakeStorage();
    storage.seed('copia.json');
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    recorder.actions.remove(NAME);
    recorder.actions.remove('copia.json');
    recorder.actions.remove('../x.txt');
    await settle();
    expect(storage.files.has(NAME)).toBe(true);
    expect(storage.files.has('copia.json')).toBe(true);
  });

  it('removeOthers() apaga todos, menos o atual', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(1));
    storage.seed(nameOfDay(2));
    storage.seed('copia.json');
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    recorder.actions.removeOthers();
    await settle();
    expect([...storage.files.keys()].sort()).toEqual(['copia.json', NAME]);
    expect(recorder.getSnapshot().files.map((f) => f.name)).toEqual([NAME]);
  });

  it('falha ao apagar vira problem', async () => {
    const storage = new FakeStorage();
    storage.seed(nameOfDay(1));
    const { recorder } = make(storage);
    await settle();
    storage.failRemove = new Error('em uso');
    recorder.actions.remove(nameOfDay(1));
    await settle();
    expect(recorder.getSnapshot().problem).toBe('Não foi possível apagar o registro: em uso');
  });
});

describe('compartilhar', () => {
  it('grava o pendente antes de abrir a folha de compartilhamento', async () => {
    const { recorder, storage } = make();
    let seen = '';
    storage.share = async () => {
      seen = storage.textOf(NAME);
    };
    recorder.write(line('pendente'));
    recorder.actions.share(NAME);
    await settle();
    expect(seen).toContain('pendente');
  });

  it('não segura a fila enquanto a folha está aberta', async () => {
    const { recorder, storage } = make();
    let close = () => {};
    storage.share = () =>
      new Promise<void>((resolve) => {
        close = resolve;
      });
    recorder.write(line('a'));
    recorder.actions.share(NAME);
    await settle();
    recorder.write(line('durante', 'error'));
    await settle();
    expect(storage.textOf(NAME)).toContain('durante');
    close();
  });

  it('falha vira problem e some na ação seguinte', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    storage.failShare = new Error('já há um compartilhamento aberto');
    recorder.actions.share(NAME);
    await settle();
    expect(recorder.getSnapshot().problem).toBe(
      'Não foi possível compartilhar o registro: já há um compartilhamento aberto',
    );
    storage.failShare = null;
    recorder.actions.share(NAME);
    await settle();
    expect(recorder.getSnapshot().problem).toBeNull();
    expect(storage.shared).toEqual([NAME]);
  });
});

describe('pasta de cópia', () => {
  it('uma pasta salva antes já vale desde o início e recebe tudo o que é gravado', async () => {
    const storage = new FakeStorage();
    storage.savedMirror = FOLDER;
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    recorder.write(line('b'));
    await recorder.flush();
    expect(recorder.getSnapshot().mirror).toEqual(FOLDER);
    expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toBe(storage.textOf(NAME));
    expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toContain('# Gym Burn');
  });

  it('escolhida no meio da execução: copia primeiro o que já foi gravado, depois acompanha', async () => {
    const { recorder, storage } = make();
    recorder.write(line('antes'));
    await recorder.flush();
    storage.pickResult = FOLDER;
    recorder.actions.chooseMirrorFolder();
    await settle();
    const key = storage.mirrorKey(FOLDER, NAME);
    expect(recorder.getSnapshot().mirror).toEqual(FOLDER);
    expect(storage.savedMirror).toEqual(FOLDER);
    expect(storage.mirrorFiles.get(key)).toBe(storage.textOf(NAME));

    recorder.write(line('depois'));
    await recorder.flush();
    expect(storage.mirrorFiles.get(key)).toBe(storage.textOf(NAME));
    expect(storage.mirrorFiles.get(key)?.match(/info {3}(antes|depois)$/gm)).toEqual([
      'info   antes',
      'info   depois',
    ]);
  });

  it('linhas pendentes na hora da escolha não são copiadas duas vezes', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    recorder.write(line('pendente'));
    storage.pickResult = FOLDER;
    recorder.actions.chooseMirrorFolder();
    await recorder.flush();
    await settle();
    const copy = storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME)) ?? '';
    expect(copy).toBe(storage.textOf(NAME));
    expect(copy.match(/pendente/g)).toHaveLength(1);
  });

  it('escolhida antes de o arquivo existir: nada a copiar, a primeira gravação já vai para as duas', async () => {
    const { recorder, storage } = make();
    storage.pickResult = FOLDER;
    recorder.actions.chooseMirrorFolder();
    await settle();
    expect(storage.mirrorFiles.size).toBe(0);
    recorder.write(line('a'));
    await recorder.flush();
    expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toBe(storage.textOf(NAME));
  });

  it('cancelar o seletor não muda nada; falha do seletor vira problem', async () => {
    const { recorder, storage } = make();
    await settle();
    const before = recorder.getSnapshot();
    storage.pickResult = null;
    recorder.actions.chooseMirrorFolder();
    await settle();
    expect(recorder.getSnapshot()).toBe(before);

    storage.pickResult = new Error('sem seletor');
    recorder.actions.chooseMirrorFolder();
    await settle();
    expect(recorder.getSnapshot().problem).toBe('Não foi possível abrir o seletor de pastas: sem seletor');
    expect(recorder.getSnapshot().mirror).toBeNull();
  });

  it('falha na cópia vira problem, suspende a cópia e não afeta o arquivo interno', async () => {
    const storage = new FakeStorage();
    storage.savedMirror = FOLDER;
    const { recorder } = make(storage);
    storage.failMirror = new Error('pasta indisponível');
    recorder.write(line('a'));
    await recorder.flush();
    expect(recorder.getSnapshot().problem).toContain('Documents');
    expect(recorder.getSnapshot().problem).toContain('pasta indisponível');
    expect(recorder.getSnapshot().mirror).toEqual(FOLDER); // a configuração é mantida
    expect(storage.savedMirror).toEqual(FOLDER);
    expect(storage.textOf(NAME)).toContain('info   a');

    // Mesmo com a pasta de volta, a cópia segue suspensa até o fim da execução.
    storage.failMirror = null;
    recorder.write(line('b'));
    await recorder.flush();
    expect(storage.textOf(NAME)).toContain('info   b');
    expect(storage.mirrorFiles.size).toBe(0);
    expect(recorder.getSnapshot().problem).toContain('pasta indisponível');
  });

  it('o problema da cópia não esconde nem é apagado por gravações internas que funcionam', async () => {
    const storage = new FakeStorage();
    storage.savedMirror = FOLDER;
    storage.failMirror = new Error('x');
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    const problem = recorder.getSnapshot().problem;
    recorder.write(line('b'));
    await recorder.flush();
    expect(recorder.getSnapshot().problem).toBe(problem);
  });

  it('falha ao copiar o conteúdo anterior: problem, pasta mantida, interno intacto', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    await recorder.flush();
    storage.failMirror = new Error('sem acesso');
    storage.pickResult = FOLDER;
    recorder.actions.chooseMirrorFolder();
    await settle();
    expect(recorder.getSnapshot().mirror).toEqual(FOLDER);
    expect(recorder.getSnapshot().problem).toContain('sem acesso');
    recorder.write(line('b'));
    await recorder.flush();
    expect(storage.textOf(NAME)).toContain('info   b');
    expect(storage.mirrorFiles.size).toBe(0);
  });

  it('escolher a pasta de novo religa a cópia e limpa o problema', async () => {
    const storage = new FakeStorage();
    storage.savedMirror = FOLDER;
    storage.failMirror = new Error('x');
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    storage.failMirror = null;
    storage.pickResult = FOLDER;
    recorder.actions.chooseMirrorFolder();
    await settle();
    expect(recorder.getSnapshot().problem).toBeNull();
    expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toBe(storage.textOf(NAME));
  });

  it('stopMirroring() para a cópia, esquece a pasta e limpa o problema dela', async () => {
    const storage = new FakeStorage();
    storage.savedMirror = FOLDER;
    storage.failMirror = new Error('x');
    const { recorder } = make(storage);
    recorder.write(line('a'));
    await recorder.flush();
    recorder.actions.stopMirroring();
    await settle();
    expect(recorder.getSnapshot().mirror).toBeNull();
    expect(recorder.getSnapshot().problem).toBeNull();
    expect(storage.savedMirror).toBeNull();

    storage.failMirror = null;
    recorder.write(line('b'));
    await recorder.flush();
    expect(storage.mirrorFiles.size).toBe(0);
  });
});

describe('snapshot imutável', () => {
  it('a referência só muda quando algo muda, e as partes iguais mantêm a referência', async () => {
    const { recorder, storage } = make();
    const listener = jest.fn();
    recorder.subscribe(listener);
    await settle();
    const initial = recorder.getSnapshot();

    recorder.write(line('a'));
    await recorder.flush(); // cria o arquivo: a lista muda
    const created = recorder.getSnapshot();
    expect(created).not.toBe(initial);
    expect(created.files).not.toBe(initial.files);
    expect(created.mirror).toBe(initial.mirror);
    const calls = listener.mock.calls.length;

    // nada de novo: mesma referência e nenhum aviso
    recorder.write(line('b'));
    await recorder.flush();
    recorder.actions.refresh();
    recorder.actions.refresh();
    await settle();
    // só o tamanho do arquivo mudou, então a lista é nova no refresh
    const refreshed = recorder.getSnapshot();
    expect(refreshed.files).not.toBe(created.files);
    const callsAfterRefresh = listener.mock.calls.length;
    expect(callsAfterRefresh).toBeGreaterThan(calls);
    recorder.actions.refresh();
    await settle();
    expect(recorder.getSnapshot()).toBe(refreshed);
    expect(listener.mock.calls.length).toBe(callsAfterRefresh);

    // um problema novo troca o snapshot, mas não a lista
    storage.failAppend = new Error('x');
    recorder.write(line('c'));
    await recorder.flush();
    const failed = recorder.getSnapshot();
    expect(failed).not.toBe(refreshed);
    expect(failed.files).toBe(refreshed.files);
    expect(failed.problem).not.toBeNull();

    // a mesma falha de novo não notifica
    const callsBefore = listener.mock.calls.length;
    await recorder.flush();
    expect(recorder.getSnapshot()).toBe(failed);
    expect(listener.mock.calls.length).toBe(callsBefore);
  });

  it('subscribe() devolve a função que cancela, e um ouvinte que lança não atrapalha', async () => {
    const { recorder } = make();
    const quiet = jest.fn();
    const off = recorder.subscribe(quiet);
    recorder.subscribe(() => {
      throw new Error('ouvinte com defeito');
    });
    off();
    recorder.write(line('a'));
    await recorder.flush();
    expect(quiet).not.toHaveBeenCalled();
    expect(recorder.getSnapshot().files).toHaveLength(1);
  });
});

const countOf = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('flushSync', () => {
  it('grava na hora, com o cabeçalho, sem esperar o prazo nem a fila; e cancela o prazo', async () => {
    const { recorder, storage } = make();
    recorder.write(line('antes de morrer'));
    recorder.flushSync();
    expect(storage.syncAppends).toHaveLength(1);
    const text = storage.textOf(NAME);
    expect(text.startsWith('# Gym Burn — registro de execução\n')).toBe(true);
    expect(text.endsWith('info   antes de morrer\n')).toBe(true);
    expect(storage.appendAttempts).toBe(0);

    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
    expect(storage.appendAttempts).toBe(0);
    expect(storage.textOf(NAME)).toBe(text);
  });

  it('sem nada pendente, não faz nada', () => {
    const { recorder, storage } = make();
    recorder.flushSync();
    expect(storage.syncAppends).toHaveLength(0);
    expect(storage.files.size).toBe(0);
  });

  it('com uma descarga em andamento, não repete as linhas dela nem o cabeçalho que ela leva', async () => {
    const { recorder, storage } = make();
    const release = storage.hold();
    recorder.write(line('em andamento', 'error')); // descarga imediata, presa no armazenamento
    await settle();
    expect(storage.appendAttempts).toBe(1);

    recorder.write(line('fatal', 'error'));
    recorder.flushSync();
    expect(storage.syncAppends).toHaveLength(1);
    expect(storage.syncAppends[0].text).not.toContain('#');
    expect(storage.syncAppends[0].text).toContain('fatal');
    expect(storage.syncAppends[0].text).not.toContain('em andamento');

    release();
    await settle();
    const text = storage.textOf(NAME);
    expect(countOf(text, /^# Gym Burn/gm)).toBe(1);
    expect(countOf(text, /em andamento$/gm)).toBe(1);
    expect(countOf(text, /fatal$/gm)).toBe(1);
    // A ordem entre os dois blocos pode se inverter: o bloco síncrono sai primeiro.
    expect(text.indexOf('fatal')).toBeLessThan(text.indexOf('em andamento'));
    expect(recorder.getSnapshot().problem).toBeNull();
  });

  it('a reserva do cabeçalho é desfeita se a descarga que o leva falha', async () => {
    const { recorder, storage } = make();
    const release = storage.hold();
    storage.failAppend = new Error('disco cheio');
    recorder.write(line('a', 'error'));
    await settle();

    recorder.write(line('b'));
    recorder.flushSync(); // não leva o cabeçalho: a descarga em andamento o reservou
    expect(storage.syncAppends[0].text).not.toContain('#');

    release();
    await settle(); // a descarga falha; 'a' volta para a fila
    storage.failAppend = null;
    recorder.write(line('c'));
    await recorder.flush();

    const text = storage.textOf(NAME);
    // O cabeçalho nunca chegou ao arquivo: o próximo bloco o leva, uma vez só.
    expect(countOf(text, /^# Gym Burn/gm)).toBe(1);
    expect(countOf(text, /error {2}a$/gm)).toBe(1);
    expect(countOf(text, /info {3}b$/gm)).toBe(1);
    expect(countOf(text, /info {3}c$/gm)).toBe(1);
  });

  it('se o app não morrer, o gravador continua: estado coerente, lista atualizada, nada regravado', async () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    recorder.flushSync();
    await settle();
    expect(recorder.getSnapshot().currentFileName).toBe(NAME);
    expect(recorder.getSnapshot().problem).toBeNull();
    expect(recorder.getSnapshot().files).toEqual([
      expect.objectContaining({ name: NAME, current: true }),
    ]);

    recorder.write(line('b'));
    await recorder.flush();
    expect(storage.appends).toHaveLength(1); // a descarga normal só levou 'b'
    expect(storage.appends[0].text).not.toContain('#');
    expect(storage.appends[0].text).not.toContain('info   a');
    expect(storage.appends[0].text).toContain('info   b');
    const text = storage.textOf(NAME);
    expect(countOf(text, /^# Gym Burn/gm)).toBe(1);
    expect(countOf(text, /info {3}a$/gm)).toBe(1);

    recorder.flushSync();
    expect(storage.syncAppends).toHaveLength(1); // nada pendente
  });

  it('leva também o aviso de linhas descartadas', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('sem espaço');
    for (let i = 0; i < MAX_PENDING_LINES + 3; i++) {
      recorder.write(line(`n${i}`));
    }
    await settle();
    storage.failAppend = null;
    recorder.flushSync();
    const text = storage.textOf(NAME);
    expect(text).toContain('3 linhas foram descartadas da memória');
    expect(text.indexOf('3 linhas')).toBeLessThan(text.indexOf('info   n3'));
  });

  it('sem appendSync no armazenamento, as linhas voltam e a descarga normal as grava', async () => {
    const { recorder, storage } = make();
    storage.appendSync = undefined;
    recorder.write(line('a'));
    recorder.flushSync();
    expect(storage.files.size).toBe(0);
    expect(recorder.getSnapshot().problem).toBeNull();
    await settle();
    expect(countOf(storage.textOf(NAME), /^# Gym Burn/gm)).toBe(1);
    expect(storage.textOf(NAME)).toContain('info   a\n');
    expect(storage.textOf(NAME)).not.toContain('falhou');
  });

  it('se appendSync lança: problem, linhas de volta, descarga normal, e o próximo bloco avisa da falha', async () => {
    const { recorder, storage } = make();
    storage.failAppendSync = new Error('sem permissão');
    recorder.write(line('a'));
    expect(() => recorder.flushSync()).not.toThrow();
    expect(recorder.getSnapshot().problem).toBe('Não foi possível gravar o registro: sem permissão');
    expect(storage.files.size).toBe(0);

    await settle();
    const text = storage.textOf(NAME);
    expect(countOf(text, /^# Gym Burn/gm)).toBe(1);
    expect(countOf(text, /info {3}a$/gm)).toBe(1);
    expect(text).toContain('A gravação anterior falhou (sem permissão)');
    expect(recorder.getSnapshot().problem).toBeNull();
  });

  it('nunca lança, mesmo com um armazenamento que lança valores estranhos', () => {
    const { recorder, storage } = make();
    storage.appendSync = () => {
      throw 'texto solto';
    };
    recorder.write(line('a'));
    expect(() => recorder.flushSync()).not.toThrow();
    expect(recorder.getSnapshot().problem).toBe('Não foi possível gravar o registro: texto solto');
  });

  it('funciona também depois de dispose()', () => {
    const { recorder, storage } = make();
    recorder.write(line('a'));
    recorder.dispose();
    recorder.flushSync();
    // dispose() já pediu a descarga normal; qualquer um dos dois caminhos grava a linha, uma vez
    expect(countOf(storage.textOf(NAME), /info {3}a$/gm)).toBeLessThanOrEqual(1);
  });

  describe('cópia externa', () => {
    it('com a cópia ativa, anexa o mesmo bloco na pasta', async () => {
      const storage = new FakeStorage();
      storage.savedMirror = FOLDER;
      const { recorder } = make(storage);
      await settle();
      recorder.write(line('a'));
      recorder.flushSync();
      expect(storage.mirrorSyncAppends).toEqual([storage.textOf(NAME)]);
      expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toBe(storage.textOf(NAME));
    });

    it('falha na cópia suspende a cópia e vira problem, sem afetar o arquivo interno', async () => {
      const storage = new FakeStorage();
      storage.savedMirror = FOLDER;
      const { recorder } = make(storage);
      await settle();
      storage.failMirrorSync = new Error('permissão revogada');
      recorder.write(line('a'));
      recorder.flushSync();
      expect(storage.textOf(NAME)).toContain('info   a\n');
      expect(recorder.getSnapshot().problem).toBe(
        'A cópia para Documents falhou e foi suspensa até o app ser reaberto: permissão revogada',
      );

      storage.failMirrorSync = null;
      recorder.write(line('b'));
      await recorder.flush();
      expect(storage.mirrorFiles.get(storage.mirrorKey(FOLDER, NAME))).toBeUndefined();
    });

    it('sem mirrorWriteSync, grava só o arquivo interno', async () => {
      const storage = new FakeStorage();
      storage.savedMirror = FOLDER;
      storage.mirrorWriteSync = undefined;
      const { recorder } = make(storage);
      await settle();
      recorder.write(line('a'));
      recorder.flushSync();
      expect(storage.textOf(NAME)).toContain('info   a\n');
      expect(recorder.getSnapshot().problem).toBeNull();
    });
  });
});

describe('repetição depois de uma gravação que falhou no meio', () => {
  const NOTICE = /error {2}A gravação anterior falhou \((.*)\); se parte dela chegou ao arquivo, as linhas a seguir a repetem$/gm;

  it('a próxima gravação bem-sucedida começa com o aviso, depois do cabeçalho e antes das linhas', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('disco cheio');
    storage.partialOnFail = 60; // parte do cabeçalho chega ao arquivo
    recorder.write(line('a'));
    recorder.write(line('b'));
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(storage.textOf(NAME)).toHaveLength(60);

    storage.failAppend = null;
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    const text = storage.textOf(NAME);
    expect(countOf(text, NOTICE)).toBe(1);
    expect(text).toContain('A gravação anterior falhou (disco cheio); se parte dela chegou');
    const block = storage.appends[0].text;
    expect(block.indexOf('# Gym Burn')).toBeLessThan(block.indexOf('A gravação anterior'));
    expect(block.indexOf('A gravação anterior')).toBeLessThan(block.indexOf('info   a'));
    expect(block.indexOf('info   a')).toBeLessThan(block.indexOf('info   b'));
  });

  it('uma linha por sequência de falhas, não uma por tentativa', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('primeira causa');
    recorder.write(line('a'));
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 3); // várias tentativas falham
    expect(storage.appendAttempts).toBeGreaterThanOrEqual(3);

    storage.failAppend = new Error('outra causa');
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    storage.failAppend = null;
    await jest.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    const text = storage.textOf(NAME);
    expect(countOf(text, NOTICE)).toBe(1);
    expect(text).toContain('(primeira causa)');
  });

  it('depois que a gravação volta ao normal, os blocos seguintes não têm o aviso; uma nova falha tem o seu', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('x');
    recorder.write(line('a'));
    await recorder.flush();
    storage.failAppend = null;
    await recorder.flush(); // nada pendente: o aviso espera um bloco de verdade
    recorder.write(line('b'));
    await recorder.flush();
    recorder.write(line('c'));
    await recorder.flush();
    expect(countOf(storage.textOf(NAME), NOTICE)).toBe(1);

    storage.failAppend = new Error('y');
    recorder.write(line('d'));
    await recorder.flush();
    storage.failAppend = null;
    recorder.write(line('e'));
    await recorder.flush();
    expect(countOf(storage.textOf(NAME), NOTICE)).toBe(2);
    expect(storage.textOf(NAME)).toContain('(y)');
  });

  it('o aviso fica de fora enquanto nada é gravado e não conta como linha pendente', async () => {
    const { recorder, storage } = make();
    storage.failAppend = new Error('x');
    recorder.write(line('a'));
    await recorder.flush();
    await recorder.flush();
    expect(storage.textOf(NAME)).toBe('');
  });
});
