const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('privacy policy is served and linked from login, home and the location screen', () => {
    assert.match(read('server.js'), /\['\/privacy', 'privacy\.html', null\]/);
    const policy = read('views/privacy.html');
    for (const section of ['처리하는 개인정보 항목', '위치정보의 수집·이용', '보유 기간과 파기', '국외 이전', '권리와 행사 방법', '보호책임자']) {
        assert.ok(policy.includes(section), section);
    }
    assert.match(policy, /id="location"/);
    assert.doesNotMatch(policy, /입력 필요/, 'contact placeholder must be filled before release');
    assert.match(policy, /href="mailto:[^"]+@[^"]+"/);
    for (const file of ['views/login.html', 'views/index.html', 'views/visit.html']) assert.match(read(file), /href="\/privacy/, file);
    assert.match(read('views/visit.html'), /id="visit-consent"/);
});
