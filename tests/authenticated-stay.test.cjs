const test=require('node:test');const assert=require('node:assert/strict');
const express=require('express');const fs=require('node:fs');const path=require('node:path');
const {createStayRouter}=require('../server/stay-routes.js');const {createStayStore}=require('../server/stay-store.js');
const {openVisits}=require('../server/visits.js');

test('only the authenticated session owner can earn a space; repeat completions stay at one',async()=>{
    let time=0;const visits=openVisits(':memory:');const store=createStayStore({now:()=>time});
    const verifyToken=async token=>{if(!['user-A','user-B'].includes(token))throw new Error('invalid_token');return {uid:token};};
    const app=express();app.use('/api/stays',createStayRouter({store,visits,verifyToken}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/stays`;
    const post=(route,body,token='user-A')=>fetch(base+route,{method:'POST',headers:{Origin:'https://spacecycle.space','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    const center={latitude:36.7678561856971,longitude:126.933492079991,accuracy:5};
    try{
        assert.equal((await post('',{spaceId:'indoor-01'},null)).status,401);
        assert.equal((await post('',{spaceId:'indoor-01'},'forged')).status,401);
        assert.equal((await post('',{spaceId:'indoor-01',uid:'user-B'})).status,400);
        for(let visit=0;visit<2;visit++){
            const creation=await post('',{spaceId:'indoor-01'});assert.equal(creation.status,201);let s=await creation.json();
            assert.equal((await post(`/${s.id}/sample`,{...center,challenge:s.challenge},'user-B')).status,403);
            assert.equal((await post(`/${s.id}/cancel`,{challenge:s.challenge},'user-B')).status,403);
            s=await (await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();
            assert.equal(visits.list('user-A').foundSpaceCount,visit===0?0:1);
            for(let i=0;i<12;i++){time+=5000;s=await(await post(`/${s.id}/sample`,{...center,challenge:s.challenge})).json();}
            assert.equal(s.phase,'complete');assert.equal(s.persisted,true);assert.equal(s.foundSpaceCount,1);assert.equal(s.newlyFound,visit===0);
            assert.deepEqual(visits.list('user-A'),{foundSpaces:['indoor-01'],foundSpaceCount:1});
            assert.equal(visits.list('user-B').foundSpaceCount,0);
            assert.equal((await post(`/${s.id}/cancel`,{challenge:s.challenge})).status,204);
        }
        // A fresh login by a different account owns only its own session.
        let other=await(await post('',{spaceId:'indoor-01'},'user-B')).json();
        assert.equal((await post(`/${other.id}/sample`,{...center,challenge:other.challenge})).status,403);
        assert.equal((await post(`/${other.id}/cancel`,{challenge:other.challenge},'user-B')).status,204);
    }finally{await new Promise(r=>server.close(r));visits.close();}
});

test('personal counts require a verified token and cannot be read for arbitrary client UIDs',async()=>{
    const file=path.join(__dirname,'../server/me-routes.js');assert.ok(fs.existsSync(file),'authenticated personal count API must exist');
    const {createMeRouter}=require(file);const visits=openVisits(':memory:');visits.record('user-A','indoor-01');
    const verifyToken=async token=>{if(!['user-A','user-B'].includes(token))throw new Error('invalid_token');return {uid:token};};
    const app=express();app.use('/api/me',createMeRouter({visits,verifyToken}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/me/spaces`;
    try{
        assert.equal((await fetch(base)).status,401);
        const a=await fetch(base,{headers:{Authorization:'Bearer user-A'}});assert.equal(a.headers.get('cache-control'),'no-store');assert.deepEqual(await a.json(),{foundSpaces:['indoor-01'],foundSpaceCount:1});
        const b=await fetch(base,{headers:{Authorization:'Bearer user-B'}});assert.deepEqual(await b.json(),{foundSpaces:[],foundSpaceCount:0});
        assert.equal((await fetch(base+'?uid=user-A',{headers:{Authorization:'Bearer user-B'}})).status,400);
        assert.equal((await fetch(base,{method:'POST',headers:{Authorization:'Bearer user-A'}})).status,405);
    }finally{await new Promise(r=>server.close(r));visits.close();}
});
