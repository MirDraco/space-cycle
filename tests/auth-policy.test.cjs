const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policyFile = path.join(__dirname, '..', 'public', 'js', 'auth-policy.js');

function policy() {
    assert.ok(fs.existsSync(policyFile), 'local auth policy must exist');
    return require(policyFile);
}

test('login return paths accept only canonical local destinations', () => {
    const { safeReturnPath, readReturnPath, loginHref } = policy();
    const permitted = ['/', '/spaces', '/qr', '/badges'];
    for (const kind of ['indoor', 'outdoor']) for (let n = 1; n <= 5; n++) {
        const id = `${kind}-0${n}`;
        for (const route of ['/spaces', '/qr', '/visit']) permitted.push(`${route}?space=${id}`);
        permitted.push(`/s/${kind === 'indoor' ? 'in' : 'out'}0${n}`);
    }
    for (const target of permitted) {
        assert.equal(safeReturnPath(target), target);
        assert.equal(readReturnPath(`?next=${encodeURIComponent(target)}`), target);
        const [pathname, query = ''] = target.split('?');
        assert.equal(loginHref(pathname, query ? `?${query}` : ''), `/login?next=${encodeURIComponent(target)}`);
    }
    const rejected = [
        undefined, null, {}, 1, '', ' /spaces', '/spaces ', '/spaces\n',
        'https://spacecycle.space/spaces', 'https://evil.example', '//evil.example',
        'javascript:alert(1)', 'data:text/html,test', '/\\evil.example',
        '/a/../spaces', '/%73paces', '/spaces/', '/login', '/unknown',
        '/?space=indoor-01', '/badges?space=indoor-01', '/visit', '/spaces?',
        '/spaces#x', '/spaces#', '/spaces?space=indoor-01#x',
        '/spaces?space=indoor-01&space=outdoor-01', '/spaces?space=indoor-01&x=1',
        '/spaces?x=1', '/spaces?space=', '/spaces?space=indoor-06',
        '/spaces?space=INDOOR-01', '/spaces?space=%69ndoor-01',
        '/s/in01/', '/s/in01?x=1', '/s/in06', '/s/IN01', '/s/%69n01',
    ];
    for (const target of rejected) assert.equal(safeReturnPath(target), '/', String(target));
    for (const query of [
        '', '?next=', '?next=%', '?next=%252Fspaces', '?next=//evil.example',
        '?next=%2Fspaces&next=%2Fqr', '?next=%2Fspaces&x=1', '?x=1',
        '?x=1&next=%2Fspaces', '?%6eext=%2Fspaces',
    ]) assert.equal(readReturnPath(query), '/', query);
    assert.equal(readReturnPath('?next=%2Fspaces', '#x'), '/');
    assert.equal(loginHref('/spaces', '', '#x'), '/login?next=%2F');
    assert.equal(loginHref('/login', '?next=%2Fvisit%3Fspace%3Dindoor-01'), '/login?next=%2Fvisit%3Fspace%3Dindoor-01');
});

test('found-space counts accept only consistent unique canonical IDs from the server', () => {
    const { verifiedSpaceCount } = policy();
    assert.equal(typeof verifiedSpaceCount, 'function', 'backend count validator is required');
    assert.equal(verifiedSpaceCount({ foundSpaces: [], foundSpaceCount: 0 }), 0);
    assert.equal(verifiedSpaceCount({ foundSpaces: ['indoor-01', 'outdoor-05'], foundSpaceCount: 2 }), 2);
    for (const value of [
        null, undefined, [], {}, { foundSpaceCount: 3 }, { foundSpaces: [] },
        { foundSpaces: ['indoor-01', 'indoor-01'], foundSpaceCount: 2 },
        { foundSpaces: ['in01'], foundSpaceCount: 1 },
        { foundSpaces: ['indoor-01\n'], foundSpaceCount: 1 },
        { foundSpaces: ['indoor-06'], foundSpaceCount: 1 },
        { foundSpaces: [null], foundSpaceCount: 1 },
        { foundSpaces: ['indoor-01'], foundSpaceCount: 0 },
        { foundSpaces: ['indoor-01'], foundSpaceCount: '1' },
        { foundSpaces: [], foundSpaceCount: -1 },
        { foundSpaces: [], foundSpaceCount: NaN },
    ]) assert.throws(() => verifiedSpaceCount(value), /공간/);
});

test('auth failures use Korean actionable code-based messages without exception details', () => {
    const { authErrorMessage } = policy();
    assert.equal(typeof authErrorMessage, 'function', 'actionable auth errors are required');
    const checks = {
        'auth/unauthorized-domain': /도메인.*관리자/,
        'auth/popup-blocked': /팝업.*허용/,
        'auth/popup-closed-by-user': /닫.*다시/,
        'auth/cancelled-popup-request': /진행.*기다/,
        'auth/operation-not-allowed': /관리자.*Google/,
        'auth/invalid-api-key': /관리자.*설정/,
        'auth/network-request-failed': /연결.*다시/,
        'auth/web-storage-unsupported': /저장.*허용/,
    };
    for (const [code, expected] of Object.entries(checks)) {
        const message = authErrorMessage({ code, message: 'DO_NOT_EXPOSE@example.test' });
        assert.match(message, expected, code);
        assert.doesNotMatch(message, /DO_NOT_EXPOSE|example.test/);
    }
    for (const error of [null, {}, new Error('DO_NOT_EXPOSE'), { code: 'DO_NOT_EXPOSE' }]) {
        assert.match(authErrorMessage(error), /다시/);
        assert.doesNotMatch(authErrorMessage(error), /DO_NOT_EXPOSE/);
    }
});
