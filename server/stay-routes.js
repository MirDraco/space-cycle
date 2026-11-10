const express = require('express');
const { createStayStore } = require('./stay-store.js');

function approvedOrigin(origin, host) {
    if (origin === 'https://spacecycle.space') return true;
    try {
        const url = new URL(origin);
        return url.origin === origin && url.host === host &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
    } catch { return false; }
}

function createStayRouter({ store = createStayStore() } = {}) {
    const router = express.Router();
    // This is a no-reward test API. No cookies, credentials, raw GPS logging or persistence.
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
        if (!approvedOrigin(req.get('origin'), req.get('host'))) return res.status(403).json({ error: 'origin_denied' });
        if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
        next();
    });
    router.use(express.json({ limit: '2kb', strict: true }));
    router.post('/', (req, res) => {
        if (!req.body || Object.keys(req.body).join(',') !== 'spaceId') return res.status(400).json({ error: 'invalid_payload' });
        res.status(201).json(store.create(req.body.spaceId));
    });
    router.post('/:id/sample', (req, res) => res.json(store.sample(req.params.id, req.body)));
    router.post('/:id/cancel', (req, res) => {
        if (!req.body || Object.keys(req.body).join(',') !== 'challenge') return res.status(400).json({ error: 'invalid_payload' });
        store.cancel(req.params.id, req.body.challenge);
        res.sendStatus(204);
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = ['not_configured', 'capacity', 'session_missing', 'invalid_payload', 'invalid_position', 'stale_challenge'];
        const code = known.includes(error.message) ? error.message
            : error.type === 'entity.too.large' ? 'payload_too_large'
            : error.type === 'entity.parse.failed' ? 'invalid_json' : 'server_error';
        const status = code === 'server_error' ? 500 : error.status || 400;
        res.status(status).json({ error: code });
    });
    return router;
}
module.exports = { createStayRouter };
