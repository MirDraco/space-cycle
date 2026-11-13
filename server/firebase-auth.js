const { createRemoteJWKSet, jwtVerify } = require('jose');
const PROJECT_ID = 'space-cycle-1b705';
const keySet = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 60 * 60 * 1000,
});
function authError(code, status = 401) {
    const error = new Error(code);
    error.status = status;
    return error;
}
// Small clock skew between this host (e.g. a Docker VM that drifted during laptop sleep)
// and Google must not turn a freshly issued token into a "login expired" error.
const CLOCK_SKEW_S = 60;
function createFirebaseVerifier({ keySet: keys = keySet, now = () => Date.now() / 1000 } = {}) {
    return async token => {
        if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw authError('invalid_token');
        try {
            const time = now();
            const { payload } = await jwtVerify(token, keys, {
                issuer: `https://securetoken.google.com/${PROJECT_ID}`, audience: PROJECT_ID,
                algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
                currentDate: new Date(time * 1000), clockTolerance: CLOCK_SKEW_S,
            });
            if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 ||
                !Number.isFinite(payload.iat) || payload.iat > time + CLOCK_SKEW_S ||
                !Number.isFinite(payload.auth_time) || payload.auth_time > time + CLOCK_SKEW_S ||
                payload.firebase?.sign_in_provider !== 'google.com') throw authError('invalid_token');
            return Object.freeze({ uid: payload.sub });
        } catch {
            // Never log tokens or decoded claims. Fail closed for network/key/claim errors.
            throw authError('invalid_token');
        }
    };
}
function authenticate(verifyToken = createFirebaseVerifier()) {
    return async (req, res, next) => {
        const header = req.get('authorization');
        if (!header || !/^Bearer [A-Za-z0-9_.-]+$/.test(header)) return next(authError('login_required'));
        try {
            req.identity = await verifyToken(header.slice(7));
            if (!req.identity?.uid) throw authError('invalid_token');
            next();
        } catch { next(authError('invalid_token')); }
    };
}
module.exports = { createFirebaseVerifier, authenticate };
