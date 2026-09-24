import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import {createWorkersAI} from 'workers-ai-provider';
import {generateText} from 'ai';

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
let budget;
try { budget = await load('workers/lib/ai-budget.ts'); } catch { /* missing guard is tested below */ }
const model = '@cf/moonshotai/kimi-k2.5';
const input = { messages: [{ role: 'user', content: 'Hello' }] };

test('unknown models and non-text inputs cannot reach the AI provider', () => {
  assert.ok(budget, 'AI budget guard must exist');
  assert.throws(() => budget.prepareRequest('unknown', input));
  assert.throws(() => budget.prepareRequest(model, { ...input, image: [1, 2] }));
  assert.throws(() => budget.prepareRequest(model, { messages: [{role:'user', content:[{type:'image_url',image_url:{url:'https://example.com'}}]}] }));
});
test('every request has bounded output and a positive conservative reservation', () => {
  const result = budget.prepareRequest(model, input);
  assert.throws(() => budget.prepareRequest(model, {...input,max_tokens:999999}));
  assert.equal(result.inputs.max_tokens, 1024);
  assert.ok(result.neurons > 1024 * 0.273);
  assert.ok(result.neurons < 8000);
  assert.ok(budget.prepareRequest(model, {messages:[{role:'user',content:'😃'.repeat(100)}]}).neurons > result.neurons);
  assert.throws(() => budget.prepareRequest(model, { ...input, max_tokens: -1 }));
  assert.throws(() => budget.prepareRequest(model, { messages:[{role:'user',content:'a'.repeat(100000)}] }));
});
test('budget blocks before the next request would cross the cap', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const state = budget.reserve({day:'2026-09-26',used:7500}, 500, now);
  assert.equal(state.used, 8000);
  assert.throws(() => budget.reserve(state, 1, now));
});
test('first deployment day is blocked, and UTC midnight resets the ledger', () => {
  assert.throws(() => budget.reserve(undefined, 1, Date.parse('2026-09-24T12:00:00Z')));
  assert.equal(budget.reserve({day:'2026-09-25',used:8000}, 500, Date.parse('2026-09-26T00:00:00Z')).used, 500);
});
test('invalid accounting and the midnight safety window fail closed', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  for (const amount of [-1, 0, NaN, Infinity, 1.5]) assert.throws(() => budget.reserve(undefined, amount, now));
  assert.throws(() => budget.reserve({day:'2026-09-26',used:NaN}, 1, now));
  assert.throws(() => budget.reserve(undefined, 1, Date.parse('2026-09-26T23:50:00Z')));
});
test('provider is never called when the shared reservation fails', async () => {
  let calls = 0;
  const ai = budget.createBudgetedAI({
    AI_RAW: {run:async()=>{calls++;}},
    AI_BUDGET:{idFromName:()=> 'shared',get:()=>({fetch:async()=>new Response('Daily AI limit reached',{status:429})})}
  });
  await assert.rejects(() => ai.run(model, input), /Daily AI/);
  assert.equal(calls, 0);
});
test('successful reservations preserve streaming and cap the actual provider request', async () => {
  let actual;
  let reservations = 0;
  const stream = new ReadableStream({start(c){c.close();}});
  const ai = budget.createBudgetedAI({
    AI_RAW:{run:async(_model,inputs)=>{actual=inputs; return stream;}},
    AI_BUDGET:{idFromName:()=> 'shared',get:()=>({fetch:async()=>{reservations++;return new Response('{}');}})}
  });
  assert.equal(await ai.run(model, {...input,stream:true}), stream);
  assert.equal(actual.max_tokens, 1024);
  assert.equal(reservations, 1);
});
test('storage failure and unsupported run options fail closed', async () => {
  let calls = 0;
  const ai = budget.createBudgetedAI({
    AI_RAW:{run:async()=>{calls++;}},
    AI_BUDGET:{idFromName:()=> 'shared',get:()=>({fetch:async()=>{throw new Error('offline');}})}
  });
  await assert.rejects(() => ai.run(model,input));
  await assert.rejects(() => ai.run(model,input,{gateway:{id:'other'}}));
  assert.equal(calls,0);
});
test('manual draft text is preserved when AI proofreading reaches the budget', async () => {
  const {verifyDraft} = await load('workers/lib/ai.ts');
  const body = '<p>This manually written email must still be sendable.</p>';
  const ai = {run:async()=>{const e = new Error('Daily AI limit'); e.name='AIBudgetError'; throw e;}};
  assert.equal(await verifyDraft(ai,body),body);
});
test('the actual Workers AI SDK uses the guarded binding successfully', async () => {
  let called = 0;
  const ai = budget.createBudgetedAI({
    AI_RAW:{run:async()=>{called++; return {response:'Hello',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}},
    AI_BUDGET:{idFromName:()=> 'shared',get:()=>({fetch:async()=>new Response('{}')})}
  });
  const result = await generateText({model:createWorkersAI({binding:ai})(model),prompt:'Hi',maxRetries:0});
  assert.equal(result.text,'Hello');
  assert.equal(called,1);
});
test('proofreading preserves original text if the provider reports truncated output', async () => {
  const {verifyDraft} = await load('workers/lib/ai.ts');
  const body = 'This is a business email. '.repeat(200) + 'Important final instructions.';
  const ai = {run:async()=>({response:body.slice(0,4000),finish_reason:'length'})};
  assert.equal(await verifyDraft(ai,body),body);
  const limited = {run:async()=>({response:body.slice(0,4000),usage:{completion_tokens:4096}})};
  assert.equal(await verifyDraft(limited,body),body);
});
