/* Camera lifecycle is separate from UI/decoder to make cancellation testable. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleCamera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function cameraMessage(error) {
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
            return '카메라 권한이 허용되지 않았어요. 브라우저의 사이트 설정에서 카메라를 허용한 뒤 다시 시도해주세요.';
        }
        if (error?.name === 'NotFoundError') return '사용할 카메라를 찾지 못했어요. 카메라가 있는 휴대폰에서 열어주세요.';
        if (error?.name === 'NotReadableError') return '카메라를 사용할 수 없어요. 다른 앱의 카메라를 닫고 다시 시도해주세요.';
        return '카메라를 시작하지 못했어요. 브라우저를 확인하고 다시 시도해주세요.';
    }

    function createCameraSession({ video, mediaDevices, readCode, onState, onCode, setTimer = setTimeout, clearTimer = clearTimeout }) {
        let generation = 0;
        let phase = 'idle';
        let stream = null;
        let frameTimer = null;
        let requestTimer = null;
        const emit = (next, message) => { phase = next; onState({ phase: next, message }); };
        const releaseTracks = source => source?.getTracks().forEach(track => track.stop());

        function release() {
            generation++;
            if (frameTimer !== null) clearTimer(frameTimer);
            if (requestTimer !== null) clearTimer(requestTimer);
            frameTimer = requestTimer = null;
            const previous = stream;
            stream = null;
            video.pause();
            video.srcObject = null;
            releaseTracks(previous);
        }

        function stop(message = '카메라를 껐어요. 다시 스캔하려면 버튼을 눌러주세요.') {
            release();
            emit('stopped', message);
        }

        function fail(message) {
            release();
            emit('error', message);
        }

        function scheduleFrame(token) {
            frameTimer = setTimer(() => {
                frameTimer = null;
                if (token !== generation || phase !== 'scanning') return;
                let code = null;
                try {
                    if (video.readyState >= 2 && video.videoWidth > 0) code = readCode(video);
                } catch {
                    fail('QR을 읽는 중 문제가 생겼어요. 카메라를 다시 켜주세요.');
                    return;
                }
                if (typeof code === 'string' && code.length) {
                    stop('QR을 읽어 카메라를 껐어요.');
                    onCode(code);
                } else scheduleFrame(token);
            }, 125);
        }

        async function start() {
            if (phase === 'requesting' || phase === 'scanning') return;
            if (!mediaDevices?.getUserMedia) {
                fail('이 브라우저에서는 카메라를 사용할 수 없어요. HTTPS 주소를 Safari 또는 Chrome에서 열어주세요.');
                return;
            }
            const token = ++generation;
            emit('requesting', '카메라 권한을 확인하고 있어요. 브라우저의 허용 버튼을 눌러주세요.');
            requestTimer = setTimer(() => {
                if (token === generation) fail('카메라 응답을 기다리다 중단했어요. 권한을 확인한 뒤 다시 시도해주세요.');
            }, 30000);
            let acquired;
            try {
                acquired = await mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                });
                if (token !== generation) { releaseTracks(acquired); return; }
                stream = acquired;
                video.srcObject = acquired;
                for (const track of acquired.getVideoTracks()) {
                    track.addEventListener('ended', () => {
                        if (token === generation) stop('카메라 연결이 종료됐어요. 다시 시작해주세요.');
                    });
                }
                await video.play();
                if (token !== generation) { releaseTracks(acquired); return; }
                clearTimer(requestTimer);
                requestTimer = null;
                emit('scanning', 'QR 전체가 화면 안에 들어오도록 비춰주세요.');
                scheduleFrame(token);
            } catch (error) {
                if (token !== generation) { releaseTracks(acquired); return; }
                fail(cameraMessage(error));
            }
        }

        return Object.freeze({ start, stop });
    }
    return Object.freeze({ createCameraSession, cameraMessage });
});
