const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisitSession } = require('../public/js/visit-session.js');
const { createStayStore } = require('../server/stay-store.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    let time = 100000;
    let timers = [];
    const fixes = [], states = [], samples = [], cancels = [];
    const store = createStayStore({ now: () => time });
    const session = createVisitSession({
        spaceId: 'indoor-01', now: () => time, wallNow: () => time,
        geolocation: { getCurrentPosition: (ok, error, options) => fixes.push({ ok, error, options }) },
        schedule: (fn, ms) => { const item = { fn, at: time + ms }; timers.push(item); return item; },
        unschedule: item => { timers = timers.filter(timer => timer !== item); },
        onState: state => states.push(state),
        request: async (route, body) => {
            if (route === '/api/stays') return store.create(body.spaceId);
            const [, id, action] = route.match(/\/api\/stays\/([^/]+)\/(sample|cancel)/);
            if (action === 'cancel') { cancels.push(id); return store.cancel(id, body.challenge); }
            const result = store.sample(id, body);
            samples.push({ time, result });
            return result;
        },
    });
    const advance = async milliseconds => {
        const until = time + milliseconds;
        for (let iterations = 0; ; iterations++) {
            assert.ok(iterations < 1000, 'retries must not create a busy loop');
            timers.sort((a, b) => a.at - b.at);
            if (!timers.length || timers[0].at > until) break;
            const item = timers.shift(); time = item.at; item.fn(); await flush();
        }
        time = until; await flush();
    };
    const fix = (callback = fixes.at(-1), timestamp = time) => callback.ok({ timestamp,
        coords: { latitude: 36.7678561856971, longitude: 126.933492079991, accuracy: 5 } });
    return { session, fixes, states, samples, cancels, advance, fix, get time() { return time; } };
}

test('first GPS acquisition gets a cold-start budget and retries a timeout without starting dwell time', async () => {
    const h = harness(); await h.session.start();
    assert.equal(h.fixes[0].options.timeout, 15000, 'first high-accuracy fix must not use the short recurring timeout');
    assert.equal(h.fixes[0].options.maximumAge, 0);
    await h.advance(15000); h.fixes[0].error({ code: 3 }); await flush();
    assert.equal(h.session.isActive(), true, 'one GPS timeout must not cancel the entire session');
    assert.equal(h.states.at(-1).phase, 'locating');
    assert.equal(h.states.at(-1).locationPending, true);
    assert.equal(h.states.at(-1).elapsedMs, 0);
    assert.equal(h.states.at(-1).confirmedAt, null);
    assert.equal(h.samples.length, 0);
    assert.equal(h.cancels.length, 0);
    await h.advance(250); assert.equal(h.fixes.length, 2);
    h.fix(); await flush();
    assert.equal(h.states.at(-1).phase, 'dwelling');
    assert.equal(h.states.at(-1).elapsedMs, 0, 'cold-start wait must not count as a visit');
    assert.equal(h.states.at(-1).locationPending, false);
    h.session.stop(); await flush();
});

test('one acquisition timeout recovers with a fresh fix inside the advertised continuity budget', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    await h.advance(3000); h.fix(); await flush();
    const confirmed = h.states.at(-1);
    assert.equal(confirmed.elapsedMs, 3000);
    await h.advance(3000); const failedAttempt = h.fixes.at(-1);
    assert.equal(failedAttempt.options.timeout, 15000);
    await h.advance(15000); failedAttempt.error({ code: 3 }); await flush();
    assert.equal(h.session.isActive(), true);
    assert.equal(h.states.at(-1).phase, 'dwelling');
    assert.equal(h.states.at(-1).locationPending, true);
    assert.equal(h.states.at(-1).confirmedAt, confirmed.confirmedAt, 'retry must not refresh the display anchor');
    assert.equal(h.states.at(-1).elapsedMs, confirmed.elapsedMs, 'no local approval of unverified time');
    assert.equal(h.samples.length, 2, 'a failed acquisition sends no heartbeat');
    await h.advance(250);
    assert.equal(h.fixes.at(-1).options.maximumAge, 0);
    assert.ok(h.fixes.at(-1).options.timeout <= 1750, 'retry must retain five seconds for transport inside the gap');
    await h.advance(500); h.fix(); await flush();
    assert.equal(h.states.at(-1).phase, 'dwelling');
    assert.equal(h.states.at(-1).locationPending, false);
    assert.equal(h.states.at(-1).elapsedMs, 21750, 'real server continues the same stay with a fresh timely fix');
    assert.equal(h.samples.at(-1).result.reason, null);
    assert.equal(h.cancels.length, 0);
    h.session.stop(); await flush();
});

test('retrying never extends the server gap; expired or stopped attempts cannot submit late fixes', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    await h.advance(3000); const old = h.fixes.at(-1);
    await h.advance(15000); old.error({ code: 3 }); await flush();
    await h.advance(250); const retry = h.fixes.at(-1);
    const count = h.samples.length;
    h.fix(old); await flush(); assert.equal(h.samples.length, count, 'a settled timeout cannot later succeed');
    await h.advance(6750);
    assert.equal(h.session.isActive(), false);
    assert.equal(h.states.at(-1).errorCode, 'location_gap');
    assert.equal(h.states.at(-1).elapsedMs, 0);
    h.fix(retry); await flush(); assert.equal(h.samples.length, count);
    const calls = h.fixes.length;
    await h.advance(30000); assert.equal(h.fixes.length, calls, 'no retries after stop');
    assert.equal(h.cancels.length, 1);
});

test('stopping during a scheduled GPS retry cancels it and restart starts from zero', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    await h.advance(3000); await h.advance(6000); h.fixes.at(-1).error({ code: 3 }); await flush();
    h.session.stop(); await flush(); const calls = h.fixes.length;
    await h.advance(1000); assert.equal(h.fixes.length, calls);
    assert.equal(h.states.at(-1).elapsedMs, 0);
    await h.session.start(); h.fix(); await flush();
    assert.equal(h.states.at(-1).elapsedMs, 0);
    assert.equal(h.states.at(-1).locationPending, false);
    h.session.stop(); await flush();
});

test('a recovered but stale GPS fix is never reused as a fresh sample', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    await h.advance(3000); await h.advance(6000); h.fixes.at(-1).error({ code: 3 }); await flush();
    await h.advance(250); const count = h.samples.length;
    h.fix(h.fixes.at(-1), h.time - 5000); await flush();
    assert.equal(h.session.isActive(), true, 'stale results are skipped rather than immediately cancelling');
    assert.equal(h.states.at(-1).locationIssue.code, 'gps_stale');
    assert.equal(h.samples.length, count);
    await h.advance(15750);
    assert.equal(h.session.isActive(), false, 'stale data cannot extend the original continuity deadline');
    assert.equal(h.states.at(-1).errorCode, 'location_gap');
    assert.equal(h.states.at(-1).locationIssue.code, 'gps_stale', 'failure keeps the last safe diagnostic');
    assert.equal(h.states.at(-1).elapsedMs, 0);
});

test('an old returned fix is skipped and a fresh follow-up continues the same stay', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    await h.advance(3000); h.fix(); await flush();
    const confirmed = h.states.at(-1); await h.advance(3000);
    h.fix(h.fixes.at(-1), h.time - 5000); await flush();
    assert.equal(h.session.isActive(), true, 'one old device result must not cancel an otherwise valid stay');
    assert.equal(h.samples.length, 2, 'old location must not be sent as a fresh heartbeat');
    assert.equal(h.states.at(-1).locationPending, true);
    assert.equal(h.states.at(-1).confirmedAt, confirmed.confirmedAt);
    assert.equal(h.states.at(-1).locationIssue.code, 'gps_stale');
    assert.equal(h.states.at(-1).locationIssue.fixAgeMs, 5000);
    await h.advance(250); h.fix(); await flush();
    assert.equal(h.states.at(-1).phase, 'dwelling');
    assert.equal(h.states.at(-1).elapsedMs, 6250);
    assert.equal(h.states.at(-1).locationPending, false);
    assert.equal(h.samples.at(-1).result.reason, null);
    h.session.stop(); await flush();
});

test('a repeated timestamp is skipped, while unchanged coordinates with a new timestamp are accepted', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    const firstTime = h.time; await h.advance(3000); h.fix(h.fixes.at(-1), firstTime); await flush();
    assert.equal(h.session.isActive(), true);
    assert.equal(h.states.at(-1).locationIssue.code, 'gps_duplicate');
    assert.equal(h.samples.length, 1);
    await h.advance(250); h.fix(); await flush();
    assert.equal(h.samples.length, 2);
    assert.equal(h.states.at(-1).elapsedMs, 3250);
    assert.equal(h.states.at(-1).locationIssue, null);
    h.session.stop(); await flush();
});

test('state listeners cannot overwrite the stored safe diagnostic', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    const first = h.time; await h.advance(3000); h.fix(h.fixes.at(-1), first); await flush();
    h.states.at(-1).locationIssue.code = 'changed-by-listener';
    await h.advance(25000);
    assert.equal(h.session.isActive(), false);
    assert.equal(h.states.at(-1).locationIssue.code, 'gps_duplicate');
});

test('invalid or future device timestamps never submit and retries do not extend initial acquisition', async () => {
    for (const [value, code] of [[NaN, 'gps_invalid_timestamp'], [105000, 'gps_clock']]) {
        const h = harness(); await h.session.start(); h.fix(h.fixes.at(-1), value); await flush();
        assert.equal(h.samples.length, 0);
        assert.equal(h.states.at(-1).locationIssue.code, code);
        assert.equal(h.states.at(-1).locationPending, true);
        assert.equal(h.session.isActive(), true);
        await h.advance(30000);
        assert.equal(h.session.isActive(), false);
        assert.equal(h.states.at(-1).errorCode, 'location_timeout');
        assert.equal(h.states.at(-1).locationIssue.code, code);
    }
});

test('old or repeated device responses cannot prolong a stay indefinitely or produce completion', async () => {
    const h = harness(); await h.session.start(); h.fix(); await flush();
    const first = h.time;
    for (let i = 0; i < 40 && h.session.isActive(); i++) {
        await h.advance(i === 0 ? 3000 : 250);
        if (h.session.isActive()) { h.fix(h.fixes.at(-1), first); await flush(); }
    }
    if (h.session.isActive()) await h.advance(25000);
    assert.equal(h.session.isActive(), false);
    assert.equal(h.states.at(-1).errorCode, 'location_gap');
    assert.equal(h.states.at(-1).elapsedMs, 0);
    assert.equal(h.samples.length, 1, 'retries send no synthetic heartbeat');
    assert.equal(h.states.some(state => state.phase === 'complete'), false);
    assert.equal(h.cancels.length, 1);
});

test('repeated initial timeouts stop at the thirty-second acquisition limit, not forever', async () => {
    const h = harness(); await h.session.start();
    await h.advance(15000); h.fixes.at(-1).error({ code: 3 }); await flush();
    await h.advance(250); assert.equal(h.fixes.length, 2);
    await h.advance(14750);
    assert.equal(h.session.isActive(), false);
    assert.equal(h.states.at(-1).errorCode, 'location_timeout');
    assert.equal(h.samples.length, 0);
    assert.equal(h.cancels.length, 1);
});
