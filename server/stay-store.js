const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { getSpace } = require('../public/js/space-data.js');
const { readStayPolicy, validateStayPolicy } = require('./stay-policy.js');

const MAX_GAP_MS = readStayPolicy().maxGapMs;
const TTL_MS = 10 * 60 * 1000;
const token = () => randomBytes(24).toString('hex');

function fail(code, status = 400) {
    const error = new Error(code);
    error.status = status;
    throw error;
}

function assessPosition(space, sample) {
    const { latitude, longitude, accuracy } = sample;
    if (![latitude, longitude, accuracy].every(value => typeof value === 'number' && Number.isFinite(value)) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100000) fail('invalid_position');
    const radians = value => value * Math.PI / 180;
    const latDelta = radians(latitude - space.latitude);
    const lonDelta = radians(longitude - space.longitude);
    const a = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(space.latitude)) * Math.cos(radians(latitude)) * Math.sin(lonDelta / 2) ** 2;
    const distanceM = 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
    // The measured point must be inside the radius, and the reported GPS error must be within
    // the place's separate accuracy cap so a coarse fix cannot pass by chance.
    const phase = distanceM > space.radiusM ? 'outside'
        : accuracy > space.maxAccuracyM ? 'uncertain' : 'inside';
    return { phase, distanceM, accuracyM: accuracy };
}

function createStayStore({ now = () => performance.now(), maxSessions = 500,
    policy = readStayPolicy(process.env) } = {}) {
    const timing = validateStayPolicy(policy);
    const sessions = new Map();
    function cleanup() {
        const time = now();
        for (const [id, s] of sessions) if (time - s.createdAt > TTL_MS) sessions.delete(id);
    }
    function lookup(id) {
        cleanup();
        const s = sessions.get(id);
        if (!s) fail('session_missing', 410);
        return s;
    }
    function verify(s, challenge) {
        if (typeof challenge !== 'string' || challenge !== s.challenge) fail('stale_challenge', 409);
    }
    function snapshot(s, reason = null) {
        return {
            id: s.id, challenge: s.challenge, space: getSpace(s.spaceId), phase: s.phase,
            elapsedMs: s.elapsedMs, requiredMs: getSpace(s.spaceId).requiredMs,
            distanceM: s.distanceM, accuracyM: s.accuracyM, ...timing,
            reason, persisted: false,
        };
    }
    function create(spaceId, owner = null) {
        const space = getSpace(spaceId);
        if (!space?.enabled) fail('not_configured', 404);
        cleanup();
        if (sessions.size >= maxSessions) fail('capacity', 429);
        const s = { id: token(), challenge: token(), spaceId, owner, createdAt: now(), startedAt: null,
            lastSeen: null, phase: 'waiting', elapsedMs: 0, distanceM: null, accuracyM: null };
        sessions.set(s.id, s);
        return snapshot(s);
    }
    function sample(id, body, owner = null) {
        const s = lookup(id);
        if (s.owner !== owner) fail('wrong_owner', 403);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).sort().join(',') !== 'accuracy,challenge,latitude,longitude') fail('invalid_payload');
        verify(s, body.challenge);
        const position = assessPosition(getSpace(s.spaceId), body);
        const time = now();
        const gap = s.lastSeen !== null && time - s.lastSeen > timing.maxGapMs;
        if (s.phase === 'complete') return snapshot(s);
        if (gap) { s.startedAt = null; s.elapsedMs = 0; }
        s.lastSeen = time;
        s.distanceM = Math.round(position.distanceM * 10) / 10;
        s.accuracyM = position.accuracyM;
        if (position.phase !== 'inside') {
            s.startedAt = null;
            s.elapsedMs = 0;
            s.phase = position.phase;
        } else {
            if (s.startedAt === null) s.startedAt = time;
            s.elapsedMs = Math.min(getSpace(s.spaceId).requiredMs, Math.max(0, Math.floor(time - s.startedAt)));
            s.phase = s.elapsedMs >= getSpace(s.spaceId).requiredMs ? 'complete' : 'dwelling';
        }
        s.challenge = token();
        return snapshot(s, gap ? 'gap' : null);
    }
    function cancel(id, challenge, owner = null) {
        const s = lookup(id);
        if (s.owner !== owner) fail('wrong_owner', 403);
        verify(s, challenge);
        sessions.delete(id);
    }
    // For unit inspection only; not exposed as an HTTP route.
    const inspect = id => ({ ...lookup(id) });
    return Object.freeze({ create, sample, cancel, inspect });
}
module.exports = { createStayStore, assessPosition, MAX_GAP_MS };
