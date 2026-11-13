const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, flush } = require('./visit-session.test.cjs');

test('a coarse first fix is not sent; the session keeps measuring and sends the precise one', async () => {
    const h = harness({ targetAccuracyM: 100 }); h.session.start();
    h.fix(h.fixes[0], h.time, { accuracy: 900 }); await flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.state.locationIssue?.code, 'gps_coarse');
    assert.equal(h.state.locationPending, true);
    await h.advance(250); h.fix(h.fixes.at(-1), h.time, { accuracy: 300 }); await flush();
    assert.equal(h.requests.length, 0);
    await h.advance(250); h.fix(h.fixes.at(-1), h.time, { accuracy: 20 }); await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.accuracy, 20);
    assert.equal(h.state.phase, 'waiting');
    assert.equal(h.state.locationIssue, null);
});

test('when the budget runs out with only coarse fixes, the best one is sent instead of a timeout', async () => {
    for (const final of [false, true]) {
        const h = harness({ targetAccuracyM: 100 }); h.session.start();
        if (final) { h.fix(); await flush(); await h.advance(60000); h.session.finish(); }
        const posts = h.requests.length;
        h.fix(h.fixes.at(-1), h.time, { accuracy: 400 }); await flush();
        await h.advance(250); h.fix(h.fixes.at(-1), h.time, { accuracy: 150 }); await flush();
        await h.advance(250); h.fix(h.fixes.at(-1), h.time, { accuracy: 600 }); await flush();
        assert.equal(h.requests.length, posts, 'coarse fixes are held while time remains');
        await h.advance(30000); await flush();
        assert.equal(h.requests.length, posts + 1);
        assert.equal(h.requests.at(-1).body.accuracy, 150, 'the most precise fix is sent');
        assert.notEqual(h.state.errorCode, 'location_timeout');
    }
});

test('without a target accuracy the first valid fix is sent immediately (previous behaviour)', async () => {
    const h = harness(); h.session.start();
    h.fix(h.fixes[0], h.time, { accuracy: 900 }); await flush();
    assert.equal(h.requests.length, 1);
});
