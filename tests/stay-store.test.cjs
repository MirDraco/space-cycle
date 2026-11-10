const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const file = path.join(__dirname, '../server/stay-store.js');

function setup() {
    assert.ok(fs.existsSync(file), 'server-authoritative stay engine must exist');
    const { createStayStore, assessPosition } = require(file);
    let time = 0;
    const store = createStayStore({ now: () => time });
    const advance = ms => { time += ms; };
    const center = { latitude: 36.768266, longitude: 126.933669, accuracy: 5 };
    return { store, advance, center, assessPosition };
}

test('exact supplied coordinates, requested 300m and 60s are enforced by server monotonic time', () => {
    const { store, advance, center } = setup();
    let s = store.create('indoor-01');
    assert.equal(s.space.name, '향설생활관2');
    assert.equal(s.space.latitude, 36.768266);
    assert.equal(s.space.longitude, 126.933669);
    assert.equal(s.space.radiusM, 300);
    assert.equal(s.requiredMs, 60000);
    s = store.sample(s.id, { challenge: s.challenge, ...center });
    assert.equal(s.phase, 'dwelling');
    assert.equal(s.distanceM, 0, 'the exact new coordinates are the center of the configured radius');
    assert.equal(s.elapsedMs, 0);
    for (let i=0;i<11;i++) { advance(5000); s=store.sample(s.id,{challenge:s.challenge,...center}); }
    assert.equal(s.phase,'dwelling');
    assert.equal(s.elapsedMs,55000);
    advance(5000); s=store.sample(s.id,{challenge:s.challenge,...center});
    assert.equal(s.phase,'complete');
    assert.equal(s.elapsedMs,60000);
    assert.equal(s.persisted,false);
});

test('outside, uncertain accuracy and interrupted samples reset continuous time', () => {
    const { store, advance, center } = setup();
    let s=store.create('indoor-01');
    s=store.sample(s.id,{challenge:s.challenge,...center});
    advance(5000);s=store.sample(s.id,{challenge:s.challenge,...center});
    s=store.sample(s.id,{challenge:s.challenge,...center,latitude:center.latitude+0.004});
    assert.equal(s.phase,'outside');assert.equal(s.elapsedMs,0);
    advance(5000);s=store.sample(s.id,{challenge:s.challenge,...center});assert.equal(s.elapsedMs,0);
    advance(5000);s=store.sample(s.id,{challenge:s.challenge,...center,accuracy:80});
    assert.equal(s.phase,'uncertain');assert.equal(s.elapsedMs,0);
    s=store.sample(s.id,{challenge:s.challenge,...center});
    advance(25001);s=store.sample(s.id,{challenge:s.challenge,...center});
    assert.equal(s.phase,'dwelling');assert.equal(s.elapsedMs,0);assert.equal(s.reason,'gap');
});

test('accuracy circle must fit inside the radius; invalid numeric positions never count', () => {
    const { assessPosition, center }=setup();
    const location=require('../public/js/space-data.js').getSpace('indoor-01');
    assert.equal(assessPosition(location,center).phase,'inside');
    const atMeters = (meters, accuracy) => ({ ...center, latitude: center.latitude + meters / 6371000 * 180 / Math.PI, accuracy });
    assert.equal(assessPosition(location,atMeters(60,50)).phase,'inside','60m plus 50m uncertainty fits the requested radius');
    assert.equal(assessPosition(location,atMeters(250,40)).phase,'inside');
    assert.equal(assessPosition(location,atMeters(280,30)).phase,'uncertain');
    assert.equal(assessPosition(location,atMeters(310,5)).phase,'outside');
    assert.equal(assessPosition(location,atMeters(60,80)).phase,'uncertain','radius change must not weaken the separate accuracy limit');
    assert.equal(assessPosition(location,{...center,latitude:center.latitude+0.0025,accuracy:30}).phase,'uncertain');
    for(const value of [NaN,Infinity,'36.7',null]) assert.throws(()=>assessPosition(location,{...center,latitude:value}));
    assert.throws(()=>assessPosition(location,{...center,accuracy:-1}));
    assert.throws(()=>assessPosition(location,{...center,longitude:200}));
});

test('unconfigured spaces, client time fields, replayed challenges and cancelled sessions fail closed', () => {
    const {store,center}=setup();
    assert.throws(()=>store.create('outdoor-01'),/not_configured/);
    assert.throws(()=>store.create('bogus'),/not_configured/);
    const s=store.create('indoor-01');
    assert.throws(()=>store.sample(s.id,{challenge:s.challenge,...center,elapsedMs:60000}),/invalid_payload/);
    const active=store.sample(s.id,{challenge:s.challenge,...center});
    assert.throws(()=>store.sample(s.id,{challenge:s.challenge,...center}),/stale_challenge/);
    assert.throws(()=>store.cancel(s.id,'wrong'),/stale_challenge/);
    store.cancel(s.id,active.challenge);
    assert.throws(()=>store.sample(s.id,{challenge:active.challenge,...center}),/session_missing/);
});

test('silence cannot complete, sessions expire, and server state never contains raw location samples', () => {
    const {store,advance,center}=setup();
    let s=store.create('indoor-01');s=store.sample(s.id,{challenge:s.challenge,...center});
    advance(60000);s=store.sample(s.id,{challenge:s.challenge,...center});
    assert.equal(s.phase,'dwelling');assert.equal(s.elapsedMs,0);
    assert.equal(store.inspect(s.id).latitude,undefined);
    assert.equal(store.inspect(s.id).longitude,undefined);
    advance(600001);
    assert.throws(()=>store.sample(s.id,{challenge:s.challenge,...center}),/session_missing/);
});
