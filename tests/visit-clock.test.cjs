const test = require('node:test');
const assert = require('node:assert/strict');
const { getDisplayTime } = require('../public/js/visit-clock.js');
const waiting = { mode: 'start_finish', phase: 'waiting', active: true, elapsedMs: 20000,
    requiredMs: 90000, confirmedAt: 100000, expiresInMs: 7200000 };

test('server wait projects continuously past 25 seconds and zero only invites explicit final verification', () => {
    const state = Object.freeze({ ...waiting });
    assert.deepEqual([0, 1000, 30000, 60000].map(delta => getDisplayTime(state, 100000 + delta).remainingMs),
        [70000, 69000, 40000, 10000]);
    const zero = getDisplayTime(state, 170000);
    assert.equal(zero.elapsedMs, 90000); assert.equal(zero.remainingMs, 0);
    assert.equal(zero.awaitingFinal, true); assert.equal(zero.serverComplete, false); assert.equal(zero.stale, false);
    assert.equal(state.elapsedMs, 20000);
});

test('projection requires a live start/finish anchor and bounded expiry; expiry disables final check without inventing completion', () => {
    for (const override of [{ active: false }, { mode: 'continuous' }, { confirmedAt: null }, { confirmedAt: NaN },
        { expiresInMs: NaN }, { expiresInMs: Infinity }, { expiresInMs: 7200001 }, { expiresInMs: -1 }]) {
        const state = { ...waiting, ...override };
        assert.equal(getDisplayTime(state, 160000).elapsedMs, 20000, JSON.stringify(override));
        assert.equal(getDisplayTime(state, 160000).awaitingFinal, false);
    }
    const limited = { ...waiting, expiresInMs: 40000 };
    const expired = getDisplayTime(limited, 150000);
    assert.equal(expired.stale, true); assert.equal(expired.elapsedMs, 60000);
    assert.equal(expired.awaitingFinal, false); assert.equal(expired.serverComplete, false);
    assert.equal(getDisplayTime(waiting, 99000).elapsedMs, 20000);
    assert.equal(getDisplayTime({ ...waiting, locationPending: true }, 160000).elapsedMs, 80000,
        'a pending final check cannot throw away time from the durable server wait');
    assert.equal(getDisplayTime({ ...waiting, phase: 'complete', persisted: false }, 160000).serverComplete, false);
    assert.equal(getDisplayTime({ ...waiting, phase: 'complete', persisted: true }, 160000).serverComplete, true);
    for (const phase of ['idle', 'locating', 'requesting', 'error', 'stopped']) {
        assert.equal(getDisplayTime({ ...waiting, phase }, 160000).elapsedMs, 20000);
    }
    assert.equal(getDisplayTime({ ...waiting, confirmedAt: 103000, elapsedMs: 23000 }, 104000).elapsedMs, 24000);
});

test('an invalid wait cannot advertise readiness and non-finite display inputs stay bounded', () => {
    for (const value of [NaN, Infinity, -1000]) {
        const result = getDisplayTime({ ...waiting, elapsedMs: value }, 100000);
        assert.equal(result.elapsedMs, 0); assert.equal(result.remainingMs, waiting.requiredMs);
    }
    assert.equal(getDisplayTime(waiting, NaN).elapsedMs, 20000);
    assert.equal(getDisplayTime(waiting, Infinity).elapsedMs, 20000);
    const unsaved = getDisplayTime({ ...waiting, phase: 'complete', persisted: false, elapsedMs: 60000 }, 160000);
    assert.equal(unsaved.serverComplete, false); assert.equal(unsaved.awaitingFinal, false);
});
