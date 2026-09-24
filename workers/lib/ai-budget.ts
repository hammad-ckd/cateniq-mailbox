import type { Env } from '../types';

export const DAILY_AI_BUDGET = 8000;
// No reliable pre-deployment ledger exists. Start at the next UTC reset.
export const AI_BUDGET_START = '2026-09-25';
const MODELS = new Set([
  '@cf/moonshotai/kimi-k2.5',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
]);
const MESSAGE = 'Daily AI allowance reached or request too large. AI resumes after the next 00:00 UTC reset (5:00 AM Pakistan). Regular email still works.';
export class AIBudgetError extends Error {
  constructor(message = MESSAGE) { super(message); this.name = 'AIBudgetError'; }
}
export type BudgetState = { day: string; used: number };

export function prepareRequest(model: string, input: Record<string, unknown>) {
  if (!MODELS.has(model) || !input || typeof input !== 'object') throw new AIBudgetError('AI model is not approved for the daily budget.');
  const allowed = new Set(['messages', 'max_tokens', 'stream', 'temperature', 'top_p', 'tools', 'response_format']);
  if (Object.entries(input).some(([key, value]) => value !== undefined && !allowed.has(key))) throw new AIBudgetError('Unsupported AI request; no budget can be reserved.');
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 64) throw new AIBudgetError();
  // Text-only requests: images/audio may have costs not bounded by text length.
  for (const message of input.messages) {
    if (!message || typeof message !== 'object' ||
        (message.content != null && typeof message.content !== 'string')) throw new AIBudgetError('Only text AI requests are supported by the budget guard.');
    if (Object.keys(message).some(key => !['role','content','name','tool_calls','tool_call_id'].includes(key))) throw new AIBudgetError();
  }
  const requested = input.max_tokens ?? 1024;
  const maxOutput = model === '@cf/meta/llama-4-scout-17b-16e-instruct' ? 4096 : 1024;
  // Reject rather than silently shortening output requested by the caller.
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1 || requested > maxOutput) throw new AIBudgetError();
  const inputs = JSON.parse(JSON.stringify({ ...input, max_tokens: requested }));
  const bytes = new TextEncoder().encode(JSON.stringify(inputs)).length;
  if (bytes > 64000) throw new AIBudgetError();
  // Deliberately over-reserve: two tokens per UTF-8 byte, plus generous chat
  // template overhead. Rates round UP beyond every allowlisted model's rates
  // as of 2026-09-24. No cached-input discount or post-call refunds are used.
  // Re-audit before adding a model or if Cloudflare changes its pricing/template.
  const inputTokens = bytes * 2 + 8192 + input.messages.length * 256;
  const neurons = Math.ceil(inputTokens * 0.1 + inputs.max_tokens * 0.5);
  if (neurons > DAILY_AI_BUDGET) throw new AIBudgetError();
  return { inputs, neurons };
}

export function reserve(state: BudgetState | undefined, neurons: number, now: number): BudgetState {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  if (day < AI_BUDGET_START || !Number.isSafeInteger(neurons) || neurons <= 0) throw new AIBudgetError();
  // Avoid starting a request near the billing-day boundary.
  if (date.getUTCHours() === 23 && date.getUTCMinutes() >= 45) throw new AIBudgetError();
  if (state && (!/^\d{4}-\d{2}-\d{2}$/.test(state.day) || state.day > day || !Number.isSafeInteger(state.used) || state.used < 0)) throw new AIBudgetError('AI budget ledger unavailable; AI paused.');
  const used = state?.day === day ? state.used : 0;
  if (used + neurons > DAILY_AI_BUDGET) throw new AIBudgetError();
  return { day, used: used + neurons };
}

export function createBudgetedAI(env: Pick<Env, 'AI_RAW' | 'AI_BUDGET'>): Ai {
  return {
    async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) {
      if (options && Object.values(options).some(value => value !== undefined)) throw new AIBudgetError('Unbudgeted AI options are disabled.');
      const prepared = prepareRequest(model, inputs);
      const stub = env.AI_BUDGET.get(env.AI_BUDGET.idFromName('shared-daily-ai-budget'));
      let response: Response;
      try {
        response = await stub.fetch('https://budget/reserve', {
          method: 'POST', body: JSON.stringify({ neurons: prepared.neurons }),
        });
      } catch { throw new AIBudgetError('AI budget unavailable; AI paused. Regular email still works.'); }
      if (!response.ok) throw new AIBudgetError(await response.text());
      // Reservations are never refunded, including failures/retries/stream aborts.
      // This is the ONLY path to the real AI binding in this application.
      return env.AI_RAW.run(model as Parameters<Ai['run']>[0], prepared.inputs);
    },
  } as Ai;
}
