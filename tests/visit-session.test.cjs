const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../public/js/visit-session.js');
const { createStayStore } = require('../server/stay-store.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
    assert.ok(fs.existsSync(file), 'foreground location session must exist');
    const { createVisitSession } = require(file);
    let time = 100000;
    let gps;
    let requests = 0;
    let scheduled = [];
    const states = [];
    const store = createStayStore({ now: () => time });
    const geolocation = { getCurrentPosition: (ok, error, options) => { gps={ok,error,options}; } };
    const request = async (route, body) => {
        requests++;
        if (route === '/api/stays') return store.create(body.spaceId);
        const [,id,action] = route.match(/\/api\/stays\/([^/]+)\/(sample|cancel)/);
        return action === 'sample' ? store.sample(id,body) : store.cancel(id,body.challenge);
    };
    const controller = createVisitSession({ spaceId:'indoor-01', geolocation, request,
        onState: state => states.push(state), now:()=>time, wallNow:()=>time,
        schedule:(fn,ms)=>{const id={fn,at:time+ms};scheduled.push(id);return id;},
        unschedule:id=>{scheduled=scheduled.filter(x=>x!==id);} });
    const fix = (overrides={}) => gps.ok({coords:{latitude:36.7678561856971,longitude:126.933492079991,accuracy:5,...overrides},timestamp:time});
    const advance = async ms => {time+=ms;const callbacks=scheduled.filter(x=>x.at<=time);scheduled=scheduled.filter(x=>x.at>time);for(const x of callbacks)x.fn();await tick();};
    return {controller,states,fix,advance,get gps(){return gps;},get requests(){return requests;}};
}

test('location is opt-in, fresh fixes drive server elapsed time, and server completion stops polling', async () => {
    const x=setup();assert.equal(x.requests,0);
    x.controller.start();await tick();
    assert.equal(x.gps.options.maximumAge,0);assert.equal(x.gps.options.enableHighAccuracy,true);
    x.fix();await tick();assert.equal(x.states.at(-1).phase,'dwelling');
    assert.equal(x.states.at(-1).maxGapMs,12000,'display freshness limit must follow server deadline');
    assert.equal(x.states.at(-1).sampleEveryMs,3000,'existing polling interval must remain unchanged');
    for(let i=0;i<12;i++){await x.advance(5000);x.fix();await tick();}
    assert.equal(x.states.at(-1).phase,'complete');assert.equal(x.states.at(-1).active,false);
    const count=x.requests;await x.advance(5000);assert.equal(x.requests,count);
});

test('stop discards late GPS callbacks and a restart does not inherit prior elapsed time', async () => {
    const x=setup();x.controller.start();await tick();const late=x.gps;
    x.controller.stop('화면을 벗어나 초기화했어요.');await tick();const count=x.requests;
    late.ok({coords:{latitude:36.7678561856971,longitude:126.933492079991,accuracy:5},timestamp:100000});
    await tick();assert.equal(x.requests,count);assert.equal(x.states.at(-1).elapsedMs,0);
    x.controller.start();await tick();x.fix();await tick();
    assert.equal(x.states.at(-1).elapsedMs,0);x.controller.stop();
});

test('denied permission and a GPS timeout fail closed instead of counting time', async () => {
    for(const code of [1,2,3]){
        const x=setup();x.controller.start();await tick();x.gps.error({code});await tick();
        assert.equal(x.states.at(-1).phase,'error');assert.equal(x.states.at(-1).elapsedMs,0);
        assert.equal(x.states.at(-1).active,false);
    }
});

test('a stale GPS fix is rejected instead of being resent as a fresh heartbeat', async () => {
    const x=setup();x.controller.start();await tick();
    x.gps.ok({coords:{latitude:36.7678561856971,longitude:126.933492079991,accuracy:5},timestamp:1});await tick();
    assert.equal(x.states.at(-1).phase,'error');assert.equal(x.states.at(-1).elapsedMs,0);
});
