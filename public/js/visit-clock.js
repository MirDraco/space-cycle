/* Display only: zero invites a final check, never completion or persistence. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisitClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function getDisplayTime(state, now) {
        const requiredMs = Number.isFinite(state.requiredMs) && state.requiredMs > 0 ? state.requiredMs : 60000;
        const confirmedMs = Number.isFinite(state.elapsedMs) ? Math.min(requiredMs, Math.max(0, state.elapsedMs)) : 0;
        const serverComplete = state.phase === 'complete' && state.persisted === true;
        const anchored = Number.isFinite(state.confirmedAt) && Number.isFinite(now);
        const ageMs = anchored ? Math.max(0, now - state.confirmedAt) : 0;
        const validExpiry = Number.isFinite(state.expiresInMs) && state.expiresInMs > 0 && state.expiresInMs <= 7200000;
        const tracking = state.mode === 'start_finish' && state.active === true &&
            ['waiting', 'ready'].includes(state.phase) && anchored && validExpiry;
        const stale = tracking && ageMs >= state.expiresInMs;
        const elapsedMs = serverComplete ? requiredMs : Math.min(requiredMs,
            confirmedMs + (tracking ? Math.min(ageMs, state.expiresInMs) : 0));
        return { elapsedMs, remainingMs: requiredMs - elapsedMs, serverComplete, stale,
            awaitingFinal: tracking && !stale && elapsedMs >= requiredMs };
    }
    return Object.freeze({ getDisplayTime });
});
