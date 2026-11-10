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

test('mobile page embeds complete local CSS and versions script dependencies without caching HTML',async()=>{
    const response=await fetch(`${base}/visit?space=indoor-01`);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const html=await response.text();
    assert.match(html,/<style data-source="\/css\/style.css">/);
    assert.match(html,/<style data-source="\/css\/visit.css">/);
    assert.doesNotMatch(html,/<link[^>]*href="\/css\//);
    const version=html.match(/name="spacecycle-release" content="([a-f0-9]{16})"/)?.[1];assert.ok(version);
    const scripts=[...html.matchAll(/src="(\/(?:js|vendor)\/[^\"]+)"/g)].map(x=>x[1]);
    assert.ok(scripts.includes(`/js/auth-policy.js?v=${version}`));
    for(const src of scripts){assert.ok(src.endsWith(`?v=${version}`));const asset=await fetch(base+src);assert.equal(asset.status,200);}
});

test('HTTP visitors are redirected to the canonical HTTPS site behind the tunnel',async()=>{
    const r=await new Promise((resolve,reject)=>{
        const request=require('node:http').get(`${base}/visit?space=indoor-01`,{headers:{Host:'spacecycle.space','X-Forwarded-Proto':'http'}},response=>{response.resume();resolve(response);});request.on('error',reject);
    });
    assert.equal(r.statusCode,308);assert.equal(r.headers.location,'https://spacecycle.space/visit?space=indoor-01');
});

test('personal count route is present and rejects anonymous requests',async()=>{
    const response=await fetch(`${base}/api/me/spaces`);
    assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{error:'login_required'});
});

test('GET /healthz reports process health without user or Firebase data', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
});

test('all mobile pages share four navigation items and a header theme control', async () => {
    const routes = ['/', '/spaces', '/qr', '/badges', '/login'];
    const expectedLinks = ['/', '/spaces', '/qr', '/badges'];
    let sharedMarkup = null;
    for (const route of routes) {
        const response = await fetch(`${base}${route}`);
        assert.equal(response.status, 200, `${route} must exist`);
        const html = await response.text();
        const nav = html.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/)?.[0];
        assert.ok(nav, `${route} needs shared navigation`);
        assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]), expectedLinks);
        assert.doesNotMatch(nav, /User|theme-toggle/);
        const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
        assert.match(header || '', /id="theme-toggle"/);
        assert.equal((html.match(/id="theme-toggle"/g) || []).length, 1);
        const normalized = nav.replace(/ aria-current="page"/g, '');
        if (sharedMarkup) assert.equal(normalized, sharedMarkup);
        sharedMarkup = normalized;
        const active = [...nav.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
        assert.equal(active.length, route === '/login' ? 0 : 1);
        if (active.length) assert.ok(active[0][0].includes(`href="${route}"`));
    }
});

test('spaces keeps five slots per category with only the supplied indoor test site configured', async () => {
    const response = await fetch(`${base}/spaces`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /data-source="\/css\/style\.css"/);
    assert.match(html, /data-source="\/css\/spaces\.css"/);
    assert.match(html, /src="\/js\/spaces\.js\?v=[a-f0-9]{16}"/);
    assert.match(html, /id="spaces-tabs"[^>]*hidden/);
    for (const category of ['indoor', 'outdoor']) {
        assert.equal((html.match(new RegExp(`data-category="${category}"`, 'g')) || []).length, 5);
        assert.match(html, new RegExp(`id="${category}-panel"`));
    }
    const ids = [...html.matchAll(/data-space-slot="([^"]+)"/g)].map(m => m[1]);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
    assert.equal((html.match(/class="slot-status">등록 예정/g) || []).length, 9);
    assert.match(html, /향설생활관2/);
    assert.match(html, /반경 300m/);
    assert.match(html, /1분/);
});

test('all ten pending spaces expand to honest photo/features and a selected QR entry', async () => {
    const html = await (await fetch(`${base}/spaces`)).text();
    const details = [...html.matchAll(/<details\b[^>]*data-space-slot="([^"]+)"[\s\S]*?<\/details>/g)];
    assert.equal(details.length, 10, 'every slot must be an expandable disclosure');
    for (const [markup, id] of details) {
        assert.match(markup, /<summary\b/);
        assert.match(markup, /공간 사진 준비 중/);
        assert.match(markup, /공간 특징/);
        if (id !== 'indoor-01') assert.match(markup, /장소 선정 후/);
        assert.ok(markup.includes(`href="/qr?space=${id}"`));
        assert.match(markup, /QR 찍으러 가기/);
    }
});

test('QR page exposes opt-in camera controls, local decoder and honest privacy/status copy', async () => {
    const html = await (await fetch(`${base}/qr?space=indoor-01`)).text();
    assert.ok(html.includes('id="qr-video"'));
    assert.match(html, /<video[^>]*playsinline[^>]*muted/);
    for (const id of ['camera-start', 'camera-stop', 'scan-status', 'scan-result', 'result-link']) {
        assert.ok(html.includes(`id="${id}"`), id);
    }
    for (const src of ['/vendor/jsqr/jsQR.js', '/js/qr-policy.js', '/js/qr-camera.js', '/js/qr-scanner.js']) {
        const response = await fetch(`${base}${src}`);
        assert.equal(response.status, 200, src);
        assert.ok(html.includes(`src="${src}?v=`));
    }
    assert.match(html, /서버에 업로드하지/);
    assert.match(html, /방문 인증이나 보상/);
    assert.doesNotMatch(html, /아직 제공하지 않아요.*스캐너/);
});

test('home reflects one test place and remaining planned slots', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<a href="\/spaces" class="in-first-btn">공간 보기/);
    assert.match(html, /<a href="\/badges" class="in-second-btn">내 뱃지 보기/);
    assert.match(html, /내부 테스트 공간/);
    assert.match(html, /외부 등록 예정/);
    assert.match(html, /<dd>1<\/dd>/);
    assert.match(html, /<dd>5<\/dd>/);
    assert.doesNotMatch(html, /12\+|8\+|>User</);
});

test('printed short URLs route to a safe destination and the GPS visit page loads', async () => {
    for (const prefix of ['in','out']) for(let n=1;n<=5;n++) {
        const code=`${prefix}0${n}`, id=`${prefix==='in'?'indoor':'outdoor'}-0${n}`;
        const response=await fetch(`${base}/s/${code}`,{redirect:'manual'});
        assert.equal(response.status,302);
        assert.equal(response.headers.get('location'),`${id==='indoor-01'?'/visit':'/spaces'}?space=${id}`);
    }
    for(const suffix of ['in06','IN01','in01?extra=1','in01/']) assert.equal((await fetch(`${base}/s/${suffix}`,{redirect:'manual'})).status,404);
    const page=await fetch(`${base}/visit?space=indoor-01`);
    assert.equal(page.status,200);
    const html=await page.text();
    for(const id of ['visit-start','visit-stop','visit-timer','visit-status','visit-distance','visit-accuracy']) assert.ok(html.includes(`id="${id}"`));
    assert.match(html,/서버/);assert.match(html,/보상/);assert.match(html,/위치/);
});
