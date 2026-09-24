import { DurableObject } from 'cloudflare:workers';
import { reserve, AIBudgetError, DAILY_AI_BUDGET, AI_BUDGET_START, type BudgetState } from './lib/ai-budget';

/** A single durable ledger shared by both domains and every mailbox. */
export class AIBudget extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      const state = this.ctx.storage.kv.get<BudgetState>('budget');
      const day = new Date().toISOString().slice(0, 10);
      return Response.json({ limit: DAILY_AI_BUDGET, reserved: state?.day === day ? state.used : 0, day, starts: AI_BUDGET_START });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/reserve') return new Response('Not found', {status:404});
    try {
      const { neurons } = await request.json() as { neurons: number };
      // Synchronous transaction prevents read-modify-write races between mailboxes.
      this.ctx.storage.transactionSync(() => {
        const previous = this.ctx.storage.kv.get<BudgetState>('budget');
        this.ctx.storage.kv.put('budget', reserve(previous, neurons, Date.now()));
      });
      return Response.json({ reserved: neurons });
    } catch (error) {
      return new Response(error instanceof AIBudgetError ? error.message : 'AI budget unavailable; AI paused.', { status: 429 });
    }
  }
}
