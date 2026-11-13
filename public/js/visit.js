(() => {
    const status = document.getElementById('visit-status');
    if (!status) return;
    const element = id => document.getElementById(id);
    const start = element('visit-start'), finish = element('visit-finish'), stop = element('visit-stop');
    const timer = element('visit-timer'), progress = element('visit-progress');
    const freshness = element('visit-freshness'), diagnostics = element('visit-diagnostics');
    const login = element('visit-login'), reload = element('visit-reload'), build = element('visit-build');
    const consent = element('visit-consent'), consentBox = element('visit-consent-box');
    const CONSENT_KEY = 'spacecycle-location-consent-v1';
    try { if (consent && window.localStorage?.getItem(CONSENT_KEY)) consent.checked = true; } catch {}
    // Location is requested only after the user agrees on this screen (see /privacy#location).
    const consented = () => !consent || consent.checked === true;
    const auth = () => window.SpaceCycleAuth;
    const user = () => auth()?.getUser();
    const data = window.SpaceCycleSpaces, policy = window.SpaceCycleQrPolicy;
    const engine = window.SpaceCycleVisit, transport = window.SpaceCycleVisitRequest, clock = window.SpaceCycleVisitClock;
    const selection = policy?.readSelection(location.search);
    const place = selection?.valid && data?.getSpace(selection.spaceId);
    if (!place?.enabled || !engine || !transport || !clock || !finish) {
        element('visit-name').textContent = place?.name || '공간을 확인할 수 없어요';
        status.textContent = '이 공간은 아직 체류 확인을 제공하지 않아요. 공간 목록에서 다시 선택해주세요.';
        return;
    }
    element('visit-name').textContent = place.name;
    element('visit-back').href = `/spaces?space=${place.id}`;
    login.href = `/login?next=${encodeURIComponent(`/visit?space=${place.id}`)}`;
    const canLocate = () => window.isSecureContext && Boolean(navigator.geolocation);
    const online = () => navigator.onLine !== false;
    const visible = () => !document.hidden;
    const release = document.querySelector('meta[name="spacecycle-release"]')?.content || 'unknown';
    const locationCodes = new Set(['gps_stale', 'gps_duplicate', 'gps_clock', 'gps_invalid_timestamp',
        'gps_timeout', 'gps_denied', 'gps_unavailable', 'gps_coarse']);
    const refreshed = new Set();
    let session = null, runOwner = null, observedUser = null, uiGeneration = 0;
    let latest = null, paintTimer = null;
    const request = transport.createVisitRequest({ getAuth: auth, getOwner: () => runOwner });
    const formatTime = milliseconds => {
        const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    function stopPainting() {
        if (paintTimer !== null) clearInterval(paintTimer);
        paintTimer = null;
    }
    function paintDiagnostics(state) {
        const issue = locationCodes.has(state.locationIssue?.code) ? state.locationIssue : null;
        const sample = issue || state.locationSample;
        const parts = [];
        if (Number.isFinite(sample?.requestMs)) parts.push(`위치 응답 대기 ${(Math.max(0, sample.requestMs) / 1000).toFixed(1)}초`);
        if (Number.isFinite(sample?.fixAgeMs)) parts.push(`측정값 나이 ${(sample.fixAgeMs / 1000).toFixed(1)}초`);
        parts.push('위치 획득 시도 최대 15초 · 전체 최대 30초');
        if (issue) parts.push(issue.code);
        if (diagnostics) { diagnostics.textContent = parts.join(' · '); diagnostics.hidden = false; }
        status.dataset.locationCode = issue?.code || '';
        build.textContent = [`화면 버전 ${release}`, state.errorCode, issue?.code].filter(Boolean).join(' · ');
    }
    function paint() {
        if (!latest) return;
        const display = clock.getDisplayTime(latest, performance.now());
        timer.textContent = formatTime(display.remainingMs);
        progress.max = latest.requiredMs; progress.value = display.elapsedMs;
        const hasWait = ['waiting', 'ready'].includes(latest.phase);
        const ready = auth()?.isReady && Boolean(user()) && user()?.uid === runOwner;
        const enabled = ready && visible() && online() && !latest.busy && !latest.suspended;
        start.disabled = !enabled || latest.active || !canLocate() || !consented();
        if (consentBox) consentBox.hidden = consented() && (hasWait || latest.phase === 'complete');
        start.hidden = hasWait || latest.phase === 'complete';
        start.textContent = latest.busy ? '위치 확인 중' : '위치 확인하고 시작';
        finish.hidden = !hasWait;
        finish.disabled = !enabled || !display.awaitingFinal || !canLocate() || !consented();
        finish.textContent = latest.busy ? '마지막 위치 확인 중…' : latest.errorCode ? '마지막 위치 다시 확인' : '마지막 위치 확인';
        stop.hidden = !latest.active && latest.phase !== 'complete';
        stop.disabled = !ready || !online() || latest.cancelling || latest.suspended;
        stop.textContent = latest.phase === 'complete' ? '진행 닫기 (저장 기록 유지)' : '진행 취소';
        let message = latest.message;
        if (display.stale) message = '진행 유효기간이 끝났어요. 최신 화면에서 계정의 진행을 다시 확인해주세요.';
        else if (hasWait && display.awaitingFinal && !latest.busy && !latest.errorCode && !latest.suspended) {
            message = '대기 시간이 지났어요. 마지막 위치 확인 버튼을 눌러주세요. 아직 완료·저장 전이에요.';
        }
        if (!consented() && latest.phase !== 'complete' && !latest.busy) message = hasWait ? '위치 정보 이용에 동의하면 마지막 위치를 확인할 수 있어요.' : '위치 정보 이용에 동의하면 시작할 수 있어요.';
        if (!canLocate() && latest.phase !== 'complete') message = '진행 상황은 불러왔어요. 시작·종료 위치는 Safari 또는 Chrome에서 HTTPS 주소를 열어 확인해주세요.';
        status.textContent = message;
        status.dataset.displayPhase = display.stale ? 'expired' : display.awaitingFinal ? 'ready' : latest.phase;
        reload.hidden = !latest.errorCode && !display.stale;
        if (latest.phase === 'complete' && latest.persisted) freshness.textContent = '서버에서 시작·종료 위치와 대기 시간을 확인하고 기록을 저장했어요.';
        else if (hasWait) freshness.textContent = `${latest.suspended ? '화면 확인은 잠시 멈췄어요. ' : ''}남은 시간은 서버 응답 기준 예상 표시예요. 진행은 시작 후 최대 2시간 유지돼요.`;
        else freshness.textContent = '시작·종료 버튼을 누를 때만 위치를 확인해요. 중간에는 GPS를 요청하지 않아요.';
    }
    function receive(state, owner, run) {
        if (uiGeneration !== run || runOwner !== owner || user()?.uid !== owner) return;
        latest = state;
        status.dataset.phase = state.phase; status.dataset.errorCode = state.errorCode || '';
        element('visit-condition').textContent = `${place.area || place.name} · 테스트 장소\n반경 ${place.radiusM}m·정확도 ${place.maxAccuracyM}m 이하로 시작 위치와 종료 위치, 서버 기준 ${state.requiredMs / 1000}초 대기 시간을 확인해요.`;
        element('visit-distance').textContent = state.distanceM === null ? '—' : `${Math.round(state.distanceM)}m`;
        element('visit-accuracy').textContent = state.accuracyM === null ? '—' : `±${Math.round(state.accuracyM)}m`;
        paintDiagnostics(state);
        if (state.active && !state.suspended && visible() && paintTimer === null) paintTimer = setInterval(paint, 250);
        else if (!state.active || state.suspended || !visible()) stopPainting();
        paint();
        const key = `${owner}:${state.id}`;
        if (state.phase === 'complete' && state.persisted === true && Number.isSafeInteger(state.foundSpaceCount) &&
            !refreshed.has(key) && user()?.uid === owner) {
            refreshed.add(key);
            void auth().refreshFoundSpaces().catch(() => {});
        }
    }
    function syncAuth() {
        const currentUser = user()?.uid || null;
        const ready = auth()?.isReady === true;
        if (currentUser !== observedUser || (!ready && runOwner)) {
            uiGeneration++; runOwner = null; session?.suspend(); session = null; latest = null; stopPainting();
            observedUser = currentUser;
            timer.textContent = formatTime(place.requiredMs); progress.value = 0;
            element('visit-distance').textContent = element('visit-accuracy').textContent = '—';
        }
        login.hidden = !ready || Boolean(currentUser);
        if (!ready || !currentUser) {
            start.disabled = true; start.hidden = false; finish.hidden = stop.hidden = true;
            status.dataset.phase = ready ? 'login-required' : 'auth-loading'; status.dataset.errorCode = '';
            status.textContent = ready ? '공간을 계정에 저장하려면 먼저 Google로 로그인해주세요.' : '로그인 상태를 확인하는 중이에요.';
            return;
        }
        if (!session) {
            const run = ++uiGeneration; runOwner = currentUser;
            session = engine.createVisitSession({ spaceId: place.id, geolocation: navigator.geolocation, request,
                targetAccuracyM: place.maxAccuracyM,
                onState: state => receive(state, currentUser, run) });
            if (visible() && online()) void session.restore();
        } else paint();
    }
    build.textContent = `화면 버전 ${release}`;
    reload.addEventListener('click', () => location.reload());
    window.addEventListener('spacecycle:authchange', syncAuth);
    syncAuth();
    const authDeadline = setTimeout(() => {
        if (!auth()?.isReady) {
            status.textContent = '로그인 기능을 불러오지 못했어요. 연결 상태를 확인하고 새로고침해주세요.';
            status.dataset.phase = 'auth-error';
        }
    }, 12000);
    const explicit = action => {
        if (visible() && online() && auth()?.isReady && user()?.uid === runOwner && session) void session[action]();
    };
    consent?.addEventListener('change', () => {
        try {
            if (consent.checked) window.localStorage?.setItem(CONSENT_KEY, new Date().toISOString());
            else window.localStorage?.removeItem(CONSENT_KEY);
        } catch {}
        paint();
    });
    start.addEventListener('click', () => { if (consented()) explicit('start'); });
    finish.addEventListener('click', () => { if (consented()) explicit('finish'); });
    stop.addEventListener('click', () => explicit('stop'));
    const suspend = () => { session?.suspend(); stopPainting(); };
    const restore = () => { if (visible() && online() && user()?.uid === runOwner) void session?.restore(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else restore(); });
    window.addEventListener('pagehide', () => { clearTimeout(authDeadline); suspend(); });
    window.addEventListener('pageshow', event => { if (event.persisted) restore(); });
    window.addEventListener('offline', suspend);
    window.addEventListener('online', restore);
})();
