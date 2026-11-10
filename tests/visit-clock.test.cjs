const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../public/js/visit-clock.js');
const dwelling = { phase: 'dwelling', active: true, elapsedMs: 20000, requiredMs: 60000, confirmedAt: 100000, maxGapMs: 12000 };

function clock() {
    assert.ok(fs.existsSync(file), 'display-only clock must interpolate between server confirmations');
    return require(file).getDisplayTime;
}

test('display advances each second from the server anchor without changing confirmed time', () => {
    const read = clock();
    const state = Object.freeze({ ...dwelling });
    assert.deepEqual([0, 1000, 2000, 3000].map(delta => read(state, 100000 + delta).remainingMs), [40000, 39000, 38000, 37000]);
    assert.equal(state.elapsedMs, 20000);
    assert.equal(read(state, 102000).serverComplete, false);
    assert.equal(read(state, 99000).remainingMs, 40000, 'negative local elapsed time cannot increase progress');
});

test('a known pending location retry holds confirmed progress instead of predicting unobserved time', () => {
    const state = Object.freeze({ ...dwelling, locationPending: true });
    const result = clock()(state, 109000);
    assert.equal(result.elapsedMs, 20000);
    assert.equal(result.remainingMs, 40000);
    assert.equal(result.serverComplete, false);
    assert.equal(result.awaitingFinal, false);
    assert.equal(clock()(state, 113000).stale, true, 'a paused display still has the original deadline');
});

test('the actual confirmation deadline bounds projection even when a response consumed part of the gap', () => {
    const state = { ...dwelling, maxGapMs: 25000, confirmationDeadlineAt: 120000 };
    assert.equal(clock()(state, 120001).stale, true, 'reply latency must not buy extra unconfirmed display time');
    assert.equal(clock()(state, 130000).elapsedMs, 40000);
});

test('zero on the display means awaiting final verification, never local completion', () => {
    const read = clock();
    const near = { ...dwelling, elapsedMs: 59000 };
    const pending = read(near, 102000);
    assert.equal(pending.elapsedMs, 60000);
    assert.equal(pending.remainingMs, 0);
    assert.equal(pending.awaitingFinal, true);
    assert.equal(pending.serverComplete, false);
    const approved = read({ ...near, phase: 'complete', active: false, elapsedMs: 60000 }, 200000);
    assert.equal(approved.remainingMs, 0);
    assert.equal(approved.awaitingFinal, false);
    assert.equal(approved.serverComplete, true);
});

test('no initial location, reset phases, missing confirmation and inactivity cannot interpolate', () => {
    const read = clock();
    for (const phase of ['waiting', 'requesting', 'locating', 'outside', 'uncertain', 'error', 'stopped']) {
        const result = read({ ...dwelling, phase, elapsedMs: 0 }, 108000);
        assert.equal(result.elapsedMs, 0, phase);
        assert.equal(result.awaitingFinal, false, phase);
    }
    assert.equal(read({ ...dwelling, active: false }, 108000).elapsedMs, 20000);
    assert.equal(read({ ...dwelling, confirmedAt: null }, 108000).elapsedMs, 20000);
});

test('interpolation is bounded by the existing sample deadline and reanchors to new server data', () => {
    const read = clock();
    const stale = read(dwelling, 160000);
    assert.equal(stale.stale, true);
    assert.equal(stale.elapsedMs, 32000, 'never extrapolate indefinitely without samples');
    assert.equal(stale.awaitingFinal, false);
    const reset = read({ ...dwelling, elapsedMs: 0, confirmedAt: 160000 }, 161000);
    assert.equal(reset.elapsedMs, 1000, 'server reset overrides an older projection');
    assert.equal(read({ ...dwelling, elapsedMs: 23000, confirmedAt: 103100 }, 104100).elapsedMs, 24000);
    const malformed = read({ ...dwelling, confirmedAt: NaN, maxGapMs: Infinity }, 108000);
    assert.equal(malformed.elapsedMs, 20000);
});
