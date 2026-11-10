/* Foreground-only location sampling. No client clock can mark a visit complete. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function requestFailure(error) {
        const messages = {
            login_required: '로그인 상태를 확인할 수 없어요. 로그아웃 후 Google로 다시 로그인해주세요.',
            invalid_token: '로그인이 만료되었거나 확인되지 않았어요. 로그아웃 후 Google로 다시 로그인해주세요.',
            identity_changed: '계정이 바뀌었어요. 현재 계정으로 다시 시작해주세요.',
            origin_denied: '접속 주소가 허용되지 않았어요. https://spacecycle.space에서 다시 열어주세요.',
            edge_blocked: '사이트 보안 확인이 요청을 막았어요. 최신 화면을 다시 불러온 뒤 시도해주세요.',
            capacity: '진행 중인 요청이 많아요. 잠시 후 다시 시작해주세요.',
            not_configured: '이 공간은 아직 체류할 수 없어요. 공간 목록에서 다시 선택해주세요.',
            session_missing: '체류 세션이 만료되었어요. 다시 시작해주세요.',
            stale_challenge: '체류 요청 순서가 맞지 않아요. 최신 화면을 다시 불러온 뒤 시작해주세요.',
            wrong_owner: '시작할 때의 계정과 달라요. 현재 계정으로 다시 시작해주세요.',
            invalid_payload: '화면과 서버 버전이 맞지 않아요. 최신 화면을 다시 불러와주세요.',
            invalid_position: '위치 정보를 확인할 수 없어요. 위치 권한을 확인하고 다시 시작해주세요.',
            save_failed: '완료 기록을 저장하지 못했어요. 이미 저장된 기록은 유지되며 잠시 후 다시 시도해주세요.',
            auth_unavailable: '인증 서버에 일시적으로 연결할 수 없어요. 잠시 후 다시 시도해주세요.',
            invalid_response: '서버에서 예상과 다른 응답이 왔어요. 최신 화면을 다시 불러와주세요.',
            network_error: '서버 연결이 끊겼어요. 연결 상태를 확인하고 다시 시도해주세요.',
            request_timeout: '서버 응답을 기다리다 중단됐어요. 잠시 후 다시 시도해주세요.',
            server_error: '서버에서 요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요.',
            cancelled: '요청을 중단했어요. 다시 시작해주세요.',
        };
        const code = Object.hasOwn(messages, error?.code) ? error.code : 'server_error';
        return { code, message: `${messages[code]} (${code})` };
    }
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
        let deadlineAt = 0;
        let locationIssue = null;
        let locationSample = null;
        let timing = null;
        let confirmedSampleCount = 0;
        function readTiming(state) {
            const keys = ['sampleEveryMs', 'locationTimeoutMs', 'initialTimeoutMs', 'networkReserveMs', 'maxGapMs'];
            const value = Object.fromEntries(keys.map(key => [key, state?.[key]]));
            if (value.sampleEveryMs !== 3000 || value.initialTimeoutMs !== 30000 ||
                !keys.every(key => Number.isSafeInteger(value[key])) ||
                value.locationTimeoutMs < 6000 || value.locationTimeoutMs > 20000 ||
                value.networkReserveMs < 2000 || value.networkReserveMs > 10000 ||
                value.maxGapMs < 12000 || value.maxGapMs > 40000 ||
                value.sampleEveryMs + value.locationTimeoutMs + value.networkReserveMs >= value.maxGapMs ||
                value.locationTimeoutMs + value.networkReserveMs >= value.initialTimeoutMs ||
                (timing && keys.some(key => value[key] !== timing[key]))) {
                throw { code: 'invalid_response' };
            }
            return Object.freeze(value);
        }
        const current = run => active && generation === run;
        const emit = (phase, message, extra = {}) => onState({
            phase, message, active, elapsedMs: snapshot?.elapsedMs || 0,
            requiredMs: snapshot?.requiredMs || 60000,
            distanceM: snapshot?.distanceM ?? null, accuracyM: snapshot?.accuracyM ?? null,
            maxGapMs: snapshot?.maxGapMs ?? 0, sampleEveryMs: snapshot?.sampleEveryMs ?? 0,
            confirmedAt: lastConfirmedAt, locationPending: false,
            locationIssue: locationIssue && { ...locationIssue },
            locationSample: locationSample && { ...locationSample },
            ...(timing || {}), confirmedSampleCount,
            confirmationDeadlineAt: active && timing ? deadlineAt : null, ...extra,
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
        function stop(message = '체류를 중단하고 시간을 초기화했어요.', phase = 'stopped', errorCode = null) {
            generation++;
            active = false;
            clearTimers();
            controller?.abort();
            controller = null;
            discard(snapshot);
            snapshot = null;
            lastConfirmedAt = null;
            emit(phase, message, { errorCode });
        }
        function fail(message) { stop(message, 'error'); }
        function failRequest(error) {
            const failure = requestFailure(error);
            stop(failure.message, 'error', failure.code);
        }
        function deadlineExpired() {
            if (!snapshot) { failRequest({ code: 'request_timeout' }); return; }
            const initial = lastConfirmedAt === null;
            stop(initial
                ? '처음 위치를 30초 동안 서버에서 확인하지 못했어요. 위치 설정과 연결 상태를 확인한 뒤 다시 시작해주세요. (location_timeout)'
                : `새 위치 확인이 ${timing.maxGapMs / 1000}초 기한 안에 완료되지 않아 초기화했어요. 위치 설정과 연결 상태를 확인한 뒤 다시 시작해주세요. (location_gap)`,
            'error', initial ? 'location_timeout' : 'location_gap');
        }
        function armDeadline(run, milliseconds) {
            if (watchdog !== null) unschedule(watchdog);
            deadlineAt = now() + milliseconds;
            watchdog = schedule(() => {
                if (current(run)) deadlineExpired();
            }, milliseconds);
        }
        function retryLocation(run, code, message, sample = null) {
            if (!current(run)) return;
            if (now() >= deadlineAt) { deadlineExpired(); return; }
            locationIssue = { code, ...(sample || {}) };
            emit(lastConfirmedAt === null ? 'locating' : snapshot.phase,
                `${message} ${lastConfirmedAt === null ? '아직 체류 시간은 시작되지 않았어요.' : '확인된 시간은 유지해요.'}`,
                { locationPending: true });
            // No cached coordinate, new confirmation, or deadline extension on a retry.
            pollTimer = schedule(() => locate(run), 250);
        }
        async function submit(run, position, requestMs) {
            if (!current(run)) return;
            const timestamp = position?.timestamp;
            const age = wallNow() - timestamp;
            locationSample = { requestMs, fixAgeMs: Number.isFinite(timestamp) && Number.isFinite(age) ? Math.round(age) : null };
            if (!Number.isFinite(timestamp) || age < -1000 || age > 4000 || timestamp <= lastFixTimestamp) {
                const code = !Number.isFinite(timestamp) ? 'gps_invalid_timestamp'
                    : age < -1000 ? 'gps_clock' : age > 4000 ? 'gps_stale' : 'gps_duplicate';
                const messages = {
                    gps_invalid_timestamp: '기기에서 위치 측정 시각을 받지 못해 다시 확인 중이에요.',
                    gps_clock: '위치 측정 시각과 기기 시각이 맞지 않아 다시 확인 중이에요.',
                    gps_stale: '기기가 오래된 위치를 반환해 전송하지 않고 새 위치를 다시 확인 중이에요.',
                    gps_duplicate: '이전과 같은 위치 측정 시각이 반환되어 새 위치를 다시 확인 중이에요.',
                };
                retryLocation(run, code, messages[code], locationSample);
                return;
            }
            locationIssue = null;
            lastFixTimestamp = timestamp;
            const { latitude, longitude, accuracy } = position.coords || {};
            try {
                const sentAt = now();
                const next = await request(`/api/stays/${snapshot.id}/sample`, {
                    challenge: snapshot.challenge, latitude, longitude, accuracy,
                }, { signal: controller.signal });
                if (!current(run)) { discard(next); return; }
                if (now() >= deadlineAt) { discard(next); deadlineExpired(); return; }
                readTiming(next);
                snapshot = next;
                lastConfirmedAt = now();
                confirmedSampleCount++;
                if (next.phase === 'complete') {
                    active = false;
                    clearTimers();
                    const persisted = next.persisted === true;
                    const message = persisted
                        ? next.newlyFound
                            ? `체류 완료! 내가 찾은 스페이스에 추가했어요. 총 ${next.foundSpaceCount}곳이에요.`
                            : `이미 찾은 공간이에요. 중복으로 세지 않아요. 총 ${next.foundSpaceCount}곳이에요.`
                        : '1분 체류 테스트 완료! 방문 기록은 저장되지 않았어요.';
                    emit('complete', message, { persisted, newlyFound: next.newlyFound === true, foundSpaceCount: next.foundSpaceCount });
                    discard(snapshot);
                    snapshot = null;
                    return;
                }
                const messages = {
                    dwelling: next.reason === 'gap' ? '위치 확인 간격이 길어 처음부터 다시 측정해요.' : '반경 안에 있어요. 화면을 켜두고 머물러주세요.',
                    outside: `허용 반경${next.space?.radiusM ? ` ${next.space.radiusM}m` : ''} 밖이에요. 시간을 초기화했어요. 범위 안으로 돌아오면 다시 시작해요.`,
                    uncertain: '위치가 불확실해 시간을 초기화했어요. 정확도가 좋아지면 다시 시작해요.',
                };
                if (!Object.hasOwn(messages, next.phase)) throw new Error('invalid_response');
                // Count reply latency inside the continuity budget instead of restarting it.
                armDeadline(run, Math.max(0, sentAt + timing.maxGapMs - now()));
                emit(next.phase, messages[next.phase]);
                pollTimer = schedule(() => locate(run), timing.sampleEveryMs);
            } catch (error) {
                if (current(run)) failRequest(error);
            }
        }
        function locate(run) {
            if (!current(run)) return;
            if (now() >= deadlineAt) { deadlineExpired(); return; }
            const availableMs = deadlineAt - now() - timing.networkReserveMs;
            // Leave time for authentication, upload and reply; the unchanged deadline still runs.
            if (availableMs <= 0) return;
            const requestedAt = now();
            // A location attempt settles once, even if a broken provider delivers late callbacks.
            let settled = false;
            const accept = () => {
                if (settled || !current(run)) return false;
                settled = true;
                if (now() >= deadlineAt) { deadlineExpired(); return false; }
                return true;
            };
            try {
                geolocation.getCurrentPosition(position => { if (accept()) void submit(run, position, Math.max(0, Math.round(now() - requestedAt))); }, error => {
                    if (!accept()) return;
                    if (error?.code === 3) {
                        retryLocation(run, 'gps_timeout', lastConfirmedAt === null
                            ? '처음 위치 응답이 늦어 다시 확인 중이에요.'
                            : '위치 응답이 늦어 다시 확인 중이에요.',
                        { requestMs: Math.max(0, Math.round(now() - requestedAt)), fixAgeMs: null });
                        return;
                    }
                    const messages = {
                        1: '위치 권한이 거부되었어요. 사이트 설정에서 위치를 허용한 뒤 다시 시작해주세요.',
                        2: '위치를 찾을 수 없어 초기화했어요. GPS 신호가 잘 잡히는 안전한 곳에서 다시 시도해주세요.',
                    };
                    fail(messages[error?.code] || '위치 확인에 실패해 시간을 초기화했어요.');
                }, { enableHighAccuracy: true, maximumAge: 0,
                    timeout: Math.max(1, Math.min(timing.locationTimeoutMs, availableMs)) });
            } catch { fail('이 브라우저에서 위치를 확인할 수 없어요.'); }
        }
        async function start() {
            if (active) return;
            const run = ++generation;
            active = true;
            snapshot = null;
            lastConfirmedAt = null;
            lastFixTimestamp = -Infinity;
            locationIssue = locationSample = null;
            timing = null;
            confirmedSampleCount = 0;
            controller = new AbortController();
            emit('requesting', '위치 확인을 준비하고 있어요.');
            armDeadline(run, 30000);
            try {
                const next = await request('/api/stays', { spaceId }, { signal: controller.signal });
                if (!current(run)) { discard(next); return; }
                snapshot = next;
                timing = readTiming(next);
                armDeadline(run, timing.initialTimeoutMs);
                emit('locating', '위치 권한을 허용해주세요. 처음 위치를 찾는 중이에요.');
                locate(run);
            } catch (error) {
                if (current(run)) failRequest(error);
            }
        }
        return Object.freeze({ start, stop, isActive: () => active });
    }
    return Object.freeze({ createVisitSession });
});
