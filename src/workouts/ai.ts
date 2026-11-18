import { dailyTarget, decisions, objectives, type Decision, type pulseWindow } from './adaptive';
import type { Cue } from './guidance';
import * as SecureStore from 'expo-secure-store';
import {
  evidence,
  goals,
  levels,
  makePlan,
  type Goal,
  type Profile,
  type Workout,
  type Estimate,
} from './model';

const keyName = 'gym-burn.deepseek';
export const hasApiKey = async () => !!(await SecureStore.getItemAsync(keyName));
export async function saveApiKey(value: string) {
  if (!/^sk-[A-Za-z0-9_-]{12,200}$/.test(value.trim()))
    throw new Error('Confira o formato da chave DeepSeek.');
  await SecureStore.setItemAsync(keyName, value.trim(), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function request(prompt: string, profile: Profile, data: object) {
  const key = await SecureStore.getItemAsync(keyName);
  if (!key) throw new Error('Configure a chave DeepSeek em Perfil.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 500,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify({ profile, ...data }) },
        ],
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error('A DeepSeek recusou a chave. Confira em Perfil.');
      if (res.status === 402) throw new Error('Saldo insuficiente na conta DeepSeek.');
      throw new Error('DeepSeek indisponível (' + res.status + '). Tente novamente.');
    }
    const reply = await res.json();
    try {
      return JSON.parse(reply.choices[0].message.content);
    } catch {
      throw new Error('A resposta da DeepSeek veio incompleta. Tente novamente.');
    }
  } catch (error) {
    if (controller.signal.aborted || error instanceof TypeError)
      throw new Error('Falha de conexão com a DeepSeek. Tente novamente.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function recent(history: Workout[]) {
  return history.slice(0, 5).map((w) => ({ ...evidence(w), estimate: w.estimate?.level ?? null }));
}

export async function generatePlan(
  profile: Profile,
  minutes: number,
  goal: Goal | null,
  history: Workout[],
) {
  const choice = await request(
    `Escolha um treino de esteira para hoje com base no perfil, histórico, objetivo e minutos.
    Sem histórico, escolha caminhada confortável. Prefira mudanças pequenas e alvos conservadores.
    Escolha também o objetivo fisiológico diário (objective) entre ${objectives.join(', ')}. Respeite o modo pedido, ou escolha entre ${goals.join(', ')}.
    O app monta aquecimento, blocos e volta à calma. Retorne apenas json como
    {"goal":"Intervalado","objective":"Base aeróbica","pace":4.5,"grade":1,"workMinutes":4,"recoveryMinutes":2}. pace é velocidade principal de 1 a 9 km/h em décimos;
    grade é inclinação de 0 a 5% em passos de 0.5. Escolha a duração aproximada dos blocos principais (workMinutes: 1 a 20) e de recuperação (recoveryMinutes: 1 a 10) conforme a sessão. Não prometa perda de gordura.`,
    profile,
    { minutes, goal, recent: recent(history) },
  );
  const plan = makePlan(
    goal ?? choice?.goal,
    minutes,
    choice?.pace,
    choice?.grade,
    choice?.workMinutes,
    choice?.recoveryMinutes,
  );
  if (!objectives.includes(choice?.objective))
    throw new Error('Objetivo diário inválido. Gere o treino novamente.');
  return { ...plan, objective: choice.objective } as typeof plan;
}

export async function assess(w: Workout, history: Workout[]): Promise<Estimate> {
  const data = evidence(w);
  const insufficient = data.bpmReadings < 3 || data.movingSeconds < 60;
  const answer = await request(
    `Estime qualitativamente o condicionamento observado nesta sessão de esteira em português do Brasil.
    Use carga REAL, tempo em movimento, cobertura dos BPM e sessões anteriores. Não use o alvo como realizado.
    Sem diagnóstico, VO2max ou inferência a partir de IMC. Não extrapole de dados esparsos.
    Se insufficient for true, explique a falta de dados. Use apenas os níveis ${levels.join(', ')}.
    Devolva json {"level":"Dados insuficientes","summary":"Uma ou duas frases sobre as medições."}.`,
    w.profile,
    { actual: data, insufficient, recent: recent(history) },
  );
  if (
    !levels.includes(answer?.level) ||
    typeof answer?.summary !== 'string' ||
    !answer.summary.trim() ||
    answer.summary.length > 1000
  )
    throw new Error('Avaliação incompleta. Tente novamente.');
  return { level: insufficient ? levels[0] : answer.level, summary: answer.summary.trim() };
}

export async function reviewIntensity(
  w: Workout,
  plan: NonNullable<Workout['plan']>,
  cue: Cue,
  readings: ReturnType<typeof pulseWindow>,
): Promise<Decision> {
  const reply = await request(
    `Acompanhe este treino de esteira. Revise a carga da etapa atual conforme o objetivo diário,
    a faixa orientativa de BPM, o perfil, a duração, os BPM recentes e a carga realmente realizada.
    Acima da faixa prefira reduzir a carga. Na faixa mantenha. Abaixo dela só proponha aumento
    se as leituras forem consistentes e a pessoa estiver cumprindo os alvos da etapa principal.
    Preserve aquecimento, recuperação e volta à calma. A faixa é uma estimativa, não um limiar medido.
    Escolha uma única decisão entre ${decisions.join(', ')}. Retorne json {"decision":"manter"}.`,
    w.profile,
    {
      target: dailyTarget(plan, w.profile),
      mode: plan.goal,
      actual: evidence(w),
      stage: cue.stage,
      stageIndex: cue.index,
      remainingSeconds: cue.left,
      readings,
    },
  );
  if (!decisions.includes(reply?.decision)) throw new Error('Resposta de ajuste inválida.');
  return reply.decision;
}
