/* Public place configuration. Exact test coordinates supplied by the project owner. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleSpaces = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const spaces = [];
    for (const category of ['indoor', 'outdoor']) {
        for (let n = 1; n <= 5; n++) {
            const number = String(n).padStart(2, '0');
            spaces.push(Object.freeze({
                id: `${category}-${number}`,
                code: `${category === 'indoor' ? 'in' : 'out'}${number}`,
                category,
                name: `${category === 'indoor' ? '내부' : '외부'} 공간 ${number}`,
                enabled: false,
                ...(category === 'indoor' && n === 1 ? {
                    name: '향설생활관2',
                    enabled: true,
                    latitude: 36.767780,
                    longitude: 126.933294,
                    radiusM: 300,
                    requiredMs: 60000,
                    maxAccuracyM: 100,
                } : {}),
            }));
        }
    }
    const getSpace = id => spaces.find(space => space.id === id) || null;
    const fromCode = code => spaces.find(space => space.code === code) || null;
    const destination = id => {
        const space = getSpace(id);
        return space ? `${space.enabled ? '/visit' : '/spaces'}?space=${space.id}` : null;
    };
    return Object.freeze({ all: Object.freeze(spaces), getSpace, fromCode, destination });
});
