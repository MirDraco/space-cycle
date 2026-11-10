const express = require('express');
const { createStayStore } = require('./stay-store.js');
const { authenticate } = require('./firebase-auth.js');
const { defaultVisits } = require('./visits.js');

function approvedOrigin(origin, host) {
    if (origin === 'https://spacecycle.space') return true;
    try {
        const url = new URL(origin);
        return url.origin === origin && url.host === host &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
    } catch { return false; }
}

function createStayRouter({ store = createStayStore(), visits = null, verifyToken } = {}) {
    const router = express.Router();
    // Verified UID owns the session; never accept a client-supplied UID or completion count.
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
        if (!approvedOrigin(req.get('origin'), req.get('host'))) return res.status(403).json({ error: 'origin_denied' });
        if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
        next();
    });
    router.use(express.json({ limit: '2kb', strict: true }));
    router.use(authenticate(verifyToken));
    router.post('/', (req, res) => {
        if (!req.body || Object.keys(req.body).join(',') !== 'spaceId') return res.status(400).json({ error: 'invalid_payload' });
        res.status(201).json(store.create(req.body.spaceId, req.identity.uid));
    });
    router.post('/:id/sample', (req, res) => {
        const state = store.sample(req.params.id, req.body, req.identity.uid);
        if (state.phase === 'complete') {
            try {
                // Synchronous transaction/unique constraint makes concurrent retries idempotent.
                const result = (visits || defaultVisits()).record(req.identity.uid, state.space.id);
                return res.json({ ...state, ...result, persisted: true });
            } catch {
                // No false saved state and no raw DB errors/UIDs in responses or logs.
                return res.status(503).json({ error: 'save_failed' });
            }
        }
        res.json(state);
    });
    router.post('/:id/cancel', (req, res) => {
        if (!req.body || Object.keys(req.body).join(',') !== 'challenge') return res.status(400).json({ error: 'invalid_payload' });
        store.cancel(req.params.id, req.body.challenge, req.identity.uid);
        res.sendStatus(204);
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = ['not_configured', 'capacity', 'session_missing', 'invalid_payload', 'invalid_position', 'stale_challenge', 'wrong_owner', 'login_required', 'invalid_token'];
        const code = known.includes(error.message) ? error.message
            : error.type === 'entity.too.large' ? 'payload_too_large'
            : error.type === 'entity.parse.failed' ? 'invalid_json' : 'server_error';
        const status = code === 'server_error' ? 500 : error.status || 400;
        res.status(status).json({ error: code });
    });
    return router;
}
module.exports = { createStayRouter };
