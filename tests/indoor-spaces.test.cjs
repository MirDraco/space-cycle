const test = require('node:test');
const assert = require('node:assert/strict');
const spaces = require('../public/js/space-data.js');
const { assessPosition } = require('../server/stay-store.js');

const supplied = [
    ['in01', '김승우 라운지', 36.77282799161019, 126.93329938074858],
    ['in02', '오월 라운지', 36.77145784931604, 126.93251089396017],
    ['in03', '학생 회관 2층', 36.76998389914673, 126.93142010481328],
    ['in04', '공학관 편의점 옆 휴게공간', 36.769281474235655, 126.932199181013],
];

test('only the four supplied indoor sites can start a visit', () => {
    assert.deepEqual(spaces.all.filter(place => place.category === 'indoor' && place.enabled).map(place => place.code),
        supplied.map(([code]) => code));
    for (const [code, name, latitude, longitude] of supplied) {
        const place = spaces.fromCode(code);
        assert.equal(place.id, `indoor-${code.slice(-2)}`);
        assert.equal(place.name, name);
        assert.equal(place.latitude, latitude);
        assert.equal(place.longitude, longitude);
        assert.equal(place.photo, `/images/spaces/${code}.jpg`);
        assert.equal(place.requiredMs, 60000);
        assert.equal(spaces.destination(place.id), `/visit?space=${place.id}`);
    }
    assert.equal(spaces.fromCode('in05').enabled, false);
});

test('the server uses a 75m radius and the existing 50m indoor accuracy limit', () => {
    for (const [code, , latitude, longitude] of supplied) {
        const place = spaces.fromCode(code);
        assert.equal(place.radiusM, 75, code);
        assert.equal(place.maxAccuracyM, 50, code);
        const at = (meters, accuracy) => ({ latitude: latitude + meters / 6371000 * 180 / Math.PI, longitude, accuracy });
        assert.equal(assessPosition(place, at(0, 5)).distanceM, 0, code);
        assert.equal(assessPosition(place, at(74.9, 50)).phase, 'inside', code);
        assert.equal(assessPosition(place, at(75.1, 5)).phase, 'outside', code);
        assert.equal(assessPosition(place, at(0, 51)).phase, 'uncertain', code);
    }
});
