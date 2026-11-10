const express = require('express');
const { createStayProgress } = require('./stay-progress.js');
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

function exactBody(body, keys) {
    return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === keys;
}

function createStayRateLimiter({ now = Date.now, maxRequests = 60, maxEntries = 10000, windowMs = 60000 } = {}) {
    const buckets = new Map();
    return uid => {
        const time = now();
        // Fixed windows are insertion-ordered; only expired buckets are scanned.
        for (const [key, bucket] of buckets) {
            if (bucket.expiresAt > time) break;
            buckets.delete(key);
        }
        let bucket = buckets.get(uid);
        if (!bucket && buckets.size < maxEntries) {
            bucket = { count: 0, expiresAt: time + windowMs };
            buckets.set(uid, bucket);
        }
        if (!bucket || bucket.count >= maxRequests) {
            const error = new Error('rate_limited');
            error.status = 429;
            throw error;
        }
        bucket.count++;
    };
}

function createStayRouter({ progress = null, visits = null, verifyToken, limiter = createStayRateLimiter() } = {}) {
    let durable = progress;
    function state() {
        if (!durable) durable = createStayProgress({ visits: visits || defaultVisits() });
        return durable;
    }
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
    router.use((req, res, next) => { limiter(req.identity.uid); next(); });
    router.post('/', (req, res) => {
        if (!exactBody(req.body, 'accuracy,latitude,longitude,spaceId') &&
            !exactBody(req.body, 'accuracy,attemptId,latitude,longitude,spaceId')) return res.status(400).json({ error: 'invalid_payload' });
        const { spaceId, latitude, longitude, accuracy, attemptId } = req.body;
        const result = state().start(spaceId, { latitude, longitude, accuracy }, req.identity.uid, attemptId);
        res.status(result.created ? 201 : 200).json(result.state);
    });
    router.post('/resume', (req, res) => {
        if (!exactBody(req.body, 'spaceId')) return res.status(400).json({ error: 'invalid_payload' });
        res.json(state().resume(req.body.spaceId, req.identity.uid));
    });
    router.post('/abandon', (req, res) => {
        if (!exactBody(req.body, 'attemptId,spaceId')) return res.status(400).json({ error: 'invalid_payload' });
        state().abandon(req.body.spaceId, req.body.attemptId, req.identity.uid);
        res.sendStatus(204);
    });
    router.post('/:id/finish', (req, res) => {
        if (!exactBody(req.body, 'accuracy,challenge,latitude,longitude')) return res.status(400).json({ error: 'invalid_payload' });
        res.json(state().finish(req.params.id, req.body, req.identity.uid));
    });
    router.post('/:id/cancel', (req, res) => {
        if (!exactBody(req.body, 'challenge')) return res.status(400).json({ error: 'invalid_payload' });
        state().cancel(req.params.id, req.body.challenge, req.identity.uid);
        res.sendStatus(204);
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = ['not_configured', 'capacity', 'start_cancelled', 'session_missing', 'invalid_payload', 'invalid_position', 'stale_challenge', 'wrong_owner', 'login_required', 'invalid_token', 'outside', 'uncertain', 'too_early', 'save_failed', 'rate_limited'];
        const code = known.includes(error.message) ? error.message
            : error.type === 'entity.too.large' ? 'payload_too_large'
            : error.type === 'entity.parse.failed' ? 'invalid_json' : 'server_error';
        const status = code === 'server_error' ? 500 : error.status || 400;
        res.status(status).json({ error: code });
    });
    return router;
}
module.exports = { createStayRouter, createStayRateLimiter };
