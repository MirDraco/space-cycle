const test=require('node:test');const assert=require('node:assert/strict');
const {createVisitSession}=require('../public/js/visit-session.js');
const {readStayPolicy}=require('../server/stay-policy.js');
const tick=()=>new Promise(r=>setImmediate(r));
async function complete(persisted,newlyFound){
 let success;const states=[];let samples=0;
 const response={id:'session',challenge:'challenge',requiredMs:60000,elapsedMs:0,...readStayPolicy({}),phase:'waiting',distanceM:0,accuracyM:5};
 const session=createVisitSession({spaceId:'indoor-01',geolocation:{getCurrentPosition:ok=>{success=ok;}},request:async route=>{
  if(route==='/api/stays')return response;
  if(route.endsWith('/cancel'))return null;
  samples++;return {...response,phase:'complete',elapsedMs:60000,persisted,newlyFound,foundSpaceCount:1};
 },onState:s=>states.push(s)});
 session.start();await tick();success({timestamp:Date.now(),coords:{latitude:36.7678561856971,longitude:126.933492079991,accuracy:5}});await tick();
 return {states,samples};
}
test('saved first completion and duplicate completion explain the distinct count',async()=>{
 const fresh=await complete(true,true);assert.equal(fresh.states.at(-1).persisted,true);assert.match(fresh.states.at(-1).message,/1곳/);assert.match(fresh.states.at(-1).message,/추가/);
 const repeat=await complete(true,false);assert.equal(repeat.states.at(-1).persisted,true);assert.match(repeat.states.at(-1).message,/이미/);assert.match(repeat.states.at(-1).message,/중복/);
 const unpersisted=await complete(false,false);assert.equal(unpersisted.states.at(-1).persisted,false);assert.match(unpersisted.states.at(-1).message,/저장되지/);
});
