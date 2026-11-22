import { planProcedure } from '../prompts';
import { planChecks, scenarioCount } from '../scenarios';

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

it('um dos cenários de plano parte de uma sessão gravada minuto a minuto, com patamares', () => {
  const check = planChecks(NOW).find((c) => c.name === 'base-patamar-no-alvo-repete')!;
  const [session] = check.data.recent;
  expect(session.plateaus).toHaveLength(4);
  // A carga de referência é a do primeiro patamar no alvo (3%), não a do fim da sessão (2%).
  expect(session.work).toMatchObject({ targetInclinePercent: 3, bpmEnd: 133, reference: { fromMinute: 4, minutes: 8 } });
});
