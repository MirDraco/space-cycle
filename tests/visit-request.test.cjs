const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const file=path.join(__dirname,'../public/js/visit-request.js');
const reply=(status,body,type='application/json')=>({ok:status>=200&&status<300,status,headers:{get:()=>type},json:async()=>body});
function setup(responses){assert.ok(fs.existsSync(file),'stay transport must expose real HTTP/auth errors');const api=require(file);let owner='A';const calls=[],refresh=[];const auth={getUser:()=>owner?{uid:owner}:null,getToken:async force=>{refresh.push(force);return force?'fresh':'cached';}};const request=api.createVisitRequest({getAuth:()=>auth,getOwner:()=>owner,fetchImpl:async(url,options)=>{calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;return next;}});return {api,request,calls,refresh,auth,setOwner:x=>owner=x};}
test('start/finish transport accepts only canonical routes, exact bounded payloads and known safe error codes', async()=>{
 const id='a'.repeat(48),challenge='b'.repeat(48),attemptId='c'.repeat(48),position={latitude:36.7,longitude:126.9,accuracy:5};
 const routes=[['/api/stays',{spaceId:'indoor-01',...position}],['/api/stays/resume',{spaceId:'indoor-01'}],
  ['/api/stays',{spaceId:'indoor-01',...position,attemptId}],['/api/stays/abandon',{spaceId:'indoor-01',attemptId}],
  [`/api/stays/${id}/finish`,{challenge,...position}],[`/api/stays/${id}/cancel`,{challenge}]];
 for(const [route,body] of routes){
  const noContent=route.endsWith('/cancel')||route.endsWith('/abandon');
  const x=setup([reply(noContent?204:200,{accepted:true})]);
  assert.deepEqual(await x.request(route,body),noContent?null:{accepted:true});
  assert.equal(x.calls[0].url,route);assert.equal(x.calls[0].options.method,'POST');
  assert.equal(x.calls[0].options.body,JSON.stringify(body));assert.equal(x.calls[0].options.cache,'no-store');
 }
 for(const [route,body] of [[`/api/stays/${id}/sample`,{challenge,...position}],['https://other/api/stays',{}],
  [{toString:()=>`/api/stays/${id}/finish`},{challenge,...position}],
  ['/api/stays/../finish',{}],['/api/stays/short/finish',{challenge,...position}],['/api/stays/resume',{spaceId:'x',latitude:36}],
  ['/api/stays',{spaceId:'x',...position,elapsedMs:60000}],['/api/stays',{spaceId:'x',...position,latitude:NaN}],
  ['/api/stays',{spaceId:'x',...position,longitude:181}],['/api/stays',{spaceId:'x',...position,accuracy:-1}],
  ['/api/stays',{spaceId:'x'.repeat(2100),...position}],['/api/stays/resume',null],
  ['/api/stays/abandon',{spaceId:'x'}],['/api/stays/abandon',{spaceId:'x',attemptId,uid:'PRIVATE'}],
  ['/api/stays/abandon',{spaceId:'x',attemptId,...position}],['/api/stays/abandon',{spaceId:'x',attemptId:'C'.repeat(48)}],
  ['/api/stays',{spaceId:'x',...position,attemptId:null}],['/api/stays',{spaceId:'x',...position,attemptId:47}]]){
  const x=setup([]);await assert.rejects(x.request(route,body),e=>e.code==='invalid_payload');assert.equal(x.calls.length,0);
 }
 for(const code of ['outside','uncertain','too_early','rate_limited','expired','start_cancelled']){
  const x=setup([reply(422,{error:code,details:'PRIVATE'})]);
  await assert.rejects(x.request('/api/stays/resume',{spaceId:'indoor-01'}),e=>e.code===code&&!e.message.includes('PRIVATE'));
 }
 const x=setup([reply(204,null)]);await assert.rejects(x.request('/api/stays/resume',{spaceId:'indoor-01'}),e=>e.code==='invalid_response');
});

test('transport rechecks the original owner after JSON parsing failures and rejects non-204 cancel success', async()=>{
 for(const abort of [false,true]){
  const x=setup([]),controller=new AbortController();let reject;
  x.auth.getToken=async()=> 'token';
  const api=x.api.createVisitRequest({getAuth:()=>x.auth,getOwner:()=>owner,
   fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:()=>new Promise((_,r)=>reject=r)})});
  let owner='A';
  const pending=api('/api/stays/resume',{spaceId:'indoor-01'},{signal:controller.signal});
  await new Promise(r=>setImmediate(r));
  if(abort)controller.abort();else{owner='B';x.setOwner('B');}
  reject(Error('PRIVATE JSON'));await assert.rejects(pending,e=>e.code===(abort?'cancelled':'identity_changed'));
 }
 const x=setup([reply(200,{ok:true})]);await assert.rejects(x.request(`/api/stays/${'a'.repeat(48)}/cancel`,{challenge:'b'.repeat(48)}),e=>e.code==='invalid_response');
 const abandon=setup([reply(200,{ok:true})]);await assert.rejects(abandon.request('/api/stays/abandon',{spaceId:'indoor-01',attemptId:'c'.repeat(48)}),e=>e.code==='invalid_response');
});

test('literal request payload is captured before token waits and owner is rechecked after response headers/body', async()=>{
 const x=setup([reply(200,{mode:'fixture'})]);let token;
 x.auth.getToken=()=>new Promise(resolve=>token=resolve);
 const body={spaceId:'indoor-01'},pending=x.request('/api/stays/resume',body);
 body.spaceId='other';token('token');await pending;
 assert.equal(x.calls[0].options.body,'{"spaceId":"indoor-01"}');
 for(const stage of ['fetch','json']){
  let owner='A',resolve;
  const auth={getUser:()=>({uid:owner}),getToken:async()=> 'token'};
  const response=reply(200,{mode:'fixture'});
  if(stage==='json')response.json=()=>new Promise(r=>resolve=r);
  const request=x.api.createVisitRequest({getAuth:()=>auth,getOwner:()=>owner,fetchImpl:()=>stage==='fetch'?new Promise(r=>resolve=r):Promise.resolve(response)});
  const waiting=request('/api/stays/resume',{spaceId:'indoor-01'});await new Promise(r=>setImmediate(r));
  owner='B';resolve(stage==='fetch'?response:{mode:'fixture'});
  await assert.rejects(waiting,e=>e.code==='identity_changed');
 }
});

test('401 retries once with a fresh Firebase token and keeps same-origin clearance cookies',async()=>{
 const x=setup([reply(401,{error:'invalid_token'}),reply(201,{id:'session'})]);
 assert.deepEqual(await x.request('/api/stays/resume',{spaceId:'indoor-01'}),{id:'session'});
 assert.deepEqual(x.refresh,[false,true]);assert.equal(x.calls.length,2);
 assert.equal(x.calls[1].options.headers.Authorization,'Bearer fresh');assert.equal(x.calls[1].options.credentials,'same-origin');
 const failed=setup([reply(401,{error:'invalid_token'}),reply(401,{error:'invalid_token'})]);
 await assert.rejects(failed.request('/api/stays/resume',{spaceId:'indoor-01'}),e=>e.code==='invalid_token'&&e.status===401);
 assert.equal(failed.calls.length,2);
});
test('server JSON and edge HTML errors remain distinct and never echo untrusted details',async()=>{
 for(const [response,code] of [[reply(403,{error:'origin_denied'}),'origin_denied'],[reply(429,{error:'capacity'}),'capacity'],[reply(503,{error:'save_failed'}),'save_failed'],[reply(403,'SECRET EDGE HTML','text/html'),'edge_blocked'],[reply(200,'HTML','text/html'),'invalid_response']]){
  const x=setup([response]);await assert.rejects(x.request('/api/stays/resume',{spaceId:'indoor-01'}),e=>e.code===code&&!e.message.includes('SECRET'));
 }
 const x=setup([new TypeError('private transport data')]);await assert.rejects(x.request('/api/stays/resume',{spaceId:'indoor-01'}),e=>e.code==='network_error'&&!e.message.includes('private'));
});
test('account changes or cancellation while awaiting a token send no stale request',async()=>{
 const x=setup([]);let done;x.auth.getToken=()=>new Promise(r=>done=r);
 const waiting=x.request('/api/stays/resume',{spaceId:'indoor-01'});x.setOwner('B');done('A-token');await assert.rejects(waiting,e=>e.code==='identity_changed');assert.equal(x.calls.length,0);
 const y=setup([]),controller=new AbortController();let resolve;y.auth.getToken=()=>new Promise(r=>resolve=r);
 const request=y.request('/api/stays/resume',{spaceId:'indoor-01'}, {signal:controller.signal});controller.abort();resolve('token');await assert.rejects(request,e=>e.code==='cancelled');assert.equal(y.calls.length,0);
});
