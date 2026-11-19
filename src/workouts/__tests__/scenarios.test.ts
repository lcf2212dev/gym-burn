import { planProcedure } from '../prompts';
import { planChecks, scenarioCount } from '../scenarios';

jest.mock('../ai', () => ({ callModel: jest.fn() }));

// O gabarito dos cenários de plano foi escrito à mão, com a conta ao lado de
// cada um. Aqui ele é conferido com o procedimento em código, para o
// diagnóstico não reprovar a IA por um erro do próprio gabarito.
it('o gabarito de cada cenário de plano é o que a conta do app dá', () => {
  const checks = planChecks(1_800_000_000_000);
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
