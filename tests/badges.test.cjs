const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'views/badges.html'), 'utf8');
const { all } = require('../public/js/space-data.js');
const groups = ['indoor', 'outdoor'];
const placesIn = group => all.filter(place => place.enabled && place.category === group);
const sections = [...html.matchAll(/<section\b[^>]*data-badge-group="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
const cardsIn = body => [...body.matchAll(/<li\b[^>]*data-badge="([^"]+)"[^>]*data-name="([^"]+)"[^>]*data-earned="false"[^>]*>([\s\S]*?)<\/li>/g)];
const ids = all.filter(place => place.enabled).map(place => place.id);

test('the badge collection lists each registered place in its indoor or outdoor section', () => {
    assert.deepEqual(sections.map(([, group]) => group), groups);
    for (const [, group, body] of sections) {
        const places = placesIn(group);
        const cards = cardsIn(body);
        assert.deepEqual(cards.map(([, id, name]) => [id, name]), places.map(({ id, name }) => [id, name]));
        assert.match(body, group === 'indoor' ? /내부 공간 배지/ : /외부 공간 배지/);
        assert.ok(body.includes(`– / ${places.length}`));
        for (const [i, [, id, , card]] of cards.entries()) {
            const filename = `images/badges/${places[i].code}.webp`;
            assert.ok(card.includes(`src="/${filename}"`), id);
            assert.ok(fs.existsSync(path.join(root, 'public', filename)), id);
        }
    }
});

test('both sections use the grayscale-to-color two-column grid', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
    assert.match(css, /\.badge-grid \{[^}]*grid-template-columns: repeat\(2/);
    assert.match(css, /\.badge-card img \{[^}]*grayscale\(1\)/);
    assert.match(css, /\.badge-card\[data-earned="true"\] img \{ filter: none/);
});

test('the word 배지 is used everywhere instead of 뱃지', () => {
    const files = ['views', 'public/js', 'README.md'].flatMap(entry => {
        const full = path.join(root, entry);
        return fs.statSync(full).isDirectory()
            ? fs.readdirSync(full, { recursive: true }).map(file => path.join(full, file)).filter(file => fs.statSync(file).isFile())
            : [full];
    });
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /뱃지/, file);
});

function harness() {
    const byGroup = new Map(sections.map(([, group, body]) => {
        const cards = cardsIn(body).map(([, id, name]) => {
            const state = { textContent: '미획득' }, image = { alt: `${name} 배지 (아직 획득 전)` };
            return { dataset: { badge: id, name, earned: 'false' }, state, image,
                querySelector: selector => selector === 'img' ? image : state };
        });
        const progress = { textContent: `– / ${cards.length}` };
        return [group, { cards, progress, querySelectorAll: () => cards, querySelector: () => progress }];
    }));
    const cards = [...byGroup.values()].flatMap(section => section.cards);
    const board = { querySelectorAll: selector => selector === '[data-badge-group]' ? [...byGroup.values()] : cards };
    const status = { textContent: '' };
    const elements = { 'badge-board': board, 'badge-status': status };
    const listeners = {};
    let user = null;
    const auth = { isReady: true, getUser: () => user, foundSpaces: null };
    const context = { document: { getElementById: id => elements[id] || null },
        addEventListener: (name, fn) => { listeners[name] = fn; }, SpaceCycleAuth: auth };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/badges.js'), 'utf8'), context);
    const changeUser = uid => {
        user = uid ? { uid } : null;
        auth.foundSpaces = null;
        listeners['spacecycle:authchange']();
    };
    const show = found => { auth.foundSpaces = found; listeners['spacecycle:spaceschange']({ detail: { foundSpaces: found } }); };
    const earned = () => cards.filter(card => card.dataset.earned === 'true').map(card => card.dataset.badge);
    const progress = () => groups.map(group => byGroup.get(group).progress.textContent);
    return { auth, listeners, cards, status, changeUser, show, earned, progress };
}

test('only verified account records turn the corresponding indoor and outdoor badges to color', () => {
    const h = harness();
    assert.deepEqual(h.progress(), ['– / 4', '– / 5']);
    h.changeUser('A');
    assert.match(h.status.textContent, /불러오고/);
    h.show(['indoor-01', 'outdoor-02', 'outdoor-05']);
    assert.deepEqual(h.earned(), ['indoor-01', 'outdoor-02', 'outdoor-05']);
    assert.deepEqual(h.progress(), ['1 / 4', '2 / 5']);
    assert.equal(h.cards.find(card => card.dataset.badge === 'indoor-01').state.textContent, '획득');
    assert.match(h.cards.find(card => card.dataset.badge === 'indoor-02').image.alt, /획득 전/);
});

test('switching accounts, a lookup error, and signing out clear any previous awards', () => {
    const h = harness();
    h.changeUser('A');
    h.show(ids);
    h.changeUser('B');
    assert.deepEqual(h.earned(), []);
    assert.deepEqual(h.progress(), ['– / 4', '– / 5']);
    h.listeners['spacecycle:spaceschange']({ detail: { foundSpaces: ids } });
    assert.deepEqual(h.earned(), [], 'event payload is not an account snapshot');
    h.show([]);
    assert.deepEqual(h.progress(), ['0 / 4', '0 / 5']);
    h.show(['indoor-03']);
    h.auth.foundSpaces = null;
    h.listeners['spacecycle:spaceserror']();
    assert.deepEqual(h.earned(), []);
    assert.deepEqual(h.progress(), ['– / 4', '– / 5']);
    assert.match(h.status.textContent, /불러오지 못했/);
    h.show(['outdoor-04']);
    h.changeUser(null);
    h.listeners['spacecycle:spaceschange']({ detail: { foundSpaces: ids } });
    assert.deepEqual(h.earned(), []);
    assert.deepEqual(h.progress(), ['– / 4', '– / 5']);
    assert.match(h.status.textContent, /로그인하면/);
});

test('all badges means all nine registered places, not one category', () => {
    const h = harness();
    h.changeUser('A');
    h.show(placesIn('outdoor').map(place => place.id));
    assert.deepEqual(h.progress(), ['0 / 4', '5 / 5']);
    assert.doesNotMatch(h.status.textContent, /모두/);
    h.show(ids);
    assert.deepEqual(h.progress(), ['4 / 4', '5 / 5']);
    assert.match(h.status.textContent, /모두/);
});

test('accepted final checks unlock each registered badge exactly once through the account API', async t => {
    const express = require('express');
    const { openVisits } = require('../server/visits.js');
    const { createStayProgress } = require('../server/stay-progress.js');
    const { createStayRouter } = require('../server/stay-routes.js');
    const { createMeRouter } = require('../server/me-routes.js');
    let time = 1000;
    const visits = openVisits(':memory:');
    const progress = createStayProgress({ visits, now: () => time });
    const verifyToken = async uid => ['badge-owner', 'badge-other'].includes(uid) ? { uid } : null;
    const app = express();
    app.use('/api/stays', createStayRouter({ progress, visits, verifyToken }));
    app.use('/api/me', createMeRouter({ visits, verifyToken }));
    const srv = app.listen(0, '127.0.0.1');
    t.after(async () => {
        await new Promise(resolve => srv.close(resolve));
        visits.close();
    });
    await new Promise((resolve, reject) => srv.once('listening', resolve).once('error', reject));
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const owner = 'badge-owner';
    const request = (route, body, uid = owner) => fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(uid ? { Authorization: `Bearer ${uid}` } : {}),
            ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const collection = harness();
    collection.changeUser(owner);
    async function check(expected) {
        const response = await request('/api/me/spaces');
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data, { foundSpaces: expected, foundSpaceCount: expected.length });
        collection.show(data.foundSpaces);
        assert.deepEqual(collection.earned(), expected);
    }
    assert.equal((await request('/api/me/spaces', undefined, null)).status, 401);
    await check([]);
    const saved = [];
    for (const { id, latitude, longitude, requiredMs } of all.filter(place => place.enabled)) {
        const position = { latitude, longitude, accuracy: 5 };
        const start = await request('/api/stays', { spaceId: id, ...position });
        assert.equal(start.status, 201, id);
        const session = await start.json();
        assert.equal(session.phase, 'waiting');
        await check(saved);
        const finish = `/api/stays/${session.id}/finish`;
        const body = { ...position, challenge: session.challenge };
        if (!saved.length) {
            const early = await request(finish, body);
            assert.equal(early.status, 409);
            assert.equal((await early.json()).error, 'too_early');
        }
        time += requiredMs;
        if (!saved.length) {
            assert.equal((await request(finish, body, 'badge-other')).status, 403);
            const rejected = await request(finish, { ...body, accuracy: 101 });
            assert.equal(rejected.status, 422);
            assert.equal((await rejected.json()).error, 'uncertain');
            await check(saved);
        }
        const done = await request(finish, body);
        assert.equal(done.status, 200, id);
        assert.equal((await done.json()).newlyFound, true, id);
        saved.push(id);
        await check(saved);
        if (saved.length === 1) {
            const replay = await request(finish, body);
            assert.equal(replay.status, 200);
            assert.equal((await replay.json()).newlyFound, false);
            await check(saved);
        }
    }
    assert.deepEqual(collection.progress(), ['4 / 4', '5 / 5']);
    const other = await request('/api/me/spaces', undefined, 'badge-other');
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { foundSpaces: [], foundSpaceCount: 0 });
});
