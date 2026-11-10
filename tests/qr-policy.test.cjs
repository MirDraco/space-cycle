const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policyFile = path.join(__dirname, '..', 'public', 'js', 'qr-policy.js');

test('printed short QR codes map safely, with in01 leading to the test visit page', () => {
    const policy=require(policyFile);
    assert.equal(policy.spaceLabel('indoor-01'),'향설생활관2');
    for(const prefix of ['in','out']) for(let n=1;n<=5;n++) {
        const code=`${prefix}0${n}`;
        const id=`${prefix==='in'?'indoor':'outdoor'}-0${n}`;
        const result=policy.interpretQr(`https://spacecycle.space/s/${code}`,null,'http://127.0.0.1:4500');
        assert.equal(result.status,'matched');assert.equal(result.spaceId,id);
        assert.equal(result.path,`${id==='indoor-01'?'/visit':'/spaces'}?space=${id}`);
    }
    for(const suffix of ['/in01?extra=1','/in01#x','/in06','/IN01','/%69n01','/../s/in01','/in01/']) {
        assert.equal(policy.interpretQr('https://spacecycle.space/s'+suffix,null,'http://127.0.0.1:4500').status,'invalid');
    }
    assert.equal(policy.interpretQr('https://evil.example/s/in01',null,'http://127.0.0.1:4500').status,'invalid');
    assert.equal(policy.interpretQr('https://spacecycle.space/s/out01','indoor-01','http://127.0.0.1:4500').status,'mismatch');
});

test('QR policy accepts only known Space Cycle space links and checks selected space', () => {
    assert.ok(fs.existsSync(policyFile), 'safe QR policy must exist');
    const { readSelection, interpretQr, spaceLabel } = require(policyFile);
    const origin = 'http://127.0.0.1:4500';
    assert.deepEqual(readSelection(''), { valid: true, spaceId: null });
    assert.deepEqual(readSelection('?space=indoor-01'), { valid: true, spaceId: 'indoor-01' });
    for (const query of ['?space=unknown', '?space=indoor-06', '?space=INDOOR-01', '?space=', '?space=indoor-01&space=outdoor-01', '?space=indoor-01&next=https://evil.example']) {
        assert.equal(readSelection(query).valid, false, query);
    }
    assert.equal(spaceLabel('indoor-01'), '향설생활관2');
    assert.equal(spaceLabel('outdoor-05'), '외부 공간 05');
    assert.equal(spaceLabel('indoor-99'), null);
    for (const id of ['indoor-01', 'outdoor-05']) {
        const result = interpretQr(`https://spacecycle.space/spaces?space=${id}`, id, origin);
        assert.equal(result.status, 'matched');
        assert.equal(result.spaceId, id);
        assert.equal(result.path, `${id === 'indoor-01' ? '/visit' : '/spaces'}?space=${id}`);
    }
    assert.equal(interpretQr(`${origin}/spaces?space=indoor-02`, null, origin).status, 'matched');
    assert.equal(interpretQr('https://spacecycle.space/spaces?space=outdoor-01', 'indoor-01', origin).status, 'mismatch');
    const invalid = [
        'https://evil.example/spaces?space=indoor-01',
        'https://spacecycle.space.evil.example/spaces?space=indoor-01',
        'https://spacecycle.space@evil.example/spaces?space=indoor-01',
        'https://user:pass@spacecycle.space/spaces?space=indoor-01',
        'http://spacecycle.space/spaces?space=indoor-01',
        'https://spacecycle.space:8443/spaces?space=indoor-01',
        'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
        '/spaces?space=indoor-01', '//spacecycle.space/spaces?space=indoor-01',
        'https://spacecycle.space/login?space=indoor-01',
        'https://spacecycle.space/spaces?space=indoor-99',
        'https://spacecycle.space/spaces?space=indoor-01&space=outdoor-01',
        'https://spacecycle.space/spaces?space=indoor-01&next=https://evil.example',
        'https://spacecycle.space/spaces?space=indoor-01#unexpected',
        'https://spacecycle.space/a/../spaces?space=indoor-01',
        'https://spacecycle.space/spaces?space=%69ndoor-01',
        ' https://spacecycle.space/spaces?space=indoor-01',
        'x'.repeat(2049),
    ];
    for (const value of invalid) assert.equal(interpretQr(value, null, origin).status, 'invalid', value);
    assert.equal(interpretQr('https://spacecycle.space/spaces?space=indoor-01', 'unknown', origin).status, 'invalid');
});
