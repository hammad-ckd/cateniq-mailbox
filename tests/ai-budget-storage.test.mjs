import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('concurrent mailbox reservations cannot exceed the shared durable cap, even after restart', async () => {
  const bundled = await build({stdin:{contents:`
    export {AIBudget} from './workers/ai-budget.ts';
    Date.now = () => Date.parse('2026-09-26T12:00:00Z');
    export default {fetch(request,env){return env.BUDGET.get(env.BUDGET.idFromName('shared')).fetch(request);}};
  `,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'neutral',external:['cloudflare:workers'],write:false});
  const dir = await mkdtemp(join(tmpdir(),'inbox-budget-test-'));
  const options = {modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{BUDGET:{className:'AIBudget',useSQLite:true}},durableObjectsPersist:dir};
  let mf = new Miniflare(options);
  try {
    const responses = await Promise.all(Array.from({length:24},()=>mf.dispatchFetch('https://budget/reserve',{method:'POST',body:JSON.stringify({neurons:1000})})));
    assert.equal(responses.filter(r=>r.status===200).length,8);
    assert.equal(responses.filter(r=>r.status===429).length,16);
    await mf.dispose();
    mf = new Miniflare(options);
    assert.equal((await mf.dispatchFetch('https://budget/reserve',{method:'POST',body:JSON.stringify({neurons:1})})).status,429);
  } finally {await mf.dispose(); await rm(dir,{recursive:true,force:true});}
});
