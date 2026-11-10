const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const file = path.join(__dirname, '../server/stay-policy.js');
function policy() {
    assert.ok(fs.existsSync(file), 'the server must own one validated timing policy');
    return require(file);
}

test('server timing policy reserves acquisition and network time inside a bounded continuity window', () => {
    const { readStayPolicy } = policy();
    assert.deepEqual(readStayPolicy({}), {
        sampleEveryMs: 3000, locationTimeoutMs: 15000, initialTimeoutMs: 30000,
        networkReserveMs: 5000, maxGapMs: 25000,
    });
    const store = require('../server/stay-store.js').createStayStore({ policy: readStayPolicy({}) });
    const state = store.create('indoor-01');
    for (const [key, value] of Object.entries(readStayPolicy({}))) assert.equal(state[key], value, `API must publish ${key}`);
});

test('environment timing overrides are strict, bounded and cannot exceed safe acquisition budgets', () => {
    const { readStayPolicy, validateStayPolicy } = policy();
    const configured = readStayPolicy({ SPACE_CYCLE_LOCATION_TIMEOUT_MS: '18000', SPACE_CYCLE_MAX_GAP_MS: '30000', SPACE_CYCLE_NETWORK_RESERVE_MS: '6000' });
    assert.equal(configured.locationTimeoutMs, 18000); assert.equal(configured.maxGapMs, 30000);
    assert.equal(Object.isFrozen(configured), true);
    for (const raw of ['', '0', '-1', '15000ms', '15000.0', '015000', '900000', ' 15000', 15000]) {
        assert.throws(() => readStayPolicy({ SPACE_CYCLE_LOCATION_TIMEOUT_MS: raw }), /invalid_stay_timing/);
    }
    assert.throws(() => readStayPolicy({ SPACE_CYCLE_MAX_GAP_MS: '20000' }), /invalid_stay_timing_budget/);
    assert.throws(() => validateStayPolicy({ ...configured, sampleEveryMs: 10000 }), /invalid_stay_timing_policy/);
    assert.throws(() => validateStayPolicy({ ...configured, maxGapMs: Infinity }), /invalid_stay_timing_policy/);
});

test('the advertised server gap is enforced at its boundary and long silence cannot complete', () => {
    const { readStayPolicy } = policy();
    const { createStayStore } = require('../server/stay-store.js'); let time = 0;
    const store = createStayStore({ now: () => time, policy: readStayPolicy({}) });
    const position = { latitude: 36.7678561856971, longitude: 126.933492079991, accuracy: 5 };
    let state = store.create('indoor-01'); state = store.sample(state.id, { ...position, challenge: state.challenge });
    time = 25000; state = store.sample(state.id, { ...position, challenge: state.challenge });
    assert.equal(state.elapsedMs, 25000); assert.equal(state.reason, null);
    time += 25001; state = store.sample(state.id, { ...position, challenge: state.challenge });
    assert.equal(state.elapsedMs, 0); assert.equal(state.reason, 'gap');
    time += 60000; state = store.sample(state.id, { ...position, challenge: state.challenge });
    assert.equal(state.phase, 'dwelling'); assert.equal(state.elapsedMs, 0);
});
