const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openVisits } = require('../server/visits.js');
const { getSpace } = require('../public/js/space-data.js');

const spaceId = 'indoor-01';
const center = { latitude: 36.767780, longitude: 126.933294, accuracy: 5 };
const progressPath = path.join(__dirname, '../server/stay-progress.js');
function progress(options) {
    assert.ok(fs.existsSync(progressPath), 'durable start/finish progress module must exist');
    return require(progressPath).createStayProgress(options);
}
function disk(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-finish-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'visits.sqlite');
}

// Each scenario is added and exercised red before its implementation.
test('public start accepts the agreed server place, position and authenticated UID arguments', t => {
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    const store = progress({ visits, now: () => 1234 });
    assert.equal(typeof store.start, 'function');
    assert.deepEqual(Object.keys(store).sort(), ['abandon', 'cancel', 'finish', 'resume', 'start']);
    const started = store.start(spaceId, center, 'owner');
    assert.equal(started.created, true);
    assert.equal(started.state.phase, 'waiting');
    assert.equal(store.start(spaceId, center, 'owner').created, false);
    assert.equal(store.resume(spaceId, 'owner').id, started.state.id);
    assert.throws(() => store.start(spaceId, { ...center, spaceId: 'other' }, 'owner'), /invalid_payload/);
});

test('a server-timed start survives closing and reopening the database', t => {
    const filename = disk(t);
    let time = 100000;
    let visits = openVisits(filename);
    let store = progress({ visits, now: () => time });
    assert.deepEqual(store.resume(spaceId, 'owner'), {
        mode: 'start_finish', phase: 'idle', spaceId, requiredMs: 60000,
        locationTimeoutMs: 15000, initialTimeoutMs: 30000,
    });
    const { created, state } = store.start(spaceId, center, 'owner');
    assert.equal(created, true);
    assert.match(state.id, /^[a-f0-9]{48}$/);
    assert.match(state.challenge, /^[a-f0-9]{48}$/);
    assert.notEqual(state.id, state.challenge);
    assert.deepEqual(state, {
        mode: 'start_finish', id: state.id, challenge: state.challenge, spaceId,
        phase: 'waiting', elapsedMs: 0, requiredMs: getSpace(spaceId).requiredMs,
        expiresInMs: 7200000, distanceM: 0, accuracyM: 5,
        persisted: false, newlyFound: false,
        locationTimeoutMs: 15000, initialTimeoutMs: 30000,
    });
    visits.close();
    time += 45000;
    visits = openVisits(filename);
    t.after(() => visits.close());
    store = progress({ visits, now: () => time });
    assert.deepEqual(store.resume(spaceId, 'owner'), {
        ...state, elapsedMs: 45000, expiresInMs: 7155000, distanceM: null, accuracyM: null,
    });
    assert.equal(visits.list('owner').foundSpaceCount, 0);
});

test('start requires an enabled server place and a strict inside position before writing progress', t => {
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    const store = progress({ visits, now: () => 100 });
    const rejects = (body, code, status = 400) => {
        assert.throws(() => store.start(spaceId, body, 'owner'), error => error.message === code && error.status === status);
        assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    };
    for (const body of [null, [], {}, { accuracy: 5 }, { ...center, requiredMs: 1 }, { ...center, uid: 'other' }]) {
        rejects(body, 'invalid_payload');
    }
    for (const body of [
        { ...center, latitude: '36.767780' }, { ...center, latitude: null },
        { ...center, latitude: NaN }, { ...center, latitude: Infinity },
        { ...center, latitude: 91 }, { ...center, longitude: -181 },
        { ...center, accuracy: -1 }, { ...center, accuracy: 100001 },
        { ...center, accuracy: '5' },
    ]) rejects(body, 'invalid_position');
    for (const id of ['outdoor-01', 'missing']) {
        assert.throws(() => store.start(id, center, 'owner'), error => error.message === 'not_configured' && error.status === 404);
    }
    rejects({ ...center, latitude: 0, longitude: 0 }, 'outside', 422);
    rejects({ ...center, accuracy: 101 }, 'uncertain', 422);
    assert.throws(() => store.resume('outdoor-01', 'owner'), error => error.message === 'not_configured' && error.status === 404);
    assert.equal(store.start(spaceId, { longitude: center.longitude, accuracy: 5, latitude: center.latitude }, 'owner').state.phase, 'waiting');
});

test('duplicate starts from separate connections keep one original start and stable credentials', t => {
    const filename = disk(t);
    const a = openVisits(filename);
    const b = openVisits(filename);
    t.after(() => { a.close(); b.close(); });
    let time = 1000;
    const firstStore = progress({ visits: a, now: () => time });
    const secondStore = progress({ visits: b, now: () => time });
    const first = firstStore.start(spaceId, center, 'owner').state;
    time += 47000;
    const duplicate = secondStore.start(spaceId, center, 'owner');
    assert.equal(duplicate.created, false);
    assert.deepEqual(duplicate.state, { ...first, elapsedMs: 47000, expiresInMs: 7153000 });
    const another = secondStore.start(spaceId, center, 'other').state;
    assert.notEqual(another.id, first.id);
    assert.equal(another.elapsedMs, 0);
    time += 13000;
    const resumed = firstStore.resume(spaceId, 'owner');
    assert.equal(resumed.phase, 'ready');
    assert.equal(resumed.elapsedMs, 60000);
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.challenge, first.challenge);
    assert.equal(a.list('owner').foundSpaceCount, 0, 'waiting alone never grants a visit');
});

test('finish atomically saves a unique visit and durable completed progress with replay-safe credentials', t => {
    const filename = disk(t);
    let time = 10000;
    let visits = openVisits(filename);
    let store = progress({ visits, now: () => time });
    const first = store.start(spaceId, center, 'owner').state;
    time += 60000;
    const finishBody = { ...center, challenge: first.challenge };
    const completed = store.finish(first.id, finishBody, 'owner');
    assert.deepEqual(completed, {
        ...first, phase: 'complete', elapsedMs: 60000, expiresInMs: 7140000,
        persisted: true, newlyFound: true, foundSpaceCount: 1,
    });
    assert.deepEqual(visits.list('owner'), { foundSpaces: [spaceId], foundSpaceCount: 1 });
    visits.close();
    visits = openVisits(filename);
    t.after(() => visits.close());
    store = progress({ visits, now: () => time });
    const resumed = store.resume(spaceId, 'owner');
    assert.deepEqual(resumed, { ...completed, newlyFound: false, distanceM: null, accuracyM: null });
    assert.deepEqual(store.finish(first.id, finishBody, 'owner'), { ...completed, newlyFound: false });
    assert.equal(store.start(spaceId, center, 'owner').created, false);
    assert.deepEqual(store.start(spaceId, center, 'owner').state, { ...completed, newlyFound: false });
    assert.equal(visits.list('owner').foundSpaceCount, 1);
});

test('early, missing, wrong-owner, stale, invalid and rejected GPS finishes preserve the original wait', t => {
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    let time = 10000;
    const store = progress({ visits, now: () => time });
    const start = store.start(spaceId, center, 'owner').state;
    const good = { ...center, challenge: start.challenge };
    const rejects = (id, body, owner, code, status = 400) => {
        assert.throws(() => store.finish(id, body, owner), error => error.message === code && error.status === status);
        const current = store.resume(spaceId, 'owner');
        assert.equal(current.id, start.id);
        assert.equal(current.challenge, start.challenge);
        assert.equal(current.elapsedMs, Math.min(time - 10000, 60000));
        assert.equal(current.persisted, false);
        assert.equal(visits.list('owner').foundSpaceCount, 0);
    };
    rejects('0'.repeat(48), good, 'owner', 'session_missing', 410);
    rejects(start.id, good, 'other', 'wrong_owner', 403);
    rejects(start.id, { ...good, challenge: 'f'.repeat(48) }, 'owner', 'stale_challenge', 409);
    for (const body of [null, [], {}, { ...good, now: 1000000 }, { ...good, requiredMs: 1 }, { ...good, uid: 'other' }]) {
        rejects(start.id, body, 'owner', 'invalid_payload');
    }
    rejects(start.id, { ...good, latitude: '36.767780' }, 'owner', 'invalid_position');
    rejects(start.id, good, 'owner', 'too_early', 409);
    time += 59999;
    rejects(start.id, good, 'owner', 'too_early', 409);
    time += 1;
    rejects(start.id, { ...good, latitude: 0, longitude: 0 }, 'owner', 'outside', 422);
    rejects(start.id, { ...good, accuracy: 101 }, 'owner', 'uncertain', 422);
    // No updates during background, GPS timeout or network loss; server time keeps accruing.
    time += 120000;
    assert.equal(store.resume(spaceId, 'owner').phase, 'ready');
    const complete = store.finish(start.id, good, 'owner');
    assert.equal(complete.phase, 'complete');
    assert.equal(complete.challenge, start.challenge);
    assert.equal(complete.newlyFound, true);
    assert.throws(() => store.finish(start.id, { ...good, complete: true }, 'owner'), /invalid_payload/);
    assert.throws(() => store.finish(start.id, { ...good, accuracy: '5' }, 'owner'), /invalid_position/);
    assert.throws(() => store.finish(start.id, good, 'other'), /wrong_owner/);
    assert.throws(() => store.finish(start.id, { ...good, challenge: 'bad' }, 'owner'), /stale_challenge/);
    assert.equal(store.finish(start.id, good, 'owner').newlyFound, false);
});

test('a failed completion transaction rolls back the visit and keeps the same progress retriable', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    let time = 0;
    const store = progress({ visits, now: () => time });
    const start = store.start(spaceId, center, 'owner').state;
    time = 60000;
    observer.exec(`CREATE TRIGGER fixture_fail_complete BEFORE UPDATE OF status ON stay_progress
        WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT, 'private database detail owner'); END;`);
    const body = { ...center, challenge: start.challenge };
    assert.throws(() => store.finish(start.id, body, 'owner'), error => error.message === 'save_failed' && error.status === 503);
    assert.equal(visits.list('owner').foundSpaceCount, 0);
    const stillReady = store.resume(spaceId, 'owner');
    assert.equal(stillReady.phase, 'ready');
    assert.equal(stillReady.id, start.id);
    assert.equal(stillReady.challenge, start.challenge);
    assert.equal(observer.prepare('SELECT status FROM stay_progress WHERE id=?').get(start.id).status, 'active');
    observer.exec('DROP TRIGGER fixture_fail_complete');
    assert.equal(store.finish(start.id, body, 'owner').newlyFound, true);
    assert.equal(store.finish(start.id, body, 'owner').newlyFound, false);
    assert.equal(visits.list('owner').foundSpaceCount, 1);
});

test('only an owner with the stable challenge can cancel without deleting earned visits', t => {
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    let time = 0;
    const store = progress({ visits, now: () => time });
    const first = store.start(spaceId, center, 'owner').state;
    assert.throws(() => store.cancel(first.id, first.challenge, 'other'), error => error.message === 'wrong_owner' && error.status === 403);
    assert.throws(() => store.cancel(first.id, 'wrong', 'owner'), error => error.message === 'stale_challenge' && error.status === 409);
    store.cancel(first.id, first.challenge, 'owner');
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    assert.throws(() => store.finish(first.id, { ...center, challenge: first.challenge }, 'owner'), /session_missing/);
    const second = store.start(spaceId, center, 'owner').state;
    assert.notEqual(second.id, first.id);
    time += 60000;
    assert.equal(store.finish(second.id, { ...center, challenge: second.challenge }, 'owner').newlyFound, true);
    store.cancel(second.id, second.challenge, 'owner');
    assert.equal(visits.list('owner').foundSpaceCount, 1);
    const third = store.start(spaceId, center, 'owner').state;
    time += 60000;
    const repeated = store.finish(third.id, { ...center, challenge: third.challenge }, 'owner');
    assert.equal(repeated.newlyFound, false);
    assert.equal(repeated.foundSpaceCount, 1);
});

test('indexed expiry and active capacity free abandoned progress without rewarding expired sessions', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    let time = 1000;
    const store = progress({ visits, now: () => time, ttlMs: 120000, maxSessions: 1 });
    const first = store.start(spaceId, center, 'owner').state;
    assert.equal(first.expiresInMs, 120000);
    assert.equal(store.start(spaceId, center, 'owner').created, false, 'capacity does not reject an existing start');
    assert.throws(() => store.start(spaceId, center, 'other'), error => error.message === 'capacity' && error.status === 429);
    time += 120000;
    assert.throws(() => store.finish(first.id, { ...center, challenge: first.challenge }, 'owner'), error => error.message === 'session_missing' && error.status === 410);
    assert.equal(visits.list('owner').foundSpaceCount, 0);
    const second = store.start(spaceId, center, 'other').state;
    time += 120000;
    assert.throws(() => store.resume(spaceId, 'other'), error => error.message === 'session_missing' && error.status === 410);
    assert.throws(() => store.cancel(second.id, second.challenge, 'other'), /session_missing/);
    const third = store.start(spaceId, center, 'owner').state;
    time += 60000;
    assert.equal(store.finish(third.id, { ...center, challenge: third.challenge }, 'owner').persisted, true);
    const fourth = store.start(spaceId, center, 'other').state;
    assert.equal(fourth.phase, 'waiting', 'completed progress is not active capacity');
    time += 120000;
    store.start(spaceId, center, 'fresh');
    assert.equal(observer.prepare('SELECT count(*) AS n FROM stay_progress').get().n, 1);
    assert.equal(visits.list('owner').foundSpaceCount, 1);
    const expiryPlan = observer.prepare('EXPLAIN QUERY PLAN DELETE FROM stay_progress WHERE expires_at <= ?').all(time);
    assert.ok(expiryPlan.some(row => /SEARCH.*INDEX.*expires/i.test(row.detail)), JSON.stringify(expiryPlan));
    const activePlan = observer.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM stay_progress WHERE status='active'").all();
    assert.ok(activePlan.some(row => /INDEX.*status/i.test(row.detail)), JSON.stringify(activePlan));
});

test('additive migration preserves every legacy visit and keeps SQL parameters and raw GPS private', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE visits(uid TEXT NOT NULL,space_id TEXT NOT NULL,completed_at INTEGER NOT NULL,
        PRIMARY KEY(uid,space_id)) WITHOUT ROWID;`);
    const fixtureRows = [
        ['owner', spaceId, 123], ['owner', 'outdoor-05', 456],
        ["quoted' ; DROP TABLE visits; --", spaceId, 789], ['old-account', 'retired-place', 111],
    ];
    const insert = legacy.prepare('INSERT INTO visits VALUES(?,?,?)');
    for (const row of fixtureRows) insert.run(...row);
    legacy.close();
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const rows = () => observer.prepare('SELECT uid,space_id,completed_at FROM visits ORDER BY uid,space_id').all().map(row => [row.uid, row.space_id, row.completed_at]);
    const before = rows();
    assert.deepEqual(before, [...fixtureRows].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    let time = 1000;
    const store = progress({ visits, now: () => time });
    const uid = fixtureRows[2][0];
    const state = store.start(spaceId, center, uid).state;
    time += 60000;
    assert.equal(store.finish(state.id, { ...center, challenge: state.challenge }, uid).newlyFound, false);
    assert.deepEqual(rows(), before);
    assert.equal(store.resume(spaceId, 'other').phase, 'idle');
    const columns = observer.prepare('PRAGMA table_info(stay_progress)').all().map(row => row.name).sort();
    assert.deepEqual(columns, ['id','challenge','uid','space_id','started_at','ready_at','expires_at','required_ms','status'].sort());
    assert.equal(observer.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(observer.prepare('SELECT * FROM stay_progress').all()).includes(String(center.latitude)), false);
    assert.equal(JSON.stringify(observer.prepare('SELECT * FROM stay_progress').all()).includes(String(center.longitude)), false);
    assert.equal(store.resume(spaceId, uid).accuracyM, null);
});

test('a finish that reaches the TTL boundary cannot award using an earlier owner lookup time', t => {
    const visits = openVisits(':memory:');
    t.after(() => visits.close());
    let time = 0;
    let ticking = false;
    const store = progress({ visits, now: () => ticking ? time++ : time, ttlMs: 60001 });
    const state = store.start(spaceId, center, 'owner').state;
    time = 60000;
    ticking = true;
    assert.throws(() => store.finish(state.id, { ...center, challenge: state.challenge }, 'owner'), error => error.message === 'session_missing' && error.status === 410);
    assert.equal(visits.list('owner').foundSpaceCount, 0);
});

test('a failed start write returns a private retriable save_failed error instead of claiming progress', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const store = progress({ visits, now: () => 1000 });
    observer.exec(`CREATE TRIGGER fixture_fail_start BEFORE INSERT ON stay_progress
        BEGIN SELECT RAISE(ABORT, 'raw UID database private detail'); END;`);
    assert.throws(() => store.start(spaceId, center, 'owner'), error => error.message === 'save_failed' && error.status === 503);
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
    observer.exec('DROP TRIGGER fixture_fail_start');
    assert.equal(store.start(spaceId, center, 'owner').created, true);
});

test('default active capacity is 10000 persisted rows across progress instances', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const store = progress({ visits, now: () => 0 });
    const row = store.start(spaceId, center, 'owner').state;
    const insert = observer.prepare(`INSERT INTO stay_progress
        (id,challenge,uid,space_id,started_at,ready_at,expires_at,required_ms,status) VALUES(?,?,?,?,?,?,?,?,?)`);
    observer.exec('BEGIN IMMEDIATE');
    for (let count = 1; count < 10000; count++) {
        insert.run(count.toString(16).padStart(48, '0'), row.challenge, `capacity-${count}`, spaceId, 0, 60000, 7200000, 60000, 'active');
    }
    observer.exec('COMMIT');
    const other = progress({ visits, now: () => 0 });
    assert.throws(() => other.start(spaceId, center, 'overflow'), error => error.message === 'capacity' && error.status === 429);
    assert.equal(observer.prepare("SELECT count(*) AS n FROM stay_progress WHERE status='active'").get().n, 10000);
    assert.equal(other.start(spaceId, center, 'owner').created, false);
});

test('parallel database connections finish the same challenge once without duplicate visits', async t => {
    const { Worker } = require('node:worker_threads');
    const filename = disk(t);
    const visits = openVisits(filename);
    t.after(() => visits.close());
    const store = progress({ visits, now: () => 0 });
    const state = store.start(spaceId, center, 'owner').state;
    const workerCode = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { openVisits } = require(workerData.visitsPath);
        const { createStayProgress } = require(workerData.progressPath);
        const visits = openVisits(workerData.filename);
        const store = createStayProgress({ visits, now: () => 60000 });
        parentPort.postMessage({ ready: true });
        parentPort.once('message', () => {
            try { parentPort.postMessage({ result: store.finish(workerData.state.id,
                { ...workerData.center, challenge: workerData.state.challenge }, 'owner') }); }
            catch (error) { parentPort.postMessage({ error: error.message }); }
            finally { visits.close(); }
        });
    `;
    const workers = Array.from({ length: 6 }, () => new Worker(workerCode, { eval: true, workerData: {
        visitsPath: path.join(__dirname, '../server/visits.js'), progressPath, filename, state, center,
    } }));
    t.after(async () => Promise.all(workers.map(worker => worker.terminate())));
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
        worker.once('message', message => message.ready ? resolve() : reject(Error(JSON.stringify(message))));
        worker.once('error', reject);
    })));
    const responses = workers.map(worker => new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
    }));
    for (const worker of workers) worker.postMessage('finish');
    const results = await Promise.all(responses);
    assert.equal(results.filter(message => message.result?.newlyFound).length, 1);
    for (const message of results) {
        assert.ok(message.result, JSON.stringify(message));
        assert.equal(message.result.phase, 'complete');
        assert.equal(message.result.persisted, true);
        assert.equal(message.result.foundSpaceCount, 1);
        assert.equal(message.result.challenge, state.challenge);
    }
    assert.deepEqual(visits.list('owner'), { foundSpaces: [spaceId], foundSpaceCount: 1 });
});

test('failed cancellation storage leaves the original stable progress available for another attempt', t => {
    const { DatabaseSync } = require('node:sqlite');
    const filename = disk(t);
    const visits = openVisits(filename);
    const observer = new DatabaseSync(filename);
    t.after(() => { observer.close(); visits.close(); });
    const store = progress({ visits, now: () => 1000 });
    const state = store.start(spaceId, center, 'owner').state;
    observer.exec(`CREATE TRIGGER fixture_fail_cancel BEFORE DELETE ON stay_progress
        BEGIN SELECT RAISE(ABORT, 'private cancellation detail owner'); END;`);
    assert.throws(() => store.cancel(state.id, state.challenge, 'owner'), error => error.message === 'save_failed' && error.status === 503);
    assert.equal(store.resume(spaceId, 'owner').challenge, state.challenge);
    assert.equal(store.resume(spaceId, 'owner').phase, 'waiting');
    observer.exec('DROP TRIGGER fixture_fail_cancel');
    store.cancel(state.id, state.challenge, 'owner');
    assert.equal(store.resume(spaceId, 'owner').phase, 'idle');
});
