const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { getSpace } = require('../public/js/space-data.js');

function validUser(uid) {
    if (typeof uid !== 'string' || !uid || uid.length > 128) throw new Error('invalid_user');
}
function openVisits(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    db.exec(`PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS visits (
            uid TEXT NOT NULL,
            space_id TEXT NOT NULL,
            completed_at INTEGER NOT NULL,
            PRIMARY KEY (uid, space_id)
        ) WITHOUT ROWID;`);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    const insert = db.prepare('INSERT INTO visits(uid,space_id,completed_at) VALUES(?,?,?) ON CONFLICT(uid,space_id) DO NOTHING');
    const query = db.prepare('SELECT space_id FROM visits WHERE uid=? ORDER BY space_id');
    function list(uid) {
        validUser(uid);
        const foundSpaces = query.all(uid).map(row => row.space_id).filter(id => getSpace(id));
        return { foundSpaces, foundSpaceCount: foundSpaces.length };
    }
    function record(uid, spaceId) {
        validUser(uid);
        if (!getSpace(spaceId)?.enabled) throw new Error('not_configured');
        const result = insert.run(uid, spaceId, Date.now());
        return { ...list(uid), newlyFound: result.changes === 1 };
    }
    return Object.freeze({ list, record, close: () => db.close() });
}
let instance;
function defaultVisits() {
    if (!instance) instance = openVisits(process.env.SPACE_CYCLE_DB || path.join(__dirname, '..', 'data', 'visits.sqlite'));
    return instance;
}
module.exports = { openVisits, defaultVisits };
