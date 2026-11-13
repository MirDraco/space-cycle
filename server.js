const express = require('express');
const app = express();
const path = require('path');
const fs = require('node:fs');
const PORT = 4500;
const spaces = require('./public/js/space-data.js');
const { createStayRouter } = require('./server/stay-routes.js');
const { createMeRouter } = require('./server/me-routes.js');
const { createPageAssets } = require('./server/page-assets.js');
const assets = createPageAssets(__dirname);

// Preserve HTTPS for camera/GPS when the trusted local tunnel reports an HTTP visitor.
app.use((req, res, next) => {
    if (req.get('host') === 'spacecycle.space' && req.get('x-forwarded-proto') === 'http') {
        return res.redirect(308, `https://spacecycle.space${req.originalUrl}`);
    }
    res.set('X-SpaceCycle-Release', assets.release);
    next();
});

app.use('/api/stays', createStayRouter());
app.use('/api/me', createMeRouter());
app.get('/s/:code', (req, res) => {
    const place = spaces.fromCode(req.params.code);
    if (!place || req.originalUrl !== `/s/${place.code}`) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, spaces.destination(place.id));
});

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filename) {
        if (/\.(?:js|css)$/.test(filename)) res.set('Cache-Control', 'no-store');
    },
}));

// Fixed local templates only: no request data is interpolated into page markup.
const header = fs.readFileSync(path.join(__dirname, 'views', 'partials', 'header.html'), 'utf8');
const navigation = fs.readFileSync(path.join(__dirname, 'views', 'partials', 'navigation.html'), 'utf8');
const pages = [
    ['/', 'index.html', 'home'],
    ['/spaces', 'spaces.html', 'spaces'],
    ['/qr', 'qr.html', 'qr'],
    ['/visit', 'visit.html', 'qr'],
    ['/badges', 'badges.html', 'badges'],
    ['/login', 'login.html', null],
    ['/privacy', 'privacy.html', null],
];

for (const [route, filename, active] of pages) {
    const pageNavigation = active
        ? navigation.replace(`data-nav="${active}"`, `data-nav="${active}" aria-current="page"`)
        : navigation;
    const html = assets.prepare(fs.readFileSync(path.join(__dirname, 'views', filename), 'utf8')
        .replace('<!-- app-header -->', header.trim())
        .replace('<!-- app-navigation -->', pageNavigation.trim()));
    app.get(route, (req, res) => res.set('Cache-Control', 'no-store').type('html').send(html));
}

app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT}에서 실행 중 입니다.`);
});
