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
  const computed = checks.map((check) => {
    const { pace, grade, repeat } = planProcedure(check.data);
    return { name: check.name, pace, grade, repeat };
  });
  expect(computed).toEqual(
    checks.map((check) => ({ name: check.name, ...check.expect, repeat: check.exact })),
  );
});

type ReviewData = {
  stage: { secondsRemaining: number; secondsAtLoad: number; laterBlocks: number };
  bpm: { trend: string; belowTopBpm: number };
  allowed: string[];
};

// As regras de "COMO DECIDIR" do prompt de revisão, seguidas só com os campos
// que a IA recebe. Se uma regra do prompt mudar, muda aqui também.
function reviewRules({ stage, bpm, allowed }: ReviewData) {
  const change = allowed.find((option) => option !== 'manter')!;
  if (bpm.trend === 'subindo') return 'manter';
  if (stage.secondsRemaining <= 120 && stage.laterBlocks === 0) return 'manter';
  return bpm.belowTopBpm >= (stage.secondsAtLoad < 240 ? 8 : 4) ? change : 'manter';
}

it('o gabarito de cada cenário de revisão é o que as regras do prompt e a conta do app dão', () => {
  const checks = reviewChecks(NOW);
  expect(checks).toHaveLength(scenarioCount.review);
  const answers = checks.map((check) => ({
    name: check.name,
    answer: [check.user ? reviewRules(check.user as ReviewData) : check.answer],
  }));
  expect(answers).toEqual(checks.map((check) => ({ name: check.name, answer: check.expect })));
  // A IA só recebe o que está dentro da faixa e abaixo do teto, e só pode manter ou aumentar.
  const sent = checks.filter((c) => c.user);
  expect(sent.map((c) => c.name)).toEqual([
    'na-faixa-longe-do-teto',
    'junto-do-teto',
    'quatro-abaixo-do-teto',
    'abaixo-do-teto-apos-aumento',
    'carga-nova-longe-do-teto',
    'pico-isolado-no-fim',
    'caminhada-na-faixa-longe-do-teto',
  ]);
  for (const c of sent) {
    const user = c.user as ReviewData & { bpm: { position: string } };
    expect(user.bpm.position).toBe('na faixa');
    expect(user.allowed.every((option) => !option.startsWith('reduzir'))).toBe(true);
  }
});

// Fora da faixa quem resolve é o app: o diagnóstico mostra a carga que ele poria.
it('os cenários fora da faixa são corrigidos pelo app, com a carga nova no detalhe', () => {
  const local = Object.fromEntries(reviewChecks(NOW).map((c) => [c.name, c.local]));
  expect(local).toMatchObject({
    'acima-sustentado': 'correção do app: 5.6 km/h e 0%',
    'acima-por-pouco': 'correção do app: 5.6 km/h e 1.5%',
    'acima-sem-estabilizar': 'correção do app: 5.6 km/h e 1%',
    'acima-logo-apos-reducao': 'espera após ajuste',
    'abaixo-cedo-demais': 'regra local: abaixo',
    'abaixo-estavel': 'correção do app: 5.6 km/h e 4.5%',
    'volta-a-calma-acima-caindo': 'correção do app: 3 km/h e 0%',
    'volta-a-calma-presa-acima': 'correção do app: 3 km/h e 0%',
    'tiro-abaixo-subindo': 'regra local: abaixo',
    'tiro-abaixo-estavel': 'correção do app: 5.6 km/h e 9%',
    'limiar-correndo-acima': 'correção do app: 7 km/h e 1%',
    'caminhada-abaixo-estavel': 'correção do app: 5.6 km/h e 1%',
  });
});
