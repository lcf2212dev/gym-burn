import type { RecorderStorage, StoredFile } from '../session-recorder';
import type { MirrorFolder } from '../types';

/** Armazenamento em memória para os testes do gravador. */
export class FakeStorage implements RecorderStorage {
  /** Arquivos internos: texto e, opcionalmente, um tamanho forçado (para testar a retenção). */
  readonly files = new Map<string, { text: string; size?: number; modifiedAt: number }>();
  readonly mirrorFiles = new Map<string, string>();
  savedMirror: MirrorFolder | null = null;
  /** O que o seletor de pastas devolve; um `Error` faz o seletor falhar. */
  pickResult: MirrorFolder | null | Error = null;

  failAppend: Error | null = null;
  /** Com `failAppend`, quantos caracteres do texto chegam ao arquivo antes da falha (disco cheio no meio). */
  partialOnFail = 0;
  failAppendSync: Error | null = null;
  failMirrorSync: Error | null = null;
  failMirror: Error | null = null;
  failRemove: Error | null = null;
  failShare: Error | null = null;

  readonly appends: { name: string; text: string }[] = [];
  readonly syncAppends: { name: string; text: string }[] = [];
  readonly mirrorSyncAppends: string[] = [];
  appendAttempts = 0;
  readonly shared: string[] = [];
  maxConcurrentAppends = 0;
  private activeAppends = 0;
  private gate: Promise<void> | null = null;

  /**
   * Escrita síncrona. É propriedade (e não método) para um teste poder pôr `undefined` e simular
   * um armazenamento sem escrita síncrona.
   */
  appendSync: RecorderStorage['appendSync'] = (name, text) => {
    if (this.failAppendSync) {
      throw this.failAppendSync;
    }
    this.syncAppends.push({ name, text });
    this.writeToFile(name, text);
  };

  mirrorWriteSync: RecorderStorage['mirrorWriteSync'] = (folder, name, text) => {
    if (this.failMirrorSync) {
      throw this.failMirrorSync;
    }
    const key = this.mirrorKey(folder, name);
    this.mirrorFiles.set(key, (this.mirrorFiles.get(key) ?? '') + text);
    this.mirrorSyncAppends.push(text);
  };

  /** Segura as gravações até que a função devolvida seja chamada. */
  hold(): () => void {
    let release = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  seed(name: string, options: { text?: string; size?: number; modifiedAt?: number } = {}): void {
    this.files.set(name, {
      text: options.text ?? '',
      size: options.size,
      modifiedAt: options.modifiedAt ?? 0,
    });
  }

  /** Tudo o que foi gravado no arquivo, em ordem. */
  textOf(name: string): string {
    return this.files.get(name)?.text ?? '';
  }

  mirrorKey(folder: MirrorFolder, name: string): string {
    return `${folder.uri}|${name}`;
  }

  async list(): Promise<StoredFile[]> {
    return [...this.files].map(([name, file]) => ({
      name,
      sizeBytes: file.size ?? file.text.length,
      modifiedAt: file.modifiedAt,
    }));
  }

  async append(name: string, text: string): Promise<void> {
    this.appendAttempts += 1;
    this.activeAppends += 1;
    this.maxConcurrentAppends = Math.max(this.maxConcurrentAppends, this.activeAppends);
    try {
      if (this.gate) {
        await this.gate;
      }
      if (this.failAppend) {
        if (this.partialOnFail > 0) {
          this.writeToFile(name, text.slice(0, this.partialOnFail));
        }
        throw this.failAppend;
      }
      this.appends.push({ name, text });
      this.writeToFile(name, text);
    } finally {
      this.activeAppends -= 1;
    }
  }

  private writeToFile(name: string, text: string): void {
    const file = this.files.get(name) ?? { text: '', modifiedAt: 0 };
    file.text += text;
    this.files.set(name, file);
  }

  async read(name: string): Promise<string> {
    const file = this.files.get(name);
    if (!file) {
      throw new Error('arquivo inexistente');
    }
    return file.text;
  }

  async remove(name: string): Promise<void> {
    if (this.failRemove) {
      throw this.failRemove;
    }
    this.files.delete(name);
  }

  async share(name: string): Promise<void> {
    if (this.failShare) {
      throw this.failShare;
    }
    this.shared.push(name);
  }

  async loadMirror(): Promise<MirrorFolder | null> {
    return this.savedMirror;
  }

  async saveMirror(mirror: MirrorFolder | null): Promise<void> {
    this.savedMirror = mirror;
  }

  async pickMirrorFolder(): Promise<MirrorFolder | null> {
    if (this.pickResult instanceof Error) {
      throw this.pickResult;
    }
    return this.pickResult;
  }

  async mirrorWrite(
    folder: MirrorFolder,
    name: string,
    text: string,
    { append }: { append: boolean },
  ): Promise<void> {
    if (this.failMirror) {
      throw this.failMirror;
    }
    const key = this.mirrorKey(folder, name);
    this.mirrorFiles.set(key, append ? (this.mirrorFiles.get(key) ?? '') + text : text);
  }
}
