import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { AppState, Platform } from 'react-native';

import { createFileStorage } from './file-storage';
import type { HeaderInfo } from './format';
import { SessionRecorder } from './session-recorder';
import type { RecorderActions, RecorderSnapshot, RecorderStore } from './types';

export type DisposableRecorder = RecorderStore & { dispose(): void };

function headerInfo(): HeaderInfo {
  const config = Constants.expoConfig;
  const device = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ');
  // No Android, `Device.osName` pode vir com a identificação inteira da ROM do fabricante.
  const osName = Platform.OS === 'android' ? 'Android' : (Device.osName ?? Platform.OS);
  const api = Platform.OS === 'android' ? ` (API ${Platform.Version})` : '';
  return {
    app: `${config?.name ?? 'Gym Burn'} ${config?.version ?? 'versão desconhecida'}`,
    device: device || 'desconhecido',
    system: `${osName} ${Device.osVersion ?? '?'}${api}`,
  };
}

const NO_FILES: RecorderSnapshot['files'] = [];

/** Um gravador que não grava: guarda o motivo em `problem` e descarta as linhas. */
function createUnavailableRecorder(reason: string): DisposableRecorder {
  const snapshot: RecorderSnapshot = {
    currentFileName: null,
    files: NO_FILES,
    mirror: null,
    problem: `O registro em arquivo não está disponível: ${reason}`,
  };
  const nothing = () => {};
  const actions: RecorderActions = {
    refresh: nothing,
    share: nothing,
    remove: nothing,
    removeOthers: nothing,
    chooseMirrorFolder: nothing,
    stopMirroring: nothing,
  };
  return {
    subscribe: () => nothing,
    getSnapshot: () => snapshot,
    actions,
    write: nothing,
    flush: () => Promise.resolve(),
    flushSync: nothing,
    dispose: nothing,
  };
}

/**
 * Monta o gravador de verdade: arquivos no armazenamento do app, relógio real, cabeçalho com o app
 * e o aparelho, e descarga ao ir para segundo plano. Nunca lança.
 */
export function createRecorder(): DisposableRecorder {
  try {
    const recorder = new SessionRecorder({ storage: createFileStorage(), headerInfo: headerInfo() });
    // O sistema pode encerrar o app em segundo plano sem aviso: grava antes.
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        void recorder.flush();
      }
    });
    return {
      subscribe: recorder.subscribe,
      getSnapshot: recorder.getSnapshot,
      actions: recorder.actions,
      write: recorder.write,
      flush: () => recorder.flush(),
      flushSync: () => recorder.flushSync(),
      dispose: () => {
        appState.remove();
        recorder.dispose();
      },
    };
  } catch (error) {
    return createUnavailableRecorder(error instanceof Error ? error.message : String(error));
  }
}
