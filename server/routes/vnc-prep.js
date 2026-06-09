const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { sendCommandToAgent } = require('../ws/agent-handler');

function requireAuth(req, res, next) {
    if (!req.session || !req.session.authenticated) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

function generateVncPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// Trigger VNC preparation on the machine.
// Generates (or reuses) a VNC password, sends setup_vnc to the agent, returns command_id.
router.post('/prepare/:machineId', requireAuth, (req, res) => {
    const { machineId } = req.params;
    const port = parseInt(req.body && req.body.port) || 5900;

    const machine = db.prepare('SELECT machine_id, vnc_password, status FROM machines WHERE machine_id = ?').get(machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    if (machine.status !== 'online') return res.status(409).json({ error: 'Machine offline' });

    let password = machine.vnc_password;
    const needsSetup = !password;
    if (!password) {
        password = generateVncPassword();
        db.prepare('UPDATE machines SET vnc_password = ?, vnc_port = ? WHERE machine_id = ?').run(password, port, machineId);
    } else {
        db.prepare('UPDATE machines SET vnc_port = ? WHERE machine_id = ?').run(port, machineId);
    }

    if (needsSetup) {
        const result = sendCommandToAgent(machineId, 'setup_vnc', { password, port });
        res.json({ ok: true, command_id: result.command_id || null, port });
    } else {
        res.json({ ok: true, command_id: null, port });
    }
});

// Return VNC credentials for a machine (authenticated users only).
router.get('/credentials/:machineId', requireAuth, (req, res) => {
    const { machineId } = req.params;
    const row = db.prepare('SELECT vnc_password, vnc_port FROM machines WHERE machine_id = ?').get(machineId);
    if (!row || !row.vnc_password) return res.status(404).json({ error: 'No VNC credentials configured' });
    res.json({ password: row.vnc_password, port: row.vnc_port || 5900 });
});

module.exports = router;
