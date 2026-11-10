/* Start/finish verification. Only the server can approve and persist a visit. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleVisit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const messages = Object.freeze({
        login_required: '로그인 상태를 확인해주세요. 로그아웃 후 다시 로그인해주세요.',
        invalid_token: '로그인이 만료되었어요. 로그아웃 후 다시 로그인해주세요.',
        identity_changed: '계정이 바뀌었어요. 현재 계정의 진행을 다시 확인해주세요.',
        wrong_owner: '시작한 계정과 달라요. 현재 계정의 진행을 확인해주세요.',
        origin_denied: '접속 주소가 허용되지 않았어요. https://spacecycle.space에서 다시 열어주세요.',
        edge_blocked: '사이트 보안 확인이 요청을 막았어요. 최신 화면을 다시 불러와주세요.',
        capacity: '진행 중인 요청이 많아요. 잠시 후 다시 확인해주세요.',
        rate_limited: '요청이 너무 많아요. 잠시 후 다시 확인해주세요.',
        not_configured: '이 공간은 아직 이용할 수 없어요. 공간 목록에서 다시 선택해주세요.',
        session_missing: '진행이 없거나 만료되었어요. 다시 시작해주세요.',
        expired: '진행이 만료되었어요. 다시 시작해주세요.',
        stale_challenge: '체류 요청 순서가 맞지 않아요. 진행 상황을 다시 불러와주세요.',
        start_cancelled: '취소한 시작 요청이에요. 새로 시작해주세요.',
        invalid_payload: '화면과 서버 버전이 맞지 않아요. 최신 화면을 다시 불러와주세요.',
        invalid_position: '위치 정보를 확인할 수 없어요. 새 위치로 다시 확인해주세요.',
        outside: '허용 반경 밖이에요. 범위 안에서 다시 확인해주세요.',
        uncertain: '위치 정확도가 부족해요. 신호가 잘 잡히는 안전한 곳에서 다시 확인해주세요.',
        too_early: '서버 기준 대기 시간이 아직 남아 있어요. 잠시 후 마지막 위치를 다시 확인해주세요.',
        save_failed: '완료 기록이 저장되지 않았어요. 잠시 후 다시 확인해주세요.',
        auth_unavailable: '인증 서버에 일시적으로 연결할 수 없어요. 잠시 후 다시 확인해주세요.',
        invalid_response: '서버에서 예상과 다른 응답이 왔어요. 진행을 다시 확인해주세요.',
        network_error: '서버 연결이 끊겼어요. 연결 후 다시 확인해주세요.',
        request_timeout: '서버 응답을 기다리다 중단됐어요. 진행을 다시 확인해주세요.',
        server_error: '서버에서 요청을 처리하지 못했어요. 잠시 후 다시 확인해주세요.',
        cancelled: '이 화면의 요청을 중단했어요. 계정의 진행은 다시 불러올 수 있어요.',
        gps_denied: '위치 권한이 거부되었어요. 사이트 설정에서 위치를 허용한 뒤 다시 확인해주세요.',
        gps_unavailable: '위치를 찾을 수 없어요. 신호가 잘 잡히는 안전한 곳에서 다시 확인해주세요.',
        gps_timeout: '위치 응답이 늦어요. 다시 확인해주세요.',
        location_timeout: '30초 동안 새 위치를 확인하지 못했어요. 다시 확인해주세요.',
        gps_stale: '오래된 측정값은 보내지 않고 새 위치를 다시 확인해요.',
        gps_duplicate: '이전과 같은 측정 시각은 보내지 않고 새 위치를 다시 확인해요.',
        gps_clock: '위치 측정 시각이 기기 시각과 맞지 않아 다시 확인해요.',
        gps_invalid_timestamp: '위치 측정 시각이 없어 다시 확인해요.',
    });
    function createVisitSession({ spaceId, geolocation, request, onState,
        now = () => performance.now(), wallNow = () => Date.now(),
        createAttemptId = () => {
            const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes);
            return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        },
        schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id) }) {
        let generation = 0, active = false, snapshot = null, controller = null;
        let confirmedAt = null, phase = 'idle', message = '', busy = false, requiredMs = 60000;
        let lastFixTimestamp = -Infinity, errorCode = null;
        let locationIssue = null, locationSample = null, locationPending = false;
        let acquisitionDeadline = 0, suspended = false, createUncertain = false, cancelling = false;
        let attemptId = null, abandonPending = false;
        const timers = new Set();
        function later(fn, milliseconds) {
            const timer = schedule(() => { timers.delete(timer); fn(); }, milliseconds);
            timers.add(timer); return timer;
        }
        function clearTimers() { for (const timer of timers) unschedule(timer); timers.clear(); }
        function clearTimer(timer) { unschedule(timer); timers.delete(timer); }
        function send(route, body) {
            const local = controller = new AbortController();
            return new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn, value) => {
                    if (settled) return;
                    settled = true; clearTimer(timer); local.signal.removeEventListener('abort', aborted); fn(value);
                };
                const aborted = () => settle(reject, { code: 'cancelled' });
                const timer = later(() => { settle(reject, { code: 'request_timeout' }); local.abort(); }, 15000);
                local.signal.addEventListener('abort', aborted, { once: true });
                Promise.resolve().then(() => {
                    if (local.signal.aborted) throw { code: 'cancelled' };
                    return request(route, body, { signal: local.signal });
                }).then(value => settle(resolve, value), error => settle(reject, error));
            });
        }
        function validate(next, allowIdle = false) {
            const invalid = () => { throw { code: 'invalid_response' }; };
            const bounded = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
            if (!next || typeof next !== 'object' || Array.isArray(next) || next.mode !== 'start_finish' ||
                next.spaceId !== spaceId || !Number.isSafeInteger(next.requiredMs) || !bounded(next.requiredMs, 1, 7200000) ||
                next.locationTimeoutMs !== 15000 || next.initialTimeoutMs !== 30000) invalid();
            const keys = ['mode', 'phase', 'spaceId', 'requiredMs', 'locationTimeoutMs', 'initialTimeoutMs'];
            if (allowIdle && next.phase === 'idle') {
                if (Object.keys(next).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(next, key))) invalid();
                return next;
            }
            keys.push('id', 'challenge', 'elapsedMs', 'expiresInMs', 'distanceM', 'accuracyM', 'persisted', 'newlyFound');
            if (next.phase === 'complete') keys.push('foundSpaceCount');
            if (Object.keys(next).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(next, key)) ||
                typeof next.id !== 'string' || typeof next.challenge !== 'string' ||
                !/^[a-f0-9]{48}$/.test(next.id) || !/^[a-f0-9]{48}$/.test(next.challenge) ||
                !['waiting', 'ready', 'complete'].includes(next.phase) ||
                !bounded(next.elapsedMs, 0, next.requiredMs) || !bounded(next.expiresInMs, Number.MIN_VALUE, 7200000) ||
                ![next.distanceM, next.accuracyM].every(value => value === null || bounded(value, 0, Number.MAX_SAFE_INTEGER)) ||
                typeof next.persisted !== 'boolean' || typeof next.newlyFound !== 'boolean' ||
                (next.phase !== 'complete' && (next.persisted || next.newlyFound)) ||
                (next.phase === 'waiting' && next.elapsedMs >= next.requiredMs) ||
                (next.phase !== 'waiting' && next.elapsedMs !== next.requiredMs) ||
                (next.phase === 'complete' && (!Number.isSafeInteger(next.foundSpaceCount) || next.foundSpaceCount < 0 ||
                    (next.persisted && next.foundSpaceCount < 1) || (!next.persisted && next.newlyFound)))) invalid();
            return next;
        }
        function getState() {
            return { mode: 'start_finish', phase, message, active, busy, errorCode, locationPending, suspended, cancelling,
                locationIssue: locationIssue && { ...locationIssue }, locationSample: locationSample && { ...locationSample },
                id: snapshot?.id, elapsedMs: snapshot?.elapsedMs ?? 0, requiredMs,
                confirmedAt, expiresInMs: snapshot?.expiresInMs ?? null,
                persisted: snapshot?.persisted === true, newlyFound: snapshot?.newlyFound === true,
                foundSpaceCount: snapshot?.foundSpaceCount,
                distanceM: snapshot?.distanceM ?? null, accuracyM: snapshot?.accuracyM ?? null,
                locationTimeoutMs: 15000, initialTimeoutMs: 30000 };
        }
        function emit(nextPhase, nextMessage) { phase = nextPhase; message = nextMessage; onState(getState()); }
        const current = run => run === generation;
        function failRequest(error) {
            clearTimers(); locationPending = false;
            errorCode = Object.hasOwn(messages, error?.code) ? error.code : 'server_error';
            busy = false; cancelling = false;
            if (['session_missing', 'expired'].includes(errorCode)) { snapshot = null; confirmedAt = null; }
            active = createUncertain || abandonPending || (Boolean(snapshot) && snapshot.phase !== 'complete');
            if (abandonPending) {
                emit('error', `진행 취소 확인필요. ${messages[errorCode]} 취소를 다시 확인해주세요. (${errorCode})`);
                return;
            }
            if (createUncertain && !snapshot) {
                emit('error', `시작 요청 상태 확인필요. ${messages[errorCode]} 진행 또는 취소를 다시 확인해주세요. (${errorCode})`);
                return;
            }
            emit(snapshot?.phase || 'error', `${messages[errorCode]}${active ? ' 기다린 진행은 유지해요.' : ''} (${errorCode})`);
        }
        function accept(next, allowIdle = false) {
            validate(next, allowIdle);
            // A read overtaking the original start is not evidence that it cannot commit later.
            if (next.phase === 'idle' && createUncertain) { failRequest({ code: 'network_error' }); return; }
            errorCode = null; cancelling = false;
            if (next.phase === 'complete' && !next.persisted) {
                busy = false; active = Boolean(snapshot); errorCode = 'save_failed';
                emit(snapshot?.phase || 'error', '완료 기록이 저장되지 않았어요. 진행은 유지해요. 잠시 후 다시 확인해주세요. (save_failed)');
                return;
            }
            requiredMs = next.requiredMs;
            snapshot = next.phase === 'idle' ? null : { ...next };
            confirmedAt = snapshot ? now() : null; active = Boolean(snapshot) && next.phase !== 'complete'; busy = false;
            emit(next.phase, next.phase === 'complete'
                ? next.newlyFound ? `체류 완료! 내가 찾은 스페이스에 추가했어요. 총 ${next.foundSpaceCount}곳이에요.`
                    : `이미 찾은 공간이에요. 중복으로 세지 않아요. 총 ${next.foundSpaceCount}곳이에요.`
                : next.phase === 'idle' ? '버튼을 누르면 시작 위치를 확인해요.'
                    : '시작 위치를 확인했어요. 기다린 뒤 마지막 위치를 확인해주세요.');
        }
        async function submit(run, position) {
            if (!current(run)) return;
            lastFixTimestamp = position.timestamp;
            const { latitude, longitude, accuracy } = position.coords;
            createUncertain = true;
            emit('requesting', '시작 위치를 서버에서 확인하고 있어요.');
            try {
                const next = await send('/api/stays', { spaceId, latitude, longitude, accuracy, attemptId });
                if (current(run)) {
                    validate(next); createUncertain = false; attemptId = null; accept(next);
                }
            } catch (error) {
                if (!current(run)) return;
                if (['network_error', 'request_timeout'].includes(error?.code)) {
                    try {
                        const recovered = await send('/api/stays/resume', { spaceId });
                        if (current(run)) accept(recovered, true);
                    } catch (resumeError) { if (current(run)) failRequest(resumeError); }
                } else {
                    if (['outside', 'uncertain', 'invalid_position', 'invalid_payload', 'not_configured', 'start_cancelled', 'capacity', 'rate_limited'].includes(error?.code)) {
                        createUncertain = false; attemptId = null;
                    }
                    failRequest(error);
                }
            }
        }
        function locate(run, submitPosition) {
            if (!current(run) || !busy) return;
            const available = acquisitionDeadline - now();
            if (available <= 0) { failRequest({ code: 'location_timeout' }); return; }
            const requestedAt = now(), timeout = Math.min(15000, available);
            let settled = false, watchdog;
            locationPending = true;
            const settle = () => {
                if (settled || !current(run) || !busy) return false;
                settled = true; clearTimer(watchdog); return true;
            };
            function retry(code) {
                if (!current(run)) return;
                locationIssue = { code, ...locationSample };
                if (now() >= acquisitionDeadline) { failRequest({ code: 'location_timeout' }); return; }
                emit(snapshot?.phase || 'locating', `${messages[code]} (${code})`);
                later(() => locate(run, submitPosition), Math.min(250, acquisitionDeadline - now()));
            }
            function failed(error) {
                if (!settle()) return;
                locationSample = { requestMs: Math.max(0, Math.round(now() - requestedAt)), fixAgeMs: null };
                if (error?.code === 3) retry('gps_timeout');
                else failRequest({ code: error?.code === 1 ? 'gps_denied' : 'gps_unavailable' });
            }
            watchdog = later(() => failed({ code: 3 }), timeout);
            try {
                geolocation.getCurrentPosition(position => {
                    if (!settle()) return;
                    if (now() >= acquisitionDeadline) { failRequest({ code: 'location_timeout' }); return; }
                    const timestamp = position?.timestamp, age = wallNow() - timestamp;
                    locationSample = { requestMs: Math.max(0, Math.round(now() - requestedAt)),
                        fixAgeMs: Number.isFinite(timestamp) && Number.isFinite(age) ? Math.round(age) : null };
                    const code = !Number.isFinite(timestamp) ? 'gps_invalid_timestamp' : !Number.isFinite(age) || age < -1000 ? 'gps_clock'
                        : age > 4000 ? 'gps_stale' : timestamp <= lastFixTimestamp ? 'gps_duplicate' : null;
                    if (code) { retry(code); return; }
                    const coords = position?.coords;
                    if (!coords || !['latitude', 'longitude', 'accuracy'].every(key => Number.isFinite(coords[key])) ||
                        Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180 || coords.accuracy < 0) {
                        failRequest({ code: 'invalid_position' }); return;
                    }
                    lastFixTimestamp = timestamp; locationPending = false; locationIssue = null;
                    void submitPosition(position);
                }, failed, { enableHighAccuracy: true, maximumAge: 0, timeout });
            } catch { failed({ code: 2 }); }
        }
        function start() {
            if (active || busy) return;
            if (createUncertain || abandonPending) {
                emit('error', '이전 시작 또는 취소 여부 확인필요. 진행 취소를 다시 확인해주세요.'); return;
            }
            try {
                attemptId = createAttemptId();
                if (typeof attemptId !== 'string' || !/^[a-f0-9]{48}$/.test(attemptId)) throw Error('invalid_attempt');
            } catch { failRequest({ code: 'server_error' }); return; }
            const run = ++generation; active = busy = true; snapshot = null; confirmedAt = null;
            suspended = false; errorCode = null; locationIssue = locationSample = null;
            controller = new AbortController(); acquisitionDeadline = now() + 30000;
            emit('locating', '버튼을 눌러 시작한 위치 확인이에요. 위치 권한을 허용해주세요.');
            locate(run, position => submit(run, position));
        }
        function finish() {
            if (!snapshot || busy || !active) return;
            const run = ++generation; busy = true; controller = new AbortController(); acquisitionDeadline = now() + 30000;
            emit(snapshot.phase, '마지막 위치를 확인하고 있어요.');
            locate(run, async position => {
                if (!current(run)) return;
                lastFixTimestamp = position.timestamp;
                const { latitude, longitude, accuracy } = position.coords;
                try {
                    const next = await send(`/api/stays/${snapshot.id}/finish`, {
                        challenge: snapshot.challenge, latitude, longitude, accuracy,
                    });
                    if (current(run)) {
                        if (next?.id !== snapshot.id || next?.challenge !== snapshot.challenge || next?.requiredMs !== snapshot.requiredMs) {
                            throw { code: 'invalid_response' };
                        }
                        accept(next);
                    }
                } catch (error) {
                    if (current(run)) failRequest(error);
                }
            });
        }
        async function restore() {
            if (busy) return;
            if (abandonPending) {
                suspended = false;
                failRequest({ code: errorCode || 'network_error' });
                return;
            }
            const run = ++generation; busy = true; suspended = false; controller = new AbortController();
            emit(snapshot?.phase || 'restoring', '계정에 저장된 진행 상황을 확인하고 있어요.');
            try {
                const next = await send('/api/stays/resume', { spaceId });
                if (current(run)) accept(next, true);
            } catch (error) {
                if (current(run)) failRequest(error);
            }
        }
        async function stop() {
            if (cancelling) return;
            cancelling = true; suspended = false;
            const previous = snapshot;
            const run = ++generation; controller?.abort(); clearTimers(); locationPending = false;
            controller = new AbortController(); busy = true;
            function cleared() {
                snapshot = null; confirmedAt = null; active = busy = false; errorCode = null;
                createUncertain = cancelling = abandonPending = false; attemptId = null;
                emit('stopped', '진행을 취소했어요. 이미 저장한 방문 기록은 유지돼요.');
            }
            if (abandonPending || createUncertain) {
                abandonPending = true;
                emit('requesting', '시작 요청의 취소를 서버에 저장하고 있어요.');
                try {
                    const result = await send('/api/stays/abandon', { spaceId, attemptId });
                    if (!current(run)) return;
                    if (result !== null) throw { code: 'invalid_response' };
                    createUncertain = abandonPending = false; attemptId = null;
                } catch (error) { if (current(run)) failRequest(error); return; }
            }
            if (!previous) { cleared(); return; }
            emit(previous.phase, '진행 취소를 서버에서 확인하고 있어요.');
            try {
                const result = await send(`/api/stays/${previous.id}/cancel`, { challenge: previous.challenge });
                if (!current(run)) return;
                if (result !== null) throw { code: 'invalid_response' };
                cleared();
            } catch (error) {
                if (!current(run)) return;
                // A lost cancel response is not proof of cancellation. Read the account back first.
                try {
                    const next = await send('/api/stays/resume', { spaceId });
                    if (!current(run)) return;
                    validate(next, true);
                    if (next.phase === 'idle') cleared();
                    else accept(next);
                } catch (resumeError) { if (current(run)) failRequest(resumeError); }
            }
        }
        function suspend() {
            generation++; controller?.abort(); clearTimers();
            busy = cancelling = false; suspended = true; locationPending = false;
            active = createUncertain || abandonPending || (Boolean(snapshot) && snapshot.phase !== 'complete');
            emit(snapshot?.phase || 'idle', '이 화면의 위치 확인을 멈췄어요. 계정의 진행은 유지해요.');
        }
        return Object.freeze({ start, restore, finish, stop, suspend, detach: suspend, getState, isActive: () => active });
    }
    return Object.freeze({ createVisitSession });
});
