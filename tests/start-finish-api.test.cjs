const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createStayRouter } = require('../server/stay-routes.js');
const { createStayProgress } = require('../server/stay-progress.js');
const { openVisits } = require('../server/visits.js');

const spaceId = 'indoor-01';
const center = { latitude: 36.767780, longitude: 126.933294, accuracy: 5 };
const startBody = { spaceId, ...center };
const verifyToken = async token => {
    if (!/^user-[A-Z0-9-]+$/.test(token)) throw Error('invalid_token');
    return { uid: token };
};
async function api(t, { visits, progress, ...options } = {}) {
    const owned = !visits;
    visits ||= openVisits(':memory:');
    const app = express();
    app.use('/api/stays', createStayRouter({ visits, progress, verifyToken, ...options }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); if (owned) visits.close(); });
    const base = `http://127.0.0.1:${server.address().port}/api/stays`;
    const post = (route, body, token = 'user-A', headers = {}) => fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://spacecycle.space',
            ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
    });
    return { base, post, visits };
}

test('POST start and resume expose the fixed durable start_finish snapshots without legacy sampling', async t => {
    let time = 1000;
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    const progress = createStayProgress({ visits, now: () => time });
    const { post } = await api(t, { visits, progress });
    const idle = await post('/resume', { spaceId });
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), {
        mode: 'start_finish', phase: 'idle', spaceId, requiredMs: 60000,
        locationTimeoutMs: 15000, initialTimeoutMs: 30000,
    });
    assert.equal((await post('', { spaceId })).status, 400, 'no GPS start is rejected');
    const creation = await post('', startBody);
    assert.equal(creation.status, 201);
    assert.equal(creation.headers.get('cache-control'), 'no-store');
    const state = await creation.json();
    assert.deepEqual(Object.keys(state).sort(), [
        'mode', 'id', 'challenge', 'spaceId', 'phase', 'elapsedMs', 'requiredMs', 'expiresInMs',
        'distanceM', 'accuracyM', 'persisted', 'newlyFound', 'locationTimeoutMs', 'initialTimeoutMs',
    ].sort());
    assert.equal(state.mode, 'start_finish');
    assert.equal(state.phase, 'waiting');
    assert.match(state.id, /^[0-9a-f]{48}$/);
    assert.match(state.challenge, /^[0-9a-f]{48}$/);
    assert.equal(state.elapsedMs, 0);
    assert.equal(state.requiredMs, 60000);
    assert.equal(state.distanceM, 0);
    assert.equal(state.accuracyM, 5);
    time += 45000;
    const resumed = await (await post('/resume', { spaceId })).json();
    assert.deepEqual(resumed, { ...state, elapsedMs: 45000, expiresInMs: 7155000, distanceM: null, accuracyM: null });
    const duplicate = await post('', startBody);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ...resumed, distanceM: 0, accuracyM: 5 });
    const sample = await post(`/${state.id}/sample`, { ...center, challenge: state.challenge });
    assert.equal(sample.status, 404);
    assert.deepEqual(await (await post('/resume', { spaceId })).json(), resumed);
    assert.equal(visits.list('user-A').foundSpaceCount, 0);
});

test('finish returns stable errors without losing time and persists replay-safe completion', async t => {
    let time = 5000;
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    const progress = createStayProgress({ visits, now: () => time });
    const { post } = await api(t, { visits, progress });
    for (const [body, error] of [[{ ...startBody, latitude: 0, longitude: 0 }, 'outside'], [{ ...startBody, accuracy: 101 }, 'uncertain']]) {
        const response = await post('', body);
        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), { error });
    }
    const start = await (await post('', startBody)).json();
    const body = { ...center, challenge: start.challenge };
    const early = await post(`/${start.id}/finish`, body);
    assert.equal(early.status, 409);
    assert.deepEqual(await early.json(), { error: 'too_early' });
    time += 60000;
    const outside = await post(`/${start.id}/finish`, { ...body, latitude: 0, longitude: 0 });
    assert.equal(outside.status, 422);
    assert.deepEqual(await outside.json(), { error: 'outside' });
    const uncertain = await post(`/${start.id}/finish`, { ...body, accuracy: 101 });
    assert.equal(uncertain.status, 422);
    assert.deepEqual(await uncertain.json(), { error: 'uncertain' });
    assert.equal((await (await post('/resume', { spaceId })).json()).phase, 'ready');
    const completeResponse = await post(`/${start.id}/finish`, body);
    assert.equal(completeResponse.status, 200);
    const complete = await completeResponse.json();
    assert.deepEqual(complete, {
        ...start, phase: 'complete', elapsedMs: 60000, expiresInMs: 7140000,
        persisted: true, newlyFound: true, foundSpaceCount: 1,
    });
    const repeated = await (await post(`/${start.id}/finish`, body)).json();
    assert.deepEqual(repeated, { ...complete, newlyFound: false });
    const canceled = await post(`/${start.id}/cancel`, { challenge: start.challenge });
    assert.equal(canceled.status, 204);
    assert.equal(await canceled.text(), '');
    assert.equal(visits.list('user-A').foundSpaceCount, 1);
    assert.equal((await post(`/${start.id}/finish`, body)).status, 410);
});

test('the authenticated UID limiter caps 60 requests per minute and expires at most 10000 buckets', async t => {
    let time = 0;
    const { post } = await api(t, { limiter: undefined });
    for (let count = 0; count < 60; count++) {
        assert.equal((await post('/resume', { spaceId })).status, 200);
    }
    const limited = await post('/resume', { spaceId });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
    assert.equal((await post('/resume', { spaceId }, 'user-B')).status, 200);
    const { createStayRateLimiter } = require('../server/stay-routes.js');
    const limiter = createStayRateLimiter({ now: () => time });
    for (let count = 0; count < 10000; count++) limiter(`fixture-${count}`);
    assert.throws(() => limiter('overflow'), error => error.message === 'rate_limited' && error.status === 429);
    for (let count = 1; count < 60; count++) limiter('fixture-0');
    assert.throws(() => limiter('fixture-0'), /rate_limited/);
    time = 60000;
    assert.doesNotThrow(() => limiter('overflow'));
    assert.doesNotThrow(() => limiter('fixture-0'));
    // A focused injected limiter and clock exercises the actual router expiry path.
    const tiny = createStayRateLimiter({ now: () => time, maxRequests: 1, maxEntries: 1 });
    const other = await api(t, { limiter: tiny });
    assert.equal((await other.post('/resume', { spaceId }, null)).status, 401, 'unauthenticated requests allocate no UID bucket');
    assert.equal((await other.post('/resume', { spaceId })).status, 200);
    assert.equal((await other.post('/resume', { spaceId })).status, 429);
    assert.equal((await other.post('/resume', { spaceId }, 'user-B')).status, 429);
    time += 60000;
    assert.equal((await other.post('/resume', { spaceId }, 'user-B')).status, 200);
});

test('default router progress resumes after a database reopen and duplicate parallel requests earn once', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-finish-api-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'visits.sqlite');
    const firstVisits = openVisits(filename);
    const first = await api(t, { visits: firstVisits });
    const starts = await Promise.all(Array.from({ length: 12 }, () => first.post('', startBody)));
    assert.equal(starts.filter(response => response.status === 201).length, 1);
    assert.equal(starts.filter(response => response.status === 200).length, 11);
    const states = await Promise.all(starts.map(response => response.json()));
    assert.equal(new Set(states.map(state => state.id)).size, 1);
    assert.equal(new Set(states.map(state => state.challenge)).size, 1);
    const original = states[0];
    firstVisits.close();
    const reopened = openVisits(filename);
    t.after(() => reopened.close());
    const now = Date.now() + 60000;
    const progress = createStayProgress({ visits: reopened, now: () => now });
    const second = await api(t, { visits: reopened, progress });
    const state = await (await second.post('/resume', { spaceId })).json();
    assert.equal(state.id, original.id);
    assert.equal(state.challenge, original.challenge);
    assert.equal(state.phase, 'ready');
    assert.equal(state.elapsedMs, 60000);
    assert.equal(state.distanceM, null);
    const results = await Promise.all(Array.from({ length: 12 }, async () => {
        const response = await second.post(`/${state.id}/finish`, { ...center, challenge: state.challenge });
        assert.equal(response.status, 200);
        return response.json();
    }));
    assert.equal(results.filter(result => result.newlyFound).length, 1);
    for (const result of results) {
        assert.equal(result.persisted, true);
        assert.equal(result.foundSpaceCount, 1);
        assert.equal(result.challenge, original.challenge);
    }
    assert.deepEqual(reopened.list('user-A'), { foundSpaces: [spaceId], foundSpaceCount: 1 });
    assert.deepEqual(reopened.list('user-B'), { foundSpaces: [], foundSpaceCount: 0 });
});

test('start resume finish cancel reject all extra fields and invalid numeric coordinates without disturbing progress', async t => {
    let time = 1000;
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    const progress = createStayProgress({ visits, now: () => time });
    const { post } = await api(t, { visits, progress });
    for (const body of [{ spaceId }, { ...startBody, complete: true }, { ...startBody, requiredMs: 1 }, { ...startBody, elapsedMs: 60000 }]) {
        assert.equal((await post('', body)).status, 400);
    }
    for (const coordinates of [{ latitude: '36.767780' }, { latitude: null }, { latitude: 91 }, { longitude: -181 }, { accuracy: '5' }, { accuracy: -1 }]) {
        const response = await post('', { ...startBody, ...coordinates });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'invalid_position' });
    }
    const start = await (await post('', startBody)).json();
    time += 60000;
    const finish = { ...center, challenge: start.challenge };
    assert.equal((await post('/resume', { spaceId, uid: 'user-B' })).status, 400);
    assert.equal((await post('/resume', { spaceId, challenge: start.challenge })).status, 400);
    assert.equal((await post(`/${start.id}/finish`, { ...finish, elapsedMs: 60000 })).status, 400);
    assert.equal((await post(`/${start.id}/finish`, { ...finish, accuracy: '5' })).status, 400);
    assert.equal((await post(`/${start.id}/finish`, { ...finish, challenge: 1 })).status, 409);
    assert.equal((await post(`/${start.id}/finish`, finish, 'user-B')).status, 403);
    assert.equal((await post(`/${start.id}/cancel`, { challenge: start.challenge, uid: 'user-B' })).status, 400);
    assert.equal((await post(`/${start.id}/cancel`, { challenge: start.challenge }, 'user-B')).status, 403);
    assert.equal((await post('', { ...startBody, accuracy: 101 })).status, 422);
    const ready = await (await post('/resume', { spaceId })).json();
    assert.equal(ready.id, start.id);
    assert.equal(ready.challenge, start.challenge);
    assert.equal(ready.elapsedMs, 60000);
    assert.equal(ready.phase, 'ready');
    assert.equal((await post(`/${start.id}/finish`, finish)).status, 200);
});

test('constructing the default router and anonymous requests do not open a real database', async t => {
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-finish-lazy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'never-opened.sqlite');
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const express = require('express');
        const { createStayRouter } = require(${JSON.stringify(path.join(__dirname, '../server/stay-routes.js'))});
        (async () => {
            const app = express(); app.use('/api/stays', createStayRouter());
            assert.equal(fs.existsSync(process.env.SPACE_CYCLE_DB), false, 'router construction must not open storage');
            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            try {
                const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/stays/resume', {
                    method: 'POST', headers: { Origin: 'https://spacecycle.space', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ spaceId: 'indoor-01' }),
                });
                assert.equal(response.status, 401);
                assert.equal(fs.existsSync(process.env.SPACE_CYCLE_DB), false, 'anonymous requests must not open storage');
            } finally { await new Promise(resolve => server.close(resolve)); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { env: { ...process.env, SPACE_CYCLE_DB: filename }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.existsSync(filename), false);
});
