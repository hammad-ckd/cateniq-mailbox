import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Hono} from 'hono';
async function load(entry) {
 const out=await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 return import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
}
const {app:api,receiveEmail}=await load('workers/index.ts');
const names=['hammad','reza','zuhayr','yassir','sabiha'];
const boxes=names.flatMap(n=>[`${n}@cateniq.com`,`${n}@catenor.com`]);
function env() { return {DOMAINS:'cateniq.com,catenor.com',EMAIL_ADDRESSES:[],BUCKET:{
 list:async()=>({objects:boxes.map(id=>({key:`mailboxes/${id}.json`}))}),
 head:async()=>({}),get:async()=>({json:async()=>({})})},
 MAILBOX:{idFromName:id=>id,get:()=>({getEmails:async()=>[],getFolders:async()=>[]})}}; }
function as(email) {
 const app=new Hono();
 app.use('*',async(c,next)=>{c.set('identity',{email,isAdmin:email==='hammadshaikh43@gmail.com'});await next();});
 app.route('/',api);return app;
}
test('every staff login sees only their own two mailboxes',async()=>{
 for(const name of names) {
 const response=await as(`${name}@cookdbrands.com`).request('/api/v1/mailboxes',{},env());
 assert.deepEqual((await response.json()).map(m=>m.email),[`${name}@cateniq.com`,`${name}@catenor.com`]);
 }
});
test('unknown login and absent identity fail closed',async()=>{
 assert.equal((await as('outsider@cookdbrands.com').request('/api/v1/mailboxes',{},env())).status,403);
 assert.equal((await api.request('/api/v1/mailboxes',{},env())).status,403);
});
test('cross-mailbox reads, changes, attachments and sending are forbidden before storage',async()=>{
 const paths=['','/emails','/emails/id','/emails/id/reply','/emails/id/forward','/drafts','/folders','/search','/threads/id','/emails/id/attachments/id'];
 for(const person of names) for(const other of names.filter(n=>n!==person)) for(const path of paths) for(const method of ['GET','POST','PUT','DELETE']) {
  const r=await as(`${person}@cookdbrands.com`).request(`/api/v1/mailboxes/${other}%40catenor.com${path}`,{method},{});
  assert.equal(r.status,403,`${person}: ${method} ${other}${path}`);
 }
});
test('staff can read own mailbox but cannot create or delete mailboxes',async()=>{
 const app=as('reza@cookdbrands.com');
 assert.equal((await app.request('/api/v1/mailboxes/reza%40catenor.com',{},env())).status,200);
 assert.equal((await app.request('/api/v1/mailboxes',{method:'POST'},{})).status,403);
 assert.equal((await app.request('/api/v1/mailboxes/reza%40catenor.com',{method:'DELETE'},{})).status,403);
 const config=await (await app.request('/api/v1/config',{},env())).json();
 assert.equal(config.isAdmin,false);
 assert.deepEqual(config.emailAddresses,['reza@cateniq.com','reza@catenor.com']);
});
test('Gmail administrator retains all mailboxes',async()=>{
 const response=await as('hammadshaikh43@gmail.com').request('/api/v1/mailboxes',{},env());
 assert.equal((await response.json()).length,10);
 assert.match(response.headers.get('cache-control'),/no-store/);
});
test('each SMTP envelope gets its own mailbox regardless of To, CC or absent To',async()=>{
 for(const [to,headers] of [
 ['zuhayr@catenor.com','To: reza@catenor.com, zuhayr@catenor.com'],
 ['sabiha@catenor.com','To: reza@catenor.com\r\nCc: sabiha@catenor.com'],
 ['yassir@catenor.com','To: undisclosed-recipients:;'],
 ['hammad@catenor.com','']]) {
 const raw=new TextEncoder().encode(`From: sender@example.com\r\n${headers}\r\nSubject: Delivery test\r\n\r\nWelcome`);
 const stored=[];const e=env();
 e.MAILBOX.get=id=>({findThreadBySubject:async()=>null,createEmail:async()=>stored.push(id)});
 e.EMAIL_AGENT={idFromName:id=>id,get:()=>({fetch:async()=>new Response('ok')})};
 await receiveEmail({to,raw:new Response(raw).body,rawSize:raw.length},e,{waitUntil:()=>{}});
 assert.deepEqual(stored,[to]);
 }
});

const access=await load('workers/lib/access.ts');
const {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK}=await import('jose');
const pair=await generateKeyPair('RS256');
const key=await exportJWK(pair.publicKey);key.kid='test';
const keys=createLocalJWKSet({keys:[key]});
const config={TEAM_DOMAIN:'https://team.cloudflareaccess.com',POLICY_AUD:'mailbox-app'};
async function token(claims={},overrides={}) {
 return new SignJWT({email:'reza@cookdbrands.com',...claims}).setProtectedHeader({alg:'RS256',kid:'test'})
 .setIssuer(overrides.issuer||config.TEAM_DOMAIN).setAudience(overrides.audience||config.POLICY_AUD)
 .setIssuedAt().setExpirationTime(overrides.exp||'1h').sign(pair.privateKey);
}
test('only signed, unexpired tokens for this Access app and an explicit identity are accepted',async()=>{
 assert.equal((await access.verifyAccessToken(await token(),config,keys)).email,'reza@cookdbrands.com');
 for(const jwt of [await token({email:'other@cookdbrands.com'}),await token({email:undefined}),await token({}, {issuer:'https://wrong.example'}),await token({}, {audience:'different-app'}),await token({}, {exp:1}), (await token()).slice(0,-12)+'bad']) {
 await assert.rejects(()=>access.verifyAccessToken(jwt,config,keys));
 }
 await assert.rejects(()=>access.verifyAccessToken('',{},keys));
});
function protectedRoutes(email){
 const app=new Hono();app.use('*',async(c,next)=>{c.set('identity',access.identityFor(email));await next();});
 app.use('*',access.authorizeRequest);app.all('*',c=>c.text('allowed'));return app;
}
test('agent, internal hooks, page routes and MCP cannot bypass mailbox scope',async()=>{
 const app=protectedRoutes('reza@cookdbrands.com');
 for(const path of ['/agents/email-agent/sabiha@catenor.com','/agents/email-mcp/reza@catenor.com','/agents/mailbox/reza@catenor.com','/agents/ai-budget/shared','/agents/email-agent/reza@catenor.com/onNewEmail','/agents/email-agent/reza%2540catenor.com','/agents/email-agent/reza%40catenor.com','/mailbox/hammad%40catenor.com/settings','/mcp','/mcp/sse']) {
 assert.equal((await app.request(path)).status,403,path);
 }
 assert.equal((await app.request('/agents/email-agent/reza@catenor.com')).status,200);
 assert.equal((await app.request('/agents/email-agent/reza@catenor.com/get-messages')).status,200);
 assert.equal((await protectedRoutes('hammadshaikh43@gmail.com').request('/mcp')).status,200);
});
test('expired or reassigned agent sessions lose access even on an existing socket',()=>{
 const valid={email:'reza@cookdbrands.com',expiresAt:2000};
 assert.equal(access.canUseAgentSession?.(valid,'reza@catenor.com',1000),true);
 assert.equal(access.canUseAgentSession?.(valid,'sabiha@catenor.com',1000),false);
 assert.equal(access.canUseAgentSession?.(valid,'reza@catenor.com',2000),false);
 assert.equal(access.canUseAgentSession?.(null,'reza@catenor.com',1000),false);
 assert.equal(access.canUseAgentSession?.({email:'removed@cookdbrands.com',expiresAt:2000},'reza@catenor.com',1000),false);
});
