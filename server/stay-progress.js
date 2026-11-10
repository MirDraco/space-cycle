const { randomBytes } = require('node:crypto');
const { getSpace } = require('../public/js/space-data.js');
const { assessPosition } = require('./stay-store.js');

const TTL_MS = 7200000;
const timing = Object.freeze({ locationTimeoutMs: 15000, initialTimeoutMs: 30000 });
const token = () => randomBytes(24).toString('hex');

function fail(code, status = 400) {
    const error = new Error(code);
    error.status = status;
    throw error;
}
function exactBody(body, keys) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== keys) fail('invalid_payload');
}
function configured(spaceId) {
    const space = getSpace(spaceId);
    if (!space?.enabled) fail('not_configured', 404);
    return space;
}
function inside(space, body) {
    const position = assessPosition(space, body);
    if (position.phase !== 'inside') fail(position.phase, 422);
    return position;
}

// Persisted wall-clock timestamps survive reloads and server restarts. The trusted
// server clock must be synchronized: forward adjustments can shorten a wait/TTL,
// while backward adjustments delay readiness (elapsed time is clamped at zero).
function createStayProgress({ visits, now = Date.now, ttlMs = TTL_MS, maxSessions = 10000, maxAttempts = 10000 } = {}) {
    function validAttempt(attemptId) {
        if (typeof attemptId !== 'string' || !/^[a-f0-9]{48}$/.test(attemptId)) fail('invalid_payload');
    }
    function snapshot(row, time, position = null, newlyFound = false) {
        const complete = row.status === 'complete';
        return {
            mode: 'start_finish', id: row.id, challenge: row.challenge, spaceId: row.space_id,
            phase: complete ? 'complete' : time >= row.ready_at ? 'ready' : 'waiting',
            elapsedMs: complete ? row.required_ms : Math.min(row.required_ms, Math.max(0, Math.floor(time - row.started_at))),
            requiredMs: row.required_ms, expiresInMs: Math.max(0, row.expires_at - time),
            distanceM: position ? Math.round(position.distanceM * 10) / 10 : null,
            accuracyM: position ? position.accuracyM : null,
            persisted: complete, newlyFound,
            ...(complete ? { foundSpaceCount: visits.list(row.uid).foundSpaceCount } : {}), ...timing,
        };
    }
    function resume(spaceId, owner) {
        const space = configured(spaceId);
        const time = now();
        const row = visits.progress.find(owner, spaceId);
        if (row?.expires_at <= time) {
            visits.progress.cleanup(time);
            fail('session_missing', 410);
        }
        visits.progress.cleanup(time);
        if (row) return snapshot(row, time);
        return { mode: 'start_finish', phase: 'idle', spaceId, requiredMs: space.requiredMs, ...timing };
    }
    function create(body, owner, attemptId) {
        exactBody(body, 'accuracy,latitude,longitude,spaceId');
        const space = configured(body.spaceId);
        const position = inside(space, body);
        const time = now();
        const row = {
            id: token(), challenge: token(), uid: owner, space_id: space.id,
            started_at: time, ready_at: time + space.requiredMs, expires_at: time + ttlMs,
            required_ms: space.requiredMs, status: 'active',
        };
        let result;
        try { result = visits.progress.insert(row, maxSessions, attemptId, maxAttempts); }
        catch (error) {
            if (['capacity', 'start_cancelled', 'invalid_payload'].includes(error.message) && [400, 409, 429].includes(error.status)) throw error;
            fail('save_failed', 503);
        }
        return { created: result.created, state: snapshot(result.row, time, position) };
    }
    function owned(id, owner, challenge) {
        const row = visits.progress.get(id);
        if (!row) fail('session_missing', 410);
        if (row.uid !== owner) fail('wrong_owner', 403);
        const time = now();
        if (row.expires_at <= time) {
            visits.progress.cleanup(time);
            fail('session_missing', 410);
        }
        visits.progress.cleanup(time);
        if (typeof challenge !== 'string' || challenge !== row.challenge) fail('stale_challenge', 409);
        return row;
    }
    function finish(id, body, owner) {
        exactBody(body, 'accuracy,challenge,latitude,longitude');
        const row = owned(id, owner, body.challenge);
        const time = now();
        if (time >= row.expires_at) {
            visits.progress.cleanup(time);
            fail('session_missing', 410);
        }
        const position = assessPosition(configured(row.space_id), body);
        if (row.status === 'complete') return snapshot(row, time, position);
        if (position.phase !== 'inside') fail(position.phase, 422);
        if (time < row.ready_at) fail('too_early', 409);
        let result;
        try { result = visits.progress.complete(row, time); }
        catch { fail('save_failed', 503); }
        return snapshot(result.row, time, position, result.newlyFound);
    }
    function start(spaceId, position, owner, attemptId) {
        exactBody(position, 'accuracy,latitude,longitude');
        if (attemptId !== undefined) validAttempt(attemptId);
        return create({ spaceId, ...position }, owner, attemptId);
    }
    function abandon(spaceId, attemptId, owner) {
        configured(spaceId); validAttempt(attemptId);
        try { visits.progress.abandon(owner, spaceId, attemptId, now(), maxAttempts); }
        catch (error) {
            if (['capacity', 'invalid_payload'].includes(error.message) && [400, 429].includes(error.status)) throw error;
            fail('save_failed', 503);
        }
    }
    function cancel(id, challenge, owner) {
        owned(id, owner, challenge);
        try { visits.progress.remove(id, owner, challenge); }
        catch { fail('save_failed', 503); }
    }
    return Object.freeze({ start, resume, finish, cancel, abandon });
}
module.exports = { createStayProgress };
