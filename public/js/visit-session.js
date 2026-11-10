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
                    outside: '반경 100m 밖이에요. 시간을 초기화했어요. 범위 안으로 돌아오면 다시 시작해요.',
                    uncertain: '위치가 불확실해 시간을 초기화했어요. 정확도가 좋아지면 다시 시작해요.',
                };
                if (!Object.hasOwn(messages, next.phase)) throw new Error('invalid_response');
                emit(next.phase, messages[next.phase]);
                armDeadline(run, next.maxGapMs);
                pollTimer = schedule(() => locate(run), next.sampleEveryMs);
            } catch (error) {
                if (current(run)) failRequest(error);
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
            } catch (error) {
                if (current(run)) failRequest(error);
            }
        }
        return Object.freeze({ start, stop, isActive: () => active });
    }
    return Object.freeze({ createVisitSession });
});
