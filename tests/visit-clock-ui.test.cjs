const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { snapshot, idle, flush, deferred } = require('./visit-session.test.cjs');
const root = path.resolve(__dirname, '..');
const callResult = (status, body) => ({ httpStatus: status, body });
function harness({ initial = idle(), ready = true, uid = 'A', secure = true, respond } = {}) {
    let time = 100000, user = uid ? { uid } : null, authReady = ready, serial = 0, refreshes = 0;
    const tasks = new Map(), handlers = new Map(), elements = new Map(), fixes = [], requests = [];
    const schedule = (fn, ms, repeat = false) => { const id = ++serial; tasks.set(id, { fn, at: time + ms, ms, repeat }); return id; };
    for (const name of ['visit-status', 'visit-start', 'visit-finish', 'visit-stop', 'visit-timer', 'visit-progress',
        'visit-distance', 'visit-accuracy', 'visit-freshness', 'visit-login', 'visit-name', 'visit-condition',
        'visit-back', 'visit-reload', 'visit-build', 'visit-diagnostics']) {
        const listeners = {};
        elements.set(name, { textContent: '', hidden: false, disabled: false, dataset: {}, value: 0, max: 60000,
            href: '', addEventListener: (event, fn) => { listeners[event] = fn; },
            click: () => { const element = elements.get(name); if (!element.disabled) listeners.click?.(); },
            setAttribute() {}, removeAttribute() {} });
    }
    const document = { hidden: false, getElementById: name => elements.get(name) || null,
        querySelector: () => ({ content: 'fixture-build' }), addEventListener: (name, fn) => handlers.set('document:' + name, fn) };
    const geolocation = { getCurrentPosition: (ok, error, options) => fixes.push({ ok, error, options }) };
    let stored = initial, startedAt = time - (initial.elapsedMs || 0);
    const requestFactory = require('../public/js/visit-request.js');
    const engine = require('../public/js/visit-session.js');
    const context = { document, location: { search: '?space=indoor-01', reload() {} }, performance: { now: () => time },
        navigator: { geolocation, onLine: true }, isSecureContext: secure, URLSearchParams, console,
        SpaceCycleAuth: { get isReady() { return authReady; }, getUser: () => user, getToken: async () => 'fixture-token',
            refreshFoundSpaces: async () => { refreshes++; } },
        SpaceCycleSpaces: require('../public/js/space-data.js'), SpaceCycleQrPolicy: require('../public/js/qr-policy.js'),
        SpaceCycleVisitClock: require('../public/js/visit-clock.js'),
        SpaceCycleVisitRequest: { createVisitRequest: options => requestFactory.createVisitRequest({ ...options,
            fetchImpl: async (route, options) => {
                const call = { route, body: JSON.parse(options.body), options, owner: user?.uid }; requests.push(call);
                let result;
                if (respond) result = await respond(call);
                else if (route.endsWith('/cancel')) { stored = idle(); result = null; }
                else if (route.endsWith('/resume')) result = stored.phase === 'idle' || stored.phase === 'complete' ? stored
                    : snapshot({ ...stored, elapsedMs: Math.min(stored.requiredMs, time - startedAt),
                        phase: time - startedAt >= stored.requiredMs ? 'ready' : 'waiting' });
                else if (route === '/api/stays') { stored = stored.phase === 'idle' ? snapshot() : stored; startedAt = time; result = stored; }
                else if (route.endsWith('/finish')) { stored = snapshot({ phase: 'complete', elapsedMs: 60000,
                    persisted: true, newlyFound: true, foundSpaceCount: 1 }); result = stored; }
                else assert.fail(route);
                const status = result?.httpStatus ?? (result === null ? 204 : 200);
                const body = result?.httpStatus ? result.body : result;
                return { ok: status >= 200 && status < 300, status,
                    headers: { get: () => 'application/json' }, json: async () => body };
            } }) },
        SpaceCycleVisit: { createVisitSession: options => engine.createVisitSession({ ...options, now: () => time,
            wallNow: () => time, schedule, unschedule: id => tasks.delete(id) }) },
        setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => tasks.delete(id),
        setTimeout: schedule, clearTimeout: id => tasks.delete(id), addEventListener: (name, fn) => handlers.set('window:' + name, fn),
    };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/visit.js'), 'utf8'), context);
    const event = (name, value) => {
        if (name === 'visibilitychange') document.hidden = value;
        if (name === 'online') context.navigator.onLine = true;
        if (name === 'offline') context.navigator.onLine = false;
        if (name === 'pageshow') handlers.get('window:pageshow')?.({ persisted: value });
        else handlers.get((['visibilitychange', 'click'].includes(name) ? 'document:' : 'window:') + name)?.({ target: {} });
    };
    const advance = async ms => {
        const until = time + ms;
        for (let count = 0; ; count++) {
            assert.ok(count < 40000, 'UI timers must remain bounded');
            const due = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
            if (!due || due[1].at > until) break;
            const [id, task] = due; time = task.at;
            if (task.repeat) task.at += task.ms; else tasks.delete(id);
            task.fn(); await flush();
        }
        time = until; await flush();
    };
    const fix = (attempt = fixes.at(-1), timestamp = time) => attempt.ok({ timestamp,
        coords: { latitude: 36.7678561856971, longitude: 126.933492079991, accuracy: 5 } });
    return { elements, fixes, requests, advance, event, fix,
        async auth(uid, ready = true) { user = uid ? { uid } : null; authReady = ready; event('spacecycle:authchange'); await flush(); },
        get refreshes() { return refreshes; }, get intervalCount() { return [...tasks.values()].filter(task => task.repeat).length; } };
}
module.exports = { harness };

test('mobile view offers the final button and honest start/finish, account progress and expiry disclosures', () => {
    const html = fs.readFileSync(path.join(root, 'views/visit.html'), 'utf8');
    assert.match(html, /id="visit-finish"[^>]*disabled[^>]*hidden[^>]*>마지막 위치 확인/);
    assert.match(html, /시작·종료 위치와 시간 확인, 중간 연속 체류는 검증하지 않아요/);
    assert.match(html, /계정 ID·공간 ID·시작 시각·만료 시각/);
    assert.match(html, /2시간/); assert.match(html, /원본 좌표는 저장하지 않/);
    assert.doesNotMatch(html, /연속 \d+초|확인 기한25초|초기화|1분|다른 화면 이동.*처음부터/);
    assert.match(html, /<!-- app-header -->/); assert.match(html, /<!-- app-navigation -->/);
    assert.match(html, /class="app-shell"/); assert.match(html, /\/css\/visit.css/);
});

test('UI restores without GPS, ticks silently, enables an explicit final button at zero and refreshes count only on saved completion', async () => {
    const h = harness(); await flush();
    assert.deepEqual(h.requests.map(call => call.route), ['/api/stays/resume']); assert.equal(h.fixes.length, 0);
    assert.equal(h.elements.get('visit-finish').hidden, true);
    h.elements.get('visit-start').click(); assert.equal(h.fixes.length, 1); h.fix(); await flush();
    assert.equal(h.elements.get('visit-status').dataset.phase, 'waiting');
    assert.equal(h.elements.get('visit-timer').textContent, '01:00');
    assert.equal(h.elements.get('visit-finish').hidden, false); assert.equal(h.elements.get('visit-finish').disabled, true);
    await h.advance(30000); assert.equal(h.elements.get('visit-timer').textContent, '00:30');
    await h.advance(30000); assert.equal(h.elements.get('visit-timer').textContent, '00:00');
    assert.equal(h.requests.length, 2); assert.equal(h.fixes.length, 1); assert.equal(h.refreshes, 0);
    assert.equal(h.elements.get('visit-finish').disabled, false);
    assert.equal(h.elements.get('visit-finish').textContent, '마지막 위치 확인');
    assert.match(h.elements.get('visit-status').textContent, /마지막 위치.*확인/);
    h.elements.get('visit-finish').click(); assert.equal(h.fixes.length, 2); assert.equal(h.refreshes, 0);
    h.fix(); await flush(); assert.equal(h.elements.get('visit-status').dataset.phase, 'complete');
    assert.equal(h.refreshes, 1); assert.equal(h.intervalCount, 0);
    assert.equal(h.elements.get('visit-stop').hidden, false, 'completed progress may be explicitly cleared without deleting earned visit');
});

test('final GPS errors keep zero and enable retry, never cancel background/offline progress', async () => {
    const h = harness({ initial: snapshot({ phase: 'ready', elapsedMs: 60000 }) }); await flush();
    assert.equal(h.fixes.length, 0); assert.equal(h.elements.get('visit-finish').disabled, false);
    for (const code of [1, 2]) {
        h.elements.get('visit-finish').click(); h.fixes.at(-1).error({ code }); await flush();
        assert.equal(h.elements.get('visit-timer').textContent, '00:00');
        assert.equal(h.elements.get('visit-finish').disabled, false);
        assert.equal(h.elements.get('visit-status').dataset.errorCode, code === 1 ? 'gps_denied' : 'gps_unavailable');
        assert.equal(h.elements.get('visit-status').dataset.phase, 'ready'); assert.equal(h.refreshes, 0);
    }
    h.elements.get('visit-finish').click(); const late = h.fixes.at(-1);
    h.event('visibilitychange', true); assert.equal(h.intervalCount, 0);
    h.fix(late); await flush(); assert.equal(h.requests.length, 1);
    await h.advance(30000); h.event('visibilitychange', false); await flush();
    assert.equal(h.requests.at(-1).route, '/api/stays/resume'); assert.equal(h.fixes.at(-1), late);
    assert.equal(h.elements.get('visit-finish').disabled, false);
    h.event('offline'); await h.advance(30000); h.event('online'); await flush();
    assert.equal(h.elements.get('visit-timer').textContent, '00:00');
    assert.equal(h.requests.every(call => call.route === '/api/stays/resume'), true);
});

test('restored saved completion refreshes once for that id and once again for a different completed visit', async () => {
    let result = snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: false, foundSpaceCount: 1 });
    const h = harness({ respond: () => result }); await flush();
    assert.equal(h.refreshes, 1); assert.equal(h.fixes.length, 0);
    h.event('visibilitychange', true); h.event('visibilitychange', false); await flush();
    assert.equal(h.refreshes, 1, 'duplicate restored snapshot refreshes only once');
    result = snapshot({ id: 'c'.repeat(48), phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 2 });
    h.event('offline'); h.event('online'); await flush();
    assert.equal(h.refreshes, 2, 'a different saved visit must not be deduplicated against the previous id');
});

test('expired server progress stays restartable after offline/online recovery without deleting or requesting GPS', async () => {
    let expired = false;
    const h = harness({ respond: () => expired ? callResult(410, { error: 'session_missing' }) : snapshot() });
    await flush(); h.event('offline'); expired = true; h.event('online'); await flush();
    assert.equal(h.elements.get('visit-status').dataset.errorCode, 'session_missing');
    assert.equal(h.elements.get('visit-start').disabled, false, 'restoring a missing session must restart the display-only lifecycle');
    assert.equal(h.elements.get('visit-start').hidden, false); assert.equal(h.fixes.length, 0);
    assert.equal(h.requests.every(call => call.route === '/api/stays/resume'), true);
});

test('safe GPS diagnostics show relative ages and latencies only, then clear stale issue on a real recovery', async () => {
    const h = harness(); await flush(); h.elements.get('visit-start').click();
    await h.advance(6200);
    h.fixes.at(-1).ok({ timestamp: 95900, coords: { latitude: 36.7, longitude: 126.9, accuracy: 5 }, secret: 'PRIVATE' });
    await flush();
    assert.match(h.elements.get('visit-diagnostics').textContent, /10\.3초/);
    assert.match(h.elements.get('visit-diagnostics').textContent, /6\.2초/);
    assert.match(h.elements.get('visit-build').textContent, /gps_stale/);
    assert.doesNotMatch(h.elements.get('visit-diagnostics').textContent, /36\.7|126\.9|100900|PRIVATE|token/);
    await h.advance(250); h.fix(); await flush();
    assert.equal(h.elements.get('visit-status').dataset.locationCode, '');
    assert.doesNotMatch(h.elements.get('visit-build').textContent, /gps_stale/);
});

test('the explicit cancel button remains usable while GPS is pending and clears only after server acknowledgement', async () => {
    const h = harness(); await flush();
    h.elements.get('visit-start').click(); const pending = h.fixes[0];
    assert.equal(h.elements.get('visit-stop').hidden, false);
    assert.equal(h.elements.get('visit-stop').disabled, false, 'an ignored location prompt must be cancellable');
    h.elements.get('visit-stop').click(); await flush();
    assert.equal(h.elements.get('visit-status').dataset.phase, 'stopped');
    h.fix(pending); await flush(); assert.equal(h.requests.length, 1);
});

test('uncertain, outside and transient final HTTP errors keep zero ready for another deliberate click', async () => {
    for (const [code, status] of [['uncertain', 422], ['outside', 422], ['save_failed', 503], ['too_early', 409], ['rate_limited', 429]]) {
        const h = harness({ respond: call => call.route.endsWith('/finish') ? callResult(status, { error: code })
            : snapshot({ phase: 'ready', elapsedMs: 60000 }) }); await flush();
        h.elements.get('visit-finish').click(); h.fix(); await flush();
        assert.equal(h.elements.get('visit-status').dataset.errorCode, code);
        assert.equal(h.elements.get('visit-status').dataset.phase, 'ready');
        assert.equal(h.elements.get('visit-timer').textContent, '00:00');
        assert.equal(h.elements.get('visit-finish').disabled, false); assert.equal(h.refreshes, 0);
        assert.match(h.elements.get('visit-finish').textContent, /다시 확인/);
        assert.equal(h.requests.some(call => call.route.endsWith('/cancel')), false);
    }
});

test('auth readiness and pagehide/pageshow restore account progress without ever requesting GPS', async () => {
    const h = harness({ ready: false, uid: null }); await flush();
    assert.equal(h.requests.length, 0); assert.equal(h.fixes.length, 0);
    await h.auth('A'); assert.equal(h.requests.length, 1); assert.equal(h.fixes.length, 0);
    h.event('pagehide'); await h.advance(60000); h.event('pageshow', true); await flush();
    assert.equal(h.requests.length, 2); assert.equal(h.fixes.length, 0);
    assert.equal(h.requests.every(call => call.route === '/api/stays/resume'), true);
    await h.auth(null); assert.equal(h.elements.get('visit-login').hidden, false);
    assert.equal(h.elements.get('visit-start').disabled, true);
});

test('restored complete with persisted false or malformed saved reply never refreshes count and offers safe recovery', async () => {
    for (const initial of [snapshot({ phase: 'complete', elapsedMs: 60000, persisted: false, newlyFound: false, foundSpaceCount: 1 }),
        snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: -1 })]) {
        const h = harness({ initial }); await flush();
        assert.equal(h.refreshes, 0); assert.notEqual(h.elements.get('visit-status').dataset.phase, 'complete');
        assert.equal(h.elements.get('visit-reload').hidden, false); assert.equal(h.fixes.length, 0);
    }
});

test('UI resumes a server wait without GPS after complete recreation of the page', async () => {
    const initial = snapshot({ elapsedMs: 32000, expiresInMs: 7168000 });
    const h = harness({ initial }); await flush();
    assert.equal(h.elements.get('visit-status').dataset.phase, 'waiting');
    assert.equal(h.elements.get('visit-timer').textContent, '00:28'); assert.equal(h.fixes.length, 0);
    await h.advance(28000); assert.equal(h.elements.get('visit-timer').textContent, '00:00');
    assert.equal(h.elements.get('visit-finish').disabled, false);
    assert.equal(h.requests.length, 1); assert.equal(h.refreshes, 0);
});

test('returning to the original account restores its old progress instead of cancelling or creating a replacement', async () => {
    const h = harness({ respond: call => call.owner === 'A' ? snapshot({ elapsedMs: 22000 }) : idle() });
    await flush(); await h.auth('B'); await h.auth('A');
    assert.equal(h.elements.get('visit-status').dataset.phase, 'waiting');
    assert.equal(h.elements.get('visit-timer').textContent, '00:38'); assert.equal(h.fixes.length, 0);
    assert.deepEqual(h.requests.map(call => call.owner), ['A', 'B', 'A']);
    assert.equal(h.requests.every(call => call.route === '/api/stays/resume'), true);
});

test('same-account auth refresh does not poll or request GPS while server wait is active', async () => {
    const h = harness({ initial: snapshot({ elapsedMs: 20000 }) }); await flush();
    await h.auth('A'); await h.auth('A'); await h.advance(30000);
    assert.equal(h.requests.length, 1); assert.equal(h.fixes.length, 0);
    assert.equal(h.intervalCount, 1); assert.equal(h.elements.get('visit-timer').textContent, '00:10');
});

test('dynamic server duration controls timer and condition instead of a hardcoded minute', async () => {
    const h = harness({ respond: () => idle({ requiredMs: 90000 }) }); await flush();
    assert.equal(h.elements.get('visit-timer').textContent, '01:30');
    assert.match(h.elements.get('visit-condition').textContent, /90초/);
    assert.doesNotMatch(h.elements.get('visit-condition').textContent, /연속|1분/);
});

test('account progress restores without a location-capable context and opt-in start explains HTTPS requirements', async () => {
    const saved = harness({ initial: snapshot({ phase: 'ready', elapsedMs: 60000 }), secure: false }); await flush();
    assert.equal(saved.requests.length, 1); assert.equal(saved.fixes.length, 0);
    assert.equal(saved.elements.get('visit-timer').textContent, '00:00'); assert.equal(saved.elements.get('visit-finish').disabled, true);
    assert.match(saved.elements.get('visit-status').textContent, /HTTPS/);
    const empty = harness({ secure: false }); await flush();
    assert.equal(empty.elements.get('visit-start').disabled, true);
    assert.match(empty.elements.get('visit-status').textContent, /HTTPS/);
});

test('account switch invalidates late create, finish and resume without cancelling the old account or refreshing the new count', async () => {
    for (const step of ['create', 'finish', 'resume']) {
        const waiting = deferred();
        const h = harness({ respond: call => {
            if (call.owner !== 'A') return idle();
            if ((step === 'create' && call.route === '/api/stays') ||
                (step === 'finish' && call.route.endsWith('/finish')) || step === 'resume') return waiting.promise;
            return step === 'create' ? idle() : snapshot({ phase: 'ready', elapsedMs: 60000 });
        } });
        await flush();
        if (step === 'create') { h.elements.get('visit-start').click(); h.fix(); await flush(); }
        else if (step === 'finish') { h.elements.get('visit-finish').click(); h.fix(); await flush(); }
        const old = h.requests.at(-1);
        await h.auth('B');
        assert.equal(old.options.signal.aborted, true);
        assert.equal(h.elements.get('visit-status').dataset.phase, 'idle');
        waiting.resolve(snapshot({ phase: 'complete', elapsedMs: 60000, persisted: true, newlyFound: true, foundSpaceCount: 7 }));
        await flush();
        assert.equal(h.elements.get('visit-status').dataset.phase, 'idle'); assert.equal(h.refreshes, 0);
        assert.equal(h.requests.some(call => call.route.endsWith('/cancel')), false);
        assert.equal(h.requests.at(-1).owner, 'B');
    }
});
