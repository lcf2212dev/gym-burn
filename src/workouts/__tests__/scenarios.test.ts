import { planProcedure } from '../prompts';
import { planChecks, reviewChecks, scenarioCount } from '../scenarios';

jest.mock('../ai', () => ({ callModel: jest.fn() }));

const NOW = 1_800_000_000_000;

// O gabarito dos cenários de plano foi escrito à mão, com a conta ao lado de
// cada um. Aqui ele é conferido com o procedimento em código, para o
// diagnóstico não reprovar a IA por um erro do próprio gabarito.
it('o gabarito de cada cenário de plano é o que a conta do app dá', () => {
  const checks = planChecks(NOW);
  expect(checks).toHaveLength(scenarioCount.plan);
  for (const check of checks) {
    const { pace, grade, repeat } = planProcedure(check.data);
    expect({ name: check.name, pace, grade, repeat }).toEqual({
      name: check.name,
      ...check.expect,
      repeat: check.exact,
    });
  }
});

type ReviewData = {
  stage: { kind: string; secondsInStage: number; secondsRemaining: number; secondsAtLoad: number; laterBlocks: number };
  bpm: { trend: string; marginBpm: number; belowTopBpm: number };
  session: { changes: { secondsAgo: number; decision: string }[] };
  allowed: string[];
};

// As regras de "COMO DECIDIR" do prompt de revisão, seguidas só com os campos
// que a IA recebe. Se uma regra do prompt mudar, muda aqui também.
function reviewRules({ stage, bpm, session, allowed }: ReviewData) {
  const change = allowed.find((option) => option !== 'manter')!;
  if (change.startsWith('reduzir')) {
    if (session.changes.some((c) => c.decision.startsWith('reduzir') && c.secondsAgo < 120)) return 'manter';
    if (stage.kind === 'leve' && stage.secondsInStage < 120)
      return bpm.trend === 'subindo' && bpm.marginBpm >= 10 ? change : 'manter';
    if (bpm.marginBpm >= 10) return change;
    return bpm.marginBpm >= 5 && bpm.trend !== 'caindo' ? change : 'manter';
  }
  if (bpm.trend === 'subindo') return 'manter';
  if (stage.secondsRemaining <= 120 && stage.laterBlocks === 0) return 'manter';
  return bpm.belowTopBpm >= (stage.secondsAtLoad < 240 ? 8 : 4) ? change : 'manter';
}

it('o gabarito de cada cenário de revisão é o que as regras do prompt dão', () => {
  const checks = reviewChecks(NOW);
  expect(checks).toHaveLength(scenarioCount.review);
  for (const check of checks) {
    const answer = check.user ? reviewRules(check.user as ReviewData) : 'manter';
    expect({ name: check.name, answer: [answer] }).toEqual({ name: check.name, answer: check.expect });
  }
  // Os casos que as regras locais resolvem não chegam à IA.
  expect(checks.filter((c) => c.local).map((c) => c.name)).toEqual([
    'acima-logo-apos-reducao',
    'abaixo-cedo-demais',
    'aquecimento-abaixo',
    'abaixo-sem-atingir-alvo',
    'recuperacao-abaixo-do-teto',
  ]);
});
