/* Foreground-only location sampling. No client clock can mark a visit complete. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function createVisitSession({ spaceId, geolocation, request, onState,
        now = () => performance.now(), wallNow = () => Date.now(),
        schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id) }) {
        let generation = 0;
        let active = false;
        let snapshot = null;
        let pollTimer = null;
        let watchdog = null;
        let controller = null;
        let lastFixTimestamp = -Infinity;
        let lastConfirmedAt = null;
        const current = run => active && generation === run;
        const emit = (phase, message, extra = {}) => onState({
            phase, message, active, elapsedMs: snapshot?.elapsedMs || 0,
            requiredMs: snapshot?.requiredMs || 60000,
            distanceM: snapshot?.distanceM ?? null, accuracyM: snapshot?.accuracyM ?? null,
            confirmedAt: lastConfirmedAt, ...extra,
        });
        function clearTimers() {
            if (pollTimer !== null) unschedule(pollTimer);
            if (watchdog !== null) unschedule(watchdog);
            pollTimer = watchdog = null;
        }
        function discard(s) {
            if (!s?.id || !s.challenge) return;
            // Best effort only: a lost cancellation cannot resume in this page, and server TTL bounds it.
            Promise.resolve().then(() => request(`/api/stays/${s.id}/cancel`, { challenge: s.challenge }, { keepalive: true })).catch(() => {});
        }
        function stop(message = '체류를 중단하고 시간을 초기화했어요.', phase = 'stopped') {
            generation++;
            active = false;
            clearTimers();
            controller?.abort();
            controller = null;
            discard(snapshot);
            snapshot = null;
            lastConfirmedAt = null;
            emit(phase, message);
        }
        function fail(message) { stop(message, 'error'); }
        function armDeadline(run, milliseconds) {
            if (watchdog !== null) unschedule(watchdog);
            watchdog = schedule(() => {
                if (current(run)) fail('위치 확인이 끊겨 시간을 초기화했어요. 위치와 인터넷을 확인하고 다시 시작해주세요.');
            }, milliseconds);
        }
        async function submit(run, position) {
            if (!current(run)) return;
            const timestamp = position?.timestamp;
            const age = wallNow() - timestamp;
            if (!Number.isFinite(timestamp) || age < -1000 || age > 4000 || timestamp <= lastFixTimestamp) {
                fail('최신 위치를 확인하지 못해 초기화했어요. 잠시 후 다시 시작해주세요.');
                return;
            }
            lastFixTimestamp = timestamp;
            const { latitude, longitude, accuracy } = position.coords || {};
            try {
                const next = await request(`/api/stays/${snapshot.id}/sample`, {
                    challenge: snapshot.challenge, latitude, longitude, accuracy,
                }, { signal: controller.signal });
                if (!current(run)) { discard(next); return; }
                snapshot = next;
                lastConfirmedAt = now();
                if (next.phase === 'complete') {
                    active = false;
                    clearTimers();
                    emit('complete', '1분 체류 테스트 완료! 뱃지·보상이나 방문 기록은 아직 저장되지 않아요.');
                    discard(snapshot);
                    snapshot = null;
                    return;
                }
                const messages = {
                    dwelling: next.reason === 'gap' ? '위치 확인 간격이 길어 처음부터 다시 측정해요.' : '반경 안에 있어요. 화면을 켜두고 머물러주세요.',
                    outside: '반경 100m 밖이에요. 시간을 초기화했어요. 범위 안으로 돌아오면 다시 시작해요.',
                    uncertain: '위치가 불확실해 시간을 초기화했어요. 정확도가 좋아지면 다시 시작해요.',
                };
                if (!Object.hasOwn(messages, next.phase)) throw new Error('invalid_response');
                emit(next.phase, messages[next.phase]);
                armDeadline(run, next.maxGapMs);
                pollTimer = schedule(() => locate(run), next.sampleEveryMs);
            } catch {
                if (current(run)) fail('서버와 연결하지 못해 초기화했어요. 인터넷을 확인하고 다시 시작해주세요.');
            }
        }
        function locate(run) {
            if (!current(run)) return;
            try {
                geolocation.getCurrentPosition(position => { void submit(run, position); }, error => {
                    if (!current(run)) return;
                    const messages = {
                        1: '위치 권한이 거부되었어요. 사이트 설정에서 위치를 허용한 뒤 다시 시작해주세요.',
                        2: '위치를 찾을 수 없어 초기화했어요. GPS 신호가 잘 잡히는 안전한 곳에서 다시 시도해주세요.',
                        3: '위치 확인 시간이 초과되어 초기화했어요. 잠시 후 다시 시작해주세요.',
                    };
                    fail(messages[error?.code] || '위치 확인에 실패해 시간을 초기화했어요.');
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 6000 });
            } catch { fail('이 브라우저에서 위치를 확인할 수 없어요.'); }
        }
        async function start() {
            if (active) return;
            const run = ++generation;
            active = true;
            snapshot = null;
            lastConfirmedAt = null;
            lastFixTimestamp = -Infinity;
            controller = new AbortController();
            emit('requesting', '위치 확인을 준비하고 있어요.');
            armDeadline(run, 30000);
            try {
                const next = await request('/api/stays', { spaceId }, { signal: controller.signal });
                if (!current(run)) { discard(next); return; }
                snapshot = next;
                emit('locating', '위치 권한을 허용해주세요. 처음 위치를 찾는 중이에요.');
                locate(run);
            } catch {
                if (current(run)) fail('체류 테스트를 시작하지 못했어요. 인터넷 연결을 확인해주세요.');
            }
        }
        return Object.freeze({ start, stop, isActive: () => active });
    }
    return Object.freeze({ createVisitSession });
});
