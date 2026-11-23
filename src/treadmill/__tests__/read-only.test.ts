import type { BleConnection, BleTransport, BleWriter } from '@/ble/transport';
import { SIMULATED_DEVICE_ID, SimulatedTreadmillTransport } from '@/simulator/simulated-treadmill';

import { TreadmillSession } from '../treadmill-session';

// O projeto não tem os tipos do Node; o Jest roda no Node e tem os dois módulos.
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = jest.requireActual<{
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { isDirectory(): boolean };
}>('fs');
const { join } = jest.requireActual<{ join(...parts: string[]): string }>('path');

/**
 * A esteira é 100% só leitura. A escrita BLE existe no contrato só para a
 * cinta (o protocolo da XOSS X2 Pro); estes testes falham se algo em
 * `src/treadmill` passar a usá-la.
 */

/** O código de `src/treadmill`, sem os testes. */
function sources(dir = join(__dirname, '..')): { file: string; code: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [{ file: path, code: readFileSync(path, 'utf8') }] : [];
  });
}

/** Tira os comentários: falar de escrita num comentário não é escrever. */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('nada em src/treadmill toca a capacidade de escrita', () => {
  const files = sources();
  expect(files.length).toBeGreaterThan(3);
  for (const { file, code } of files) {
    const clean = withoutComments(code);
    for (const pattern of [/\bwriter\b/, /\bBleWriter\b/, /\.write\s*\(/, /writeWithoutResponse/, /WriteMode/]) {
      if (pattern.test(clean)) {
        throw new Error(`${file} usa a escrita (${pattern}): a esteira é só leitura.`);
      }
    }
  }
});

it('com uma conexão que oferece escrita, a sessão da esteira nunca escreve', async () => {
  const write = jest.fn<ReturnType<BleWriter['write']>, Parameters<BleWriter['write']>>(async () => undefined);
  const simulated = new SimulatedTreadmillTransport();
  // A esteira simulada não tem `writer`; aqui ela ganha um, só para provar que ninguém o usa.
  const transport: BleTransport = {
    prepare: () => simulated.prepare(),
    scan: (onDevice, onError) => simulated.scan(onDevice, onError),
    connect: async (id) => {
      const connection = await simulated.connect(id);
      return new Proxy(connection, {
        get: (target, key) => (key === 'writer' ? { write } : Reflect.get(target, key, target)),
      }) as BleConnection;
    },
  };
  const session = new TreadmillSession({
    ble: transport,
    demo: { transport, deviceId: SIMULATED_DEVICE_ID },
    heartRate: (now) => ({ bpm: 120, at: now, beats: [{ seq: 1, rrMs: 500 }], cadence: null }),
  });

  session.actions.openDemo();
  await jest.advanceTimersByTimeAsync(30_000);

  expect(session.getSnapshot().phase).toBe('connected');
  expect(session.getSnapshot().samples.length).toBeGreaterThan(10);
  expect(write).not.toHaveBeenCalled();
  session.actions.disconnect();
  await jest.advanceTimersByTimeAsync(1000);
  expect(write).not.toHaveBeenCalled();
});
