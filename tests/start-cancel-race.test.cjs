const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { openVisits } = require('../server/visits.js');
const { createStayProgress } = require('../server/stay-progress.js');
const { createStayRouter } = require('../server/stay-routes.js');
const { createVisitSession } = require('../public/js/visit-session.js');

const spaceId = 'indoor-01';
const center = { latitude: 36.768266, longitude: 126.933669, accuracy: 5 };
const attemptId = 'c'.repeat(48);
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
// Intentionally ignore AbortSignal: aborting a browser request cannot undo a
// POST already received by Express while asynchronous authentication is held.
function post(base, route, body, uid = 'owner') {
    return new Promise((resolve, reject) => {
        const req = http.request(base + route, { method: 'POST', headers: {
            'Content-Type': 'application/json', Origin: 'https://spacecycle.space',
            Authorization: `Bearer ${uid}`,
        } }, res => {
            let text = '';
            res.setEncoding('utf8'); res.on('data', part => { text += part; });
            res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject); req.end(JSON.stringify(body));
    });
}
async function api(t, { visits = openVisits(':memory:'), verifyToken = async uid => ({ uid }), ...options } = {}) {
    const progress = createStayProgress({ visits, ...options });
    const app = express();
    app.use('/api/stays', createStayRouter({ progress, verifyToken }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); visits.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { visits, progress, post: (route, body, uid) => post(base, '/api/stays' + route, body, uid) };
}

test('real delayed authentication cannot create progress after the client acknowledges pending-start cancellation', { timeout: 5000 }, async t => {
    const entered = deferred(), release = deferred(), originalReply = deferred();
    let authentications = 0;
    const fixture = await api(t, { verifyToken: async uid => {
        if (++authentications === 1) { entered.resolve(); await release.promise; }
        return { uid };
    } });
    t.after(() => release.resolve());
    const states = [], calls = [];
    const session = createVisitSession({ spaceId, createAttemptId: () => attemptId,
        geolocation: { getCurrentPosition(ok) { ok({ timestamp: Date.now(), coords: center }); } },
        onState: state => states.push(state),
        request: async (route, body) => {
            calls.push({ route, body });
            const response = await fixture.post(route.slice('/api/stays'.length), body);
            if (route === '/api/stays') originalReply.resolve(response);
            if (response.status >= 400) throw { code: response.body.error };
            return response.body;
        },
    });
    session.start(); await entered.promise;
    await session.stop();
    const claimedCancellation = session.getState();
    release.resolve();
    const lateReply = await originalReply.promise;
    const resumed = await fixture.post('/resume', { spaceId });
    assert.equal(claimedCancellation.phase, 'stopped', 'stop must complete without waiting for original authentication');
    assert.equal(resumed.body.phase, 'idle', 'no progress may appear after the client claims cancellation');
    assert.equal(lateReply.status, 409);
    assert.deepEqual(lateReply.body, { error: 'start_cancelled' });
    assert.deepEqual(calls.map(call => call.route), ['/api/stays', '/api/stays/abandon']);
    assert.deepEqual(calls[1].body, { spaceId, attemptId });
    assert.equal(session.getState().phase, 'stopped', 'late original response is generation-fenced');
    assert.equal(fixture.visits.list('owner').foundSpaceCount, 0);
});

test('a recovered existing wait and an unmapped delayed start are both cancelled before the client reports stopped', { timeout: 5000 }, async t => {
    const entered = deferred(), release = deferred(), originalReply = deferred(), recovered = deferred();
    let authentications = 0;
    const fixture = await api(t, { verifyToken: async uid => {
        if (++authentications === 1) { entered.resolve(); await release.promise; }
        return { uid };
    } });
    t.after(() => release.resolve());
    const existing = fixture.progress.start(spaceId, center, 'owner').state;
    const session = createVisitSession({ spaceId, createAttemptId: () => attemptId,
        geolocation: { getCurrentPosition(ok) { ok({ timestamp: Date.now(), coords: center }); } },
        onState: state => { if (state.phase === 'waiting') recovered.resolve(state); },
        request: async (route, body) => {
            const response = fixture.post(route.slice('/api/stays'.length), body);
            if (route === '/api/stays') {
                response.then(originalReply.resolve);
                await entered.promise;
                throw { code: 'network_error' }; // response lost while the server still authenticates
            }
            const reply = await response;
            if (reply.status >= 400) throw { code: reply.body.error };
            return reply.body;
        },
    });
    session.start();
    assert.equal((await recovered.promise).id, existing.id);
    await session.stop();
    release.resolve(); await originalReply.promise;
    assert.equal(session.getState().phase, 'stopped');
    assert.equal((await fixture.post('/resume', { spaceId })).body.phase, 'idle');
    assert.equal(fixture.visits.list('owner').foundSpaceCount, 0);
});

test('abandon-before-start survives a real database reopen and is idempotent and UID-scoped', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-intent-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    let visits = openVisits(filename);
    let store = createStayProgress({ visits, now: () => 1000 });
    store.abandon(spaceId, attemptId, 'owner');
    store.abandon(spaceId, attemptId, 'owner');
    visits.close(); visits = openVisits(filename);
    t.after(() => visits.close());
    store = createStayProgress({ visits, now: () => 2000 });
    assert.throws(() => store.start(spaceId, center, 'owner', attemptId), error => error.message === 'start_cancelled' && error.status === 409);
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    const other = store.start(spaceId, center, 'other', attemptId).state;
    store.abandon(spaceId, attemptId, 'owner');
    assert.equal(store.resume(spaceId, 'other').id, other.id);
    assert.equal(visits.list('owner').foundSpaceCount, 0);
});

test('attempt maps an existing progress ID; duplicate abandon cannot delete a later start or earned visits', t => {
    const visits = openVisits(':memory:'); t.after(() => visits.close());
    let time = 0;
    const store = createStayProgress({ visits, now: () => time });
    const original = store.start(spaceId, center, 'owner').state;
    const mapped = store.start(spaceId, center, 'owner', attemptId);
    assert.equal(mapped.created, false); assert.equal(mapped.state.id, original.id);
    assert.equal(store.start(spaceId, center, 'owner', attemptId).state.id, original.id);
    time = 60000;
    assert.equal(store.finish(original.id, { ...center, challenge: original.challenge }, 'owner').persisted, true);
    store.abandon(spaceId, attemptId, 'other');
    assert.equal(store.resume(spaceId, 'owner').phase, 'complete');
    store.abandon(spaceId, attemptId, 'owner');
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    assert.equal(visits.list('owner').foundSpaceCount, 1);
    const later = store.start(spaceId, center, 'owner', 'd'.repeat(48)).state;
    store.abandon(spaceId, attemptId, 'owner');
    assert.equal(store.resume(spaceId, 'owner').id, later.id);
    assert.throws(() => store.start(spaceId, center, 'owner', attemptId), /start_cancelled/);
    assert.throws(() => store.finish(original.id, { ...center, challenge: original.challenge }, 'owner'), /session_missing/);
    store.abandon(spaceId, 'd'.repeat(48), 'owner');
    assert.throws(() => store.finish(later.id, { ...center, challenge: later.challenge }, 'owner'), /session_missing/);
    assert.equal(visits.list('owner').foundSpaceCount, 1);
});

test('intent capacity is bounded, cleanup indexed and private; existing abandon still succeeds at capacity', t => {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-capacity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    const visits = openVisits(filename), observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    let time = 1000;
    const store = createStayProgress({ visits, now: () => time, maxAttempts: 1 });
    const first = store.start(spaceId, center, 'owner', attemptId).state;
    assert.equal(store.start(spaceId, center, 'owner', attemptId).state.id, first.id);
    const capacity = error => error.message === 'capacity' && error.status === 429;
    assert.throws(() => store.abandon(spaceId, 'd'.repeat(48), 'owner'), capacity);
    assert.equal(store.resume(spaceId, 'owner').id, first.id, 'failed early tombstone must not claim or perform cancellation');
    assert.throws(() => store.start(spaceId, center, 'other', 'd'.repeat(48)), capacity);
    store.abandon(spaceId, attemptId, 'owner'); store.abandon(spaceId, attemptId, 'owner');
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    const rows = observer.prepare('SELECT * FROM stay_start_attempts').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].cancelled, 1);
    assert.equal(rows[0].progress_id, first.id); assert.equal(rows[0].expires_at, 7201000);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['uid', 'attempt_id', 'space_id', 'progress_id', 'cancelled', 'expires_at'].sort());
    assert.doesNotMatch(JSON.stringify(rows), /36\.768266|126\.933669|latitude|longitude|accuracy|challenge/);
    const plan = observer.prepare('EXPLAIN QUERY PLAN DELETE FROM stay_start_attempts WHERE expires_at <= ?').all(time);
    assert.ok(plan.some(row => /SEARCH.*INDEX.*expires/i.test(row.detail)), JSON.stringify(plan));
    time = 7201000;
    assert.equal(store.start(spaceId, center, 'other', 'd'.repeat(48)).created, true);
    assert.equal(observer.prepare('SELECT count(*) AS n FROM stay_start_attempts').get().n, 1);
});

test('default intent capacity is 10000 durable rows and cannot evict an unexpired cancellation', t => {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-default-capacity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    const visits = openVisits(filename), observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const store = createStayProgress({ visits, now: () => 0 });
    store.abandon(spaceId, attemptId, 'owner');
    const insert = observer.prepare('INSERT INTO stay_start_attempts VALUES(?,?,?,?,?,?)');
    observer.exec('BEGIN IMMEDIATE');
    for (let count = 1; count < 10000; count++) {
        insert.run(`fixture-${count}`, count.toString(16).padStart(48, '0'), spaceId, null, 1, 7200000);
    }
    observer.exec('COMMIT');
    assert.throws(() => store.abandon(spaceId, 'd'.repeat(48), 'overflow'), error => error.message === 'capacity' && error.status === 429);
    store.abandon(spaceId, attemptId, 'owner');
    assert.throws(() => store.start(spaceId, center, 'owner', attemptId), /start_cancelled/);
    assert.equal(observer.prepare('SELECT count(*) AS n FROM stay_start_attempts').get().n, 10000);
});

test('abandon rollback is atomic and exposes no private SQLite failure details over the actual API', async t => {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-rollback-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    const fixture = await api(t, { visits: openVisits(filename), now: () => 1000 });
    const observer = new DatabaseSync(filename); t.after(() => observer.close());
    const started = await fixture.post('', { spaceId, ...center, attemptId });
    assert.equal(started.status, 201);
    observer.exec(`CREATE TRIGGER fixture_fail_abandon BEFORE DELETE ON stay_progress
        BEGIN SELECT RAISE(ABORT, 'PRIVATE owner GPS database detail'); END;`);
    const failed = await fixture.post('/abandon', { spaceId, attemptId });
    assert.equal(failed.status, 503); assert.deepEqual(failed.body, { error: 'save_failed' });
    assert.equal(observer.prepare('SELECT cancelled FROM stay_start_attempts').get().cancelled, 0);
    assert.equal((await fixture.post('/resume', { spaceId })).body.id, started.body.id);
    observer.exec('DROP TRIGGER fixture_fail_abandon');
    assert.equal((await fixture.post('/abandon', { spaceId, attemptId })).status, 204);
    assert.equal((await fixture.post('', { spaceId, ...center, attemptId })).status, 409);
    assert.equal((await fixture.post('/resume', { spaceId })).body.phase, 'idle');
    assert.equal(fixture.visits.list('owner').foundSpaceCount, 0);
});

test('abandon API accepts only exact known fields and canonical attempt IDs, shares authenticated rate limits', async t => {
    const fixture = await api(t);
    for (const bad of [{ spaceId }, { attemptId }, { spaceId, attemptId, uid: 'other' },
        { spaceId, attemptId, latitude: center.latitude }, { spaceId, attemptId, challenge: 'b'.repeat(48) },
        ...[null, 1, 'c'.repeat(47), 'C'.repeat(48), 'g'.repeat(48)].map(id => ({ spaceId, attemptId: id }))]) {
        const response = await fixture.post('/abandon', bad);
        assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'invalid_payload' });
    }
    for (const id of [null, 1, '', 'C'.repeat(48)]) {
        const response = await fixture.post('', { spaceId, ...center, attemptId: id });
        assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'invalid_payload' });
    }
    assert.equal((await fixture.post('/abandon', { spaceId, attemptId })).status, 204);
    const late = await fixture.post('', { spaceId, ...center, attemptId });
    assert.equal(late.status, 409); assert.deepEqual(late.body, { error: 'start_cancelled' });
    for (let count = 0; count < 60; count++) {
        const response = await fixture.post('/abandon', { spaceId, attemptId }, 'rate-owner');
        assert.equal(response.status, 204);
    }
    const limited = await fixture.post('/abandon', { spaceId, attemptId }, 'rate-owner');
    assert.equal(limited.status, 429); assert.deepEqual(limited.body, { error: 'rate_limited' });
});

test('failed start-attempt mapping rolls back the progress insert rather than leaving uncancellable progress', t => {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-mapping-rollback-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    const visits = openVisits(filename), observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const store = createStayProgress({ visits, now: () => 1000 });
    observer.exec(`CREATE TRIGGER fixture_fail_mapping BEFORE INSERT ON stay_start_attempts
        BEGIN SELECT RAISE(ABORT, 'PRIVATE mapping UID GPS'); END;`);
    assert.throws(() => store.start(spaceId, center, 'owner', attemptId), error => error.message === 'save_failed' && error.status === 503);
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    assert.equal(observer.prepare('SELECT count(*) AS n FROM stay_start_attempts').get().n, 0);
    assert.throws(() => store.abandon(spaceId, attemptId, 'owner'), /save_failed/);
    observer.exec('DROP TRIGGER fixture_fail_mapping');
    assert.equal(store.start(spaceId, center, 'owner', attemptId).created, true);
    store.abandon(spaceId, attemptId, 'owner');
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
});
