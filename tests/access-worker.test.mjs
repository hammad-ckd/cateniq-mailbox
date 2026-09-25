import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,createFetchMock} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';

test('production Worker verifies identity before API, chat history and websocket access',async()=>{
 const pair=await generateKeyPair('RS256');
 const key=await exportJWK(pair.publicKey);key.kid='integration';
 const issuer='https://test.cloudflareaccess.com';
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();
 fetchMock.get(issuer).intercept({path:'/cdn-cgi/access/certs'}).reply(200,{keys:[key]}).persist();
 const bundle=await build({entryPoints:['workers/app.ts'],bundle:true,format:'esm',platform:'node',conditions:['workerd','worker','browser'],mainFields:['module','main'],external:['cloudflare:*','node:*'],write:false,
 define:{'import.meta.env.MODE':'"production"','import.meta.env.DEV':'false'},
 plugins:[{name:'test-page-build',setup(b){b.onResolve({filter:/^virtual:react-router\/server-build$/},()=>({path:'page',namespace:'test-page'}));b.onLoad({filter:/.*/,namespace:'test-page'},()=>({contents:'export default {};'}));}}]});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',compatibilityFlags:['nodejs_compat'],fetchMock,
 bindings:{TEAM_DOMAIN:issuer,POLICY_AUD:'test-audience',DOMAINS:'cateniq.com,catenor.com',EMAIL_ADDRESSES:[]},r2Buckets:['BUCKET'],
 durableObjects:{MAILBOX:{className:'MailboxDO',useSQLite:true},EMAIL_AGENT:{className:'EmailAgent',useSQLite:true},EMAIL_MCP:{className:'EmailMCP',useSQLite:true},AI_BUDGET:{className:'AIBudget',useSQLite:true}}});
 try {
 const bucket=await mf.getR2Bucket('BUCKET');
 await bucket.put('mailboxes/reza@catenor.com.json','{}');await bucket.put('mailboxes/sabiha@catenor.com.json','{}');
 const jwt=await new SignJWT({email:'reza@cookdbrands.com'}).setProtectedHeader({alg:'RS256',kid:'integration'}).setIssuer(issuer).setAudience('test-audience').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
 const headers={'cf-access-jwt-assertion':jwt,'x-inbox-identity':JSON.stringify({email:'hammadshaikh43@gmail.com',expiresAt:9999999999})};
 const request=(path,extra={})=>mf.dispatchFetch('https://inbox.test'+path,{headers,...extra});
 assert.equal((await mf.dispatchFetch('https://inbox.test/api/v1/mailboxes',{headers:{'cf-access-authenticated-user-email':'hammadshaikh43@gmail.com'}})).status,403);
 assert.deepEqual((await (await request('/api/v1/mailboxes')).json()).map(m=>m.id),['reza@catenor.com']);
 assert.equal((await request('/api/v1/mailboxes/sabiha@catenor.com/emails')).status,403);
 assert.equal((await request('/agents/email-agent/sabiha@catenor.com/get-messages')).status,403);
 assert.equal((await request('/agents/email-mcp/reza@catenor.com')).status,403);
 assert.equal((await request('/mcp')).status,403);
 assert.equal((await request('/agents/email-agent/reza@catenor.com/onNewEmail',{method:'POST',body:JSON.stringify({mailboxId:'sabiha@catenor.com'})})).status,403);
 assert.equal((await request('/agents/email-agent/reza@catenor.com/get-messages')).status,200);
 const denied=await request('/agents/email-agent/sabiha@catenor.com',{headers:{...headers,Upgrade:'websocket'}});
 assert.equal(denied.status,403);
 const own=await request('/agents/email-agent/reza@catenor.com',{headers:{...headers,Upgrade:'websocket'}});
 assert.equal(own.status,101);
 const socket = own.webSocket;
 const initial = new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Authorized socket received no SDK greeting')),3000);
  socket.addEventListener('message',()=>{clearTimeout(timeout);resolve();},{once:true});
 });
 socket.accept();await initial;socket.close();
 // An already connected socket must stop working when its signed session expires.
 const shortJwt=await new SignJWT({email:'reza@cookdbrands.com'}).setProtectedHeader({alg:'RS256',kid:'integration'}).setIssuer(issuer).setAudience('test-audience').setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+3).sign(pair.privateKey);
 const short=await request('/agents/email-agent/reza@catenor.com',{headers:{'cf-access-jwt-assertion':shortJwt,Upgrade:'websocket'}});
 assert.equal(short.status,101);
 short.webSocket.accept();
 const closed=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Expired socket stayed open')),6500);
  short.webSocket.addEventListener('close',e=>{clearTimeout(timeout);resolve(e.code);},{once:true});
 });
 await new Promise(resolve=>setTimeout(resolve,3200));
 short.webSocket.send('{}');
 assert.equal(await closed,1008);
 }finally{await mf.dispose();}
});
