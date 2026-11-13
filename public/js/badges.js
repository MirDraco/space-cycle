/* Badge board: every badge starts grayscale; the account's verified completions turn it to color. */
(() => {
    const board = document.getElementById('badge-board');
    if (!board) return;
    const cards = [...board.querySelectorAll('[data-badge]')];
    const status = document.getElementById('badge-status');
    const progress = document.getElementById('badge-progress');
    const auth = () => window.SpaceCycleAuth;

    function render(found, message) {
        const earned = new Set(Array.isArray(found) ? found : []);
        let count = 0;
        for (const card of cards) {
            const id = card.dataset.badge, on = earned.has(id);
            if (on) count++;
            card.dataset.earned = String(on);
            const state = card.querySelector('.badge-state');
            if (state) state.textContent = on ? '획득' : '미획득';
            const image = card.querySelector('img');
            if (image) image.alt = `${card.dataset.name} 배지${on ? '' : ' (아직 획득 전)'}`;
        }
        if (progress) progress.textContent = Array.isArray(found) ? `${count} / ${cards.length}` : `– / ${cards.length}`;
        if (status) status.textContent = message ?? (count === cards.length
            ? '외부 공간 배지를 모두 모았어요!'
            : count ? `배지 ${count}개를 모았어요. 남은 공간도 다녀와 보세요.`
                : '아직 모은 배지가 없어요. 외부 공간에서 체류를 완료하면 컬러로 바뀌어요.');
    }

    function sync() {
        const api = auth();
        if (!api?.isReady) { render(null, '로그인 상태를 확인하는 중이에요.'); return; }
        if (!api.getUser()) { render(null, '로그인하면 내가 다녀온 공간의 배지를 컬러로 볼 수 있어요.'); return; }
        if (Array.isArray(api.foundSpaces)) render(api.foundSpaces);
        else render(null, '모은 배지를 불러오고 있어요.');
    }

    window.addEventListener('spacecycle:authchange', sync);
    window.addEventListener('spacecycle:spaceschange', event => {
        if (auth()?.getUser()) render(event.detail?.foundSpaces);
    });
    window.addEventListener('spacecycle:spaceserror', () => {
        if (auth()?.getUser()) render(null, '모은 배지를 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요.');
    });
    sync();
})();
