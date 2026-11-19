import * as SecureStore from 'expo-secure-store';
import type { Estimate, Plan, Profile, Workout } from './model';
import {
  assessBounds,
  assessPrompt,
  parseAssess,
  parsePlan,
  parseReview,
  planPrompt,
  PROMPT_VERSION,
  reviewPrompt,
  type Prompt,
  type ReviewInput,
} from './prompts';
import { saveCall } from './storage';
import { sessionPlan, type Session } from './week';

const keyName = 'gym-burn.deepseek';
export const apiKey = () => SecureStore.getItemAsync(keyName);
export const hasApiKey = async () => !!(await apiKey());
export async function saveApiKey(value: string) {
  if (!/^sk-[A-Za-z0-9_-]{12,200}$/.test(value.trim()))
    throw new Error('Confira o formato da chave DeepSeek.');
  await SecureStore.setItemAsync(keyName, value.trim(), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export type Kind = 'plan' | 'review' | 'assess';

// As três chamadas usam o mesmo modelo, sempre com raciocínio ligado. Muda o
// esforço: `high` para montar o plano, `low` durante o treino (a resposta
// precisa chegar enquanto as leituras ainda valem) e `max` na avaliação, que
// roda depois do treino e pode demorar.
//
// Não vai `temperature`: a API da DeepSeek ignora esse parâmetro com raciocínio
// ligado. O único controle de amostragem que vale nesse modo é `top_p`, aceito
// de 0,95 a 1.
const MODEL = 'deepseek-flash';
const MAX_TOKENS = 393216; // o máximo aceito pela API
const RETRIES = 3;
const settings: Record<Kind, { effort: 'low' | 'high' | 'max'; timeoutMs: number }> = {
  plan: { effort: 'high', timeoutMs: 300_000 },
  review: { effort: 'low', timeoutMs: 300_000 },
  assess: { effort: 'max', timeoutMs: 2_400_000 },
};

/** Erro que não muda ao repetir a chamada: chave, saldo ou requisição inválida. */
class Fatal extends Error {}

export type CallOptions = {
  /** Cancela a chamada, inclusive as novas tentativas. */
  signal?: AbortSignal;
  /** Avisa a tentativa em curso, começando em 1. */
  onAttempt?: (attempt: number, total: number) => void;
  /** `false` nos cenários de diagnóstico, para não ocupar o diário dos treinos reais. */
  journal?: boolean;
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** O objeto JSON da resposta, mesmo que venha cercado de texto ou de marcação. */
export function extractJson(content: unknown): unknown {
  if (typeof content !== 'string' || !content.trim())
    throw new Error('A resposta da DeepSeek veio vazia.');
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error('A resposta da DeepSeek veio incompleta.');
  }
}

type Reply = { content: unknown; usage?: object };

async function post(key: string, kind: Kind, prompt: Prompt, signal?: AbortSignal): Promise<Reply> {
  const { effort, timeoutMs } = settings[kind];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
        top_p: 0.95,
        response_format: { type: 'json_object' },
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: JSON.stringify(prompt.user) },
        ],
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Fatal('A DeepSeek recusou a chave. Confira em Perfil.');
      if (res.status === 402) throw new Fatal('Saldo insuficiente na conta DeepSeek.');
      const message = 'DeepSeek indisponível (' + res.status + '). Tente novamente.';
      throw res.status === 400 || res.status === 422 ? new Fatal(message) : new Error(message);
    }
    const reply = await res.json();
    const choice = reply?.choices?.[0];
    if (choice?.finish_reason !== 'stop')
      throw new Error('A DeepSeek interrompeu a resposta (' + choice?.finish_reason + ').');
    return { content: choice.message?.content, usage: reply.usage };
  } catch (error) {
    if (controller.signal.aborted || error instanceof TypeError)
      throw new Error('Falha de conexão com a DeepSeek. Tente novamente.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

function record(kind: Kind, entry: Record<string, unknown>, journal: boolean) {
  const { user, ...brief } = entry;
  console.log('[gymburn-ia] ' + JSON.stringify({ kind, ...brief }));
  if (!journal) return;
  try {
    saveCall(kind, entry);
  } catch {
    // O diário é diagnóstico: uma falha ao gravar não pode derrubar a chamada.
  }
}

/**
 * Envia um prompt e devolve a resposta já validada por `parse`. Repete até 3
 * vezes em falha de rede, erro do servidor, resposta vazia, cortada ou fora do
 * formato; a doc da DeepSeek avisa que o modo JSON às vezes devolve conteúdo em
 * branco. Cada tentativa vai para o diário.
 */
export async function callModel<T>(
  kind: Kind,
  prompt: Prompt,
  parse: (json: unknown) => T,
  { signal, onAttempt, journal = true }: CallOptions = {},
): Promise<T> {
  const key = await apiKey();
  if (!key) throw new Error('Configure a chave DeepSeek em Perfil.');
  let failure = new Error('Chamada cancelada.');
  for (let attempt = 1; attempt <= RETRIES + 1 && !signal?.aborted; attempt++) {
    if (attempt > 1) await wait(1000 * 2 ** (attempt - 1), signal);
    if (signal?.aborted) break;
    onAttempt?.(attempt, RETRIES + 1);
    const started = Date.now();
    const entry: Record<string, unknown> = {
      version: PROMPT_VERSION,
      effort: settings[kind].effort,
      attempt,
      user: prompt.user,
    };
    try {
      const reply = await post(key, kind, prompt, signal);
      Object.assign(entry, { content: reply.content, usage: reply.usage });
      const value = parse(extractJson(reply.content));
      record(kind, { ...entry, ms: Date.now() - started, ok: true }, journal);
      return value;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      record(kind, { ...entry, ms: Date.now() - started, ok: false, error: failure.message }, journal);
      if (failure instanceof Fatal) break;
    }
  }
  throw failure;
}

/**
 * O plano de hoje para uma sessão do plano semanal. A estrutura e a faixa vêm
 * da sessão; a IA escolhe a carga dos blocos de esforço. Não há teto além do
 * que a esteira alcança: a resposta é conferida com a conta do app, e a
 * revisão durante o treino corrige o que a frequência cardíaca mostrar.
 */
export async function generatePlan(
  profile: Profile,
  session: Session,
  history: Workout[],
  options?: CallOptions,
): Promise<Plan> {
  const prompt = planPrompt({ profile, session, history, now: Date.now() });
  const choice = await callModel('plan', prompt, parsePlan(prompt.user), options);
  return { ...sessionPlan(session, choice.pace, choice.grade), why: choice.why };
}

/** `history` são as sessões anteriores da mesma origem, da mais nova para a mais antiga. */
export function assess(w: Workout, history: Workout[], options?: CallOptions): Promise<Estimate> {
  const input = { workout: w, history };
  return callModel('assess', assessPrompt(input), parseAssess(assessBounds(input)), options);
}

export function reviewIntensity(input: ReviewInput, options?: CallOptions) {
  return callModel('review', reviewPrompt(input), parseReview(input.allowed), options);
}
