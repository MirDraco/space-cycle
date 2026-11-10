(() => {
    const status = document.getElementById('visit-status');
    if (!status) return;
    const start = document.getElementById('visit-start');
    const stop = document.getElementById('visit-stop');
    const timer = document.getElementById('visit-timer');
    const progress = document.getElementById('visit-progress');
    const distance = document.getElementById('visit-distance');
    const accuracy = document.getElementById('visit-accuracy');
    const freshness = document.getElementById('visit-freshness');
    const login = document.getElementById('visit-login');
    const auth = () => window.SpaceCycleAuth;
    const user = () => auth()?.getUser();
    let runOwner = null;
    let observedUser = null;
    const data = window.SpaceCycleSpaces;
    const policy = window.SpaceCycleQrPolicy;
    const engine = window.SpaceCycleVisit;
    const selection = policy?.readSelection(location.search);
    const place = selection?.valid && data?.getSpace(selection.spaceId);
    if (!place?.enabled || !engine) {
        document.getElementById('visit-name').textContent = place?.name || '공간을 확인할 수 없어요';
        status.textContent = '이 공간은 아직 체류 테스트를 제공하지 않아요. 공간 목록에서 다시 선택해주세요.';
        return;
    }
    document.getElementById('visit-name').textContent = place.name;
    document.getElementById('visit-condition').textContent = `내부 공간 01 · 테스트 장소\n반경 ${place.radiusM}m 안에서 연속 ${place.requiredMs / 1000}초 동안 머물러주세요.`;
    document.getElementById('visit-back').href = `/spaces?space=${place.id}`;
    login.href = `/login?next=${encodeURIComponent(`/visit?space=${place.id}`)}`;
    if (!window.isSecureContext || !navigator.geolocation) {
        status.textContent = '위치는 HTTPS 연결에서 확인할 수 있어요. Safari 또는 Chrome에서 HTTPS 주소를 열어주세요.';
        return;
    }
    let latest = null;
    let paintTimer = null;
    const formatTime = milliseconds => {
        const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    function paint() {
        if (!latest) return;
        // Show confirmed server progress only; never predict completion with a local timer.
        timer.textContent = formatTime(latest.requiredMs - latest.elapsedMs);
        progress.max = latest.requiredMs;
        progress.value = latest.elapsedMs;
        if (latest.confirmedAt === null) freshness.textContent = '아직 위치를 확인하지 않았어요.';
        else if (latest.phase === 'complete') freshness.textContent = '서버에서 마지막 위치와 1분 체류를 확인했어요.';
        else freshness.textContent = `마지막 확인 ${Math.floor(Math.max(0, performance.now() - latest.confirmedAt) / 1000)}초 전 · 약 3초마다 갱신`;
    }
    async function request(route, body, options = {}) {
        const owner = runOwner;
        if (!owner || user()?.uid !== owner) throw new Error('login_required');
        const token = await auth().getToken();
        if (user()?.uid !== owner || options.signal?.aborted) throw new Error('identity_changed');
        const response = await fetch(route, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body), credentials: 'omit', cache: 'no-store',
            signal: options.signal, keepalive: options.keepalive === true,
        });
        if (!response.ok) throw new Error(`stay_http_${response.status}`);
        return response.status === 204 ? null : response.json();
    }
    const session = engine.createVisitSession({
        spaceId: place.id, geolocation: navigator.geolocation, request,
        onState: state => {
            latest = state;
            status.dataset.phase = state.phase;
            status.textContent = state.message;
            start.disabled = state.active || !auth()?.isReady || !user();
            stop.hidden = !state.active;
            start.textContent = state.active ? '체류 확인 중' : state.phase === 'complete' ? '다시 테스트하기' : '위치 확인하고 시작';
            distance.textContent = state.distanceM === null ? '—' : `${Math.round(state.distanceM)}m`;
            accuracy.textContent = state.accuracyM === null ? '—' : `±${Math.round(state.accuracyM)}m`;
            if (paintTimer !== null) clearInterval(paintTimer);
            paintTimer = state.active ? setInterval(paint, 1000) : null;
            paint();
            if (state.phase === 'complete' && state.persisted && user()?.uid === runOwner) {
                void auth().refreshFoundSpaces().catch(() => {});
            }
        },
    });
    function syncAuth() {
        const currentUser = user()?.uid || null;
        if (observedUser !== currentUser) {
            session.stop('계정 상태가 바뀌어 체류 시간을 초기화했어요.');
            observedUser = currentUser;
            runOwner = null;
        }
        const ready = auth()?.isReady === true;
        login.hidden = !ready || Boolean(currentUser);
        start.disabled = !ready || !currentUser || session.isActive();
        if (!ready) {
            status.dataset.phase = 'auth-loading';
            status.textContent = '로그인 상태를 확인하는 중이에요.';
        } else if (!currentUser) {
            status.dataset.phase = 'login-required';
            status.textContent = '공간을 계정에 저장하려면 먼저 Google로 로그인해주세요.';
        } else if (!session.isActive()) {
            status.dataset.phase = 'idle';
            status.textContent = '버튼을 누르면 위치 권한을 요청해요. 반경과 정확도가 확인되면 시간이 시작돼요.';
        }
    }
    window.addEventListener('spacecycle:authchange', syncAuth);
    syncAuth();
    const authDeadline = setTimeout(() => {
        if (!auth()?.isReady) {
            status.textContent = '로그인 기능을 불러오지 못했어요. 인터넷을 확인하고 새로고침해주세요.';
            status.dataset.phase = 'auth-error';
        }
    }, 12000);
    window.addEventListener('pagehide', () => clearTimeout(authDeadline));
    start.addEventListener('click', () => {
        if (!document.hidden && auth()?.isReady && user()) {
            runOwner = user().uid;
            void session.start();
        }
    });
    stop.addEventListener('click', () => session.stop());
    const interrupt = message => {
        if (session.isActive()) session.stop(message);
    };
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) interrupt('다른 화면으로 이동해 시간을 초기화했어요. 돌아오면 버튼을 눌러 다시 시작해주세요.');
    });
    window.addEventListener('pagehide', () => interrupt('페이지를 벗어나 시간을 초기화했어요.'));
    window.addEventListener('offline', () => interrupt('인터넷 연결이 끊겨 시간을 초기화했어요.'));
    document.addEventListener('click', event => {
        if (event.target.closest?.('a[href]')) interrupt('페이지를 벗어나 시간을 초기화했어요.');
    });
})();
