const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const routerPath = path.join(__dirname, '../server/stay-routes.js');

test('stay API uses approved JSON origin and server-only duration, bounded payload, cancellable session', async () => {
    assert.ok(fs.existsSync(routerPath), 'GPS stay API router must exist');
    const { createStayRouter } = require(routerPath);
    const { createStayStore } = require('../server/stay-store.js');
    let time=0;
    const {openVisits}=require('../server/visits.js');
    const visits=openVisits(':memory:');
    const verifyToken=async token=>{if(token!=='user-A')throw new Error('invalid_token');return {uid:token};};
    const app=express();app.use('/api/stays',createStayRouter({store:createStayStore({now:()=>time}),visits,verifyToken}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}/api/stays`;
    const post=(url,body,origin='https://spacecycle.space')=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Authorization:'Bearer user-A'},body:JSON.stringify(body)});
    try {
        assert.equal((await post('',{spaceId:'indoor-01'},'https://evil.example')).status,403);
        assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
        assert.equal((await post('',{spaceId:'indoor-01',requiredMs:1})).status,400);
        assert.equal((await post('',{spaceId:'outdoor-01'})).status,404);
        const created=await post('',{spaceId:'indoor-01'});
        assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');
        let s=await created.json();const id=s.id;
        const coords={latitude:36.7678561856971,longitude:126.933492079991,accuracy:5};
        const first=await post(`/${id}/sample`,{...coords,challenge:s.challenge});
        assert.equal(first.status,200);s=await first.json();
        assert.equal(s.phase,'dwelling');assert.equal(s.elapsedMs,0);
        for(let i=0;i<12;i++) {time+=5000;s=await (await post(`/${id}/sample`,{...coords,challenge:s.challenge})).json();}
        assert.equal(s.phase,'complete');assert.equal(s.persisted,true);assert.equal(s.foundSpaceCount,1);
        assert.equal((await post(`/${id}/cancel`,{challenge:s.challenge})).status,204);
        assert.equal((await post(`/${id}/sample`,{...coords,challenge:s.challenge})).status,410);
        assert.equal((await post('',{spaceId:'x'.repeat(3000)})).status,413);
    } finally { await new Promise(r=>server.close(r));visits.close(); }
});
