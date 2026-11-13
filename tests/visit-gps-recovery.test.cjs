const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, flush } = require('./visit-session.test.cjs');

test('invalid, future, stale and duplicate fixes are never posted; a new timestamp at unchanged coordinates is accepted', async () => {
    for (const [stamp, code] of [[NaN, 'gps_invalid_timestamp'], [undefined, 'gps_invalid_timestamp'], [105000, 'gps_clock'], [89000, 'gps_stale']]) {
        const h = harness(); h.session.start();
        const position = { coords: { latitude: 36.7, longitude: 126.9, accuracy: 5 } };
        if (stamp !== undefined) position.timestamp = stamp;
        h.fixes[0].ok(position); await flush();
        assert.equal(h.requests.length, 0); assert.equal(h.state.locationIssue?.code, code);
        assert.equal(h.state.locationPending, true);
        await h.advance(250); h.fix(); await flush();
        assert.equal(h.requests.length, 1); assert.equal(h.state.phase, 'waiting');
        assert.equal(h.state.locationIssue, null);
    }
    const h = harness(); h.session.start(); h.fix(); await flush(); await h.advance(1000);
    h.session.finish(); h.fix(h.fixes.at(-1), 100000); await flush();
    assert.equal(h.requests.length, 1); assert.equal(h.state.locationIssue.code, 'gps_duplicate');
    await h.advance(250); h.fix(); await flush();
    assert.equal(h.requests.length, 2); assert.equal(h.state.errorCode, 'too_early');
    await h.advance(60000); h.session.finish(); h.fix(); await flush();
    assert.equal(h.state.phase, 'complete');
});

test('start and final freshness boundaries reject all non-finite timestamps and accept only the bounded -3000..10000ms ages', async () => {
    for (const [age, code] of [[10000, null], [-3000, null], [10001, 'gps_stale'], [-3001, 'gps_clock']]) {
        const h = harness(); h.session.start(); h.fix(h.fixes[0], h.time - age); await flush();
        assert.equal(h.requests.length, code ? 0 : 1);
        assert.equal(h.state.locationIssue?.code || null, code);
    }
    for (const wall of [NaN, Infinity]) {
        const h = harness({ wallNow: () => wall }); h.session.start(); h.fix(); await flush();
        assert.equal(h.requests.length, 0); assert.equal(h.state.locationIssue.code, 'gps_clock');
    }
    for (const stamp of [Infinity, -Infinity, null, '100000']) {
        const h = harness(); h.session.start(); h.fix(h.fixes[0], stamp); await flush();
        assert.equal(h.requests.length, 0); assert.equal(h.state.locationIssue.code, 'gps_invalid_timestamp');
    }
});

test('a timed-out acquisition can recover fresh within its remaining budget without losing a ready wait', async () => {
    for (const final of [false, true]) {
        const h = harness(); h.session.start();
        if (final) { h.fix(); await flush(); await h.advance(60000); h.session.finish(); }
        const posts = h.requests.length;
        await h.advance(15000); await h.advance(250); await h.advance(500); h.fix(); await flush();
        assert.equal(h.requests.length, posts + 1);
        assert.equal(h.state.phase, final ? 'complete' : 'waiting');
        assert.equal(h.state.locationPending, false); assert.equal(h.state.locationIssue, null);
        assert.equal(h.state.elapsedMs, final ? 60000 : 0);
    }
});

test('a silent provider is retried by a real 15-second watchdog within a fixed 30-second budget', async () => {
    for (const final of [false, true]) {
        const h = harness(); h.session.start();
        if (final) { h.fix(); await flush(); await h.advance(60000); h.session.finish(); }
        const attempt = h.fixes.at(-1), count = h.fixes.length, posts = h.requests.length;
        await h.advance(15000);
        assert.equal(h.state.locationIssue?.code, 'gps_timeout');
        assert.equal(h.state.busy, true); assert.equal(h.state.locationPending, true);
        await h.advance(250); assert.equal(h.fixes.length, count + 1);
        assert.equal(h.fixes.at(-1).options.timeout, 14750, 'retry must not extend the overall deadline');
        h.fix(attempt); await flush(); assert.equal(h.requests.length, posts, 'a timed-out provider cannot later submit');
        await h.advance(14750);
        assert.equal(h.state.errorCode, 'location_timeout'); assert.equal(h.state.busy, false);
        assert.equal(h.state.active, final); assert.equal(h.state.phase, final ? 'waiting' : 'error');
        assert.equal(h.state.locationPending, false); assert.equal(h.taskCount, 0);
        const late = h.fixes.at(-1); h.fix(late); await flush();
        await h.advance(60000); assert.equal(h.fixes.length, count + 1); assert.equal(h.requests.length, posts);
    }
});

test('safe local diagnostics are immutable copies and retries never extend a start or final deadline', async () => {
    for (const final of [false, true]) {
        const h = harness(); h.session.start();
        if (final) { h.fix(); await flush(); await h.advance(60000); h.session.finish(); }
        h.fix(h.fixes.at(-1), h.time - 11000); await flush();
        assert.equal(h.state.locationIssue.code, 'gps_stale');
        h.state.locationIssue.code = 'PRIVATE';
        assert.equal(h.session.getState().locationIssue.code, 'gps_stale', 'listeners cannot mutate stored diagnostic state');
        await h.advance(30000);
        assert.equal(h.state.errorCode, 'location_timeout');
        assert.equal(h.state.locationIssue.code, 'gps_timeout');
        assert.equal(h.state.active, final); assert.equal(h.requests.length, final ? 1 : 0);
        assert.equal(h.requests.some(call => call.route.endsWith('/cancel')), false);
    }
});

test('invalid coordinates never leave the device, denied and unavailable GPS fail closed with safe codes', async () => {
    for (const coords of [null, {}, { latitude: NaN, longitude: 126, accuracy: 5 },
        { latitude: 91, longitude: 126, accuracy: 5 }, { latitude: 36, longitude: Infinity, accuracy: 5 },
        { latitude: 36, longitude: -181, accuracy: 5 }, { latitude: 36, longitude: 126, accuracy: -1 },
        { latitude: 36, longitude: 126, accuracy: '5' }]) {
        for (const final of [false, true]) {
            const h = harness(); h.session.start();
            if (final) { h.fix(); await flush(); await h.advance(60000); h.session.finish(); }
            const count = h.requests.length;
            h.fixes.at(-1).ok({ timestamp: h.time, coords }); await flush();
            assert.equal(h.requests.length, count); assert.equal(h.state.errorCode, 'invalid_position');
            assert.equal(h.state.busy, false); assert.equal(h.state.active, final);
        }
    }
    for (const [code, expected] of [[1, 'gps_denied'], [2, 'gps_unavailable']]) {
        const h = harness(); h.session.start(); h.fixes[0].error({ code, message: 'PRIVATE GPS' }); await flush();
        assert.equal(h.state.errorCode, expected); assert.equal(h.state.phase, 'error');
        assert.equal(h.state.active, false); assert.equal(h.requests.length, 0); assert.doesNotMatch(h.state.message, /PRIVATE/);
    }
});
