import { heartStatus, onTarget } from '../briefing';
import { currentCue } from '../model';
import { aimBand, dailyTarget, heartProfile } from '../physiology';
import { PREVIEW_SECONDS, previewWorkout } from '../preview';
import { summarize } from '../prompts';

const profile = { age: 35, heightCm: 175, weightKg: 75 };
const hr = heartProfile(profile, []);
const now = 1_800_000_000_000;

describe('prévia do painel', () => {
  const { active, samples } = previewWorkout(profile, hr, now);
  const elapsed = Math.floor(active.totals.movingMs / 1000);
  const last = samples[samples.length - 1];

  it('para o treino no meio do segundo tiro', () => {
    expect(elapsed).toBe(PREVIEW_SECONDS);
    const cue = currentCue(active.plan!, elapsed)!;
    expect(cue.stage.name).toBe('VO₂máx 2/4');
    expect(cue.left).toBe(144);
  });

  it('termina agora, com a última amostra no horário pedido', () => {
    expect(last.at).toBe(now);
    expect(active.started).toBe(now - PREVIEW_SECONDS * 1000);
  });

  it('deixa a esteira na carga do tiro', () => {
    const stage = currentCue(active.plan!, elapsed)!.stage;
    expect(onTarget(last.speedKmh, stage.speed)).toBe(true);
    expect(onTarget(last.inclinationPercent, stage.incline)).toBe(true);
  });

  it('põe os batimentos dentro da faixa, a caminho do teto', () => {
    const target = dailyTarget(active.plan, profile, hr);
    const aim = aimBand(target, target.objective);
    const status = heartStatus({
      bpm: last.heartRateBpm,
      target,
      aimLow: aim.low,
      chasing: true,
      easy: false,
    });
    expect(status.tone).toBe('inside');
    expect(status.text).toMatch(/bpm abaixo do teto$/);
  });

  it('tem leitura em todos os minutos já feitos', () => {
    expect(active.beats).toHaveLength(19);
    expect(active.beats!.every(([, count]) => count > 0)).toBe(true);
  });

  it('registra as etapas como a sessão de verdade, para o resumo funcionar', () => {
    expect(active.log).toHaveLength(4);
    expect(summarize(active).zoneSharePercent).not.toBeNull();
  });

  it('dá sempre o mesmo treino para o mesmo horário', () => {
    expect(previewWorkout(profile, hr, now).active.totals).toEqual(active.totals);
  });
});
