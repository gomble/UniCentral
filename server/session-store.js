const { Store } = require('express-session');
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
)`);

// Purge expired sessions once at startup and every 15 minutes.
function purge() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
purge();
setInterval(purge, 15 * 60 * 1000);

class SQLiteStore extends Store {
    get(sid, cb) {
        const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (row.expires_at < Date.now()) {
            this.destroy(sid, () => {});
            return cb(null, null);
        }
        try { cb(null, JSON.parse(row.data)); } catch { cb(null, null); }
    }

    set(sid, session, cb) {
        const maxAge = session.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
        const expires = Date.now() + maxAge;
        db.prepare(`
            INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
        `).run(sid, JSON.stringify(session), expires);
        cb(null);
    }

    destroy(sid, cb) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        cb(null);
    }

    touch(sid, session, cb) {
        const maxAge = session.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
        const expires = Date.now() + maxAge;
        db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expires, sid);
        cb(null);
    }
}

module.exports = SQLiteStore;
