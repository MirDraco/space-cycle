const test=require('node:test');const assert=require('node:assert/strict');
const {createStayStore}=require('../server/stay-store.js');

test('expired sessions reclaim bounded capacity without reopening another account session',()=>{
 let time=0;const store=createStayStore({now:()=>time,maxSessions:2});
 const a=store.create('indoor-01','A'),b=store.create('indoor-01','B');
 assert.throws(()=>store.create('indoor-01','C'),/capacity/);
 assert.throws(()=>store.cancel(a.id,a.challenge,'B'),/wrong_owner/);
 time=600001;const c=store.create('indoor-01','C');assert.ok(c.id);
 assert.throws(()=>store.cancel(b.id,b.challenge,'B'),/session_missing/);
 store.cancel(c.id,c.challenge,'C');
});
