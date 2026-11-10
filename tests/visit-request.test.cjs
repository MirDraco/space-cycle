const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const file=path.join(__dirname,'../public/js/visit-request.js');
const reply=(status,body,type='application/json')=>({ok:status>=200&&status<300,status,headers:{get:()=>type},json:async()=>body});
function setup(responses){assert.ok(fs.existsSync(file),'stay transport must expose real HTTP/auth errors');const api=require(file);let owner='A';const calls=[],refresh=[];const auth={getUser:()=>owner?{uid:owner}:null,getToken:async force=>{refresh.push(force);return force?'fresh':'cached';}};const request=api.createVisitRequest({getAuth:()=>auth,getOwner:()=>owner,fetchImpl:async(url,options)=>{calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;return next;}});return {api,request,calls,refresh,auth,setOwner:x=>owner=x};}
test('401 retries once with a fresh Firebase token and keeps same-origin clearance cookies',async()=>{
 const x=setup([reply(401,{error:'invalid_token'}),reply(201,{id:'session'})]);
 assert.deepEqual(await x.request('/api/stays',{spaceId:'indoor-01'}),{id:'session'});
 assert.deepEqual(x.refresh,[false,true]);assert.equal(x.calls.length,2);
 assert.equal(x.calls[1].options.headers.Authorization,'Bearer fresh');assert.equal(x.calls[1].options.credentials,'same-origin');
 const failed=setup([reply(401,{error:'invalid_token'}),reply(401,{error:'invalid_token'})]);
 await assert.rejects(failed.request('/api/stays',{}),e=>e.code==='invalid_token'&&e.status===401);
 assert.equal(failed.calls.length,2);
});
test('server JSON and edge HTML errors remain distinct and never echo untrusted details',async()=>{
 for(const [response,code] of [[reply(403,{error:'origin_denied'}),'origin_denied'],[reply(429,{error:'capacity'}),'capacity'],[reply(503,{error:'save_failed'}),'save_failed'],[reply(403,'SECRET EDGE HTML','text/html'),'edge_blocked'],[reply(200,'HTML','text/html'),'invalid_response']]){
  const x=setup([response]);await assert.rejects(x.request('/api/stays',{}),e=>e.code===code&&!e.message.includes('SECRET'));
 }
 const x=setup([new TypeError('private transport data')]);await assert.rejects(x.request('/api/stays',{}),e=>e.code==='network_error'&&!e.message.includes('private'));
});
test('account changes or cancellation while awaiting a token send no stale request',async()=>{
 const x=setup([]);let done;x.auth.getToken=()=>new Promise(r=>done=r);
 const waiting=x.request('/api/stays',{});x.setOwner('B');done('A-token');await assert.rejects(waiting,e=>e.code==='identity_changed');assert.equal(x.calls.length,0);
 const y=setup([]),controller=new AbortController();let resolve;y.auth.getToken=()=>new Promise(r=>resolve=r);
 const request=y.request('/api/stays',{}, {signal:controller.signal});controller.abort();resolve('token');await assert.rejects(request,e=>e.code==='cancelled');assert.equal(y.calls.length,0);
});
