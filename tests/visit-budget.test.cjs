const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisitSession } = require('../public/js/visit-session.js');
const { createStayStore } = require('../server/stay-store.js');
const { readStayPolicy } = require('../server/stay-policy.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ acquisitionMs = 7000, responseDelayMs = 0, timing = readStayPolicy({}), firstImmediate = false } = {}) {
    let time = 100000, tasks = [], calls = 0;
    const states = [], options = [], samples = [];
    const store = createStayStore({ now: () => time, policy: timing });
    const schedule = (fn, ms) => { const task = { fn, at: time + ms }; tasks.push(task); return task; };
    const session = createVisitSession({ spaceId: 'indoor-01', now: () => time, wallNow: () => time,
        schedule, unschedule: task => { tasks = tasks.filter(value => value !== task); }, onState: state => states.push(state),
        geolocation: { getCurrentPosition: (ok, error, config) => {
            options.push(config); const delay = firstImmediate && calls++ === 0 ? 0 : acquisitionMs;
            schedule(() => delay <= config.timeout
                ? ok({ timestamp: time, coords: { latitude: 36.7678561856971, longitude: 126.933492079991, accuracy: 5 } })
                : error({ code: 3 }), Math.min(delay, config.timeout));
        } },
        request: async (route, body) => {
            if (route === '/api/stays') return store.create(body.spaceId);
            const [, id, action] = route.match(/\/api\/stays\/([^/]+)\/(sample|cancel)/);
            if (action === 'cancel') return store.cancel(id, body.challenge);
            const response = store.sample(id, body); samples.push({ time, response });
            if (responseDelayMs) await new Promise(resolve => schedule(resolve, responseDelayMs));
            return response;
        },
    });
    const advance = async milliseconds => {
        const until = time + milliseconds;
        for (let count = 0; ; count++) {
            assert.ok(count < 1000, 'must not busy-loop retries'); tasks.sort((a, b) => a.at - b.at);
            if (!tasks.length || tasks[0].at > until) break;
            const task = tasks.shift(); time = task.at; task.fn(); await flush();
        }
        time = until; await flush();
    };
    return { session, states, options, samples, advance };
}

test('seven-second acquisitions and reply latency complete without the old six-second cutoff', async () => {
    const h = harness({ acquisitionMs: 7000, responseDelayMs: 1500 });
    await h.session.start();
    assert.equal(h.options[0].timeout, 15000);
    await h.advance(100000);
    assert.equal(h.states.at(-1).phase, 'complete', 'new valid positions arriving after six seconds must reach server completion');
    assert.equal(h.states.some(state => state.locationIssue?.code === 'gps_timeout'), false);
    assert.ok(h.samples.at(-1).time - h.samples[0].time >= 60000);
    assert.ok(h.options.every(config => config.timeout > 6000));
    assert.ok(h.options.every(config => config.maximumAge === 0 && config.enableHighAccuracy === true));
});

test('server-selected acquisition budgets and reply latency leave transport headroom', async () => {
    const timing = readStayPolicy({ SPACE_CYCLE_LOCATION_TIMEOUT_MS: '18000', SPACE_CYCLE_MAX_GAP_MS: '30000', SPACE_CYCLE_NETWORK_RESERVE_MS: '6000' });
    const h = harness({ timing, firstImmediate: true, acquisitionMs: 7000, responseDelayMs: 5000 });
    await h.session.start(); await h.advance(8000);
    assert.equal(h.options[1].timeout, 16000, 'reply5s + wait3s is already spent; retain6s for transport');
    assert.equal(h.states.at(-1).maxGapMs, 30000);
    assert.equal(h.states.at(-1).confirmedSampleCount, 1);
    assert.equal(h.states.at(-1).confirmationDeadlineAt, 130000, 'UI deadline is anchored before the five-second reply delay');
    await h.advance(100000); assert.equal(h.states.at(-1).phase, 'complete');
});

test('an unavailable provider stops at the policy gap and cannot complete', async () => {
    const h = harness({ firstImmediate: true, acquisitionMs: 60000 });
    await h.session.start(); await h.advance(25000);
    assert.equal(h.states.at(-1).errorCode, 'location_gap');
    assert.equal(h.states.at(-1).confirmedSampleCount, 1, 'diagnostic count survives failure without retaining raw coordinates');
    assert.equal(h.states.at(-1).elapsedMs, 0);
    assert.equal(h.samples.length, 1);
    assert.equal(h.options.length, 3, 'no pointless GPS requests consume the reserved network-only tail');
});

test('client policy validation agrees with server validation for every bounded custom policy', async () => {
    for (const acquisition of [6000, 15000, 18000, 20000]) {
        for (const reserve of [2000, 5000, 9000, 10000]) {
            for (const gap of [12000, 25000, 30000, 40000]) {
                let timing;
                try { timing = readStayPolicy({ SPACE_CYCLE_LOCATION_TIMEOUT_MS: String(acquisition), SPACE_CYCLE_NETWORK_RESERVE_MS: String(reserve), SPACE_CYCLE_MAX_GAP_MS: String(gap) }); }
                catch { continue; }
                const states = []; let fixes = 0;
                const session = createVisitSession({ spaceId: 'indoor-01', onState: state => states.push(state),
                    geolocation: { getCurrentPosition: () => fixes++ }, request: async route => route.endsWith('/cancel') ? null
                        : ({ id: 'fixture', challenge: 'fixture', ...timing }) });
                await session.start(); assert.equal(fixes, 1); assert.equal(states.at(-1).phase, 'locating'); session.stop();
            }
        }
    }
});

test('incomplete, impossible or changed server timing fails closed before new location requests', async () => {
    for (const delta of [{ locationTimeoutMs: undefined }, { networkReserveMs: Infinity }, { maxGapMs: 10000 }, { locationTimeoutMs: 20000 }]) {
        const states = [], gps = [];
        const session = createVisitSession({ spaceId: 'indoor-01', onState: state => states.push(state),
            geolocation: { getCurrentPosition: (...args) => gps.push(args) }, request: async route => route.endsWith('/cancel') ? null
                : ({ id: 'fixture', challenge: 'fixture', ...readStayPolicy({}), ...delta }) });
        await session.start(); assert.equal(states.at(-1).errorCode, 'invalid_response');
        assert.equal(gps.length, 0); assert.equal(session.isActive(), false);
    }
    const states = [], gps = []; const policy = readStayPolicy({});
    const session = createVisitSession({ spaceId: 'indoor-01', onState: state => states.push(state),
        geolocation: { getCurrentPosition: ok => gps.push(ok) }, request: async route => route.endsWith('/cancel') ? null
            : ({ id: 'fixture', challenge: 'fixture', ...policy, ...(route.endsWith('/sample') ? { maxGapMs: 30000 } : {}) }) });
    await session.start(); gps[0]({ timestamp: Date.now(), coords: { latitude: 36.7, longitude: 126.9, accuracy: 5 } }); await flush();
    assert.equal(states.at(-1).errorCode, 'invalid_response'); assert.equal(session.isActive(), false);
});
