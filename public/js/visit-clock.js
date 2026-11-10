/* Display only: server responses remain the sole source of completion and persistence. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisitClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function getDisplayTime(state, now) {
        const requiredMs = Number.isFinite(state.requiredMs) && state.requiredMs > 0 ? state.requiredMs : 60000;
        const confirmedMs = Number.isFinite(state.elapsedMs) ? Math.min(requiredMs, Math.max(0, state.elapsedMs)) : 0;
        const serverComplete = state.phase === 'complete';
        const validAnchor = Number.isFinite(state.confirmedAt) && Number.isFinite(now);
        const tracking = state.active === true && state.phase === 'dwelling' && validAnchor;
        const canEstimate = tracking && state.locationPending !== true;
        const gapLimit = Number.isFinite(state.maxGapMs) && state.maxGapMs > 0 ? state.maxGapMs : 0;
        const displayLimit = validAnchor && Number.isFinite(state.confirmationDeadlineAt)
            ? Math.min(gapLimit, Math.max(0, state.confirmationDeadlineAt - state.confirmedAt)) : gapLimit;
        const ageMs = validAnchor ? Math.max(0, now - state.confirmedAt) : 0;
        const stale = tracking && (displayLimit === 0 || ageMs >= displayLimit);
        const elapsedMs = serverComplete ? requiredMs
            : Math.min(requiredMs, confirmedMs + (canEstimate ? Math.min(ageMs, displayLimit) : 0));
        return {
            elapsedMs, remainingMs: requiredMs - elapsedMs, serverComplete, stale,
            awaitingFinal: canEstimate && !stale && elapsedMs >= requiredMs,
        };
    }
    return Object.freeze({ getDisplayTime });
});
