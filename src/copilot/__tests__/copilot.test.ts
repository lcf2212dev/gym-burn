import {
  advanceCopilot,
  copilotView,
  createCopilot,
  hasFreshData,
  type CopilotInput,
  type CopilotState,
} from '../copilot';

const NOW = 1_000_000;

function input(overrides: Partial<CopilotInput> = {}): CopilotInput {
  return {
    belt: 'running',
    speedKmh: 0,
    inclinePercent: 0,
    heartRateBpm: 0,
    updatedAt: NOW - 200,
    now: NOW,
    ...overrides,
  };
}

/** Leva o copiloto do estado inicial até o passo pedido, do jeito que a esteira faria. */
function atStart(): { state: CopilotState; input: CopilotInput } {
  let state = createCopilot(NOW);
  const started = input({ speedKmh: 0 });
  state = advanceCopilot(state, started); // waiting -> start
  state = advanceCopilot(state, input({ speedKmh: 0.8, belt: 'running' })); // start -> speedUp
  return { state, input: input({ speedKmh: 0.8 }) };
}

describe('copiloto do treino', () => {
  it('começa esperando os dados e passa a pedir para andar quando eles chegam', () => {
    const state = createCopilot(NOW);
    expect(state.stage).toBe('waiting');
    expect(copilotView(state, input({ updatedAt: null })).message).toContain('Ainda não recebo');

    const afterData = advanceCopilot(state, input());
    expect(afterData.stage).toBe('start');
    expect(copilotView(afterData, input()).message).toContain('começar a andar');
  });

  it('sugere reabrir o app quando os dados somem por muito tempo', () => {
    const state = createCopilot(NOW);
    const veryOld = input({ updatedAt: NOW - 40_000 });
    expect(copilotView(state, veryOld).message).toContain('feche o app e abra de novo');
  });

  it('não avança com dados velhos', () => {
    const state = createCopilot(NOW);
    const stale = input({ updatedAt: NOW - 60_000, speedKmh: 5 });
    expect(hasFreshData(stale)).toBe(false);
    expect(advanceCopilot(state, stale).stage).toBe('waiting');
    expect(copilotView(state, stale).tone).toBe('waiting');
  });

  it('pede para aumentar e depois diminuir a velocidade quando percebe cada passo', () => {
    const { state } = atStart();
    expect(state.stage).toBe('speedUp');

    const faster = advanceCopilot(state, input({ speedKmh: 1.4 }));
    expect(faster.stage).toBe('speedDown');
    expect(copilotView(faster, input({ speedKmh: 1.4 })).message).toContain('diminua a velocidade');

    const slower = advanceCopilot(faster, input({ speedKmh: 0.9 }));
    expect(slower.stage).toBe('inclineUp');
    expect(copilotView(slower, input({ speedKmh: 0.9 })).message).toContain('inclinação');
  });

  it('pede inclinação para cima e para baixo e segue para os batimentos', () => {
    let { state } = atStart();
    state = advanceCopilot(state, input({ speedKmh: 1.4 }));
    state = advanceCopilot(state, input({ speedKmh: 0.9 }));
    expect(state.stage).toBe('inclineUp');

    const up = advanceCopilot(state, input({ speedKmh: 0.9, inclinePercent: 1.5 }));
    expect(up.stage).toBe('inclineDown');

    const down = advanceCopilot(up, input({ speedKmh: 0.9, inclinePercent: 1 }));
    expect(down.stage).toBe('heartRate');
    expect(copilotView(down, input({ speedKmh: 0.9, inclinePercent: 1 })).message).toContain(
      'batimentos',
    );
  });

  it('segue para parar quando os batimentos aparecem e conclui quando a esteira para', () => {
    let state: CopilotState = { ...atStart().state, stage: 'heartRate' };
    const withHeartRate = advanceCopilot(state, input({ speedKmh: 0.9, heartRateBpm: 120 }));
    expect(withHeartRate.stage).toBe('stop');

    const done = advanceCopilot(withHeartRate, input({ speedKmh: 0, belt: 'stopped' }));
    expect(done.stage).toBe('done');
    expect(copilotView(done, input({ speedKmh: 0, belt: 'stopped' })).message).toContain(
      'Tudo certo',
    );
  });

  it('esconde a mensagem de conclusão depois de alguns segundos', () => {
    const done = advanceCopilot(
      { ...atStart().state, stage: 'stop' },
      input({ speedKmh: 0, belt: 'stopped' }),
    );
    expect(copilotView(done, input({ now: NOW + 1_000 })).message).not.toBeNull();
    expect(copilotView(done, input({ now: NOW + 20_000 })).message).toBeNull();
  });

  it('não trava nos batimentos se o sensor não aparecer', () => {
    const state: CopilotState = { ...atStart().state, stage: 'heartRate', since: NOW - 31_000 };
    const skipped = advanceCopilot(state, input({ heartRateBpm: 0 }));
    expect(skipped.stage).toBe('stop');
    expect(skipped.heartRateSkipped).toBe(true);
  });

  it('volta ao começo se a esteira parar no meio do treino', () => {
    const { state } = atStart();
    expect(state.stage).toBe('speedUp');

    const stopped = advanceCopilot(state, input({ speedKmh: 0, belt: 'stopped' }));
    expect(stopped.stage).toBe('start');
    expect(copilotView(stopped, input({ speedKmh: 0, belt: 'stopped' })).message).toContain(
      'começar a andar',
    );
  });

  it('aceita qualquer ordem de passos quando o número não muda além do passo', () => {
    const { state } = atStart();
    // Variação menor que um passo não conta: continua no mesmo pedido.
    expect(advanceCopilot(state, input({ speedKmh: 1.1 })).stage).toBe('speedUp');
    expect(advanceCopilot(state, input({ speedKmh: 0.5 })).stage).toBe('speedUp');
  });
});
