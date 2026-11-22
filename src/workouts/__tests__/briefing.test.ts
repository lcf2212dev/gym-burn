import { groupStages, heartStatus, onTarget, structureFacts } from '../briefing';
import { makePlan } from '../model';
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
