const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'views/badges.html'), 'utf8');
const ids = ['outdoor-01', 'outdoor-02', 'outdoor-03', 'outdoor-04', 'outdoor-05'];

test('badge page lists five outdoor badges in a 2-column grid, all grayscale by default', () => {
    for (const [n, id] of ids.entries()) {
        assert.match(html, new RegExp(`data-badge="${id}"[^>]*data-earned="false"`));
        assert.ok(html.includes(`src="/images/badges/out0${n + 1}.webp"`));
        assert.ok(fs.existsSync(path.join(root, `public/images/badges/out0${n + 1}.webp`)));
    }
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
    const cards = ids.map(id => {
        const state = { textContent: '미획득' }, image = { alt: '' };
        return { dataset: { badge: id, name: id, earned: 'false' }, state, image,
            querySelector: selector => selector === 'img' ? image : state };
    });
    const elements = { 'badge-board': { querySelectorAll: () => cards }, 'badge-status': { textContent: '' }, 'badge-progress': { textContent: '' } };
    const listeners = {};
    const context = { document: { getElementById: id => elements[id] || null },
        addEventListener: (name, fn) => { listeners[name] = fn; }, SpaceCycleAuth: undefined };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/badges.js'), 'utf8'), context);
    const earned = () => cards.filter(card => card.dataset.earned === 'true').map(card => card.dataset.badge);
    return { context, listeners, cards, elements, earned };
}

test('only places the signed-in account completed turn to color; sign-out and errors return to grayscale', () => {
    const h = harness();
    assert.deepEqual(h.earned(), []);
    let user = { uid: 'A' };
    h.context.SpaceCycleAuth = { isReady: true, getUser: () => user, foundSpaces: null };
    h.listeners['spacecycle:authchange']();
    assert.match(h.elements['badge-status'].textContent, /불러오고/);
    h.listeners['spacecycle:spaceschange']({ detail: { count: 3, foundSpaces: ['indoor-01', 'outdoor-02', 'outdoor-05'] } });
    assert.deepEqual(h.earned(), ['outdoor-02', 'outdoor-05'], 'indoor completions do not color outdoor badges');
    assert.equal(h.elements['badge-progress'].textContent, '2 / 5');
    assert.equal(h.cards[1].state.textContent, '획득');
    assert.match(h.cards[0].image.alt, /획득 전/);
    h.listeners['spacecycle:spaceserror']();
    assert.deepEqual(h.earned(), [], 'an unknown result is never shown as earned');
    h.context.SpaceCycleAuth.foundSpaces = ids;
    h.listeners['spacecycle:authchange']();
    assert.deepEqual(h.earned(), ids);
    assert.match(h.elements['badge-status'].textContent, /모두/);
    user = null;
    h.listeners['spacecycle:authchange']();
    assert.deepEqual(h.earned(), []);
    assert.match(h.elements['badge-status'].textContent, /로그인하면/);
    h.listeners['spacecycle:spaceschange']({ detail: { foundSpaces: ids } });
    assert.deepEqual(h.earned(), [], 'a late result after sign-out is ignored');
});
