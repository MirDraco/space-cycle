const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { createStayProgress } = require('../server/stay-progress.js');
const { createStayRouter } = require('../server/stay-routes.js');
const { openVisits } = require('../server/visits.js');
const center = { latitude: 36.767780, longitude: 126.933294, accuracy: 5 };

test('failed persistence never claims success; the same stable finish safely retries without double counting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-security-'));
    const filename = path.join(dir, 'visits.sqlite');
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    let clock = 0;
    const progress = createStayProgress({ visits, now: () => clock });
    const app = express();
    app.use('/api/stays', createStayRouter({ progress, visits, verifyToken: async () => ({ uid: 'owner' }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/stays`;
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: {
        Origin: 'https://spacecycle.space', 'Content-Type': 'application/json', Authorization: 'Bearer fixture',
    }, body: JSON.stringify(body) });
    try {
        const start = await (await post('', { spaceId: 'indoor-01', ...center })).json();
        clock += 60000;
        // Fail after INSERT, before progress status changes: both must roll back.
        observer.exec(`CREATE TRIGGER fixture_fail BEFORE UPDATE OF status ON stay_progress
            BEGIN SELECT RAISE(ABORT, 'database private internal detail owner'); END;`);
        const body = { ...center, challenge: start.challenge };
        const response = await post(`/${start.id}/finish`, body);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'save_failed' });
        assert.equal(visits.list('owner').foundSpaceCount, 0);
        const ready = await (await post('/resume', { spaceId: 'indoor-01' })).json();
        assert.equal(ready.id, start.id);
        assert.equal(ready.challenge, start.challenge);
        assert.equal(ready.phase, 'ready');
        observer.exec('DROP TRIGGER fixture_fail');
        const saved = await (await post(`/${start.id}/finish`, body)).json();
        assert.equal(saved.persisted, true);
        assert.equal(saved.newlyFound, true);
        assert.equal(saved.foundSpaceCount, 1);
        const duplicate = await (await post(`/${start.id}/finish`, body)).json();
        assert.equal(duplicate.newlyFound, false);
        assert.equal(duplicate.foundSpaceCount, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        observer.close(); visits.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('strict API origins, methods, content types and parsing boundaries are preserved', async () => {
    const visits = openVisits(':memory:');
    const app = express();
    app.use('/api/stays', createStayRouter({ visits, verifyToken: async () => ({ uid: 'owner' }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, url = origin + '/api/stays';
    const headers = { Origin: origin, Authorization: 'Bearer fixture', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(url, { method: 'GET', headers })).status, 405);
        assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
        const malformed = await fetch(url, { method: 'POST', headers, body: '{' });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
        for (const bad of ['null', 'https://spacecycle.space.evil.test', origin + '/', origin.replace('127.0.0.1', 'localhost'), 'http://127.0.0.1:1']) {
            assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: bad }, body: '{}' })).status, 403);
        }
        assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ spaceId: 'indoor-01', ...center }) })).status, 201);
    } finally { await new Promise(resolve => server.close(resolve)); visits.close(); }
});
