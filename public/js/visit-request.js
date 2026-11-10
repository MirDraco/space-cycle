(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisitRequest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const allowedCodes = new Set(['login_required', 'invalid_token', 'identity_changed', 'origin_denied', 'capacity', 'not_configured', 'session_missing', 'stale_challenge', 'wrong_owner', 'invalid_payload', 'invalid_position', 'save_failed', 'auth_unavailable', 'server_error', 'edge_blocked', 'invalid_response', 'network_error', 'request_timeout', 'cancelled']);
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
            if (!/^\/api\/stays(?:\/[A-Za-z0-9_-]+\/(?:sample|cancel))?$/.test(route)) throw failure('invalid_payload');
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
                        body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store',
                        signal: options.signal, keepalive: options.keepalive === true,
                    });
                } catch { check(); throw failure('network_error'); }
                check();
                if (response.status === 204) return null;
                if (!response.headers.get('content-type')?.includes('application/json')) {
                    throw failure(response.status === 403 ? 'edge_blocked' : 'invalid_response', response.status);
                }
                let result;
                try { result = await response.json(); }
                catch { throw failure('invalid_response', response.status); }
                check();
                if (response.ok) return result;
                const code = allowedCodes.has(result?.error) ? result.error : 'server_error';
                if (response.status === 401 && ['invalid_token', 'login_required'].includes(code) && attempt === 0) continue;
                throw failure(code, response.status);
            }
        };
    }
    return Object.freeze({ createVisitRequest });
});
