const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, snapshot, flush } = require('./visit-session.test.cjs');
const fail = code => { const error = new Error('PRIVATE INTERNAL BODY'); error.code = code; throw error; };

test('safe error messages distinguish auth, origin, edge, capacity, persistence and network failures', async () => {
    for (const [code, word] of [['invalid_token', '로그인'], ['login_required', '로그인'], ['identity_changed', '계정'],
        ['origin_denied', '주소'], ['edge_blocked', '보안'], ['capacity', '요청'], ['save_failed', '저장'],
        ['network_error', '연결'], ['auth_unavailable', '인증 서버'], ['rate_limited', '요청'], ['expired', '만료'],
        ['request_timeout', '응답'], ['not_configured', '공간'], ['stale_challenge', '요청'], ['wrong_owner', '계정'],
        ['invalid_payload', '버전'], ['invalid_position', '위치'], ['session_missing', '만료'], ['invalid_response', '응답'], ['start_cancelled', '취소']]) {
        const h = harness({ respond: () => fail(code) }); await h.session.restore();
        assert.equal(h.state.phase, 'error'); assert.equal(h.state.errorCode, code);
        assert.match(h.state.message, new RegExp(word)); assert.doesNotMatch(h.state.message, /PRIVATE/);
    }
    const unknown = harness({ respond: () => fail('PRIVATE_UNKNOWN') }); await unknown.session.restore();
    assert.equal(unknown.state.errorCode, 'server_error'); assert.doesNotMatch(unknown.state.message, /PRIVATE/);
});

test('start failures never claim an established wait; final failures explicitly say the saved progress is kept', async () => {
    for (const code of ['outside', 'uncertain', 'location_timeout', 'save_failed']) {
        const first = harness({ respond: () => fail(code) }); await first.session.restore();
        assert.doesNotMatch(first.state.message, /진행은 유지|기다린 진행|확인된 시간/);
        const final = harness({ respond: call => call.route.endsWith('/finish') ? fail(code) : snapshot() });
        final.session.start(); final.fix(); await flush(); await final.advance(60000);
        final.session.finish(); final.fix(); await flush();
        assert.match(final.state.message, /진행.*유지/);
    }
});

test('final network, rate limit, outside, uncertainty, too-early and save errors preserve wait for explicit retry', async () => {
    for (const code of ['network_error', 'request_timeout', 'rate_limited', 'outside', 'uncertain', 'too_early', 'save_failed', 'auth_unavailable', 'invalid_response']) {
        let failed = true;
        const h = harness({ respond: call => {
            if (call.route.endsWith('/finish')) {
                if (failed) return fail(code);
                return snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 1 });
            }
            return snapshot();
        } });
        h.session.start(); h.fix(); await flush(); await h.advance(60000);
        const before = h.state;
        h.session.finish(); h.fix(); await flush();
        assert.equal(h.state.errorCode, code); assert.equal(h.state.phase, 'waiting');
        assert.equal(h.state.confirmedAt, before.confirmedAt); assert.equal(h.state.elapsedMs, before.elapsedMs);
        assert.equal(h.state.active, true); assert.equal(h.state.busy, false);
        assert.equal(h.requests.some(call => call.route.endsWith('/cancel')), false);
        failed = false; await h.advance(250); h.session.finish(); h.fix(); await flush();
        assert.equal(h.state.phase, 'complete', code);
    }
});
