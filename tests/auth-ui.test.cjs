const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Firebase/CDN, Google interaction and HTTP are faked. No real account sign-in is performed.
function harness(options = {}) {
    const elements = new Map();
    function element(id) {
        const listeners = new Map();
        const attributes = new Map();
        const node = {
            textContent: '', hidden: false, disabled: id === 'google-login', title: '', href: '', dataset: {},
            setAttribute(key, value) { attributes.set(key, String(value)); },
            getAttribute(key) { return attributes.get(key) ?? null; },
            removeAttribute(key) { attributes.delete(key); },
            addEventListener(type, callback) { listeners.set(type, callback); },
            click(event = { preventDefault() {} }) { return listeners.get('click')?.(event); },
        };
        elements.set(id, node);
        return node;
    }
    for (const id of ['google-login', 'logout', 'auth-status', 'auth-link', 'user-greeting', 'found-space-count']) element(id);
    if (options.noCount) elements.delete('found-space-count');
    if (options.noStatus) elements.delete('auth-status');
    const auth = { currentUser: null };
    const requests = [], events = [], logs = [], replacements = [], timers = new Map();
    const handlers = new Map();
    let stateCallback, stateError, timerId = 0, popupCalls = 0, signOutCalls = 0;
    const sandbox = {
        document: {
            getElementById: id => elements.get(id) || null,
            querySelector: selector => selector === '[data-auth-link]' ? elements.get('auth-link') : null,
        },
        location: {
            pathname: options.pathname || '/', search: options.search || '', hash: options.hash || '',
            replace: value => replacements.push(value), reload() {},
        },
        console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args), log: (...args) => logs.push(args) },
        alert: message => logs.push(['alert', message]),
        URLSearchParams, URL, AbortController,
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        dispatchEvent(event) {
            events.push({ event, ready: sandbox.SpaceCycleAuth?.isReady, user: sandbox.SpaceCycleAuth?.getUser() });
            for (const fn of handlers.get(event.type) || []) fn(event);
            return true;
        },
        addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        initializeApp() { if (options.initError) throw options.initError; return {}; },
        getAuth: () => auth,
        GoogleAuthProvider: class {},
        onAuthStateChanged(_auth, callback, error) { stateCallback = callback; stateError = error; },
        signInWithPopup() { popupCalls++; return options.popup?.() || Promise.resolve({}); },
        signOut() { signOutCalls++; return options.signOut?.() || Promise.resolve(); },
        getFirestore: () => ({}), doc: () => ({}), getDoc: async () => ({ data: () => ({ foundSpaces: [] }) }),
        fetch: async (url, init) => {
            requests.push({ url, init });
            return options.fetch ? options.fetch(url, init) : { ok: true, json: async () => ({ foundSpaces: [], foundSpaceCount: 0 }) };
        },
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(read('public/js/auth-policy.js'), context);
    const source = read('public/js/auth.js')
        .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];\s*/gm, '')
        .replace(/^import\s+['"][^'"]+['"];\s*/gm, '')
        .replace(/const firebaseConfig = \{[\s\S]*?\n\};/, 'const firebaseConfig = {};');
    vm.runInContext(source, context, { filename: 'auth.js (local Firebase fakes)' });
    return {
        window: sandbox, context, elements, auth, requests, events, logs, replacements, timers,
        get popupCalls() { return popupCalls; }, get signOutCalls() { return signOutCalls; },
        change(user) { auth.currentUser = user; stateCallback(user); },
        fail(error) { stateError(error); },
    };
}
const fakeUser = (uid = 'fixture-a', getIdToken = async () => 'test-only-token') => ({ uid, displayName: '테스트', getIdToken });

test('auth readiness is observable before the first callback and every account change', async () => {
    const h = harness({ pathname: '/visit', search: '?space=indoor-01' });
    assert.ok(h.window.SpaceCycleAuth, 'window.SpaceCycleAuth must be available');
    const api = h.window.SpaceCycleAuth;
    assert.equal(api.isReady, false);
    assert.equal(api.getUser(), null);
    assert.equal(typeof api.refreshFoundSpaces, 'function');
    assert.equal(h.elements.get('google-login').disabled, true);
    assert.equal(h.elements.get('auth-link').href, '/login?next=%2Fvisit%3Fspace%3Dindoor-01');
    await assert.rejects(api.getToken(), /로그인/);
    h.change(null);
    assert.equal(api.isReady, true);
    assert.equal(h.events.filter(({ event }) => event.type === 'spacecycle:authchange').length, 1);
    assert.equal(h.events[0].ready, true);
    assert.equal(h.elements.get('google-login').disabled, false);
    const user = fakeUser();
    h.change(user);
    await settle();
    assert.equal(api.getUser(), user);
    assert.equal(await api.getToken(), 'test-only-token');
    assert.equal(h.elements.get('auth-link').textContent, 'LOGOUT');
    h.change(null);
    const authEvents = h.events.filter(({ event }) => event.type === 'spacecycle:authchange');
    assert.deepEqual(authEvents.map(({ ready }) => ready), [true, true, true]);
    assert.deepEqual(authEvents.map(({ user }) => user), [null, user, null]);
    await assert.rejects(api.getToken(), /로그인/);
    h.window.location.pathname = '/qr';
    h.window.location.search = '?space=outdoor-05';
    h.elements.get('auth-link').click();
    assert.equal(h.elements.get('auth-link').href, '/login?next=%2Fqr%3Fspace%3Doutdoor-05', 'capture the current page at navigation time too');
});

test('found spaces use the bearer-authenticated backend, even with no count widget', async () => {
    for (const noCount of [false, true]) {
        const payload = { foundSpaces: ['indoor-01', 'outdoor-05'], foundSpaceCount: 2 };
        const h = harness({ noCount, fetch: async () => ({ ok: true, json: async () => payload }) });
        h.change(fakeUser());
        await settle();
        assert.equal(h.requests.length, 1, 'one backend read follows authentication');
        const { url, init } = h.requests[0];
        assert.equal(url, '/api/me/spaces');
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, 'Bearer test-only-token');
        assert.equal(init.credentials, 'omit');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.body, undefined);
        if (!noCount) assert.equal(h.elements.get('found-space-count').textContent, '2');
        const event = h.events.find(({ event }) => event.type === 'spacecycle:spaceschange').event;
        assert.equal(event.detail.count, 2);
        assert.equal(await h.window.SpaceCycleAuth.refreshFoundSpaces(), 2);
        assert.equal(h.requests.length, 2);
        assert.equal(h.logs.length, 0);
    }
});

test('failed or inconsistent backend reads show unknown, never a fabricated zero', async () => {
    const failures = [
        async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); },
        async () => ({ ok: false, status: 401, json: async () => { throw new Error('must not read'); } }),
        async () => ({ ok: true, json: async () => { throw new Error('PRIVATE_PARSE_DETAIL'); } }),
        async () => ({ ok: true, json: async () => ({ foundSpaces: ['indoor-01', 'indoor-01'], foundSpaceCount: 2 }) }),
    ];
    for (const fail of failures) {
        let failing = true;
        const h = harness({ fetch: (...args) => failing ? fail(...args) : Promise.resolve({ ok: true, json: async () => ({ foundSpaces: [], foundSpaceCount: 0 }) }) });
        h.change(fakeUser());
        await settle();
        const widget = h.elements.get('found-space-count');
        assert.equal(widget.textContent, '—');
        assert.match(widget.title, /확인.*다시|확인.*새로고침/);
        assert.match(widget.getAttribute('aria-label'), /확인/);
        assert.equal(h.events.filter(({ event }) => event.type === 'spacecycle:spaceschange').length, 0);
        assert.equal(h.logs.length, 0);
        failing = false;
        assert.equal(await h.window.SpaceCycleAuth.refreshFoundSpaces(), 0);
        assert.equal(widget.textContent, '0', 'zero is valid only after a verified empty response');
        assert.doesNotMatch(widget.title, /못/);
        h.change(null);
        assert.equal(widget.textContent, '—');
        assert.match(widget.title, /로그인/);
    }
});

test('late token, response, and error results cannot replace a newer account or logout', async () => {
    const token = deferred();
    const h = harness();
    const first = fakeUser('fixture-a', () => token.promise);
    h.change(first);
    const staleToken = assert.rejects(h.window.SpaceCycleAuth.getToken(), /로그인|변경/);
    h.change(fakeUser('fixture-b'));
    await settle();
    token.resolve('stale-test-token');
    await staleToken;
    await settle();
    assert.equal(h.requests.length, 1, 'a stale token must never be sent');
    assert.equal(h.elements.get('found-space-count').textContent, '0');

    for (const reject of [false, true]) {
        const old = deferred();
        let calls = 0;
        const b = harness({ fetch: () => ++calls === 1 ? old.promise : Promise.resolve({ ok: true, json: async () => ({ foundSpaces: [], foundSpaceCount: 0 }) }) });
        const user = fakeUser();
        b.change(user);
        await settle();
        b.change(null);
        b.change(user); // Even a same-object re-login invalidates the previous session.
        await settle();
        if (reject) old.reject(new Error('PRIVATE_STALE_ERROR'));
        else old.resolve({ ok: true, json: async () => ({ foundSpaces: ['indoor-01'], foundSpaceCount: 1 }) });
        await settle();
        assert.equal(b.elements.get('found-space-count').textContent, '0');
        assert.equal(b.events.filter(({ event }) => event.type === 'spacecycle:spaceschange').length, 1);
        b.change(null);
        assert.equal(await b.window.SpaceCycleAuth.refreshFoundSpaces(), null);
        assert.equal(b.elements.get('found-space-count').textContent, '—');
    }
});

test('an older refresh cannot overwrite a newer completion for the same account', async () => {
    const old = deferred();
    let calls = 0;
    const h = harness({ fetch: () => ++calls === 1 ? old.promise : Promise.resolve({ ok: true, json: async () => ({ foundSpaces: ['indoor-01', 'outdoor-01'], foundSpaceCount: 2 }) }) });
    h.change(fakeUser());
    await settle();
    assert.equal(await h.window.SpaceCycleAuth.refreshFoundSpaces(), 2);
    old.resolve({ ok: true, json: async () => ({ foundSpaces: ['indoor-01'], foundSpaceCount: 1 }) });
    await settle();
    assert.equal(h.elements.get('found-space-count').textContent, '2');
    assert.equal(h.events.filter(({ event }) => event.type === 'spacecycle:spaceschange').length, 1);
});

test('successful sign-in restores a validated next path, never an external destination', () => {
    for (const [search, expected] of [
        ['?next=%2Fvisit%3Fspace%3Dindoor-01', '/visit?space=indoor-01'],
        ['?next=%2Fs%2Fout05', '/s/out05'],
        ['?next=%2Fqr%3Fspace%3Doutdoor-05', '/qr?space=outdoor-05'],
        ['?next=https%3A%2F%2Fevil.example', '/'],
        ['?next=%2Fspaces&next=%2Fqr', '/'],
    ]) {
        const h = harness({ pathname: '/login', search });
        h.change(fakeUser());
        assert.deepEqual(h.replacements, [expected]);
        assert.equal(h.events[0].event.type, 'spacecycle:authchange');
        assert.equal(h.events[0].ready, true);
    }
    const h = harness({ pathname: '/login', search: '?next=%2Fspaces', hash: '#extra' });
    h.change(fakeUser());
    assert.deepEqual(h.replacements, ['/']);
});

test('mocked Google popup starts in the click stack, suppresses duplicates and offers actionable retry', async () => {
    const pending = deferred();
    const h = harness({ pathname: '/login', popup: () => pending.promise });
    const login = h.elements.get('google-login');
    login.click();
    assert.equal(h.popupCalls, 0, 'login stays disabled until auth readiness');
    h.change(null);
    login.click();
    assert.equal(h.popupCalls, 1, 'no await may precede popup creation in the user gesture');
    assert.equal(login.disabled, true);
    assert.equal(login.getAttribute('aria-busy'), 'true');
    assert.match(h.elements.get('auth-status').textContent, /Google.*창/);
    login.click();
    assert.equal(h.popupCalls, 1);
    pending.reject({ code: 'auth/popup-blocked', message: 'PRIVATE_ERROR' });
    await settle();
    assert.equal(login.disabled, false);
    assert.notEqual(login.getAttribute('aria-busy'), 'true');
    assert.match(h.elements.get('auth-status').textContent, /팝업.*허용/);
    assert.equal(h.logs.length, 0);
    for (const code of ['auth/unauthorized-domain', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/operation-not-allowed', 'auth/invalid-api-key', 'auth/network-request-failed', 'auth/web-storage-unsupported']) {
        const f = harness({ pathname: '/login', popup: () => Promise.reject({ code, message: 'PRIVATE_ERROR' }) });
        f.change(null);
        f.elements.get('google-login').click();
        await settle();
        const expected = require('../public/js/auth-policy.js').authErrorMessage({ code });
        assert.equal(f.elements.get('auth-status').textContent, expected);
        assert.equal(f.elements.get('google-login').disabled, false);
        assert.equal(f.logs.length, 0);
    }
});

test('header logout tolerates pages without a status node and prevents duplicate requests', async () => {
    const pending = deferred();
    const h = harness({ noStatus: true, signOut: () => pending.promise });
    h.change(fakeUser());
    await settle();
    const header = h.elements.get('auth-link');
    let prevented = 0;
    header.click({ preventDefault() { prevented++; } });
    header.click({ preventDefault() { prevented++; } });
    assert.equal(prevented, 2);
    assert.equal(h.signOutCalls, 1);
    pending.reject({ code: 'auth/network-request-failed', message: 'PRIVATE_ERROR' });
    await settle();
    assert.equal(header.getAttribute('aria-disabled'), null);
    assert.doesNotMatch(JSON.stringify(h.logs), /PRIVATE_ERROR/);
    assert.match(h.logs.at(-1)[1], /연결.*다시/);
});

test('Firebase initialization and observer errors leave login disabled with safe recovery guidance', async () => {
    for (const code of ['auth/invalid-api-key', 'auth/network-request-failed', 'auth/web-storage-unsupported']) {
        let h;
        assert.doesNotThrow(() => { h = harness({ initError: { code, message: 'PRIVATE_INIT_ERROR' } }); });
        assert.equal(h.window.SpaceCycleAuth.isReady, false);
        assert.equal(h.elements.get('google-login').disabled, true);
        assert.equal(h.elements.get('auth-status').textContent, require('../public/js/auth-policy.js').authErrorMessage({ code }));
        assert.equal(h.logs.length, 0);
        await assert.rejects(h.window.SpaceCycleAuth.getToken(), /로그인/);
    }
    const h = harness();
    h.fail({ code: 'auth/network-request-failed', message: 'PRIVATE_OBSERVER_ERROR' });
    assert.equal(h.window.SpaceCycleAuth.isReady, false);
    assert.equal(h.elements.get('google-login').disabled, true);
    assert.match(h.elements.get('auth-status').textContent, /연결.*다시/);
    assert.equal(h.logs.length, 0);
});

test('login has an independent bootstrap timeout when the CDN module never loads', () => {
    const html = read('views/login.html');
    const bootstrap = /<script id="auth-bootstrap">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(bootstrap, 'a classic local fallback must run even if ESM dependencies fail');
    assert.match(html, /id="auth-retry"[^>]*hidden/);
    assert.match(html, /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
    function boot() {
        const nodes = new Map();
        const listeners = new Map();
        let callback, reloads = 0, cleared = false;
        for (const id of ['auth-status', 'google-login', 'auth-retry']) nodes.set(id, {
            textContent: '로그인 상태 확인 중...', dataset: {}, disabled: true, hidden: true,
            addEventListener(type, fn) { this[type] = fn; },
        });
        const win = {
            location: { reload() { reloads++; } },
            addEventListener(type, fn) { listeners.set(type, fn); },
            setTimeout(fn, ms) { assert.ok(ms >= 5000 && ms <= 15000); callback = fn; return 1; },
            clearTimeout() { cleared = true; },
        };
        vm.runInNewContext(bootstrap[1], { window: win, document: { getElementById: id => nodes.get(id) } });
        return { win, nodes, timeout: () => callback(), emit: () => listeners.get('spacecycle:authchange')(), get reloads() { return reloads; }, get cleared() { return cleared; } };
    }
    const missing = boot();
    missing.timeout();
    assert.match(missing.nodes.get('auth-status').textContent, /연결.*새로고침/);
    assert.equal(missing.nodes.get('google-login').disabled, true);
    assert.equal(missing.nodes.get('auth-retry').hidden, false);
    missing.nodes.get('auth-retry').click();
    assert.equal(missing.reloads, 1);
    const ready = boot();
    ready.win.SpaceCycleAuth = { isReady: true };
    ready.emit();
    assert.equal(ready.cleared, true);
    assert.equal(ready.nodes.get('auth-retry').hidden, true);
    ready.timeout();
    assert.equal(ready.nodes.get('auth-status').textContent, '로그인 상태 확인 중...');
    const failed = boot();
    failed.nodes.get('auth-status').dataset.authError = 'true';
    failed.nodes.get('auth-status').textContent = '관리자에게 설정 확인을 요청해 주세요.';
    failed.timeout();
    assert.equal(failed.nodes.get('auth-status').textContent, '관리자에게 설정 확인을 요청해 주세요.');
    assert.equal(failed.nodes.get('auth-retry').hidden, false);
});

test('shared links explicitly color every state while navigation and CTAs keep their own contrast', () => {
    const shared = read('public/css/style.css');
    const home = read('public/css/index.css');
    const rules = Array.from(shared.matchAll(/([^{}]+)\{([^{}]*)\}/g));
    for (const state of ['link', 'visited', 'hover', 'focus-visible', 'active']) {
        assert.ok(rules.some(([, selector, body]) => selector.split(',').some(part => part.trim() === `a:${state}`) && /color:\s*var\(--link-color,\s*var\(--primary\)\)/.test(body)), `explicit palette for a:${state}`);
    }
    for (const [css, selector, token] of [
        [shared, '.site-logo,\n.auth-link', '--text'],
        [shared, '.bottom-nav a', '--muted'],
        [shared, '.bottom-nav a[aria-current="page"]', '--text'],
        [shared, '.page-action', '--primary-text'],
        [home, '.in-first-btn', '--primary-text'],
        [home, '.in-second-btn', '--secondary-text'],
    ]) {
        const body = css.slice(css.indexOf(selector)).split('{')[1]?.split('}')[0];
        assert.ok(body?.includes(`--link-color: var(${token})`), `preserve ${selector} contrast`);
    }
    assert.match(shared, /a:focus-visible[\s\S]*outline:\s*2px solid var\(--muted\)/);
    assert.match(shared, /max-width:\s*480px/);
    assert.doesNotMatch(shared + home, /(?:purple|violet|#551a8b|#800080)/i);
});
