const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, snapshot, idle, flush, deferred } = require('./visit-session.test.cjs');

test('strict fixed-contract validation rejects malformed snapshots without claiming saved completion', async () => {
    const invalid = [null, [], {}, snapshot({ mode: 'continuous' }), snapshot({ spaceId: 'other' }),
        snapshot({ id: '../cancel' }), snapshot({ id: 'g'.repeat(48) }), snapshot({ challenge: 'short' }),
        snapshot({ phase: 'dwelling' }), snapshot({ requiredMs: 0 }), snapshot({ requiredMs: Infinity }),
        snapshot({ elapsedMs: -1 }), snapshot({ elapsedMs: 60001 }), snapshot({ expiresInMs: NaN }),
        snapshot({ expiresInMs: 7200001 }), snapshot({ expiresInMs: 0 }), snapshot({ distanceM: -1 }),
        snapshot({ accuracyM: '5' }), snapshot({ distanceM: Infinity }), snapshot({ persisted: true }),
        snapshot({ newlyFound: true }), snapshot({ newlyFound: undefined }), snapshot({ locationTimeoutMs: 6000 }),
        snapshot({ initialTimeoutMs: 15000 }), snapshot({ phase: 'ready', elapsedMs: 59999 }),
        snapshot({ phase: 'waiting', elapsedMs: 60000 }), snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, foundSpaceCount: -1 }),
        snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, foundSpaceCount: 1.5 }),
        snapshot({ extra: 'unexpected' }), snapshot({ id: ['a'.repeat(48)] }), snapshot({ challenge: ['b'.repeat(48)] }),
        snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 0 }),
        idle({ requiredMs: 0 }), idle({ spaceId: 'other' }), idle({ id: 'unexpected' })];
    for (const response of invalid) {
        const h = harness({ respond: () => response }); await h.session.restore();
        assert.equal(h.state.errorCode, 'invalid_response', JSON.stringify(response));
        assert.equal(h.state.phase, 'error'); assert.equal(h.state.persisted, false);
        assert.equal(h.fixes.length, 0); assert.equal(h.requests.length, 1);
        assert.equal(h.state.foundSpaceCount, undefined);
    }
    const good = harness({ respond: () => snapshot({ distanceM: null, accuracyM: null }) });
    await good.session.restore(); assert.equal(good.state.phase, 'waiting');
});

test('seven-second start and final acquisition plus reply latency do not reintroduce a 25-second continuity deadline', async () => {
    const response = deferred();
    const h = harness({ respond: call => call.route.endsWith('/finish') ? response.promise : snapshot() });
    h.session.start(); await h.advance(7000); h.fix(); await flush();
    assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.elapsedMs, 0);
    await h.advance(90000); assert.equal(h.requests.length, 1); assert.equal(h.fixes.length, 1);
    h.session.finish(); await h.advance(7000); h.fix(); await flush(); await h.advance(5000);
    assert.equal(h.state.busy, true); assert.equal(h.state.phase, 'waiting');
    response.resolve(snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 1 }));
    await flush(); assert.equal(h.state.phase, 'complete');
    assert.equal(h.requests.length, 2); assert.equal(h.fixes.length, 2);
    assert.equal(h.fixes.every(fix => fix.options.timeout === 15000 && fix.options.maximumAge === 0), true);
});

test('finish cannot switch session, challenge or duration through a well-shaped but mismatched reply', async () => {
    for (const overrides of [{ id: 'c'.repeat(48) }, { challenge: 'c'.repeat(48) }, { requiredMs: 90000, elapsedMs: 90000 }]) {
        const h = harness({ respond: call => call.route.endsWith('/finish') ? snapshot({ phase: 'complete', elapsedMs: 60000,
            persisted: true, newlyFound: true, foundSpaceCount: 1, ...overrides }) : snapshot() });
        h.session.start(); h.fix(); await flush(); await h.advance(60000);
        h.session.finish(); h.fix(); await flush();
        assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.errorCode, 'invalid_response');
        assert.equal(h.state.persisted, false); assert.equal(h.state.active, true);
        assert.equal(h.state.requiredMs, 60000); assert.equal(h.state.foundSpaceCount, undefined);
    }
});
