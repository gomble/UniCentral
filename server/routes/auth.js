const express = require('express');
const router = express.Router();
const { verifyUser, createUser, isSetupComplete, requireAuth } = require('../auth');

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await verifyUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    res.json({ success: true, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

router.get('/check', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.json({
            authenticated: true,
            username: req.session.username,
            role: req.session.role
        });
    }
    res.json({ authenticated: false });
});

router.post('/setup', async (req, res) => {
    if (isSetupComplete()) {
        return res.status(400).json({ error: 'Setup already completed' });
    }

    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
        return res.status(400).json({ error: 'Username and password (min 6 chars) required' });
    }

    await createUser(username, password, 'admin');

    req.session.authenticated = true;
    req.session.userId = 1;
    req.session.username = username;
    req.session.role = 'admin';

    res.json({ success: true });
});

router.get('/setup-required', (req, res) => {
    res.json({ required: !isSetupComplete() });
});

module.exports = router;
