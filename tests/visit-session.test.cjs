const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisitSession } = require('../public/js/visit-session.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ID = 'a'.repeat(48), CHALLENGE = 'b'.repeat(48);
function snapshot(overrides = {}) {
    return { mode: 'start_finish', id: ID, challenge: CHALLENGE, spaceId: 'indoor-01',
        phase: 'waiting', elapsedMs: 0, requiredMs: 60000, expiresInMs: 7200000,
        distanceM: 0, accuracyM: 5, persisted: false, newlyFound: false,
        locationTimeoutMs: 15000, initialTimeoutMs: 30000, ...overrides };
}
function idle(overrides = {}) {
    return { mode: 'start_finish', phase: 'idle', spaceId: 'indoor-01', requiredMs: 60000,
        locationTimeoutMs: 15000, initialTimeoutMs: 30000, ...overrides };
}
function harness({ respond, requiredMs = 60000, wallNow } = {}) {
    let time = 100000, tasks = [], saved = null, startedAt = null;
    const fixes = [], requests = [], states = [];
    const session = createVisitSession({ spaceId: 'indoor-01', now: () => time, wallNow: wallNow || (() => time),
        geolocation: { getCurrentPosition: (ok, error, options) => fixes.push({ ok, error, options }) },
        schedule: (fn, ms) => { const task = { fn, at: time + ms }; tasks.push(task); return task; },
        unschedule: task => { tasks = tasks.filter(value => value !== task); }, onState: state => states.push(state),
        request: async (route, body, options) => {
            const call = { route, body, options }; requests.push(call);
            if (respond) return respond(call, { time, snapshot, idle });
            if (route.endsWith('/cancel')) { saved = null; return null; }
            if (route === '/api/stays/resume') return saved ? snapshot({ ...saved,
                elapsedMs: Math.min(requiredMs, time - startedAt),
                phase: time - startedAt >= requiredMs ? 'ready' : 'waiting',
                expiresInMs: Math.max(0, 7200000 - (time - startedAt)) }) : idle({ requiredMs });
            if (route === '/api/stays') { startedAt = time; saved = snapshot({ requiredMs }); return saved; }
            if (route.endsWith('/finish')) {
                if (time - startedAt < requiredMs) throw { code: 'too_early', status: 409 };
                return snapshot({ requiredMs, phase: 'complete', elapsedMs: requiredMs,
                    persisted: true, newlyFound: true, foundSpaceCount: 1 });
            }
            assert.fail(`unexpected request: ${route}`);
        },
    });
    const advance = async milliseconds => {
        const until = time + milliseconds;
        for (let count = 0; ; count++) {
            assert.ok(count < 1000, 'bounded retries must not busy-loop'); tasks.sort((a, b) => a.at - b.at);
            if (!tasks.length || tasks[0].at > until) break;
            const task = tasks.shift(); time = task.at; task.fn(); await flush();
        }
        time = until; await flush();
    };
    const fix = (attempt = fixes.at(-1), timestamp = time, coords = {}) => attempt.ok({ timestamp,
        coords: { latitude: 36.7678561856971, longitude: 126.933492079991, accuracy: 5, ...coords } });
    return { session, fixes, requests, states, fix, advance, get time() { return time; },
        get state() { return states.at(-1); }, get taskCount() { return tasks.length; } };
}
module.exports = { harness, snapshot, idle, flush, deferred, ID, CHALLENGE };

if (require.main === module) {
    test('start acquires an explicit fresh location before creating a durable server wait', async () => {
        const h = harness(); assert.equal(h.fixes.length, 0); assert.equal(h.requests.length, 0);
        void h.session.start(); await flush();
        assert.equal(h.requests.length, 0, 'no progress is created before the starting position exists');
        assert.equal(h.fixes.length, 1);
        assert.deepEqual(h.fixes[0].options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        h.fix(); await flush();
        assert.deepEqual(h.requests[0].body, { spaceId: 'indoor-01', latitude: 36.7678561856971,
            longitude: 126.933492079991, accuracy: 5, attemptId: h.requests[0].body.attemptId });
        assert.match(h.requests[0].body.attemptId, /^[a-f0-9]{48}$/);
        assert.equal(h.requests[0].route, '/api/stays');
        assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.elapsedMs, 0);
        assert.equal(h.state.mode, 'start_finish'); assert.equal(h.state.active, true);
        assert.equal(h.state.requiredMs, 60000);
    });

    test('restore resumes account progress without requesting location, including a ready visit', async () => {
        for (const phase of ['waiting', 'ready']) {
            const h = harness({ respond: () => snapshot({ phase, elapsedMs: phase === 'ready' ? 60000 : 12000 }) });
            await h.session.restore();
            assert.deepEqual(h.requests.map(call => [call.route, call.body]), [['/api/stays/resume', { spaceId: 'indoor-01' }]]);
            assert.equal(h.fixes.length, 0); assert.equal(h.state.phase, phase); assert.equal(h.state.active, true);
            assert.equal(h.state.elapsedMs, phase === 'ready' ? 60000 : 12000);
            await h.advance(60000); assert.equal(h.fixes.length, 0); assert.equal(h.requests.length, 1);
        }
        const h = harness(); await h.session.restore();
        assert.equal(h.state.phase, 'idle'); assert.equal(h.state.active, false); assert.equal(h.fixes.length, 0);
    });

    test('waiting is silent beyond 25 seconds and a fresh explicit final fix alone can complete', async () => {
        const h = harness(); h.session.start(); h.fix(); await flush();
        await h.advance(60000);
        assert.equal(h.requests.length, 1); assert.equal(h.fixes.length, 1);
        assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.persisted, false);
        h.session.finish(); await flush();
        assert.equal(h.fixes.length, 2); assert.equal(h.requests.length, 1);
        h.fix(); await flush();
        assert.equal(h.requests[1].route, `/api/stays/${ID}/finish`);
        assert.deepEqual(h.requests[1].body, { challenge: CHALLENGE, latitude: 36.7678561856971,
            longitude: 126.933492079991, accuracy: 5 });
        assert.equal(h.state.phase, 'complete'); assert.equal(h.state.persisted, true);
        assert.equal(h.state.newlyFound, true); assert.equal(h.state.foundSpaceCount, 1);
        assert.equal(h.state.active, false); assert.equal(h.taskCount, 0);
        await h.advance(60000); assert.equal(h.requests.length, 2); assert.equal(h.fixes.length, 2);
    });
}
