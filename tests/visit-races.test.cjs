const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, snapshot, idle, flush, deferred } = require('./visit-session.test.cjs');

test('suspend aborts only local work: late create, finish and GPS never cancel or resurrect an account', async () => {
    for (const step of ['gps', 'create', 'finish']) {
        const wait = deferred();
        const h = harness({ respond: call => call.route.endsWith('/resume') ? snapshot()
            : (step === 'create' || call.route.endsWith('/finish')) ? wait.promise : snapshot() });
        h.session.start();
        if (step !== 'gps') { h.fix(); await flush(); }
        if (step === 'finish') { await h.advance(60000); h.session.finish(); h.fix(); await flush(); }
        const pendingFix = h.fixes.at(-1), pendingRequest = h.requests.at(-1);
        h.session.suspend(); const states = h.states.length;
        assert.equal(h.state.suspended, true); assert.equal(h.state.busy, false); assert.equal(h.taskCount, 0);
        if (pendingRequest) assert.equal(pendingRequest.options.signal.aborted, true);
        wait.resolve(snapshot({ phase: step === 'finish' ? 'complete' : 'waiting',
            elapsedMs: step === 'finish' ? 60000 : 0, persisted: step === 'finish',
            ...(step === 'finish' ? { foundSpaceCount: 1 } : {}) }));
        h.fix(pendingFix); await flush(); await h.advance(60000);
        assert.equal(h.states.length, states); assert.equal(h.requests.some(call => call.route.endsWith('/cancel')), false);
        await h.session.restore(); assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.suspended, false);
        assert.equal(h.fixes.at(-1), pendingFix, 'resume must not request another position');
    }
});

test('explicit stop waits for cancel acknowledgement; an unknown cancellation resolves through resume', async () => {
    const wait = deferred();
    const h = harness({ respond: call => call.route.endsWith('/cancel') ? wait.promise : snapshot() });
    h.session.start(); h.fix(); await flush();
    const stopping = h.session.stop(); await flush();
    assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.active, true); assert.equal(h.state.busy, true);
    assert.deepEqual(h.requests.at(-1).body, { challenge: 'b'.repeat(48) });
    wait.resolve(null); await stopping;
    assert.equal(h.state.phase, 'stopped'); assert.equal(h.state.elapsedMs, 0); assert.equal(h.state.active, false);
    for (const cancelled of [true, false]) {
        const next = harness({ respond: call => {
            if (call.route.endsWith('/cancel')) throw { code: 'network_error' };
            if (call.route.endsWith('/resume')) return cancelled ? idle() : snapshot({ phase: 'ready', elapsedMs: 60000 });
            return snapshot();
        } });
        next.session.start(); next.fix(); await flush(); await next.advance(60000);
        await next.session.stop();
        assert.equal(next.requests.at(-1).route, '/api/stays/resume');
        assert.equal(next.state.phase, cancelled ? 'stopped' : 'ready');
        assert.equal(next.state.active, !cancelled); assert.equal(next.state.busy, false);
        assert.equal(next.fixes.length, 1);
    }
});

test('lost create replies recover via resume without another GPS; hanging final transport keeps the ready wait', async () => {
    for (const hanging of [false, true]) {
        const pending = deferred();
        const h = harness({ respond: call => call.route === '/api/stays'
            ? hanging ? pending.promise : Promise.reject({ code: 'network_error' }) : snapshot({ elapsedMs: 1200 }) });
        h.session.start(); h.fix(); await flush();
        if (hanging) await h.advance(15000);
        assert.equal(h.requests.at(-1).route, '/api/stays/resume');
        assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.elapsedMs, 1200);
        assert.equal(h.fixes.length, 1);
        const count = h.states.length; pending.resolve(snapshot()); await flush(); assert.equal(h.states.length, count);
    }
    const pending = deferred();
    const h = harness({ respond: call => call.route.endsWith('/finish') ? pending.promise : snapshot() });
    h.session.start(); h.fix(); await flush(); await h.advance(60000);
    const anchor = h.state.confirmedAt;
    h.session.finish(); h.fix(); await flush(); await h.advance(15000);
    assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.errorCode, 'request_timeout');
    assert.equal(h.state.confirmedAt, anchor); assert.equal(h.state.active, true); assert.equal(h.state.busy, false);
    assert.equal(h.requests.at(-1).options.signal.aborted, true);
    const count = h.states.length; pending.resolve(snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, foundSpaceCount: 1 }));
    await flush(); assert.equal(h.states.length, count);
});

test('suspended idle acquisition can be explicitly restarted with no stale callbacks; one attempt settles once', async () => {
    const h = harness(); h.session.start(); const old = h.fixes[0]; h.session.suspend();
    h.session.start(); const fresh = h.fixes.at(-1);
    assert.equal(h.state.suspended, false); assert.equal(h.fixes.length, 2);
    h.fix(old); await flush(); assert.equal(h.requests.length, 0);
    h.fix(fresh); h.fix(fresh); fresh.error({ code: 1 }); await flush();
    assert.equal(h.requests.length, 1); assert.equal(h.state.phase, 'waiting');
});

test('suspending before the request microtask starts sends no HTTP and leaves account progress alone', async () => {
    const h = harness(); h.session.start(); h.fix(); h.session.suspend(); await flush();
    assert.equal(h.requests.length, 0); assert.equal(h.state.suspended, true);
});

test('explicit early finish cannot manufacture elapsed time and a server rejection leaves the same wait recoverable', async () => {
    const h = harness(); h.session.start(); h.fix(); await flush(); await h.advance(1000);
    h.session.finish(); h.fix(); await flush();
    assert.equal(h.state.errorCode, 'too_early'); assert.equal(h.state.phase, 'waiting');
    assert.equal(h.state.elapsedMs, 0); assert.equal(h.state.persisted, false);
    assert.deepEqual(Object.keys(h.requests.at(-1).body).sort(), ['accuracy', 'challenge', 'latitude', 'longitude']);
});

test('explicit stop while create is unacknowledged durably abandons that attempt rather than trusting resume', async () => {
    const pending = deferred();
    const h = harness({ respond: call => call.route === '/api/stays' ? pending.promise
        : call.route.endsWith('/resume') ? snapshot() : null });
    h.session.start(); h.fix(); await flush();
    await h.session.stop();
    assert.deepEqual(h.requests.map(call => call.route), ['/api/stays', '/api/stays/abandon']);
    assert.deepEqual(h.requests[1].body, { spaceId: 'indoor-01', attemptId: h.requests[0].body.attemptId });
    assert.equal(h.state.phase, 'stopped'); assert.equal(h.state.active, false);
    const count = h.states.length; pending.resolve(snapshot()); await flush(); assert.equal(h.states.length, count);
    const gps = harness(); gps.session.start(); const old = gps.fixes[0];
    await gps.session.stop(); gps.fix(old); await flush(); await gps.advance(60000);
    assert.equal(gps.requests.length, 0); assert.equal(gps.state.phase, 'stopped'); assert.equal(gps.taskCount, 0);
});

test('lost abandon responses keep cancellation accessible and retry the identical intent, never idle resume', async () => {
    const pending = deferred();
    let failed = true;
    const h = harness({ respond: call => {
        if (call.route === '/api/stays') return pending.promise;
        if (call.route.endsWith('/abandon')) {
            if (failed) throw { code: 'network_error' };
            return null;
        }
        if (call.route.endsWith('/resume')) return idle();
        assert.fail('unexpected route');
    } });
    h.session.start(); h.fix(); await flush(); await h.session.stop();
    assert.equal(h.state.phase, 'error'); assert.match(h.state.message, /확인필요/);
    assert.equal(h.state.active, true, 'the existing UI must keep the explicit cancel control visible');
    assert.equal(h.state.busy, false); assert.equal(h.state.cancelling, false);
    const firstAbandon = h.requests.at(-1);
    h.session.start(); await flush(); assert.equal(h.requests.length, 2, 'cannot replace an unresolved attempt');
    h.session.suspend(); await h.session.restore();
    assert.equal(h.state.phase, 'error'); assert.equal(h.requests.at(-1).route, '/api/stays/abandon');
    assert.equal(h.requests.length, 2, 'visibility restoration keeps 확인필요 until an explicit cancellation retry');
    assert.equal(h.state.suspended, false, 'visible retry must re-enable the existing cancel control');
    failed = false; await h.session.stop();
    assert.equal(h.state.phase, 'stopped');
    assert.equal(h.requests.some(call => call.route.endsWith('/resume')), false);
    for (const call of h.requests.slice(1)) assert.deepEqual(call.body, firstAbandon.body);
    const count = h.states.length; pending.resolve(snapshot()); await flush(); assert.equal(h.states.length, count);
});

test('an idle resume overtaking an uncertain create preserves its attempt and never advertises an established wait', async () => {
    const h = harness({ respond: call => call.route === '/api/stays' ? Promise.reject({ code: 'network_error' })
        : call.route.endsWith('/abandon') ? null : idle() });
    h.session.start(); h.fix(); await flush();
    assert.equal(h.state.phase, 'error'); assert.equal(h.state.active, true); assert.equal(h.state.id, undefined);
    assert.match(h.state.message, /확인필요/);
    assert.doesNotMatch(h.state.message, /기다린 진행|진행은 유지/);
    await h.session.restore(); assert.equal(h.state.phase, 'error');
    await h.session.stop();
    assert.deepEqual(h.requests.at(-1).body, { spaceId: 'indoor-01', attemptId: h.requests[0].body.attemptId });
    assert.equal(h.state.phase, 'stopped');
});

test('a later resume recovers failed restoration without another permission request', async () => {
    let failed = true;
    const h = harness({ respond: () => failed ? Promise.reject({ code: 'network_error' }) : snapshot({ phase: 'ready', elapsedMs: 60000 }) });
    await h.session.restore(); assert.equal(h.state.errorCode, 'network_error');
    failed = false; await h.session.restore(); assert.equal(h.state.phase, 'ready');
    assert.equal(h.fixes.length, 0); assert.equal(h.state.errorCode, null);
});

test('a bounded cancel timeout resolves through status instead of claiming cancellation from silence', async () => {
    const wait = deferred();
    const h = harness({ respond: call => call.route.endsWith('/cancel') ? wait.promise : snapshot({ phase: 'ready', elapsedMs: 60000 }) });
    h.session.start(); h.fix(); await flush(); h.session.stop(); await flush();
    await h.advance(15000);
    assert.equal(h.requests.at(-1).route, '/api/stays/resume'); assert.equal(h.state.phase, 'ready');
    assert.equal(h.state.active, true); assert.equal(h.state.busy, false);
});

test('an unknown cancel cannot erase the UI when its status lookup is malformed', async () => {
    const h = harness({ respond: call => call.route.endsWith('/cancel') ? Promise.reject({ code: 'network_error' })
        : call.route.endsWith('/resume') ? { mode: 'start_finish', phase: 'idle', spaceId: 'other' } : snapshot({ elapsedMs: 24000 }) });
    h.session.start(); h.fix(); await flush(); const anchor = h.state.confirmedAt;
    await h.session.stop();
    assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.elapsedMs, 24000); assert.equal(h.state.confirmedAt, anchor);
    assert.equal(h.state.errorCode, 'invalid_response'); assert.equal(h.state.active, true);
});

test('explicit cancel interrupted by suspension keeps progress; an unknown cancellation plus failed resume stays retryable', async () => {
    const wait = deferred();
    const h = harness({ respond: call => call.route.endsWith('/cancel') ? wait.promise : snapshot({ elapsedMs: 12000 }) });
    h.session.start(); h.fix(); await flush(); h.session.stop(); await flush();
    h.session.suspend(); const count = h.states.length; wait.resolve(null); await flush();
    assert.equal(h.states.length, count); assert.equal(h.state.phase, 'waiting'); assert.equal(h.state.active, true);
    const failed = harness({ respond: call => call.route.endsWith('/cancel') || call.route.endsWith('/resume')
        ? Promise.reject({ code: 'network_error' }) : snapshot() });
    failed.session.start(); failed.fix(); await flush(); await failed.session.stop();
    assert.equal(failed.state.phase, 'waiting'); assert.equal(failed.state.errorCode, 'network_error');
    assert.equal(failed.state.active, true); assert.equal(failed.state.busy, false);
});
