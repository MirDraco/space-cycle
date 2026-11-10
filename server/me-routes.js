const express = require('express');
const { authenticate } = require('./firebase-auth.js');
const { defaultVisits } = require('./visits.js');

function createMeRouter({ visits = null, verifyToken } = {}) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
        next();
    });
    router.use(authenticate(verifyToken));
    router.get('/spaces', (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: 'invalid_query' });
        try { res.json((visits || defaultVisits()).list(req.identity.uid)); }
        catch { res.status(503).json({ error: 'count_unavailable' }); }
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const code = ['login_required', 'invalid_token'].includes(error.message) ? error.message : 'server_error';
        res.status(code === 'server_error' ? 500 : 401).json({ error: code });
    });
    return router;
}
module.exports = { createMeRouter };
