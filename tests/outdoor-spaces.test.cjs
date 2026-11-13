const test = require('node:test');
const assert = require('node:assert/strict');
const spaces = require('../public/js/space-data.js');
const { assessPosition } = require('../server/stay-store.js');

const radii = { 'outdoor-01': 40, 'outdoor-02': 20, 'outdoor-03': 15, 'outdoor-04': 35, 'outdoor-05': 55 };
const supplied = {
    'outdoor-01': [36.76947221339854, 126.93489279497715],
    'outdoor-02': [36.771923550939704, 126.93141557699708],
    'outdoor-03': [36.770186150125774, 126.93055745846503],
    'outdoor-04': [36.77109369711564, 126.93393653938706],
    'outdoor-05': [36.76898666399184, 126.92886443646337],
};

test('five outdoor places use the supplied coordinates and radii, a photo and a one-minute test wait', () => {
    for (const [id, [latitude, longitude]] of Object.entries(supplied)) {
        const place = spaces.getSpace(id);
        assert.equal(place.enabled, true, id);
        assert.equal(place.latitude, latitude); assert.equal(place.longitude, longitude);
        assert.equal(place.requiredMs, 60000);
        assert.equal(place.photo, `/images/spaces/out${id.slice(-2)}.jpg`);
        assert.equal(place.radiusM, radii[id]);
        assert.equal(place.maxAccuracyM, 20);
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

test('small radii stay passable: distance alone decides, while coarse GPS fixes are still refused', () => {
    const place = spaces.getSpace('outdoor-03');
    const north = meters => place.latitude + meters / 6371000 * 180 / Math.PI;
    assert.equal(assessPosition(place, { latitude: north(10), longitude: place.longitude, accuracy: 12 }).phase, 'inside',
        '10m away with 12m GPS error passes a 15m radius');
    assert.equal(assessPosition(place, { latitude: north(16), longitude: place.longitude, accuracy: 3 }).phase, 'outside');
    assert.equal(assessPosition(place, { latitude: north(2), longitude: place.longitude, accuracy: 21 }).phase, 'uncertain');
});
