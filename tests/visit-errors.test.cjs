const test=require('node:test');const assert=require('node:assert/strict');
const {createVisitSession}=require('../public/js/visit-session.js');
const tick=()=>new Promise(r=>setImmediate(r));
test('stay failure UI distinguishes authentication, origin, edge, capacity and persistence from network failure',async()=>{
 for(const [code,word] of [['invalid_token','로그인'],['origin_denied','주소'],['edge_blocked','보안'],['capacity','요청'],['save_failed','저장'],['network_error','연결'],['auth_unavailable','인증 서버']]){
  const states=[];const session=createVisitSession({spaceId:'indoor-01',geolocation:{},request:async()=>{const e=Error('PRIVATE INTERNAL BODY');e.code=code;e.status=code==='invalid_token'?401:503;throw e;},onState:s=>states.push(s)});
  await session.start();await tick();const s=states.at(-1);assert.equal(s.phase,'error');assert.match(s.message,new RegExp(word));assert.equal(s.errorCode,code);assert.ok(!s.message.includes('PRIVATE'));
  if(!['network_error'].includes(code))assert.ok(!s.message.includes('인터넷 연결을 확인'));
 }
});
