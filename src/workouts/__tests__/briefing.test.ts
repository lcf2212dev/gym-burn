import {
  formatHours,
  groupStages,
  heartStatus,
  levelStep,
  minuteColumns,
  onTarget,
  recentActivity,
  scorePercent,
  structureFacts,
  todayLine,
  zoneOf,
} from '../briefing';
import { makePlan, newWorkout, type Workout } from '../model';
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
