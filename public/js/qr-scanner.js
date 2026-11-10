(() => {
    const video = document.getElementById('qr-video');
    if (!video) return;
    const start = document.getElementById('camera-start');
    const stop = document.getElementById('camera-stop');
    const status = document.getElementById('scan-status');
    const stage = document.getElementById('camera-stage');
    const idle = document.getElementById('camera-idle');
    const result = document.getElementById('scan-result');
    const title = document.getElementById('result-title');
    const description = document.getElementById('result-description');
    const link = document.getElementById('result-link');
    const policy = window.SpaceCycleQrPolicy;
    const camera = window.SpaceCycleCamera;

    if (!policy || !camera || typeof window.jsQR !== 'function') {
        status.textContent = 'QR 스캐너를 불러오지 못했어요. 새로고침하거나 기본 카메라를 이용해주세요.';
        return;
    }
    const selection = policy.readSelection(window.location.search);
    if (!selection.valid) {
        status.textContent = '선택한 공간 주소가 올바르지 않아요. 공간 목록에서 다시 선택해주세요.';
        return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        status.textContent = '카메라는 HTTPS 연결에서 사용할 수 있어요. HTTPS 주소를 Safari 또는 Chrome에서 열어주세요.';
        return;
    }
    if (selection.spaceId) {
        document.getElementById('scan-context').hidden = false;
        document.getElementById('selected-space').textContent = policy.spaceLabel(selection.spaceId);
        document.querySelector('#scan-context .status-pill').textContent = window.SpaceCycleSpaces.getSpace(selection.spaceId).enabled ? '체류 테스트' : '등록 예정';
        document.getElementById('scanner-back').href = `/spaces?space=${selection.spaceId}`;
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        status.textContent = '이 브라우저에서 영상을 처리할 수 없어요. 기본 카메라를 이용해주세요.';
        return;
    }

    function readCode() {
        if (!video.videoHeight) return null;
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        return window.jsQR(pixels.data, width, height, { inversionAttempts: 'attemptBoth' })?.data || null;
    }

    const session = camera.createCameraSession({
        video, mediaDevices: navigator.mediaDevices, readCode,
        onState: state => {
            const active = state.phase === 'scanning';
            const requesting = state.phase === 'requesting';
            status.textContent = state.message;
            status.dataset.phase = state.phase;
            stage.dataset.active = String(active);
            video.hidden = !active;
            idle.hidden = active;
            start.disabled = active || requesting;
            stop.hidden = !(active || requesting);
            stop.textContent = requesting ? '권한 요청 취소' : '카메라 끄기';
        },
        onCode: value => {
            const decoded = policy.interpretQr(value, selection.spaceId, window.location.origin);
            result.dataset.result = decoded.status;
            result.hidden = false;
            stage.hidden = true;
            link.hidden = true;
            link.href = '/spaces';
            if (decoded.status === 'matched') {
                title.textContent = '공간 QR을 읽었어요';
                const configured = window.SpaceCycleSpaces.getSpace(decoded.spaceId).enabled;
                description.textContent = configured
                    ? `${policy.spaceLabel(decoded.spaceId)}의 QR이에요. 다음 화면에서 위치 권한을 허용하고 반경 100m 안에서 1분 동안 머물러보세요. 보상은 아직 저장하지 않아요.`
                    : `${policy.spaceLabel(decoded.spaceId)}의 링크예요. 아직 등록 예정인 공간이므로 방문 인증이나 보상은 진행되지 않아요.`;
                link.textContent = configured ? '위치·체류 테스트로 이동' : '공간 정보 보기';
                link.href = decoded.path;
                link.hidden = false;
            } else if (decoded.status === 'mismatch') {
                title.textContent = '선택한 공간과 다른 QR이에요';
                description.textContent = `${policy.spaceLabel(selection.spaceId)}를 선택했는데 ${policy.spaceLabel(decoded.spaceId)}의 QR이 읽혔어요. 해당 장소의 QR을 다시 비춰주세요.`;
            } else {
                title.textContent = 'Space Cycle 공간 QR이 아니에요';
                description.textContent = '알 수 없는 주소나 외부 사이트는 열지 않아요. 이 서비스의 장소별 QR인지 확인해주세요.';
            }
            start.textContent = '다시 스캔하기';
            title.focus({ preventScroll: true });
        },
    });

    start.disabled = false;
    status.dataset.phase = 'idle';
    status.textContent = '아래 버튼을 누르면 카메라 권한을 요청해요.';
    start.addEventListener('click', () => {
        result.hidden = true;
        result.dataset.result = '';
        stage.hidden = false;
        link.hidden = true;
        session.start();
    });
    stop.addEventListener('click', () => session.stop());
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) session.stop('다른 화면으로 이동해 카메라를 껐어요. 다시 시작하려면 버튼을 눌러주세요.');
    });
    window.addEventListener('pagehide', () => session.stop());
    // Also close immediately for in-page navigation, before the next document loads.
    document.addEventListener('click', event => {
        if (event.target.closest?.('a[href]')) session.stop();
    });
})();
