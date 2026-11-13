const test = require('node:test');
const assert = require('node:assert/strict');
const spaces = require('../public/js/space-data.js');
const { assessPosition } = require('../server/stay-store.js');

const supplied = {
    'outdoor-01': [36.76947221339854, 126.93489279497715],
    'outdoor-02': [36.771923550939704, 126.93141557699708],
    'outdoor-03': [36.770186150125774, 126.93055745846503],
    'outdoor-04': [36.77109369711564, 126.93393653938706],
    'outdoor-05': [36.76898666399184, 126.92886443646337],
};

test('five outdoor places use the supplied coordinates, a photo and a one-minute test wait', () => {
    for (const [id, [latitude, longitude]] of Object.entries(supplied)) {
        const place = spaces.getSpace(id);
        assert.equal(place.enabled, true, id);
        assert.equal(place.latitude, latitude); assert.equal(place.longitude, longitude);
        assert.equal(place.requiredMs, 60000);
        assert.equal(place.photo, `/images/spaces/out${id.slice(-2)}.jpg`);
        assert.ok(place.maxAccuracyM < place.radiusM);
        assert.equal(spaces.destination(id), `/visit?space=${id}`);
    }
});

test('each outdoor place accepts its own center and no position can satisfy two places', () => {
    const enabled = spaces.all.filter(place => place.enabled);
    for (const place of enabled.filter(p => p.category === 'outdoor')) {
        assert.equal(assessPosition(place, { latitude: place.latitude, longitude: place.longitude, accuracy: 10 }).phase, 'inside', place.id);
        for (const other of enabled.filter(p => p.id !== place.id)) {
            const here = { latitude: other.latitude, longitude: other.longitude, accuracy: 10 };
            assert.notEqual(assessPosition(place, here).phase, 'inside', `${other.id} center must not count for ${place.id}`);
        }
    }
});
