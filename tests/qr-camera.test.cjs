const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '..', 'public/js/qr-camera.js');

function harness(getUserMedia, readCode = () => null) {
    assert.ok(fs.existsSync(modulePath), 'camera lifecycle module must exist');
    const { createCameraSession } = require(modulePath);
    const states = [], codes = [], tasks = new Map();
    let timerId = 0;
    const video = { srcObject: null, readyState: 4, videoWidth: 640, play: async () => {}, pause: () => {} };
    const session = createCameraSession({
        video, mediaDevices: { getUserMedia }, readCode,
        onState: state => states.push(state), onCode: code => codes.push(code),
        setTimer: (fn, delay) => { tasks.set(++timerId, {fn, delay}); return timerId; },
        clearTimer: id => tasks.delete(id),
    });
    return { session, video, states, codes, tasks };
}
function stream() {
    const track = { readyState: 'live', stops: 0, addEventListener() {}, stop() { this.stops++; this.readyState = 'ended'; } };
    return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

test('camera opens only when started, requests no microphone, and stops before reporting QR', async () => {
    const s = stream();
    const requests = [];
    const h = harness(async constraints => { requests.push(constraints); return s; }, () => 'https://spacecycle.space/spaces?space=indoor-01');
    assert.equal(requests.length, 0);
    await h.session.start();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].audio, false);
    assert.equal(requests[0].video.facingMode.ideal, 'environment');
    assert.equal(h.states.at(-1).phase, 'scanning');
    const frame = [...h.tasks.values()].find(t => t.delay < 1000);
    assert.ok(frame);
    frame.fn();
    assert.equal(s.track.readyState, 'ended');
    assert.equal(h.video.srcObject, null);
    assert.deepEqual(h.codes, ['https://spacecycle.space/spaces?space=indoor-01']);
});

test('late permission results are released after cancellation, never attached', async () => {
    let resolve;
    const s = stream();
    const h = harness(() => new Promise(r => { resolve = r; }));
    const pending = h.session.start();
    assert.equal(h.states.at(-1).phase, 'requesting');
    h.session.stop('취소됨');
    resolve(s);
    await pending;
    assert.equal(s.track.readyState, 'ended');
    assert.equal(h.video.srcObject, null);
    assert.equal(h.states.at(-1).phase, 'stopped');
});

test('permission errors are actionable and retryable without leaking exception details', async () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError']) {
        const h = harness(async () => { const e = new Error('private driver details'); e.name = name; throw e; });
        await h.session.start();
        assert.equal(h.states.at(-1).phase, 'error');
        assert.ok(h.states.at(-1).message.length > 10);
        assert.ok(!h.states.at(-1).message.includes('private'));
        assert.equal(h.video.srcObject, null);
        assert.equal(h.tasks.size, 0);
    }
});

test('pending requests time out and late streams are stopped', async () => {
    let resolve;
    const s = stream();
    const h = harness(() => new Promise(r => { resolve = r; }));
    const pending = h.session.start();
    const timeout = [...h.tasks.values()].find(t => t.delay >= 1000);
    timeout.fn();
    assert.equal(h.states.at(-1).phase, 'error');
    resolve(s);
    await pending;
    assert.equal(s.track.readyState, 'ended');
    assert.equal(h.video.srcObject, null);
});

test('double start is ignored and a previous permission cannot replace a newer camera session', async () => {
    const resolvers = [];
    const h = harness(() => new Promise(r => resolvers.push(r)));
    const first = h.session.start();
    await h.session.start();
    assert.equal(resolvers.length, 1);
    h.session.stop();
    const second = h.session.start();
    const old = stream(), current = stream();
    resolvers[1](current);
    await second;
    resolvers[0](old);
    await first;
    assert.equal(h.video.srcObject, current);
    assert.equal(old.track.readyState, 'ended');
    h.session.stop();
    assert.equal(current.track.readyState, 'ended');
});
