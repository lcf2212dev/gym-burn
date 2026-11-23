import {
  averageCadence,
  formatHours,
  gaitLine,
  gaitSpoken,
  groupStages,
  heartStatus,
  levelStep,
  minuteColumns,
  onTarget,
  readinessCopy,
  recentActivity,
  recoveryLabel,
  restLabel,
  scorePercent,
  stageNote,
  stillProgress,
  structureFacts,
  todayLine,
  zoneOf,
} from '../briefing';
import { FATIGUE_TIP } from '../gait';
import { emptyLog, makePlan, newWorkout, type Workout } from '../model';
import type { ReadinessRecord } from '../rest';
import { week, zoneIndexes } from '../week';

describe('etapas agrupadas', () => {
  it('junta os tiros e as recuperações repetidos numa linha cada', () => {
    const plan = makePlan('VO₂máx', { warmup: 10, reps: 4, work: 4, recovery: 3, cooldown: 7 }, 9.5, 1);
    expect(groupStages(plan.stages)).toEqual([
      { count: 1, name: 'Aquecimento', seconds: 600, speed: 4, incline: 0, hard: false },
      { count: 4, name: 'VO₂máx', seconds: 240, speed: 9.5, incline: 1, hard: true },
      { count: 4, name: 'Recuperação', seconds: 180, speed: 4, incline: 0, hard: false },
      { count: 1, name: 'Volta à calma', seconds: 420, speed: 4, incline: 0, hard: false },
    ]);
  });

  it('mantém as três etapas de um treino contínuo', () => {
    const plan = makePlan('Base aeróbica', { warmup: 5, reps: 1, work: 35, recovery: 0, cooldown: 5 }, 5, 3);
    expect(groupStages(plan.stages).map((s) => [s.count, s.name])).toEqual([
      [1, 'Aquecimento'],
      [1, 'Base aeróbica'],
      [1, 'Volta à calma'],
    ]);
  });
});

describe('zonas de cada treino', () => {
  it('diz quais das cinco zonas a faixa do treino atravessa', () => {
    expect(zoneIndexes('Recuperação')).toEqual([0]);
    expect(zoneIndexes('Base aeróbica')).toEqual([1, 2]);
    expect(zoneIndexes('Limiar')).toEqual([3]);
    expect(zoneIndexes('VO₂máx')).toEqual([4]);
  });
});

describe('fatos da sessão', () => {
  it('resume os tiros e os trechos leves de um treino intervalado', () => {
    expect(structureFacts(week[2].session!)).toEqual({
      label: 'Faixa nos tiros',
      facts: [
        ['4 × 4 min', 'Tiros na faixa'],
        ['3 min', 'Leves entre eles'],
      ],
      note: '10 min aquecendo antes e 7 min desaquecendo depois.',
    });
  });

  it('chama de blocos o que o plano chama de blocos', () => {
    expect(structureFacts(week[5].session!).label).toBe('Faixa nos blocos');
    expect(structureFacts(week[5].session!).facts[0]).toEqual(['3 × 8 min', 'Blocos na faixa']);
  });

  it('resume o treino contínuo', () => {
    expect(structureFacts(week[1].session!)).toEqual({
      label: 'Faixa de batimentos',
      facts: [
        ['35 min', 'Na faixa'],
        ['5 + 5 min', 'Aquecer e desaquecer'],
      ],
      note: 'Contínuo: 5 min aquecendo, 35 min na faixa, 5 min desaquecendo.',
    });
  });
});

describe('leitura dos batimentos contra o alvo', () => {
  const target = { low: 167, high: 176 };
  const chasing = { target, aimLow: 173, chasing: true, easy: false };

  it('pede a leitura quando ela não existe', () => {
    expect(heartStatus({ ...chasing, bpm: null })).toEqual({
      tone: 'neutral',
      text: 'Segure o sensor para ler',
    });
  });

  it('avisa quanto passou do teto', () => {
    expect(heartStatus({ ...chasing, bpm: 180 })).toEqual({ tone: 'above', text: '4 bpm acima do alvo' });
  });

  it('diz quanto falta para o teto quando a mira é o alto da faixa', () => {
    expect(heartStatus({ ...chasing, bpm: 172 })).toEqual({ tone: 'inside', text: '4 bpm abaixo do teto' });
  });

  it('fica no alvo dentro da mira', () => {
    expect(heartStatus({ ...chasing, bpm: 175 })).toEqual({ tone: 'inside', text: 'No alvo' });
  });

  it('conta até o teto, e não até o piso, quando a mira é o alto da faixa', () => {
    expect(heartStatus({ ...chasing, bpm: 150 })).toEqual({ tone: 'below', text: '26 bpm abaixo do teto' });
  });

  it('não cobra a faixa numa etapa leve', () => {
    expect(heartStatus({ ...chasing, easy: true, bpm: 130 })).toEqual({ tone: 'neutral', text: 'Etapa leve' });
  });

  it('em dia de recuperação a faixa inteira é o alvo', () => {
    const recovery = { target: { low: 93, high: 111 }, aimLow: 93, chasing: false, easy: false };
    expect(heartStatus({ ...recovery, bpm: 100 })).toEqual({ tone: 'inside', text: 'No alvo' });
    expect(heartStatus({ ...recovery, bpm: 90 })).toEqual({ tone: 'below', text: '3 bpm abaixo do alvo' });
  });
});

describe('carga contra o alvo', () => {
  it('aceita a diferença de arredondamento da esteira', () => {
    expect(onTarget(9.5, 9.5)).toBe(true);
    expect(onTarget(9.54, 9.5)).toBe(true);
    expect(onTarget(9.4, 9.5)).toBe(false);
  });

  it('sem leitura ou sem alvo não está no alvo', () => {
    expect(onTarget(null, 9.5)).toBe(false);
    expect(onTarget(9.5, null)).toBe(false);
  });
});

describe('atividade recente', () => {
  const profile = { age: 35, heightCm: 175, weightKg: 75 };
  const day = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;
  const at = (daysAgo: number, minutes: number): Workout => {
    const w = newWorkout(profile, 'ble', null);
    return { ...w, started: now - daysAgo * day, totals: { ...w.totals, movingMs: minutes * 60000 } };
  };

  it('conta os treinos e o tempo em movimento dos últimos 21 dias', () => {
    expect(recentActivity([at(1, 45), at(20, 30), at(22, 45)], now)).toEqual({
      count: 2,
      movingMs: 75 * 60000,
    });
  });

  it('não conta nada num histórico vazio', () => {
    expect(recentActivity([], now)).toEqual({ count: 0, movingMs: 0 });
  });

  it('escreve o tempo em horas e minutos', () => {
    expect(formatHours(75 * 60000)).toBe('1 h 15 min');
    expect(formatHours(45 * 60000)).toBe('45 min');
    expect(formatHours(120 * 60000)).toBe('2 h');
  });
});

describe('nível da IA', () => {
  it('põe os três níveis em degraus, do mais baixo ao mais alto', () => {
    expect(levelStep('Em adaptação')).toBe(0);
    expect(levelStep('Base em formação')).toBe(1);
    expect(levelStep('Base consistente')).toBe(2);
  });

  it('não tem degrau sem dados ou sem avaliação', () => {
    expect(levelStep('Dados insuficientes')).toBeNull();
    expect(levelStep(undefined)).toBeNull();
  });
});

describe('batimentos por minuto', () => {
  it('dá a média de cada minuto e nada onde não houve leitura', () => {
    expect(minuteColumns([[300, 3], [0, 0], [130, 1]], 5)).toEqual([100, null, 130, null, null]);
  });

  it('aceita um registro sem leituras guardadas', () => {
    expect(minuteColumns(undefined, 2)).toEqual([null, null]);
  });

  it('acha a zona de um batimento pela FC máxima', () => {
    expect(zoneOf(92, 185)).toBe(0);
    expect(zoneOf(111, 185)).toBe(1);
    expect(zoneOf(140, 185)).toBe(2);
    expect(zoneOf(160, 185)).toBe(3);
    expect(zoneOf(172, 185)).toBe(4);
    expect(zoneOf(200, 185)).toBe(4);
  });
});

describe('placar do diagnóstico', () => {
  it('dá o acerto em porcentagem inteira', () => {
    expect(scorePercent(22, 24)).toBe(92);
    expect(scorePercent(0, 0)).toBe(0);
  });
});

describe('treino de hoje, em uma linha', () => {
  it('diz o dia, o treino e a duração', () => {
    expect(todayLine(2)).toBe('Hoje · Terça · VO₂máx · 45 min');
  });

  it('avisa do descanso no domingo', () => {
    expect(todayLine(0)).toBe('Hoje · Domingo · descanso');
  });
});

describe('painel com a cadência, a recuperação e o próximo tiro', () => {
  // VO₂máx: aquecimento (0), tiros de 4 min (1, 3, 5, 7), 3 min leves depois de cada um (2, 4, 6, 8) e
  // volta à calma (9). Só as leves 2, 4 e 6 ficam entre dois tiros.
  const plan = makePlan('VO₂máx', { warmup: 10, reps: 4, work: 4, recovery: 3, cooldown: 7 }, 9.5, 1);
  const base = { plan, gait: null, tip: '', recovery: null, nextBlock: null };

  it('o rodapé do bloco de velocidade traz a cadência e a passada, só com cadência', () => {
    expect(gaitLine({ cadenceSpm: 168, strideM: 0.94 })).toBe('168 passos/min · 0,94 m');
    // Parado na lona a passada não existe.
    expect(gaitLine({ cadenceSpm: 0, strideM: null })).toBe('0 passos/min');
    expect(gaitLine({ cadenceSpm: null, strideM: null })).toBeNull();
    expect(gaitLine(null)).toBeNull();
    expect(gaitSpoken({ cadenceSpm: 168, strideM: 0.94 })).toBe(', cadência de 168 passos por minuto, passada de 0,94 metro');
    expect(gaitSpoken(null)).toBe('');
  });

  it('a linha de baixo do cartão da etapa: fora da lona, a dica, o próximo tiro e o fim da recuperação', () => {
    expect(stageNote({ ...base, index: 3, into: 60 })).toBeNull();
    // Fora da lona vem antes de tudo, inclusive da dica.
    expect(stageNote({ ...base, index: 3, into: 60, gait: { offBelt: true }, tip: FATIGUE_TIP })).toEqual({
      text: 'Fora da lona · a carga não sobe',
      tone: 'warn',
    });
    // A dica tem lugar próprio: o texto do guia não a troca.
    expect(stageNote({ ...base, index: 3, into: 60, tip: FATIGUE_TIP })).toEqual({ text: FATIGUE_TIP, tone: 'warn' });
    // Na recuperação, a carga do próximo tiro e se mudou.
    const next = { index: 5, speed: 9.1, incline: 1, predictedBpm: 168, verdict: 'reduzir' as const, changed: true };
    expect(stageNote({ ...base, index: 4, into: 20, nextBlock: next })).toEqual({
      text: 'Próximo tiro · 9,1 km/h e 1% · carga reduzida',
      tone: 'info',
    });
    expect(stageNote({ ...base, index: 4, into: 20, nextBlock: { ...next, speed: 9.5, verdict: 'manter', changed: false } })?.text).toBe(
      'Próximo tiro · 9,5 km/h e 1% · mesma carga',
    );
    expect(stageNote({ ...base, index: 4, into: 20, nextBlock: { ...next, speed: 9.8, incline: 1.5, verdict: 'aumentar' } })?.text).toBe(
      'Próximo tiro · 9,8 km/h e 1,5% · carga aumentada',
    );
    // O "manter" que leva adiante a carga do fim do tiro anterior.
    expect(stageNote({ ...base, index: 4, into: 20, nextBlock: { ...next, speed: 9.8, verdict: 'manter', changed: true } })?.text).toBe(
      'Próximo tiro · 9,8 km/h e 1% · carga do anterior mantida',
    );
    // Um bloco longo é "bloco", não "tiro".
    const long = makePlan('Limiar', { warmup: 10, reps: 3, work: 8, recovery: 2, cooldown: 5 }, 8, 1);
    expect(stageNote({ ...base, plan: long, index: 2, into: 20, nextBlock: { ...next, index: 3 } })?.text).toMatch(/^Próximo bloco/);
    // Nos primeiros 30 s do tiro seguinte, como o coração encerrou a recuperação.
    const early = { index: 4, planned: 180, seconds: 135, reason: 'cedo' as const };
    expect(stageNote({ ...base, index: 5, into: 10, recovery: early })).toEqual({
      text: 'Recuperação encerrada mais cedo, aos 2:15',
      tone: 'info',
    });
    expect(stageNote({ ...base, index: 5, into: 31, recovery: early })).toBeNull();
    expect(stageNote({ ...base, index: 5, into: 10, recovery: { ...early, seconds: 250, reason: 'alongada' } })?.text).toBe(
      'Recuperação alongada: terminou aos 4:10',
    );
    expect(stageNote({ ...base, index: 5, into: 10, recovery: { ...early, reason: 'plano' } })).toBeNull();
  });

  it('o estado da recuperação guiada pelo coração, só nas recuperações entre dois tiros', () => {
    expect(recoveryLabel({ plan, index: 3, recovery: null, strap: true })).toBeNull();
    expect(recoveryLabel({ plan, index: 0, recovery: null, strap: true })).toBeNull();
    expect(recoveryLabel({ plan, index: 2, recovery: null, strap: true })).toBe('guiada pelo coração');
    expect(recoveryLabel({ plan, index: 2, recovery: null, strap: false })).toBe('no tempo do plano');
    const paced = { index: 2, planned: 180, seconds: 250, reason: 'alongada' as const };
    expect(recoveryLabel({ plan, index: 2, recovery: paced, strap: true })).toBe('alongada até 4:10');
    expect(recoveryLabel({ plan, index: 2, recovery: { ...paced, reason: 'plano' }, strap: false })).toBe('no tempo do plano');
    expect(recoveryLabel({ plan, index: 2, recovery: { ...paced, reason: 'cedo' }, strap: true })).toBe('encerrada mais cedo');
    // A de outra recuperação não vale para esta.
    expect(recoveryLabel({ plan, index: 4, recovery: paced, strap: true })).toBe('guiada pelo coração');
  });
});

describe('evolução: repouso, cadência', () => {
  const profile = { age: 36, weightKg: 75, heightCm: 175 };
  const w = (patch: Partial<Workout>): Workout => ({ ...newWorkout(profile, 'ble', null), ...patch });

  it('o repouso diz como foi medido', () => {
    expect(restLabel(w({ restBpm: 62, restSource: 'parado' }))).toBe('repouso 62');
    expect(restLabel(w({ restBpm: 86, restSource: 'andando' }))).toBe('1º minuto 86');
    // Registro antigo, sem origem: é do primeiro minuto andando.
    expect(restLabel(w({ restBpm: 86 }))).toBe('1º minuto 86');
    expect(restLabel(w({ restBpm: null }))).toBeNull();
  });

  it('a cadência média não conta os segundos fora da lona', () => {
    const base = newWorkout(profile, 'ble', null).totals;
    expect(averageCadence(w({}))).toBeNull();
    // 10 min a 160 passos/min e 1 min fora da lona, com a cadência em zero.
    const totals = { ...base, cadenceMs: 160 * 600_000, cadenceDurationMs: 660_000 };
    expect(averageCadence(w({ totals }))).toBe(145);
    expect(averageCadence(w({ totals, log: [{ ...emptyLog(), offBeltMs: 60_000 }] }))).toBe(160);
  });
});

describe('repouso e prontidão no treino do dia', () => {
  const today: ReadinessRecord = {
    day: '2026-11-22',
    at: 0,
    lnRmssd: 3.6,
    rmssd: 36.6,
    restBpm: 60,
    beats: 70,
    rejectedShare: 0,
  };

  it('o andamento da medida parado, de 0 a 60 s', () => {
    expect(stillProgress(0, false)).toEqual({ share: 0, text: 'Medindo parado · 0 de 60 s' });
    expect(stillProgress(45, false)).toEqual({ share: 0.75, text: 'Medindo parado · 45 de 60 s' });
    expect(stillProgress(84, true)).toEqual({ share: 1, text: 'Medida pronta · 1:24 parado' });
    // O minuto coberto, mas sem 30 s seguidos de leitura: ainda não está pronta.
    expect(stillProgress(80, false)).toEqual({
      share: 1,
      text: 'Medindo parado · a leitura falhou em trechos; fique mais 30 s',
    });
  });

  it('diz o estado da prontidão, como medir e, abaixo do normal, sugere uma sessão leve', () => {
    expect(readinessCopy({ state: 'sem-medida', days: 0 })).toEqual({
      title: 'Sem medida hoje',
      detail: 'Para medir, vista a cinta no peito, suba na esteira e fique parado por 1 minuto antes de ligar a lona.',
      tone: 'pending',
    });
    expect(readinessCopy({ state: 'sem-medida', days: 1 }).detail).toMatch(/Sua base tem 1 dia medido nas últimas 4 semanas\.$/);
    expect(readinessCopy({ state: 'coletando', days: 2, today })).toMatchObject({
      title: 'Coletando (2 de 5 dias)',
      tone: 'pending',
    });
    const compared = { days: 7, today, mean: 3.8, sd: 0.15 };
    expect(readinessCopy({ state: 'normal', ...compared })).toEqual({
      title: 'No seu normal',
      detail: 'RMSSD de 37 ms hoje, dentro da sua variação nos últimos 7 dias medidos.',
      tone: 'normal',
    });
    expect(readinessCopy({ state: 'acima', ...compared })).toMatchObject({ title: 'Acima do seu normal', tone: 'up' });
    const low = readinessCopy({ state: 'abaixo', ...compared });
    expect(low).toMatchObject({ title: 'Abaixo do seu normal', tone: 'down' });
    expect(low.detail).toContain('Sugestão: uma sessão leve hoje.');
  });
});
