import { normalizeUuid } from '@/ftms';

import { encodeFit, FakeXossStrap, FACTORY_PROFILE, fitName } from '../__fakes__/fake-xoss-strap';
import { LATE_REPLY_WINDOW_MS, XossBusyError, XossClient, XossTimeoutError, WRITE_STALL_MS } from '../client';
import { decodeFit } from '../fit';
import { XOSS } from '../frames';
import { CAN } from '../ymodem';

beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 22, 21, 0, 0) });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function flush(ms = 0): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Espera uma promise andando o relógio simulado. */
async function settled<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
  let done = false;
  let value!: T;
  let error: unknown = null;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      error = e;
    },
  );
  for (let elapsed = 0; elapsed <= ms && !done; elapsed += 10) await flush(10);
  if (!done) throw new Error('não terminou no tempo simulado');
  if (error) throw error;
  return value;
}

async function attach(strap = new FakeXossStrap()) {
  const client = await settled(XossClient.attach(strap, { now: Date.now }));
  return { strap, client: client! };
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const asText = (bytes: Uint8Array | null) => (bytes ? String.fromCharCode(...bytes) : null);

describe('anexar', () => {
  it('confere o serviço e o modelo, assina controle e dados e sonda com FF 00', async () => {
    const { strap, client } = await attach();

    expect(client).not.toBeNull();
    expect(client.model).toBe('X2PRO');
    expect(strap.subscribed(XOSS.control)).toBe(true);
    expect(strap.subscribed(XOSS.tx)).toBe(true);
    expect(strap.commands).toEqual(['ff 00']);
  });

  it('sem o serviço 6e400001, com outro modelo ou sem escrita: null, sem escrever nada', async () => {
    const without = new FakeXossStrap();
    without.xossService = false;
    expect(await settled(XossClient.attach(without, { now: Date.now }))).toBeNull();

    const other = new FakeXossStrap();
    other.model = 'X2';
    expect(await settled(XossClient.attach(other, { now: Date.now }))).toBeNull();
    expect(other.writes).toEqual([]);

    const readOnly = new FakeXossStrap();
    Object.defineProperty(readOnly, 'writer', { value: undefined });
    expect(await settled(XossClient.attach(readOnly, { now: Date.now }))).toBeNull();
  });

  it('sonda sem resposta: null e as assinaturas desfeitas', async () => {
    const strap = new FakeXossStrap();
    strap.faults.silent.add(0xff);
    expect(await settled(XossClient.attach(strap, { now: Date.now }))).toBeNull();
    expect(strap.subscribed(XOSS.control)).toBe(false);
    expect(strap.subscribed(XOSS.tx)).toBe(false);
  });
});

describe('comandos', () => {
  it('passos: liga, lê cadência e total com a hora da resposta', async () => {
    const { strap, client } = await attach();
    await settled(client.setSteps(true));
    strap.spm = 112;
    strap.steps = 345;

    const before = Date.now();
    const steps = await settled(client.steps());
    expect(steps).toMatchObject({ on: true, spm: 112, steps: 345 });
    expect(steps.at).toBeGreaterThanOrEqual(before);
    expect(steps.at).toBeLessThanOrEqual(Date.now());
    expect(strap.commands.slice(1)).toEqual(['72 01 00 00 00 00 00', '72 00']);
  });

  it('alerta: grava e confere por leitura', async () => {
    const { strap, client } = await attach();
    expect(await settled(client.setAlert(170))).toBe(true);
    expect(strap.alert).toBe(170);
    expect(await settled(client.alert())).toBe(170);
    expect(await settled(client.setAlert(null))).toBe(true);
    expect(strap.alert).toBe(0);
    expect(strap.commands.slice(1)).toEqual(['71 01 aa', '71 00 00', '71 00 00', '71 01 00', '71 00 00']);
  });

  it('relógio, espaço, gravação e modo', async () => {
    const { strap, client } = await attach();
    await settled(client.setClock(1795389520));
    expect(strap.clock).toBe(1795389520);
    expect(await settled(client.space())).toEqual({ freeKb: 970, totalKb: 972 });
    expect(await settled(client.recordMode())).toBe('manual');
    expect(await settled(client.recording())).toBe(false);
    await settled(client.startRecording());
    expect(await settled(client.recording())).toBe(true);
    await settled(client.stopRecording());
    expect(await settled(client.recording())).toBe(false);
  });

  it('comando sem resposta estoura em 1,5 s, e o canal segue livre', async () => {
    const { strap, client } = await attach();
    strap.faults.silent.add(0x09);
    const pending = client.space().catch((error: unknown) => error);
    await flush(1499);
    expect(client.busy).toBe(true);
    await flush(1);
    expect(await pending).toBeInstanceOf(XossTimeoutError);
    expect(client.busy).toBe(false);
    expect(await settled(client.recording())).toBe(false);
  });

  it('uma resposta de outro código, ou com XOR errado, não vale', async () => {
    const { strap, client } = await attach();
    strap.faults.silent.add(0x75);
    const pending = client.recording().catch((error: unknown) => error);
    // Uma resposta velha de passos e uma de gravação corrompida.
    const handler = (strap as unknown as { handlers: Map<string, (d: Uint8Array) => void> }).handlers.get(
      normalizeUuid(XOSS.control),
    )!;
    handler(Uint8Array.of(0x72, 0, 0, 0, 0, 0, 0, 0x72));
    handler(Uint8Array.of(0x75, 0x01, 0x00));
    await flush(1500);
    expect(await pending).toBeInstanceOf(XossTimeoutError);
  });

  it('a resposta atrasada de um comando que estourou o prazo não casa com o seguinte', async () => {
    const { strap, client } = await attach();
    // A resposta do primeiro `75 00` (gravando) chega 100 ms depois do prazo.
    strap.recording = true;
    strap.faults.replyDelay.set('75 00', 1600);
    const first = client.recording().catch((error: unknown) => error);
    await flush(1500);
    expect(await first).toBeInstanceOf(XossTimeoutError);
    // O seguinte é pedido na hora; a cinta já não grava e responde rápido.
    strap.faults.replyDelay.delete('75 00');
    strap.recording = false;
    const second = client.recording();
    await flush(50);
    // Ainda no silêncio: o pedido nem saiu.
    expect(strap.commands.filter((c) => c === '75 00')).toHaveLength(1);
    expect(await settled(second)).toBe(false);
    expect(strap.commands.filter((c) => c === '75 00')).toHaveLength(2);
    expect(LATE_REPLY_WINDOW_MS).toBe(300);
  });

  it('um comando por vez: o segundo só vai depois da resposta do primeiro', async () => {
    const { strap, client } = await attach();
    strap.latencyMs = 100;
    const first = client.space();
    const second = client.recording();
    await flush(50);
    expect(strap.commands.slice(1)).toEqual(['09 00']);
    await settled(first);
    await settled(second);
    expect(strap.commands.slice(1)).toEqual(['09 00', '75 00']);
  });

  it('toda escrita tem até 20 bytes: controle com resposta, dados sem', async () => {
    const { strap, client } = await attach();
    await settled(client.fetch('user_profile.json'));
    await settled(client.send('user_profile.json', ascii(FACTORY_PROFILE)));
    expect(strap.writes.length).toBeGreaterThan(10);
    for (const write of strap.writes) {
      expect(write.bytes.length).toBeLessThanOrEqual(20);
      expect(write.mode).toBe(write.characteristic === normalizeUuid(XOSS.control) ? 'response' : 'noResponse');
    }
  });
});

describe('arquivos', () => {
  it('baixa o perfil', async () => {
    const { client } = await attach();
    expect(asText(await settled(client.fetch('user_profile.json')))).toBe(FACTORY_PROFILE);
  });

  it('baixa a lista e um FIT de vários blocos', async () => {
    const { strap, client } = await attach();
    const start = Date.UTC(2026, 10, 22, 23, 18, 40);
    const fit = encodeFit(start, Array.from({ length: 79 }, (_, i) => ({ bpm: 70 + (i % 30), cadence: 76 })));
    strap.files.set('20261122231840.fit', fit);

    const files = await settled(client.listFiles());
    expect(files).toEqual([{ name: '20261122231840.fit', at: start, size: fit.length }]);
    const bytes = await settled(client.fetch('20261122231840.fit'));
    expect(bytes).toEqual(fit);
    expect(decodeFit(bytes!).records).toHaveLength(79);
  });

  it('lista vazia não é erro: é "nada por ora"', async () => {
    const { strap, client } = await attach();
    strap.files.set('20261122231840.fit', encodeFit(0, [{ bpm: 1, cadence: 1 }]));
    strap.faults.emptyList = true;
    expect(await settled(client.listFiles())).toEqual([]);
  });

  it('arquivo que a cinta não tem: null, sem travar o canal', async () => {
    const { client } = await attach();
    expect(await settled(client.fetch('workouts.json'))).toBeNull();
    expect(await settled(client.recording())).toBe(false);
  });

  it.each([
    ['bloco zero repetido', (strap: FakeXossStrap) => (strap.faults.repeatHeader = true)],
    ['bloco de dados repetido (ACK perdido)', (strap: FakeXossStrap) => (strap.faults.repeatBlock = 2)],
    ['bloco com CRC ruim', (strap: FakeXossStrap) => (strap.faults.badCrcBlock = 2)],
  ])('%s: o arquivo chega inteiro', async (_, fault) => {
    const { strap, client } = await attach();
    const fit = encodeFit(Date.UTC(2026, 10, 22), Array.from({ length: 60 }, () => ({ bpm: 100, cadence: 100 })));
    strap.files.set('a.fit', fit);
    fault(strap);
    expect(await settled(client.fetch('a.fit'))).toEqual(fit);
  });

  it('envia o perfil; um ACK perdido faz o bloco ir de novo', async () => {
    const { strap, client } = await attach();
    strap.faults.loseAckBlock = 1;
    const data = ascii(FACTORY_PROFILE.replace('70000', '82500'));
    expect(await settled(client.send('user_profile.json', data))).toBe(true);
    expect(strap.received).toEqual([{ name: 'user_profile.json', data }]);
  });

  it('um pedaço perdido num bloco enviado: a cinta não confirma e o emissor repete o bloco', async () => {
    const { strap, client } = await attach();
    strap.faults.dropChunkOfBlock = 2;
    const data = ascii(FACTORY_PROFILE + ' '.repeat(200));
    expect(await settled(client.send('user_profile.json', data))).toBe(true);
    expect(strap.received).toEqual([{ name: 'user_profile.json', data }]);
    // O bloco 2 foi duas vezes (7 pedaços cada; um deles se perdeu na primeira).
    const firstChunks = strap.writes.filter((w) => w.bytes[0] === 0x01 && w.bytes[1] === 2 && w.bytes[2] === 0xfd);
    expect(firstChunks).toHaveLength(2);
  });

  it('cancelar depois de a cinta aceitar o envio não corta o arquivo: o envio vai até o fim, sem CAN', async () => {
    const { strap, client } = await attach();
    strap.latencyMs = 20;
    const data = ascii(FACTORY_PROFILE + ' '.repeat(300));
    const abort = new AbortController();
    const sending = client.send('user_profile.json', data, abort.signal);
    await flush(100);
    expect(strap.commands.some((c) => c.startsWith('07'))).toBe(true);
    abort.abort();
    expect(await settled(sending)).toBe(true);
    expect(strap.cancelled).toBe(false);
    expect(strap.writes.some((w) => w.bytes.length === 1 && w.bytes[0] === CAN)).toBe(false);
    expect(strap.received).toEqual([{ name: 'user_profile.json', data }]);
  });

  it('cancelar antes de a cinta aceitar o envio não manda nada', async () => {
    const { strap, client } = await attach();
    const abort = new AbortController();
    abort.abort();
    expect(await settled(client.send('user_profile.json', ascii('{}'), abort.signal))).toBe(false);
    expect(strap.commands.some((c) => c.startsWith('07'))).toBe(false);
  });

  it('a cinta que não entende o arquivo responde 15: envio recusado', async () => {
    const { strap, client } = await attach();
    strap.faults.rejectFile = true;
    expect(await settled(client.send('user_profile.json', ascii('{}')))).toBe(false);
  });

  it('a consulta de passos não enfileira durante uma transferência', async () => {
    const { strap, client } = await attach();
    strap.latencyMs = 30;
    strap.files.set('a.fit', encodeFit(0, Array.from({ length: 200 }, () => ({ bpm: 100, cadence: 100 }))));
    const transfer = client.fetch('a.fit');
    await flush(100);
    expect(client.busy).toBe(true);
    // Desiste na hora, sem esperar a vez nem mandar nada.
    await expect(client.steps()).rejects.toBeInstanceOf(XossBusyError);
    expect(await settled(transfer)).not.toBeNull();
    expect(strap.commands.filter((command) => command.startsWith('72'))).toEqual([]);
  });

  it('cancelar manda CAN e devolve null', async () => {
    const { strap, client } = await attach();
    strap.latencyMs = 30;
    strap.files.set('a.fit', encodeFit(0, Array.from({ length: 200 }, () => ({ bpm: 100, cadence: 100 }))));
    const abort = new AbortController();
    const transfer = client.fetch('a.fit', abort.signal);
    await flush(200);
    abort.abort();
    expect(await settled(transfer)).toBeNull();
    expect(strap.cancelled).toBe(true);
    expect(strap.writes.at(-1)!.bytes).toEqual([CAN]);
    // O canal volta a servir.
    expect(await settled(client.recording())).toBe(false);
  });

  it('a queda no meio do download devolve null e fecha o cliente', async () => {
    const { strap, client } = await attach();
    strap.files.set('a.fit', encodeFit(0, Array.from({ length: 200 }, () => ({ bpm: 100, cadence: 100 }))));
    strap.faults.dropAtBlock = 3;
    expect(await settled(client.fetch('a.fit'))).toBeNull();
    expect(client.closed).toBe(true);
    await expect(client.recording()).rejects.toThrow();
  });
});

describe('soltar a cinta', () => {
  it('desfaz o que o app ligou, confere antes e recusa o que estava na fila', async () => {
    const { strap, client } = await attach();
    strap.recording = true;
    strap.alert = 140;
    strap.stepsOn = true;
    strap.latencyMs = 50;
    const inFlight = client.space().catch((error: unknown) => error);
    await flush(10);
    expect(strap.commands.at(-1)).toBe('09 00');
    // Na fila (ainda não saiu), como um passo da reconciliação que viria depois.
    const queued = client.setSteps(true).catch((error: unknown) => error);
    const released = client.release({ recording: {}, alert: { owned: [130, 140], restore: 120 }, stepsOff: true });
    const late = client.recording().catch((error: unknown) => error);
    expect(await settled(released)).toEqual({ recording: true, alert: true, steps: true });
    expect(strap).toMatchObject({ recording: false, alert: 120, stepsOn: false });
    // O que já estava no ar terminou; o da fila e o que veio depois foram recusados.
    expect(await inFlight).toEqual({ freeKb: 970, totalKb: 972 });
    expect(await queued).toBeInstanceOf(Error);
    expect(await late).toBeInstanceOf(Error);
    expect(strap.commands).not.toContain('72 01 00 00 00 00 00');
    expect(client.closed).toBe(true);
  });

  it('não encerra a gravação que já parou nem troca um alerta que a pessoa mudou', async () => {
    const { strap, client } = await attach();
    strap.alert = 160;
    const done = await settled(client.release({ recording: {}, alert: { owned: [140], restore: null } }));
    // Os dois passos ficaram resolvidos: conferidos, não era preciso fazer nada.
    expect(done).toEqual({ recording: true, alert: true, steps: true });
    expect(strap.commands).not.toContain('75 02');
    expect(strap.alert).toBe(160);
    expect(strap.commands.some((c) => c.startsWith('72'))).toBe(false);
  });

  it('com a lista mostrando que a gravação marcada já acabou, não encerra a que está em curso', async () => {
    const { strap, client } = await attach();
    const startedAt = Date.UTC(2026, 10, 22, 18, 0, 0);
    strap.files.set(fitName(startedAt + 3000), encodeFit(startedAt, [{ bpm: 100, cadence: 100 }]));
    strap.recording = true;
    const done = await settled(client.release({ recording: { unlessFileNear: { at: startedAt, toleranceMs: 5000 } } }));
    expect(done.recording).toBe(true);
    expect(strap.recording).toBe(true);
    expect(strap.commands).not.toContain('75 02');
  });

  it('passo sem resposta volta como não resolvido', async () => {
    const { strap, client } = await attach();
    strap.recording = true;
    strap.faults.silent.add(0x75);
    const done = await settled(client.release({ recording: {}, stepsOff: true }));
    expect(done).toEqual({ recording: false, alert: true, steps: true });
    expect(strap.stepsOn).toBe(false);
  });
});

describe('fila nativa presa', () => {
  it('uma escrita que não volta desliga o cliente de vez e avisa', async () => {
    const { strap, client } = await attach();
    const dead = jest.fn();
    client.onDead(dead);
    strap.faults.stuckWrites = true;

    const pending = client.space().catch((error: unknown) => error);
    await flush(1500);
    expect(await pending).toBeInstanceOf(XossTimeoutError);
    expect(dead).not.toHaveBeenCalled();
    await flush(WRITE_STALL_MS);

    expect(dead).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
    await expect(client.recording()).rejects.toThrow();
  });
});
