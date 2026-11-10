const test=require('node:test');const assert=require('node:assert/strict');
const express=require('express');const {createStayStore}=require('../server/stay-store.js');const {createStayRouter}=require('../server/stay-routes.js');
const {openVisits}=require('../server/visits.js');
const center={latitude:36.7678561856971,longitude:126.933492079991,accuracy:5};

test('failed persistence never claims success; a new full stay can safely retry without double counting',async()=>{
 let clock=0,fail=true;const actual=openVisits(':memory:');const store=createStayStore({now:()=>clock});
 const visits={record:(uid,id)=>{if(fail)throw Error('database private internal detail');return actual.record(uid,id);}};
 const verifyToken=async()=>({uid:'owner'});const app=express();app.use('/api/stays',createStayRouter({store,visits,verifyToken}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/stays`;
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{Origin:'https://spacecycle.space','Content-Type':'application/json',Authorization:'Bearer fixture'},body:JSON.stringify(body)});
 try{
  let s=await(await post('',{spaceId:'indoor-01'})).json();s=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();
  for(let i=0;i<11;i++){clock+=5000;s=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();}
  clock+=5000;const error=await post(`/${s.id}/sample`,{...center,challenge:s.challenge});assert.equal(error.status,503);assert.deepEqual(await error.json(),{error:'save_failed'});
  assert.equal(actual.list('owner').foundSpaceCount,0);
  // Failed response did not reveal the rotated challenge: old challenge safely cannot mutate.
  assert.equal((await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).status,409);
  // A new successful full stay (not a client completion flag) earns the first count.
  fail=false;s=await(await post('',{spaceId:'indoor-01'})).json();s=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();
  for(let i=0;i<12;i++){clock+=5000;s=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();}
  assert.equal(s.persisted,true);assert.equal(s.foundSpaceCount,1);
  const duplicate=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();assert.equal(duplicate.newlyFound,false);assert.equal(duplicate.foundSpaceCount,1);
 }finally{await new Promise(r=>server.close(r));actual.close();}
});

test('strict API origins, methods, content types and parsing boundaries are preserved',async()=>{
 const visits=openVisits(':memory:');const app=express();app.use('/api/stays',createStayRouter({visits,verifyToken:async()=>({uid:'owner'})}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/api/stays';
 const headers={Origin:origin,Authorization:'Bearer fixture','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(url,{method:'GET',headers})).status,405);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{'})).status,400);
  for(const bad of ['null','https://spacecycle.space.evil.test',origin+'/',origin.replace('127.0.0.1','localhost'),'http://127.0.0.1:1']){
   assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:bad},body:'{}'})).status,403);
  }
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({spaceId:'indoor-01'})})).status,201);
 }finally{await new Promise(r=>server.close(r));visits.close();}
});
