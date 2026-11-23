import { newWorkout, type Workout } from '../model';
import { COUNTED_MS, lastDone, lastDoneText, suggest, trained } from '../schedule';
import { sessionPlan, sessions, type SessionKey } from '../week';

const profile = { age: 35, weightKg: 75, heightCm: 175 };
// Segunda, 23/11/2026, 9h, no horário local.
const now = new Date(2026, 10, 23, 9, 0).getTime();
const DAY = 86_400_000;

/** Um treino de 45 min feito há `daysAgo` dias, às 18h. */
const done = (daysAgo: number, key: SessionKey | null, movingMs = 45 * 60_000): Workout => {
  const w = newWorkout(profile, 'ble', key ? sessionPlan(sessions[key], 6, 1) : null);
  const started = new Date(2026, 10, 23 - daysAgo, 18, 0).getTime();
  return { ...w, started, ended: started + movingMs, totals: { ...w.totals, movingMs } };
};
const keys = (history: Workout[]) => suggest(history, now).key;

describe('sessão sugerida para hoje', () => {
  it('sem histórico começa pelo VO₂máx de tiros curtos', () => {
    expect(suggest([], now)).toMatchObject({
      key: 'vo2',
      reason: 'Sem treino forte no histórico: hoje cabe VO₂máx.',
    });
    expect(suggest([], now).session).toBe(sessions.vo2);
  });

  it('no dia seguinte a um treino forte vem a recuperação ativa', () => {
    expect(suggest([done(1, 'vo2Long')], now)).toMatchObject({
      key: 'recovery',
      reason: 'Ontem foi VO₂máx: hoje é dia leve.',
    });
    expect(suggest([done(1, 'threshold')], now).reason).toBe('Ontem foi limiar: hoje é dia leve.');
  });

  it('a recuperação ativa não se repete na mesma semana: depois do segundo treino forte vem a base', () => {
    expect(keys([done(1, 'threshold'), done(3, 'recovery'), done(4, 'vo2')])).toBe('base');
  });

  it('dois dias depois de um treino forte ainda é dia leve; no terceiro cabe o outro treino forte', () => {
    expect(suggest([done(2, 'vo2')], now)).toMatchObject({
      key: 'base',
      reason: 'O último treino forte foi há 2 dias (VO₂máx): mais um dia leve antes do próximo.',
    });
    expect(suggest([done(3, 'vo2'), done(2, 'recovery'), done(1, 'base')], now)).toMatchObject({
      key: 'threshold',
      reason: 'O último treino forte foi há 3 dias (VO₂máx): hoje cabe limiar.',
    });
    // Os dois treinos fortes se alternam.
    expect(keys([done(3, 'threshold')])).toBe('vo2');
  });

  it('não passa de 2 treinos fortes em 7 dias', () => {
    const two = [done(3, 'threshold'), done(6, 'vo2')];
    expect(suggest(two, now)).toMatchObject({
      key: 'base',
      reason: 'Já foram 2 treinos fortes nos últimos 7 dias: hoje é dia leve.',
    });
    // Com o mais antigo saindo da janela, o treino forte volta.
    expect(keys([done(4, 'threshold'), done(7, 'vo2')])).toBe('vo2');
  });

  it('um dia sem treino conta como descanso: só aumenta a distância até o último treino forte', () => {
    // VO₂máx há 3 dias e nada desde então: hoje cabe o limiar, como se os dias tivessem sido leves.
    expect(keys([done(3, 'vo2')])).toBe('threshold');
    // Uma semana inteira parado: o histórico diz qual treino forte vem.
    expect(keys([done(9, 'threshold'), done(12, 'vo2')])).toBe('vo2');
  });

  it('treinando todo dia, a semana fica VO₂máx, recuperação, base, limiar, base, base, base', () => {
    const history: Workout[] = [];
    const week: SessionKey[] = [];
    for (let day = 0; day < 8; day++) {
      const at = now + day * DAY;
      const { key } = suggest(history, at);
      week.push(key);
      const w = newWorkout(profile, 'ble', sessionPlan(sessions[key], 6, 1));
      history.unshift({ ...w, started: at, ended: at + 45 * 60_000, totals: { ...w.totals, movingMs: 45 * 60_000 } });
    }
    expect(week).toEqual(['vo2', 'recovery', 'base', 'threshold', 'base', 'base', 'base', 'vo2']);
  });

  it('quem já fez um treino forte hoje recebe um dia leve', () => {
    expect(suggest([done(0, 'vo2')], now + 10 * 3_600_000)).toMatchObject({
      key: 'recovery',
      reason: 'Hoje já teve VO₂máx: se for treinar de novo, que seja leve.',
    });
  });

  it('a sequência real de novembro: limiar na sexta, base no sábado e VO₂máx no domingo dão recuperação na segunda', () => {
    const history = [done(1, 'vo2Long'), done(2, 'base'), done(3, 'threshold'), done(4, 'base'), done(5, null)];
    expect(suggest(history, now)).toMatchObject({ key: 'recovery', reason: 'Ontem foi VO₂máx: hoje é dia leve.' });
    // Na terça ainda há dois treinos fortes na semana: base. O limiar volta na sexta.
    const tuesday = now + DAY;
    expect(suggest([done(0, 'recovery'), ...history], tuesday).key).toBe('base');
  });
});

describe('treinos que contam', () => {
  it('só entram os de 15 minutos ou mais de lona andando, pelo dia de calendário', () => {
    const short = done(1, 'vo2', COUNTED_MS - 1);
    expect(trained([short], now)).toEqual([]);
    // Às 18h de ontem para as 9h de hoje são 15 h, e mesmo assim é "ontem".
    expect(trained([done(1, 'vo2', COUNTED_MS)], now)).toMatchObject([{ ago: 1, objective: 'VO₂máx' }]);
    // O treino livre conta como base aeróbica.
    expect(trained([done(2, null)], now)).toMatchObject([{ ago: 2, objective: 'Base aeróbica' }]);
    expect(keys([short])).toBe('vo2');
  });

  it('diz há quantos dias cada sessão foi feita', () => {
    const history = [done(1, 'vo2Long'), done(2, 'base'), done(3, 'threshold')];
    expect(lastDone(history, now)).toEqual({ base: 2, recovery: null, threshold: 3, vo2: 1, vo2Long: 1 });
    expect(lastDoneText(null)).toBe('ainda não feito');
    expect(lastDoneText(0)).toBe('feito hoje');
    expect(lastDoneText(1)).toBe('feito ontem');
    expect(lastDoneText(4)).toBe('feito há 4 dias');
  });
});
