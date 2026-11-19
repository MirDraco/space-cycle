/* Public place configuration. Exact test coordinates supplied by the project owner. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleSpaces = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    // Enabled places. Coordinates are supplied by the project owner; requiredMs is the test wait.
    // A fix counts when its distance to the center is <= radiusM and its reported accuracy is
    // <= maxAccuracyM. Each check applies to the selected place only.
    const configured = {
        'indoor-01': { name: '김승우 라운지', area: '유리벽 쉼터',
            latitude: 36.77282799161019, longitude: 126.93329938074858, radiusM: 75, requiredMs: 60000, maxAccuracyM: 50,
            photo: '/images/spaces/in01.jpg' },
        'indoor-02': { name: '오월 라운지', area: '통유리 라운지',
            latitude: 36.77145784931604, longitude: 126.93251089396017, radiusM: 75, requiredMs: 60000, maxAccuracyM: 50,
            photo: '/images/spaces/in02.jpg' },
        'indoor-03': { name: '학생 회관 2층', area: '계단 옆 쉼터',
            latitude: 36.76998389914673, longitude: 126.93142010481328, radiusM: 75, requiredMs: 60000, maxAccuracyM: 50,
            photo: '/images/spaces/in03.jpg' },
        'indoor-04': { name: '공학관 편의점 옆 휴게공간', area: '공학관 편의점 옆',
            latitude: 36.769281474235655, longitude: 126.932199181013, radiusM: 75, requiredMs: 60000, maxAccuracyM: 50,
            photo: '/images/spaces/in04.jpg' },
        'outdoor-01': { name: '학예관·멀티미디어관 앞 야외 광장', area: '학예관과 멀티미디어관 앞',
            latitude: 36.76947221339854, longitude: 126.93489279497715, radiusM: 40, requiredMs: 60000, maxAccuracyM: 20,
            photo: '/images/spaces/out01.jpg' },
        'outdoor-02': { name: 'SCH미디어랩스관 뒤편 벤치', area: 'SCH미디어랩스관 뒤편',
            latitude: 36.771923550939704, longitude: 126.93141557699708, radiusM: 20, requiredMs: 60000, maxAccuracyM: 20,
            photo: '/images/spaces/out02.jpg' },
        'outdoor-03': { name: '소운동장·체육관 사이 정자', area: '소운동장과 체육관 사이',
            latitude: 36.770186150125774, longitude: 126.93055745846503, radiusM: 15, requiredMs: 60000, maxAccuracyM: 20,
            photo: '/images/spaces/out03.jpg' },
        'outdoor-04': { name: '산학협력관–학성사 연결길', area: '산학협력관에서 학성사 기숙사로 이어지는 길',
            latitude: 36.77109369711564, longitude: 126.93393653938706, radiusM: 35, requiredMs: 60000, maxAccuracyM: 20,
            photo: '/images/spaces/out04.jpg' },
        'outdoor-05': { name: '대운동장 정면 길', area: '대운동장 정면',
            latitude: 36.76898666399184, longitude: 126.92886443646337, radiusM: 55, requiredMs: 60000, maxAccuracyM: 20,
            photo: '/images/spaces/out05.jpg' },
    };
    const spaces = [];
    for (const category of ['indoor', 'outdoor']) {
        for (let n = 1; n <= 5; n++) {
            const number = String(n).padStart(2, '0');
            const id = `${category}-${number}`;
            spaces.push(Object.freeze({
                id,
                code: `${category === 'indoor' ? 'in' : 'out'}${number}`,
                category,
                name: `${category === 'indoor' ? '내부' : '외부'} 공간 ${number}`,
                enabled: false,
                ...(configured[id] ? { ...configured[id], enabled: true } : {}),
            }));
        }
    }
    const getSpace = id => spaces.find(space => space.id === id) || null;
    const fromCode = code => spaces.find(space => space.code === code) || null;
    const destination = id => {
        const space = getSpace(id);
        // Keep an old, unassigned QR code usable as a link to the space list.
        return space ? (space.enabled ? `/visit?space=${space.id}` : '/spaces') : null;
    };
    return Object.freeze({ all: Object.freeze(spaces), getSpace, fromCode, destination });
});
