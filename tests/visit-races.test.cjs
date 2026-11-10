const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisitSession } = require('../public/js/visit-session.js');
const { createStayStore } = require('../server/stay-store.js');
const flush = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };

function harness({ holdCreate = false, holdSample = false, failSample = false } = {}) {
    let clock=100000;
    const store=createStayStore({now:()=>clock});
    const creates=[], samples=[], cancels=[], states=[], fixes=[];
    let timers=[];
    const request=async(route,body)=>{
        if(route==='/api/stays'){
            const response=store.create(body.spaceId);const wait=deferred();creates.push({response,wait});
            return holdCreate?wait.promise:response;
        }
        const [,id,action]=route.match(/\/api\/stays\/([^/]+)\/(sample|cancel)/);
        if(action==='cancel'){cancels.push(id);return store.cancel(id,body.challenge);}
        if(failSample)throw new Error('offline');
        const response=store.sample(id,body),wait=deferred();samples.push({response,wait});
        return holdSample?wait.promise:response;
    };
    const session=createVisitSession({spaceId:'indoor-01',request,
        geolocation:{getCurrentPosition:(ok,error)=>fixes.push({ok,error})},
        now:()=>clock,wallNow:()=>clock,onState:s=>states.push(s),
        schedule:(fn,ms)=>{const item={fn,at:clock+ms};timers.push(item);return item;},
        unschedule:item=>{timers=timers.filter(x=>x!==item);},
    });
    const fix=()=>fixes.at(-1).ok({timestamp:clock,coords:{latitude:36.7678561856971,longitude:126.933492079991,accuracy:5}});
    const advance=async ms=>{clock+=ms;const due=timers.filter(t=>t.at<=clock);timers=timers.filter(t=>t.at>clock);for(const x of due)x.fn();await flush();};
    return {session,creates,samples,cancels,states,fixes,fix,advance,store};
}

test('pending create timeout and restart ignore a late old session and cancel it', async()=>{
    const h=harness({holdCreate:true});h.session.start();await flush();
    await h.advance(30001);assert.equal(h.states.at(-1).phase,'error');
    h.session.start();await flush();
    h.creates[0].wait.resolve(h.creates[0].response);await flush();
    assert.equal(h.fixes.length,0);assert.ok(h.cancels.includes(h.creates[0].response.id));
    h.creates[1].wait.resolve(h.creates[1].response);await flush();assert.equal(h.fixes.length,1);
    h.session.stop();await flush();
});

test('server sample reply arriving after stop cannot resurrect elapsed time',async()=>{
    const h=harness({holdSample:true});h.session.start();await flush();h.fix();await flush();
    h.session.stop();await flush();
    h.samples[0].wait.resolve(h.samples[0].response);await flush();
    assert.equal(h.states.at(-1).active,false);assert.equal(h.states.at(-1).elapsedMs,0);
    assert.throws(()=>h.store.inspect(h.creates[0].response.id),/session_missing/);
});

test('network errors reset and silence after a valid fix hits the 12-second deadline',async()=>{
    const failed=harness({failSample:true});failed.session.start();await flush();failed.fix();await flush();
    assert.equal(failed.states.at(-1).phase,'error');assert.equal(failed.states.at(-1).elapsedMs,0);
    const silent=harness();silent.session.start();await flush();silent.fix();await flush();
    await silent.advance(3000);await silent.advance(9001);
    assert.equal(silent.states.at(-1).phase,'error');assert.equal(silent.states.at(-1).elapsedMs,0);
    assert.equal(silent.session.isActive(),false);
});
