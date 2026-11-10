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
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS stay_progress (
            id TEXT PRIMARY KEY,
            challenge TEXT NOT NULL,
            uid TEXT NOT NULL,
            space_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ready_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            required_ms INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','complete')),
            UNIQUE(uid,space_id)
        );
        CREATE INDEX IF NOT EXISTS stay_progress_expires_idx ON stay_progress(expires_at);
        CREATE INDEX IF NOT EXISTS stay_progress_status_idx ON stay_progress(status);
        CREATE TABLE IF NOT EXISTS stay_start_attempts (
            uid TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            space_id TEXT NOT NULL,
            progress_id TEXT,
            cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)),
            expires_at INTEGER NOT NULL,
            PRIMARY KEY(uid,attempt_id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS stay_start_attempts_expires_idx ON stay_start_attempts(expires_at);`);
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
    const findProgress = db.prepare('SELECT * FROM stay_progress WHERE uid=? AND space_id=?');
    const insertProgress = db.prepare(`INSERT INTO stay_progress
        (id,challenge,uid,space_id,started_at,ready_at,expires_at,required_ms,status)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(uid,space_id) DO NOTHING`);
    const findProgressById = db.prepare('SELECT * FROM stay_progress WHERE id=?');
    const completeProgress = db.prepare("UPDATE stay_progress SET status='complete' WHERE id=?");
    const deleteProgress = db.prepare('DELETE FROM stay_progress WHERE id=? AND uid=? AND challenge=?');
    const expireProgress = db.prepare('DELETE FROM stay_progress WHERE expires_at <= ?');
    const countActive = db.prepare("SELECT count(*) AS n FROM stay_progress WHERE status='active'");
    const findAttempt = db.prepare('SELECT * FROM stay_start_attempts WHERE uid=? AND attempt_id=?');
    const insertAttempt = db.prepare('INSERT INTO stay_start_attempts VALUES(?,?,?,?,?,?)');
    const cancelAttempt = db.prepare('UPDATE stay_start_attempts SET cancelled=1, expires_at=? WHERE uid=? AND attempt_id=?');
    const expireAttempts = db.prepare('DELETE FROM stay_start_attempts WHERE expires_at <= ?');
    const countAttempts = db.prepare('SELECT count(*) AS n FROM stay_start_attempts');
    const deleteMappedProgress = db.prepare('DELETE FROM stay_progress WHERE id=? AND uid=? AND space_id=?');
    function failure(code, status) { const error = new Error(code); error.status = status; throw error; }
    function capacity(maxAttempts) {
        if (countAttempts.get().n >= maxAttempts) failure('capacity', 429);
    }
    const progress = Object.freeze({
        cleanup(time) { expireProgress.run(time); expireAttempts.run(time); },
        remove(id, uid, challenge) { validUser(uid); deleteProgress.run(id, uid, challenge); },
        get(id) { return findProgressById.get(id); },
        complete(row, time) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const current = findProgressById.get(row.id);
                const result = current.status === 'complete' ? { changes: 0 } : insert.run(current.uid, current.space_id, time);
                completeProgress.run(row.id);
                const saved = { row: findProgressById.get(row.id), ...list(current.uid), newlyFound: result.changes === 1 };
                db.exec('COMMIT');
                return saved;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        find(uid, spaceId) { validUser(uid); return findProgress.get(uid, spaceId); },
        abandon(uid, spaceId, attemptId, time, maxAttempts) {
            validUser(uid);
            db.exec('BEGIN IMMEDIATE');
            try {
                expireAttempts.run(time);
                const attempt = findAttempt.get(uid, attemptId);
                if (attempt && attempt.space_id !== spaceId) failure('invalid_payload', 400);
                if (attempt) cancelAttempt.run(Math.max(attempt.expires_at, time + 7200000), uid, attemptId);
                else {
                    capacity(maxAttempts);
                    insertAttempt.run(uid, attemptId, spaceId, null, 1, time + 7200000);
                }
                // Never delete by uid/space alone: a replay must not cancel a later start.
                if (attempt?.progress_id) deleteMappedProgress.run(attempt.progress_id, uid, spaceId);
                db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        },
        insert(row, maxSessions, attemptId, maxAttempts = 10000) {
            validUser(row.uid);
            db.exec('BEGIN IMMEDIATE');
            try {
                expireProgress.run(row.started_at);
                expireAttempts.run(row.started_at);
                if (attemptId) {
                    const attempt = findAttempt.get(row.uid, attemptId);
                    if (attempt) {
                        if (attempt.space_id !== row.space_id) failure('invalid_payload', 400);
                        if (attempt.cancelled) failure('start_cancelled', 409);
                        const mapped = findProgressById.get(attempt.progress_id);
                        if (!mapped || mapped.uid !== row.uid || mapped.space_id !== row.space_id) failure('start_cancelled', 409);
                        db.exec('COMMIT');
                        return { created: false, row: mapped };
                    }
                    capacity(maxAttempts);
                }
                const existing = findProgress.get(row.uid, row.space_id);
                if (existing) {
                    if (attemptId) insertAttempt.run(row.uid, attemptId, row.space_id, existing.id, 0, row.started_at + 7200000);
                    db.exec('COMMIT');
                    return { created: false, row: existing };
                }
                if (countActive.get().n >= maxSessions) {
                    const error = new Error('capacity');
                    error.status = 429;
                    throw error;
                }
                insertProgress.run(row.id, row.challenge, row.uid, row.space_id, row.started_at,
                    row.ready_at, row.expires_at, row.required_ms, row.status);
                const saved = findProgress.get(row.uid, row.space_id);
                if (attemptId) insertAttempt.run(row.uid, attemptId, row.space_id, saved.id, 0, row.started_at + 7200000);
                db.exec('COMMIT');
                return { created: true, row: saved };
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
    });
    return Object.freeze({ list, record, progress, close: () => db.close() });
}
let instance;
function defaultVisits() {
    if (!instance) instance = openVisits(process.env.SPACE_CYCLE_DB || path.join(__dirname, '..', 'data', 'visits.sqlite'));
    return instance;
}
module.exports = { openVisits, defaultVisits };
