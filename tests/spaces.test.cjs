const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const projectRequire = createRequire(path.join(root, 'server.js'));
const express = projectRequire('express');
let server;
let base;

test.before(async () => {
    // Exercise the real routes without occupying port 4500 or exposing the app.
    const localExpress = () => {
        const app = express();
        const listen = app.listen.bind(app);
        app.listen = () => {
            server = listen(0, '127.0.0.1');
            return server;
        };
        return app;
    };
    Object.assign(localExpress, express);
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
        require: name => name === 'express' ? localExpress : projectRequire(name),
        __dirname: root,
        console,
    }, { filename: 'server.js' });
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
});

test('GET /healthz reports process health without user or Firebase data', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /spaces serves one clearly labelled test space in the shared theme', async () => {
    const response = await fetch(`${base}/spaces`);
    assert.equal(response.status, 200, 'the space-list route must exist');
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /href="\/css\/style\.css"/);
    assert.match(html, /href="\/css\/spaces\.css"/);
    assert.match(html, /src="\/js\/theme\.js"/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /향설생활관 2관/);
    assert.match(html, /테스트 공간/);
    assert.match(html, /장소 사진 준비 중/);
    assert.equal((html.match(/data-space-id=/g) || []).length, 1);
    assert.match(html, /data-space-id="hyangseol-2"/);
    assert.match(html, /<details\b/);
    assert.match(html, /QR 연결과 위치 인증은 준비 중/);
});

test('home space button enters the list without changing the badge button', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<a href="\/spaces" class="in-first-btn">공간 보기/);
    assert.match(html, /<a href="\/" class="in-second-btn">내 뱃지 보기/);
});
