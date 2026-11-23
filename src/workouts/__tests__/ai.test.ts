import * as SecureStore from 'expo-secure-store';
import { pulseFeatures, pulseWindow } from '../adaptive';
import { reviewLoad } from '../ai';
import { makePlan, newWorkout, type Plan } from '../model';
import type { ReviewInput } from '../prompts';
import { saveCall } from '../storage';
import type { TreadmillSample } from '@/treadmill/types';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
}));
jest.mock('../storage', () => ({ saveCall: jest.fn() }));

const plan: Plan = {
  ...makePlan('Base aeróbica', { warmup: 2, reps: 1, work: 6, recovery: 0, cooldown: 2 }, 5, 1),
  objective: 'Base aeróbica',
  zone: [65, 75],
};
const samples: TreadmillSample[] = Array.from({ length: 60 }, (_, i) => ({
  at: i * 1000,
  speedAt: i * 1000,
  inclineAt: i * 1000,
  speedKmh: 5,
  inclinationPercent: 1,
  heartRateBpm: 125,
  heartRateSource: 'strap',
  energyKcal: null,
  distanceM: null,
}));
const zone = { low: 117, high: 135 };
const input: ReviewInput = {
  workout: newWorkout({ age: 40, weightKg: 78, heightCm: 175 }, 'ble', plan, { rest: null, max: 180, maxSource: 'idade' }),
  index: 1,
  left: 200,
  load: { stage: plan.stages[1], easy: false, reached: true, secondsAtLoad: 160 },
  features: pulseFeatures(pulseWindow(samples, 0, 59_000), zone)!,
  live: { bpm: 125, rise: 0 },
  samples,
  now: 59_000,
  allowed: ['manter', 'reduzir'],
  maxRaiseBpm: 0,
  sinceRelief: null,
};
const reply = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: {} }),
});
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue('sk-test-0123456789abcdef');
});
afterEach(() => {
  jest.useRealTimers();
});

it('sem chave a revisão falha na hora, sem rede e sem encher o diário', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  await expect(reviewLoad(input)).rejects.toThrow('Configure a chave DeepSeek em Perfil.');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(saveCall).not.toHaveBeenCalled();
});

it('a leitura da chave conta nos 12 s da revisão: uma que não volta não prende a chamada', async () => {
  jest.useFakeTimers();
  jest.mocked(SecureStore.getItemAsync).mockReturnValue(new Promise(() => {}));
  const call = reviewLoad(input);
  const failed = expect(call).rejects.toThrow('A chave DeepSeek não pôde ser lida a tempo.');
  await jest.advanceTimersByTimeAsync(12_000);
  await failed;
  expect(fetchMock).not.toHaveBeenCalled();
  expect(saveCall).not.toHaveBeenCalled();
});

it('a revisão vai com esforço baixo e desiste em 12 s, sem nova tentativa', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    (_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const call = reviewLoad(input);
  const failed = expect(call).rejects.toThrow('Falha de conexão com a DeepSeek. Tente novamente.');
  await jest.advanceTimersByTimeAsync(11_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(saveCall).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await failed;
  // Nada de nova tentativa: a revisão seguinte já vem com leituras novas.
  await jest.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: 'low' });
  expect(saveCall).toHaveBeenCalledTimes(1);
  expect(saveCall).toHaveBeenCalledWith('review', expect.objectContaining({ ok: false, attempt: 1, effort: 'low', version: '8' }));
});

it('uma revisão cancelada fica no diário como cancelada, e não como falha de conexão', async () => {
  fetchMock.mockImplementation(
    (_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const abort = new AbortController();
  const call = reviewLoad(input, { signal: abort.signal });
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  await expect(call).rejects.toThrow('Chamada cancelada.');
  expect(saveCall).toHaveBeenCalledWith('review', expect.objectContaining({ ok: false, error: 'Chamada cancelada.' }));
});

it('a resposta da revisão é validada, e uma inválida também não é repetida', async () => {
  fetchMock.mockResolvedValueOnce(reply('{"reason": "125 BPM, 10 abaixo do teto", "decision": "manter", "bpm": 0}'));
  await expect(reviewLoad(input)).resolves.toEqual({ decision: 'manter', bpm: 0, reason: '125 BPM, 10 abaixo do teto' });
  // "aumentar" não está entre as decisões aceitas agora.
  fetchMock.mockResolvedValueOnce(reply('{"reason": "longe do teto", "decision": "aumentar", "bpm": 4}'));
  await expect(reviewLoad(input)).rejects.toThrow('Resposta de ajuste inválida.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(saveCall).toHaveBeenNthCalledWith(1, 'review', expect.objectContaining({ ok: true }));
  expect(saveCall).toHaveBeenNthCalledWith(2, 'review', expect.objectContaining({ ok: false }));
});
