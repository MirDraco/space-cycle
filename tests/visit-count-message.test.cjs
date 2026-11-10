const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, snapshot, flush } = require('./visit-session.test.cjs');
async function complete(overrides) {
    const h = harness({ respond: call => call.route.endsWith('/finish')
        ? snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 2, ...overrides })
        : snapshot() });
    h.session.start(); h.fix(); await flush(); await h.advance(60000);
    h.session.finish(); h.fix(); await flush(); return h;
}
test('starting with an already complete account/place response is idempotent and never launches final GPS', async () => {
    const h = harness({ respond: () => snapshot({ phase: 'complete', elapsedMs: 60000,
        persisted: true, newlyFound: false, foundSpaceCount: 1 }) });
    h.session.start(); h.fix(); await flush();
    assert.equal(h.state.phase, 'complete'); assert.equal(h.state.newlyFound, false);
    assert.match(h.state.message, /중복/);
    h.session.finish(); await h.advance(60000);
    assert.equal(h.requests.length, 1); assert.equal(h.fixes.length, 1);
});

test('saved and duplicate completions explain the count, and unsaved completion stays retryable not complete', async () => {
    const fresh = await complete({}); assert.equal(fresh.state.persisted, true);
    assert.match(fresh.state.message, /2곳/); assert.match(fresh.state.message, /추가/);
    const repeat = await complete({ newlyFound: false }); assert.equal(repeat.state.persisted, true);
    assert.match(repeat.state.message, /이미/); assert.match(repeat.state.message, /중복/);
    const unsaved = await complete({ persisted: false, newlyFound: false });
    assert.notEqual(unsaved.state.phase, 'complete'); assert.equal(unsaved.state.persisted, false);
    assert.equal(unsaved.state.errorCode, 'save_failed'); assert.match(unsaved.state.message, /저장/);
    assert.equal(unsaved.state.active, true); assert.equal(unsaved.state.busy, false);
    assert.equal(unsaved.state.foundSpaceCount, undefined);
});
