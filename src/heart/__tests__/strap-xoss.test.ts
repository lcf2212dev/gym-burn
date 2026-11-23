import { FACTORY_PROFILE, FakeXossStrap, FakeXossTransport, encodeFit, fitName } from '../xoss/__fakes__/fake-xoss-strap';
import { HeartStrapSession, type SavedStrap, type StrapWishes } from '../strap-session';
import { XOSS } from '../xoss/frames';

const T0 = Date.UTC(2026, 10, 22, 21, 0, 0);
const STRAP_ID = 'C5:2A:C5:16:AF:97';

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Deixa correr o que está pendente (com as respostas da cinta saindo na hora) e anda `ms` no relógio. */
async function flush(ms = 0): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
  }
  if (ms > 0) {
    await jest.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
  }
}

/** Anda o relógio de 100 em 100 ms, deixando cada resposta e cada prazo correr. */
async function run(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) await flush(100);
}

function makeSession(saved: SavedStrap | null = { id: STRAP_ID, name: 'XOSS_X2P_989171' }) {
  const transport = new FakeXossTransport();
  const stored = { value: saved };
  const session = new HeartStrapSession({
    ble: transport,
    storage: { read: () => stored.value, write: (next) => void (stored.value = next) },
    releaseGraceMs: 15_000,
  });
  return { transport, session, stored };
}

async function connect(transport: FakeXossTransport, session: HeartStrapSession) {
  const release = session.hold();
  await flush();
  transport.see();
  await flush();
  expect(session.getSnapshot().phase).toBe('connected');
  return { strap: transport.last, release };
}

const guided = (id = 'w1', alertBpm: number | null = 140): NonNullable<StrapWishes['workout']> => ({
  id,
  startedAt: Date.now(),
  guided: true,
  alertBpm,
});
const USER = { weightG: 82500, heightMm: 1760, age: 41, maxHr: 179 };

describe('outras cintas e falhas do protocolo', () => {
  it('sem o serviço 6e400001: só o perfil padrão, sem escrever nada', async () => {
    const { transport, session, stored } = makeSession();
    transport.configure = (strap) => (strap.xossService = false);
    const { strap } = await connect(transport, session);
    strap.beat(72);

    expect(session.getSnapshot()).toMatchObject({ bpm: 72, xoss: null, error: null });
    expect(strap.writes).toEqual([]);
    expect(stored.value?.xoss).toBeUndefined();
    expect(session.reading(Date.now())?.cadence).toBeUndefined();
  });

  it('com outro Model Number: só o perfil padrão', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => (strap.model = 'X2');
    const { strap } = await connect(transport, session);
    await flush(2000);

    expect(session.getSnapshot().xoss).toBeNull();
    expect(strap.writes).toEqual([]);
  });

  it('o protocolo que falha não derruba os batimentos nem mostra erro', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => strap.faults.silent.add(0xff);
    const { strap } = await connect(transport, session);
    await run(3000);
    strap.beat(80);

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', bpm: 80, xoss: null, error: null });
    expect(strap.disconnected).toBe(false);
    expect(session.reading(Date.now())).toMatchObject({ bpm: 80 });
  });

  it('a fila nativa presa sem treino desliga o protocolo e desconecta para soltá-la', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    expect(session.getSnapshot().xoss).not.toBeNull();

    strap.faults.stuckWrites = true;
    session.watchCadence();
    await run(6000);

    expect(strap.disconnected).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ xoss: null, error: null });
    // Volta a procurar e conecta de novo.
    transport.see();
    await flush();
    expect(session.getSnapshot().phase).toBe('connected');
    expect(transport.connections).toHaveLength(2);
  });

  it('a fila presa com treino ativo só desliga o protocolo: a cinta fica e os batimentos seguem', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    strap.faults.stuckWrites = true;
    session.want({ workout: guided(), profile: null });
    await run(6000);

    expect(strap.disconnected).toBe(false);
    expect(session.getSnapshot().xoss).toBeNull();
    strap.beat(130);
    expect(session.reading(Date.now())?.bpm).toBe(130);
    expect(session.reading(Date.now())?.cadence).toBeUndefined();
  });
});

describe('bateria e RR', () => {
  it('a bateria segue as notificações da cinta', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    expect(session.getSnapshot().battery).toBe(86);

    strap.batteryLevel(14);
    expect(session.getSnapshot().battery).toBe(14);
  });

  it('os RR ficam num anel numerado, e cada pacote chega a quem pediu os batimentos', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    const beats = jest.fn();
    session.onBeat(beats);

    strap.beat(60, [1000]);
    strap.beat(62, [970, 965]);

    expect(session.reading(Date.now())?.beats).toEqual([
      { seq: 1, rrMs: 1000 },
      { seq: 2, rrMs: 970 },
      { seq: 3, rrMs: 965 },
    ]);
    expect(beats).toHaveBeenLastCalledWith({ at: Date.now(), bpm: 62, rrMs: [970, 965] });
    for (let i = 0; i < 40; i++) strap.beat(60, [1000]);
    const ring = session.reading(Date.now())!.beats!;
    expect(ring).toHaveLength(32);
    expect(ring.at(-1)!.seq).toBe(43);
  });
});

describe('anexar e reconciliar', () => {
  it('na X2 Pro anexa depois de conectar, guarda a marca e, sem treino nem marca, só lê', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();

    expect(stored.value?.xoss).toBe(true);
    // Nada ligado pelo app: passos e alerta não são tocados, só lidos para o diagnóstico.
    expect(strap.commands).toEqual(['ff 00', '71 00 00', '75 00', '09 00']);
    expect(session.getSnapshot().xoss).toMatchObject({
      model: 'X2PRO',
      alertBpm: null,
      recording: false,
      space: { freeKb: 970, totalKb: 972 },
    });
    // Ninguém pediu passos: sem consulta.
    await run(3000);
    expect(strap.commands.filter((c) => c === '72 00')).toEqual([]);
  });

  it('treino guiado: relógio, passos a 1 Hz, gravação e alerta conferido', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    const recorded = jest.fn();
    session.onRecorded(recorded);
    strap.commands.length = 0;

    session.want({ workout: guided('w1', 140), profile: null });
    await flush();

    expect(strap.clock).toBe(Math.floor(T0 / 1000));
    expect(strap.stepsOn).toBe(true);
    expect(strap.recording).toBe(true);
    expect(strap.alert).toBe(140);
    expect(stored.value?.recording).toEqual({ workoutId: 'w1', startedAt: Date.now() });
    expect(recorded).toHaveBeenCalledWith({ workoutId: 'w1', recordedAt: Date.now() });
    expect(session.getSnapshot().xoss).toMatchObject({ recording: true, ownRecording: true, alertBpm: 140 });

    strap.spm = 118;
    strap.steps = 40;
    strap.beat(120);
    await run(1000);
    expect(session.reading(Date.now())?.cadence).toMatchObject({ spm: 118, steps: 40 });
    const before = strap.commands.filter((c) => c === '72 00').length;
    await run(3000);
    expect(strap.commands.filter((c) => c === '72 00').length - before).toBe(3);
  });

  it('três prazos estourados na consulta: recua para 5 s e a cadência vira null', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    strap.spm = 100;
    await run(1500);
    strap.beat(120);
    expect(session.reading(Date.now())?.cadence?.spm).toBe(100);

    strap.faults.silent.add(0x72);
    await run(8000);
    strap.beat(120);
    expect(session.getSnapshot().xoss?.cadence).toBeNull();
    expect(session.reading(Date.now())?.cadence).toBeNull();
    const queries = () => strap.commands.filter((c) => c === '72 00').length;
    const before = queries();
    await run(10_000);
    // A cada 5 s mais o prazo de 1,5 s: no máximo 2 consultas em 10 s.
    expect(queries() - before).toBeLessThanOrEqual(2);

    strap.faults.silent.delete(0x72);
    await run(7000);
    strap.beat(120);
    expect(session.reading(Date.now())?.cadence?.spm).toBe(100);
  });

  it('a cadência velha (mais de 3 s) não vale, mesmo com a consulta parada', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await run(1500);
    // O app em segundo plano: os temporizadores param, mas a hora anda.
    jest.setSystemTime(Date.now() + 3500);
    strap.beat(120);
    expect(session.reading(Date.now())?.cadence).toBeNull();
  });

  it('sem 60 kB livres, ou no modo automático, não grava', async () => {
    for (const setup of [
      (strap: FakeXossStrap) => (strap.freeKb = 59),
      (strap: FakeXossStrap) => (strap.recordMode = 1),
    ]) {
      const { transport, session, stored } = makeSession();
      transport.configure = setup;
      const { strap } = await connect(transport, session);
      await flush();
      session.want({ workout: guided(), profile: null });
      await flush();
      expect(strap.recording).toBe(false);
      expect(stored.value?.recording ?? null).toBeNull();
      expect(strap.alert).toBe(140);
    }
  });

  it('treino livre: passos sim, gravação e alerta não', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: { id: 'w1', startedAt: T0, guided: false, alertBpm: null }, profile: null });
    await flush();
    expect(strap.stepsOn).toBe(true);
    expect(strap.recording).toBe(false);
    expect(strap.alert).toBe(0);
  });

  it('o fim do treino desliga passos e alerta e encerra a gravação do app', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await run(60_000);
    expect(strap.recording).toBe(true);

    session.want({ workout: null, profile: null });
    await run(3000);
    expect(strap).toMatchObject({ stepsOn: false, alert: 0, recording: false });
    expect(stored.value?.recording ?? null).toBeNull();
    // A gravação de 60 s virou arquivo.
    expect([...strap.files.keys()]).toContain(fitName(T0));
    const polls = strap.commands.filter((c) => c === '72 00').length;
    await run(3000);
    expect(strap.commands.filter((c) => c === '72 00').length).toBe(polls);
  });

  it('reconecta no meio do treino: a gravação segue, sem outra, e o resto volta ao pedido', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await flush();
    const recordedAt = strap.recordingStartedAt;

    // A cinta reinicia o que não grava na memória (passos e alerta) e o link cai.
    strap.drop();
    await flush();
    transport.configure = (next) => {
      next.recording = true;
      next.recordingStartedAt = recordedAt;
    };
    transport.see();
    await flush();
    const again = transport.last;
    expect(again).not.toBe(strap);
    expect(again.commands).not.toContain('75 01');
    expect(again.commands).not.toContain('75 02');
    expect(again).toMatchObject({ stepsOn: true, alert: 140, recording: true });
    expect(session.getSnapshot().xoss).toMatchObject({ recording: true, ownRecording: true });
  });

  it('depois de o app ter sido morto: gravação, alerta e passos órfãos do app são desfeitos', async () => {
    const { transport, session, stored } = makeSession({
      id: STRAP_ID,
      name: 'XOSS_X2P_989171',
      xoss: true,
      recording: { workoutId: 'morto', startedAt: T0 - 120_000 },
      alert: { workoutId: 'morto', previous: null, owned: [150] },
      steps: { since: T0 - 120_000 },
    });
    transport.configure = (strap) => {
      strap.recording = true;
      strap.recordingStartedAt = T0 - 120_000;
      strap.alert = 150;
      strap.stepsOn = true;
    };
    const { strap } = await connect(transport, session);
    await run(3000);

    expect(strap).toMatchObject({ recording: false, alert: 0, stepsOn: false });
    expect(stored.value).toMatchObject({ recording: null, alert: null, steps: null });
    expect(strap.files.has(fitName(T0 - 120_000))).toBe(true);
  });

  it('a resposta do início da gravação que se perde não deixa a gravação sem dono', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    const recorded = jest.fn();
    session.onRecorded(recorded);
    strap.faults.lostReplies.add('75 01');
    session.want({ workout: guided(), profile: null });
    await run(3000);
    // A cinta gravou; o app não soube na hora, mas a marca já estava lá.
    expect(strap.recording).toBe(true);
    expect(stored.value?.recording).toMatchObject({ workoutId: 'w1' });
    expect(strap.commands.filter((c) => c === '75 01')).toHaveLength(1);
    // A volta seguinte acha a gravação do app e avisa o treino do horário.
    await run(11_000);
    expect(recorded).toHaveBeenCalledWith({ workoutId: 'w1', recordedAt: stored.value!.recording!.startedAt });
    expect(strap.commands.filter((c) => c === '75 01')).toHaveLength(1);

    session.want({ workout: null, profile: null });
    await run(3000);
    expect(strap.recording).toBe(false);
    expect(stored.value?.recording ?? null).toBeNull();
  });

  it('o início da gravação que não pega tira a marca, sem avisar o treino', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    const recorded = jest.fn();
    session.onRecorded(recorded);
    strap.faults.refuseRecording = true;
    session.want({ workout: guided(), profile: null });
    await flush();
    expect(strap.commands).toContain('75 01');
    expect(stored.value?.recording ?? null).toBeNull();
    expect(recorded).not.toHaveBeenCalled();
    expect(strap.alert).toBe(140);
  });

  it('um prazo estourado na consulta da gravação não tira a gravação da conexão', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    strap.faults.silent.add(0x75);
    session.want({ workout: guided(), profile: null });
    await run(2000);
    strap.faults.silent.delete(0x75);
    await run(11_000);
    expect(strap.recording).toBe(true);
  });

  it('uma escrita recusada pelo rádio não para a consulta de passos', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await run(1500);
    strap.faults.rejectCommand = '72 00';
    await run(1500);
    const before = strap.commands.filter((c) => c === '72 00').length;
    strap.spm = 90;
    await run(3000);
    expect(strap.commands.filter((c) => c === '72 00').length - before).toBeGreaterThanOrEqual(2);
    strap.beat(120);
    expect(session.reading(Date.now())?.cadence?.spm).toBe(90);
  });

  it('esquecer a cinta encerra antes a gravação do app', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await run(1000);
    expect(strap.recording).toBe(true);

    session.actions.forget();
    await run(1000);
    expect(strap.recording).toBe(false);
    expect(strap.disconnected).toBe(true);
    expect(stored.value).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ saved: null, phase: 'idle', xoss: null });
  });

  it('uma gravação que não é do app não é tocada, nem com treino guiado', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => {
      strap.recording = true;
      strap.recordingStartedAt = T0 - 60_000;
    };
    const recorded = jest.fn();
    session.onRecorded(recorded);
    const { strap } = await connect(transport, session);
    await flush();
    expect(strap.recording).toBe(true);
    expect(session.getSnapshot().xoss).toMatchObject({ recording: true, ownRecording: false });

    session.want({ workout: guided(), profile: null });
    await flush();
    session.want({ workout: null, profile: null });
    await flush();

    expect(strap.recording).toBe(true);
    expect(strap.recordingStartedAt).toBe(T0 - 60_000);
    expect(strap.commands).not.toContain('75 01');
    expect(strap.commands).not.toContain('75 02');
    expect(recorded).not.toHaveBeenCalled();
  });

  it('pedidos iguais não repetem comandos', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided(), profile: null });
    await flush();
    const count = strap.commands.filter((c) => c !== '72 00').length;
    session.want({ workout: { ...guided(), startedAt: Date.now() }, profile: null });
    await flush();
    expect(strap.commands.filter((c) => c !== '72 00').length).toBe(count);
  });
});

describe('tarefas ociosas: FIT e perfil', () => {
  it('perfil igual: lê e não envia', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) =>
      strap.files.set(
        'user_profile.json',
        Uint8Array.from(
          FACTORY_PROFILE.replace('"weight":70000', '"weight":82500')
            .replace('"height":1700', '"height":1760')
            .replace('"MAXHR":200', '"MAXHR":179')
            .replace('"birthday":441763200', `"birthday":${Date.UTC(1985, 0, 1) / 1000}`),
          (c) => c.charCodeAt(0),
        ),
      );
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(2000);

    expect(strap.commands).toContain('05 75 73 65 72 5f 70 72 6f 66 69 6c 65 2e 6a 73 6f 6e');
    expect(strap.received).toEqual([]);
    expect(session.getSnapshot().xoss?.profileSynced).toBe(true);
  });

  it('perfil diferente: corrige, envia, relê e confere pelos valores (a cinta reescreve o arquivo)', async () => {
    const { transport, session } = makeSession();
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(4000);

    expect(strap.received).toHaveLength(1);
    const sent = String.fromCharCode(...strap.received[0].data);
    expect(sent).toContain('"weight":82500');
    expect(sent).toContain('"height":1760');
    expect(sent).toContain('"MAXHR":179');
    expect(sent).toContain('"LTHR":170');
    expect(sent).toContain('"gender":1');
    expect(String.fromCharCode(...strap.files.get('user_profile.json')!)).toContain('"sn": "989171"');
    expect(session.getSnapshot().xoss?.profileSynced).toBe(true);

    // Uma tentativa por conexão: um pedido novo não envia de novo nesta conexão.
    session.want({ workout: null, profile: { ...USER, maxHr: 180 } });
    await run(4000);
    expect(strap.received).toHaveLength(1);
  });

  it('perfil com chave faltando: não envia', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) =>
      strap.files.set(
        'user_profile.json',
        Uint8Array.from(FACTORY_PROFILE.replace('"MAXHR":200,', ''), (c) => c.charCodeAt(0)),
      );
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(3000);

    expect(strap.received).toEqual([]);
    expect(strap.commands.some((c) => c.startsWith('07'))).toBe(false);
  });

  /** Uma cinta com o FIT de uma gravação começada em `startedAt`. */
  const withFit = (startedAt: number) => (strap: FakeXossStrap) =>
    strap.files.set(
      fitName(startedAt),
      encodeFit(startedAt, Array.from({ length: 90 }, () => ({ bpm: 125, cadence: 112 }))),
    );

  it('baixa o FIT antes de mexer no perfil, e entrega os registros do treino', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = withFit(recordedAt);
    const jobs = jest.fn();
    session.onBackfill(jobs);
    session.want({ workout: null, profile: USER, backfill: [{ workoutId: 'w0', recordedAt: recordedAt + 2000 }] });
    const { strap } = await connect(transport, session);
    await run(5000);

    const files = strap.commands.filter((c) => c.startsWith('05') || c.startsWith('07'));
    const name = (text: string) => ['05', ...Array.from(text, (c) => c.charCodeAt(0).toString(16))].join(' ');
    expect(files).toEqual([
      name('filelist.txt'),
      name(fitName(recordedAt)),
      name('user_profile.json'),
      expect.stringMatching(/^07 /),
      name('user_profile.json'),
    ]);
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs.mock.calls[0][0]).toMatchObject({ workoutId: 'w0', file: fitName(recordedAt) });
    expect(jobs.mock.calls[0][0].records).toHaveLength(90);
  });

  it('arquivo fora dos ±5 s não casa', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = withFit(recordedAt);
    const jobs = jest.fn();
    session.onBackfill(jobs);
    session.want({ workout: null, profile: null, backfill: [{ workoutId: 'w0', recordedAt: recordedAt + 6000 }] });
    const { strap } = await connect(transport, session);
    await run(3000);
    // A lista foi lida (o arquivo existe), mas nada casou.
    expect(strap.commands.filter((c) => c.startsWith('05'))).toHaveLength(1);
    expect(jobs).not.toHaveBeenCalled();
  });

  it('lista vazia não é erro: o perfil segue, e a próxima conexão tenta de novo', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = (strap) => {
      withFit(recordedAt)(strap);
      strap.faults.emptyList = true;
    };
    const jobs = jest.fn();
    session.onBackfill(jobs);
    session.want({ workout: null, profile: USER, backfill: [{ workoutId: 'w0', recordedAt }] });
    const { strap, release } = await connect(transport, session);
    await run(4000);
    expect(jobs).not.toHaveBeenCalled();
    expect(strap.received).toHaveLength(1);
    expect(session.getSnapshot().error).toBeNull();

    // Outra conexão: a lista voltou.
    release();
    await run(16_000);
    transport.configure = withFit(recordedAt);
    await connect(transport, session);
    await run(3000);
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it('um treino que começa cancela a transferência em curso', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => {
      strap.latencyMs = 20;
      strap.files.set(
        'user_profile.json',
        Uint8Array.from(FACTORY_PROFILE + ' '.repeat(3000), (c) => c.charCodeAt(0)),
      );
    };
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(500);
    expect(session.getSnapshot().xoss?.transferring).toBe(true);

    session.want({ workout: guided(), profile: USER });
    await run(3000);
    expect(strap.cancelled).toBe(true);
    expect(strap.received).toEqual([]);
    expect(strap).toMatchObject({ stepsOn: true, recording: true, alert: 140 });
  });

  it('a consulta de passos não enfileira durante a transferência ociosa', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => {
      strap.latencyMs = 20;
      strap.files.set(
        'user_profile.json',
        Uint8Array.from(FACTORY_PROFILE + ' '.repeat(12_000), (c) => c.charCodeAt(0)),
      );
    };
    // A tela da cinta aberta: a consulta a 1 Hz já roda quando a transferência começa.
    session.watchCadence();
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    const polled = () => strap.commands.filter((c) => c === '72 00').length;
    const downloading = () =>
      strap.commands.some((c) => c.startsWith('05')) && !strap.commands.some((c) => c.startsWith('07'));
    while (!downloading()) await run(100);
    expect(strap.stepsOn).toBe(true);

    // Durante o download do perfil (o canal na mão da transferência), as
    // consultas desistem sem mandar nada nem esperar a vez.
    const during = polled();
    let checks = 0;
    for (; downloading() && checks < 100; checks++) {
      await run(500);
      if (downloading()) expect(polled()).toBe(during);
    }
    expect(checks).toBeGreaterThanOrEqual(3);
    // Acabou a sincronização (download, envio pausado bloco a bloco e releitura):
    // as consultas voltam sozinhas, sem ninguém religar a consulta.
    while (session.getSnapshot().xoss?.transferring) await run(1000);
    expect(strap.received).toHaveLength(1);
    const after = polled();
    await run(3000);
    expect(polled()).toBeGreaterThan(after);
  });
});

describe('donos: o app só desfaz o que ligou', () => {
  it('alerta e passos ligados por outro ficam como estavam; o alerta do treino volta ao valor anterior', async () => {
    const { transport, session, stored } = makeSession();
    transport.configure = (strap) => {
      strap.alert = 150;
      strap.stepsOn = true;
    };
    const { strap } = await connect(transport, session);
    await flush();
    // Sem treino e sem marca: nada muda.
    expect(strap).toMatchObject({ alert: 150, stepsOn: true });
    expect(strap.commands.some((c) => c.startsWith('71 01') || c.startsWith('72 00 00'))).toBe(false);

    // Treino livre: não mexe no alerta.
    session.want({ workout: { id: 'livre', startedAt: T0, guided: false, alertBpm: null }, profile: null });
    await flush();
    expect(strap.alert).toBe(150);
    session.want({ workout: null, profile: null });
    await run(3000);

    // Treino guiado: o alerta do treino, guardando o que a pessoa tinha.
    session.want({ workout: guided('w1', 140), profile: null });
    await flush();
    expect(strap.alert).toBe(140);
    expect(stored.value?.alert).toEqual({ workoutId: 'w1', previous: 150, owned: [140] });
    // Os passos já estavam ligados: não são do app.
    expect(stored.value?.steps ?? null).toBeNull();

    session.want({ workout: null, profile: null });
    await run(3000);
    expect(strap).toMatchObject({ alert: 150, stepsOn: true });
    expect(stored.value?.alert ?? null).toBeNull();
  });

  it('passos que o app ligou são desligados no fim; um alerta que a pessoa mudou no meio fica', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided('w1', 140), profile: null });
    await flush();
    expect(stored.value?.steps).toEqual({ since: expect.any(Number) });
    expect(strap.stepsOn).toBe(true);
    // A pessoa mudou o alerta pelo app da XOSS durante o treino.
    strap.alert = 170;

    session.want({ workout: null, profile: null });
    await run(3000);
    expect(strap).toMatchObject({ stepsOn: false, alert: 170 });
    expect(stored.value).toMatchObject({ steps: null, alert: null });
  });

  it('esquecer a cinta no meio do treino desfaz gravação, alerta e passos do app', async () => {
    const { transport, session, stored } = makeSession();
    transport.configure = (strap) => (strap.alert = 120);
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided('w1', 140), profile: null });
    await run(1000);
    expect(strap).toMatchObject({ recording: true, alert: 140, stepsOn: true });

    session.actions.forget();
    await run(2000);
    expect(strap).toMatchObject({ recording: false, alert: 120, stepsOn: false });
    expect(strap.disconnected).toBe(true);
    expect(stored.value).toBeNull();
    // A reconciliação que ainda corria não religou nada depois.
    await run(15_000);
    expect(strap).toMatchObject({ recording: false, alert: 120, stepsOn: false });
  });

  it('parear de novo a mesma cinta: as marcas só somem quando o release confirma cada passo', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided('w1', 140), profile: null });
    await run(1000);
    expect(stored.value).toMatchObject({ recording: { workoutId: 'w1' }, alert: { owned: [140] }, steps: {} });
    // A cinta vai responder ao alerta, mas não à gravação.
    strap.latencyMs = 50;
    strap.faults.silent.add(0x75);
    session.actions.startPairing();
    await flush();
    transport.see(STRAP_ID);
    // A nova conexão fica presa, para ver as marcas logo depois do release.
    const radioConnect = transport.connect.bind(transport);
    let open!: () => void;
    const gate = new Promise<void>((done) => (open = done));
    let attempts = 0;
    transport.connect = async (id) => {
      attempts += 1;
      await gate;
      return radioConnect(id);
    };
    session.actions.choose(STRAP_ID);
    // Logo depois da escolha, as marcas continuam lá.
    expect(stored.value).toMatchObject({ recording: { workoutId: 'w1' }, alert: { owned: [140] } });
    expect(attempts).toBe(0);
    await run(6000);
    // O alerta e os passos foram desfeitos e confirmados; a gravação ficou sem resposta e a marca dela fica.
    expect(strap).toMatchObject({ alert: 0, stepsOn: false });
    expect(stored.value?.alert ?? null).toBeNull();
    expect(stored.value?.steps ?? null).toBeNull();
    expect(stored.value?.recording).toMatchObject({ workoutId: 'w1' });
    // Só depois de a conexão velha cair a sessão tenta conectar de novo.
    expect(strap.disconnected).toBe(true);
    expect(attempts).toBe(1);
    open();
    await run(2000);
    expect(session.getSnapshot().phase).toBe('connected');
    expect(transport.connections.length).toBe(2);
  });

  it('trocar de cinta também desfaz o que o app ligou na anterior', async () => {
    const { transport, session } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided('w1', 140), profile: null });
    await run(1000);
    session.actions.startPairing();
    await flush();
    transport.see('AA:BB:CC:DD:EE:FF');
    session.actions.choose('AA:BB:CC:DD:EE:FF');
    await run(2000);
    expect(strap).toMatchObject({ recording: false, alert: 0, stepsOn: false });
    expect(strap.disconnected).toBe(true);
  });

  /** Uma cinta salva com a marca de uma gravação começada em `startedAt` por um treino que já não está ativo. */
  const orphan = (startedAt: number) =>
    makeSession({ id: STRAP_ID, name: 'XOSS_X2P_989171', xoss: true, recording: { workoutId: 'velho', startedAt } });

  it('um treino com pausa longa (bem além da duração do plano): a gravação é encerrada no fim e o seguinte grava', async () => {
    const { transport, session, stored } = makeSession();
    const { strap } = await connect(transport, session);
    await flush();
    session.want({ workout: guided('w1', 140), profile: null });
    await run(1000);
    expect(strap.recording).toBe(true);
    // Um treino de 30 min com 2 h de pausa no meio: o treino segue ativo no app.
    jest.setSystemTime(Date.now() + 2 * 3_600_000);
    await run(1000);
    expect(stored.value?.recording).toMatchObject({ workoutId: 'w1' });

    session.want({ workout: null, profile: null });
    await run(5000);
    expect(strap.recording).toBe(false);
    expect(strap.commands.filter((c) => c === '75 02')).toHaveLength(1);

    session.want({ workout: guided('w2', 140), profile: null });
    await run(3000);
    expect(strap.recording).toBe(true);
    expect(stored.value?.recording).toMatchObject({ workoutId: 'w2' });
  });

  it('app morto e reaberto 4 h depois: a gravação do app é encerrada', async () => {
    const { transport, session, stored } = orphan(T0 - 4 * 3_600_000);
    transport.configure = (strap) => {
      strap.recording = true;
      strap.recordingStartedAt = T0 - 4 * 3_600_000;
    };
    const { strap } = await connect(transport, session);
    await run(5000);
    expect(strap.recording).toBe(false);
    expect(strap.commands).toContain('75 02');
    expect(stored.value?.recording ?? null).toBeNull();
  });

  it('marca com mais de 24 h: é descartada sem encerrar a gravação em curso', async () => {
    const recorded = jest.fn();
    const { transport, session, stored } = orphan(T0 - 25 * 3_600_000);
    session.onRecorded(recorded);
    transport.configure = (strap) => {
      strap.recording = true;
      strap.recordingStartedAt = T0 - 10 * 60_000;
    };
    const { strap } = await connect(transport, session);
    await run(5000);
    expect(strap.recording).toBe(true);
    expect(strap.commands).not.toContain('75 02');
    expect(stored.value?.recording ?? null).toBeNull();
    // O treino dono ainda fica sabendo do horário da gravação dele.
    expect(recorded).toHaveBeenCalledWith({ workoutId: 'velho', recordedAt: T0 - 25 * 3_600_000 });
  });

  it('a gravação do app já virou arquivo e há outra em curso: não encerra, e avisa o treino dono', async () => {
    const startedAt = T0 - 3 * 3_600_000;
    const recorded = jest.fn();
    const { transport, session, stored } = orphan(startedAt);
    session.onRecorded(recorded);
    transport.configure = (strap) => {
      strap.files.set(fitName(startedAt + 2000), encodeFit(startedAt, [{ bpm: 100, cadence: 100 }]));
      strap.recording = true;
      strap.recordingStartedAt = T0 - 20 * 60_000;
    };
    const { strap } = await connect(transport, session);
    await run(5000);
    expect(strap.recording).toBe(true);
    expect(strap.commands).not.toContain('75 02');
    expect(stored.value?.recording ?? null).toBeNull();
    expect(recorded).toHaveBeenCalledWith({ workoutId: 'velho', recordedAt: startedAt });
  });

  it('com a lista vazia (não prova nada), a gravação da marca é encerrada', async () => {
    const startedAt = T0 - 3 * 3_600_000;
    const { transport, session } = orphan(startedAt);
    transport.configure = (strap) => {
      strap.files.set(fitName(startedAt), encodeFit(startedAt, [{ bpm: 100, cadence: 100 }]));
      strap.faults.emptyList = true;
      strap.recording = true;
      strap.recordingStartedAt = startedAt;
    };
    const { strap } = await connect(transport, session);
    await run(5000);
    expect(strap.recording).toBe(false);
    expect(strap.commands).toContain('75 02');
  });

  it('a órfã que já virou arquivo, achada no começo de um treino guiado: o app não a encerra nem grava por cima', async () => {
    const startedAt = T0 - 3 * 3_600_000;
    const { transport, session } = orphan(startedAt);
    transport.configure = (strap) => {
      strap.files.set(fitName(startedAt), encodeFit(startedAt, [{ bpm: 100, cadence: 100 }]));
      strap.recording = true;
      strap.recordingStartedAt = T0 - 20 * 60_000;
    };
    session.want({ workout: guided('w1', 140), profile: null });
    const { strap } = await connect(transport, session);
    await run(5000);
    expect(strap.commands).not.toContain('75 02');
    expect(strap.commands).not.toContain('75 01');
    expect(session.getSnapshot().xoss).toMatchObject({ recording: true, ownRecording: false });
  });

  it('o alerta do app fica marcado mesmo quando a reprogramação falha, e no fim volta ao da pessoa', async () => {
    // O app morreu com o alerta 140 do treino A; a pessoa tinha 120.
    const { transport, session, stored } = makeSession({
      id: STRAP_ID,
      name: 'XOSS_X2P_989171',
      xoss: true,
      alert: { workoutId: 'A', previous: 120, owned: [140] },
    });
    transport.configure = (strap) => {
      strap.alert = 140;
      // A cinta responde, mas não troca o alerta: a leitura de volta não bate.
      strap.faults.frozenAlert = true;
    };
    session.want({ workout: guided('B', 150), profile: null });
    const { strap } = await connect(transport, session);
    await run(3000);
    expect(strap.alert).toBe(140);
    expect(stored.value?.alert).toEqual({ workoutId: 'B', previous: 120, owned: [140, 150] });

    // A falha agenda nova volta, como as outras: com a cinta boa de novo, o 150 entra.
    strap.faults.frozenAlert = false;
    await run(11_000);
    expect(strap.alert).toBe(150);

    // E se no fim a cinta estiver em qualquer valor do app (aqui, o 140 velho), volta ao da pessoa.
    strap.alert = 140;
    session.want({ workout: null, profile: null });
    await run(5000);
    expect(strap.alert).toBe(120);
    expect(stored.value?.alert ?? null).toBeNull();
  });

  it('ao encerrar a gravação do app sem treino, o treino dono recebe o horário antes de a marca sumir', async () => {
    const recorded = jest.fn();
    const { transport, session } = makeSession({
      id: STRAP_ID,
      name: 'XOSS_X2P_989171',
      recording: { workoutId: 'morto', startedAt: T0 - 600_000 },
    });
    session.onRecorded(recorded);
    transport.configure = (strap) => {
      strap.recording = true;
      strap.recordingStartedAt = T0 - 600_000;
    };
    await connect(transport, session);
    await run(3000);
    expect(recorded).toHaveBeenCalledWith({ workoutId: 'morto', recordedAt: T0 - 600_000 });
  });

  it('um 75 02 cuja resposta demora: dentro do prazo vale; depois dele, a volta seguinte confere e limpa', async () => {
    for (const delay of [1000, 1700]) {
      const recorded = jest.fn();
      const { transport, session, stored } = makeSession({
        id: STRAP_ID,
        name: 'XOSS_X2P_989171',
        recording: { workoutId: 'w0', startedAt: T0 - 600_000 },
      });
      session.onRecorded(recorded);
      transport.configure = (strap) => {
        strap.recording = true;
        strap.recordingStartedAt = T0 - 600_000;
        strap.faults.replyDelay.set('75 02', delay);
      };
      const { strap } = await connect(transport, session);
      await run(15_000);
      expect(strap.recording).toBe(false);
      expect(stored.value?.recording ?? null).toBeNull();
      expect(recorded).toHaveBeenCalledWith({ workoutId: 'w0', recordedAt: T0 - 600_000 });
      expect(session.getSnapshot().error).toBeNull();
      // A resposta atrasada (75 04) não foi lida como o estado da gravação.
      expect(session.getSnapshot().xoss?.recording).toBe(false);
    }
  });
});

describe('tarefas ociosas: envio, lona e descanso', () => {
  it('um treino que começa no meio do envio do perfil não o corta: o envio termina, sem CAN, e o treino vem depois', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => (strap.latencyMs = 20);
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    while (!strap.commands.some((c) => c.startsWith('07'))) await run(20);
    await run(40);

    session.want({ workout: guided(), profile: USER });
    await run(5000);
    expect(strap.cancelled).toBe(false);
    expect(strap.received).toHaveLength(1);
    expect(readName(strap.received[0].data)).toContain('"MAXHR":179');
    expect(strap).toMatchObject({ stepsOn: true, recording: true, alert: 140 });
    // Os passos do treino só foram ligados depois de o envio acabar.
    const sendAt = strap.commands.findIndex((c) => c.startsWith('07'));
    const stepsAt = strap.commands.findIndex((c) => c === '72 01 00 00 00 00 00');
    expect(stepsAt).toBeGreaterThan(sendAt);
  });

  it('com a lona andando o perfil não começa a sincronizar; quando ela para, sincroniza', async () => {
    const { transport, session } = makeSession();
    session.setBeltMoving(true);
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(3000);
    expect(strap.commands.some((c) => c.startsWith('05'))).toBe(false);

    session.setBeltMoving(false);
    await run(4000);
    expect(strap.received).toHaveLength(1);
  });

  it('a cinta solta (rest) no meio de um download espera ele acabar, e o perfil roda depois', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = (strap) => {
      // Um rádio lento: o FIT de ~10 kB leva bem mais que os 15 s de carência.
      strap.latencyMs = 200;
      strap.files.set(
        fitName(recordedAt),
        encodeFit(recordedAt, Array.from({ length: 1500 }, () => ({ bpm: 125, cadence: 112 }))),
      );
    };
    const jobs = jest.fn();
    session.onBackfill(jobs);
    session.want({ workout: null, profile: USER, backfill: [{ workoutId: 'w0', recordedAt }] });
    const { strap, release } = await connect(transport, session);
    while (!strap.commands.includes(fetchCommand(fitName(recordedAt)))) await run(100);

    // A esteira soltou a cinta; o descanso viria 15 s depois, no meio do download.
    release();
    await run(16_000);
    expect(jobs).not.toHaveBeenCalled();
    expect(strap.disconnected).toBe(false);
    for (let i = 0; i < 100 && !strap.disconnected; i++) await run(1000);
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs.mock.calls[0][0].records).toHaveLength(1500);
    // O perfil, que vinha atrás, também rodou antes de soltar.
    expect(strap.received).toHaveLength(1);
    expect(strap.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('idle');
  });

  it('o descanso adiado tem teto de 120 s', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = (strap) => {
      // Um download que não acaba antes do teto: ~70 kB num rádio bem lento (~0,4 s por bloco).
      strap.latencyMs = 400;
      strap.files.set(
        fitName(recordedAt),
        encodeFit(recordedAt, Array.from({ length: 10_000 }, () => ({ bpm: 125, cadence: 112 }))),
      );
    };
    const jobs = jest.fn();
    session.onBackfill(jobs);
    session.want({ workout: null, profile: null, backfill: [{ workoutId: 'w0', recordedAt }] });
    const { strap, release } = await connect(transport, session);
    while (!strap.commands.includes(fetchCommand(fitName(recordedAt)))) await run(100);
    release();
    // 15 s de carência + 120 s de teto.
    await run(15_000 + 119_000);
    expect(strap.disconnected).toBe(false);
    await run(2000);
    expect(strap.disconnected).toBe(true);
    expect(session.getSnapshot().phase).toBe('idle');
    // O download foi cortado pelo teto, não terminou.
    expect(jobs).not.toHaveBeenCalled();
  });

  it('um arquivo que falha duas vezes sai da fila nesta conexão, e o perfil roda', async () => {
    const { transport, session } = makeSession();
    const recordedAt = T0 - 3_600_000;
    transport.configure = (strap) => {
      strap.files.set(fitName(recordedAt), encodeFit(recordedAt, [{ bpm: 100, cadence: 100 }]));
      strap.faults.silentFetch.add(fitName(recordedAt));
    };
    session.want({ workout: null, profile: USER, backfill: [{ workoutId: 'w0', recordedAt }] });
    const { strap } = await connect(transport, session);
    await run(10_000);
    expect(strap.commands.filter((c) => c === fetchCommand(fitName(recordedAt)))).toHaveLength(2);
    expect(strap.received).toHaveLength(1);
    expect(session.getSnapshot().xoss?.lastDownload).toMatchObject({ file: 'user_profile.json', ok: true });
  });

  it('o diagnóstico guarda o tempo e o tamanho do último download', async () => {
    const { transport, session } = makeSession();
    transport.configure = (strap) => (strap.latencyMs = 20);
    session.want({ workout: null, profile: { ...USER, weightG: 70000, heightMm: 1700, maxHr: 200, age: 42 } });
    await connect(transport, session);
    await run(3000);
    const last = session.getSnapshot().xoss?.lastDownload;
    expect(last).toMatchObject({ file: 'user_profile.json', bytes: FACTORY_PROFILE.length, ok: true });
    expect(last!.ms).toBeGreaterThan(0);
  });
});

const readName = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const fetchCommand = (name: string) => ['05', ...Array.from(name, (c) => c.charCodeAt(0).toString(16))].join(' ');

describe('o canal da cinta não usa a escrita fora do protocolo', () => {
  it('toda escrita vai ao serviço 6e400001 e tem até 20 bytes', async () => {
    const { transport, session } = makeSession();
    session.want({ workout: null, profile: USER });
    const { strap } = await connect(transport, session);
    await run(4000);
    session.want({ workout: guided(), profile: USER });
    await run(2000);
    expect(strap.writes.length).toBeGreaterThan(0);
    for (const write of strap.writes) {
      expect([XOSS.control, XOSS.rx]).toContain(write.characteristic);
      expect(write.bytes.length).toBeLessThanOrEqual(20);
    }
  });
});
