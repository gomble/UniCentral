const bcrypt = require('bcrypt');
const db = require('./db');

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.authenticated && req.session.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Admin access required' });
}

function isSetupComplete() {
    const user = db.prepare('SELECT id FROM users LIMIT 1').get();
    return !!user;
}

async function createUser(username, password, role = 'admin') {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
}

async function verifyUser(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return null;
    return { id: user.id, username: user.username, role: user.role };
}

module.exports = { requireAuth, requireAdmin, isSetupComplete, createUser, verifyUser };
