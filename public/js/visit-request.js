(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisitRequest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const allowedCodes = new Set(['login_required', 'invalid_token', 'identity_changed', 'origin_denied', 'capacity', 'start_cancelled', 'not_configured', 'session_missing', 'stale_challenge', 'wrong_owner', 'invalid_payload', 'invalid_position', 'save_failed', 'auth_unavailable', 'server_error', 'edge_blocked', 'invalid_response', 'network_error', 'request_timeout', 'cancelled', 'outside', 'uncertain', 'too_early', 'rate_limited', 'expired']);
    function failure(code, status = 0) {
        const error = new Error(allowedCodes.has(code) ? code : 'server_error');
        error.code = error.message;
        error.status = status;
        return error;
    }
    function createVisitRequest({ getAuth, getOwner, fetchImpl = (...args) => fetch(...args) }) {
        return async (route, body, options = {}) => {
            const owner = getOwner();
            if (!owner || getAuth()?.getUser()?.uid !== owner) throw failure('login_required');
            const check = () => {
                if (options.signal?.aborted) throw failure('cancelled');
                if (getOwner() !== owner || getAuth()?.getUser()?.uid !== owner) throw failure('identity_changed');
            };
            if (typeof route !== 'string') throw failure('invalid_payload');
            const action = route === '/api/stays' ? 'start' : route === '/api/stays/resume' ? 'resume' : route === '/api/stays/abandon' ? 'abandon'
                : /^\/api\/stays\/[a-f0-9]{48}\/(finish|cancel)$/.exec(route)?.[1];
            const positionKeys = ['latitude', 'longitude', 'accuracy'];
            const keys = action === 'start' ? ['spaceId', ...positionKeys, ...(Object.hasOwn(body || {}, 'attemptId') ? ['attemptId'] : [])]
                : action === 'abandon' ? ['spaceId', 'attemptId'] : action === 'resume' ? ['spaceId']
                : action === 'finish' ? ['challenge', ...positionKeys] : ['challenge'];
            if (!action || !body || typeof body !== 'object' || Array.isArray(body) ||
                Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) ||
                (['start', 'resume', 'abandon'].includes(action) && (typeof body.spaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.spaceId))) ||
                ((action === 'abandon' || (action === 'start' && Object.hasOwn(body, 'attemptId'))) &&
                    (typeof body.attemptId !== 'string' || !/^[a-f0-9]{48}$/.test(body.attemptId))) ||
                (['finish', 'cancel'].includes(action) && (typeof body.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(body.challenge))) ||
                (['start', 'finish'].includes(action) && (!positionKeys.every(key => Number.isFinite(body[key])) ||
                    Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180 || body.accuracy < 0))) throw failure('invalid_payload');
            let payload;
            try { payload = JSON.stringify(body); }
            catch { throw failure('invalid_payload'); }
            if (new TextEncoder().encode(payload).length > 2048) throw failure('invalid_payload');
            for (let attempt = 0; attempt < 2; attempt++) {
                check();
                let token;
                try { token = await getAuth().getToken(attempt === 1); }
                catch { check(); throw failure('login_required'); }
                check();
                let response;
                try {
                    response = await fetchImpl(route, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: payload, credentials: 'same-origin', cache: 'no-store',
                        signal: options.signal, keepalive: options.keepalive === true,
                    });
                } catch { check(); throw failure('network_error'); }
                check();
                if (response.status === 204) {
                    if (!['cancel', 'abandon'].includes(action)) throw failure('invalid_response', response.status);
                    return null;
                }
                if (!response.headers.get('content-type')?.includes('application/json')) {
                    throw failure(response.status === 403 ? 'edge_blocked' : 'invalid_response', response.status);
                }
                let result;
                try { result = await response.json(); }
                catch { check(); throw failure('invalid_response', response.status); }
                check();
                if (response.ok) {
                    if (['cancel', 'abandon'].includes(action)) throw failure('invalid_response', response.status);
                    return result;
                }
                const code = allowedCodes.has(result?.error) ? result.error : 'server_error';
                if (response.status === 401 && ['invalid_token', 'login_required'].includes(code) && attempt === 0) continue;
                throw failure(code, response.status);
            }
        };
    }
    return Object.freeze({ createVisitRequest });
});
