import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { mirrorLabel } from './format';
import type { RecorderStorage } from './session-recorder';
import type { MirrorFolder } from './types';

// Tradução fina das chamadas do gravador para o expo-file-system (API nova) e o expo-sharing.
//
// Arquivos internos: `Paths.document/registros/`. A pasta de cópia vem do seletor de pastas do
// sistema (Storage Access Framework, URI `content://`): escrever por caminho `file://` em
// armazenamento externo não funciona para arquivos novos, e o seletor dá permissão persistente.

const LOG_DIRECTORY = 'registros';
const MIRROR_CONFIG_FILE = 'copia.json';
const CANCELLED_CODE = 'ERR_PICKER_CANCELLED';

function isCancellation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === CANCELLED_CODE;
}

function isMirrorFolder(value: unknown): value is MirrorFolder {
  const candidate = value as Partial<MirrorFolder> | null;
  return typeof candidate?.uri === 'string' && typeof candidate.label === 'string';
}

export function createFileStorage(): RecorderStorage {
  const directory = new Directory(Paths.document, LOG_DIRECTORY);
  let directoryReady = false;
  // Achar o arquivo pelo nome numa pasta do seletor lista a pasta inteira; guarda o último.
  let mirrorFile: { key: string; file: File } | null = null;

  function ensureDirectory(): void {
    if (!directoryReady) {
      directory.create({ intermediates: true, idempotent: true });
      directoryReady = true;
    }
  }

  function logFile(name: string): File {
    ensureDirectory();
    return new File(directory, name);
  }

  function findOrCreateMirrorFile(folder: MirrorFolder, name: string, recreate: boolean): File {
    const key = `${folder.uri}|${name}`;
    if (!recreate && mirrorFile?.key === key) {
      return mirrorFile.file;
    }
    const target = new Directory(folder.uri);
    const existing = target
      .list()
      .find((entry): entry is File => entry instanceof File && entry.name === name);
    if (existing && recreate) {
      // O modo de escrita sem `append` do SAF nem sempre trunca; apagar e recriar é seguro.
      existing.delete();
    }
    // `createFile` num nome que já existe criaria "nome (1).txt"; por isso a busca acima.
    const file = !existing || recreate ? target.createFile(name, 'text/plain') : existing;
    mirrorFile = { key, file };
    return file;
  }

  return {
    async list() {
      ensureDirectory();
      return directory
        .list()
        .filter((entry): entry is File => entry instanceof File)
        .map((file) => ({ name: file.name, sizeBytes: file.size, modifiedAt: file.lastModified }));
    },

    async append(name, text) {
      await logFile(name).write(text, { append: true });
    },

    // Síncrono: roda na thread de JS e termina antes de voltar. Usa o mesmo caminho nativo da escrita
    // assíncrona (anexa por stream, cria o arquivo se faltar), sem handle com posição própria.
    appendSync(name, text) {
      logFile(name).writeSync(text, { append: true });
    },

    read(name) {
      return logFile(name).text();
    },

    async remove(name) {
      logFile(name).delete();
    },

    async share(name) {
      await Sharing.shareAsync(logFile(name).uri, {
        mimeType: 'text/plain',
        dialogTitle: 'Compartilhar registro',
      });
    },

    async loadMirror() {
      const config = logFile(MIRROR_CONFIG_FILE);
      if (!config.exists) {
        return null;
      }
      const parsed: unknown = JSON.parse(await config.text());
      return isMirrorFolder(parsed) ? { uri: parsed.uri, label: parsed.label } : null;
    },

    async saveMirror(mirror) {
      const config = logFile(MIRROR_CONFIG_FILE);
      if (!mirror) {
        if (config.exists) {
          config.delete();
        }
        return;
      }
      await config.write(JSON.stringify({ uri: mirror.uri, label: mirror.label }));
    },

    async pickMirrorFolder() {
      try {
        const picked = await Directory.pickDirectoryAsync();
        return { uri: picked.uri, label: mirrorLabel(picked.uri) };
      } catch (error) {
        if (isCancellation(error)) {
          return null;
        }
        throw error;
      }
    },

    async mirrorWrite(folder, name, text, { append }) {
      try {
        await findOrCreateMirrorFile(folder, name, !append).write(text, { append });
      } catch (error) {
        mirrorFile = null;
        throw error;
      }
    },

    mirrorWriteSync(folder, name, text) {
      try {
        findOrCreateMirrorFile(folder, name, false).writeSync(text, { append: true });
      } catch (error) {
        mirrorFile = null;
        throw error;
      }
    },
  };
}
