/* Server-owned foreground acquisition budgets. No user identity or GPS data. */
function validateStayPolicy(policy) {
    const limits = {
        sampleEveryMs: [3000, 3000], locationTimeoutMs: [6000, 20000],
        initialTimeoutMs: [30000, 30000], networkReserveMs: [2000, 10000], maxGapMs: [12000, 40000],
    };
    if (!policy || typeof policy !== 'object' || Object.keys(policy).sort().join(',') !== Object.keys(limits).sort().join(',')) {
        throw new Error('invalid_stay_timing_policy');
    }
    for (const [key, [minimum, maximum]] of Object.entries(limits)) {
        if (!Number.isSafeInteger(policy[key]) || policy[key] < minimum || policy[key] > maximum) throw new Error('invalid_stay_timing_policy');
    }
    if (policy.sampleEveryMs + policy.locationTimeoutMs + policy.networkReserveMs >= policy.maxGapMs ||
        policy.locationTimeoutMs + policy.networkReserveMs >= policy.initialTimeoutMs) throw new Error('invalid_stay_timing_budget');
    return Object.freeze({ ...policy });
}
function readStayPolicy(env = {}) {
    const setting = (name, fallback) => {
        const raw = env[name];
        if (raw === undefined) return fallback;
        if (typeof raw !== 'string' || !/^[1-9]\d{0,5}$/.test(raw)) throw new Error('invalid_stay_timing_environment');
        return Number(raw);
    };
    return validateStayPolicy({
        sampleEveryMs: 3000, locationTimeoutMs: setting('SPACE_CYCLE_LOCATION_TIMEOUT_MS', 15000),
        initialTimeoutMs: 30000, networkReserveMs: setting('SPACE_CYCLE_NETWORK_RESERVE_MS', 5000),
        maxGapMs: setting('SPACE_CYCLE_MAX_GAP_MS', 25000),
    });
}
module.exports = { readStayPolicy, validateStayPolicy };
