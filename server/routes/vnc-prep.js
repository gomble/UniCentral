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
    if (!password) {
        password = generateVncPassword();
        db.prepare('UPDATE machines SET vnc_password = ?, vnc_port = ? WHERE machine_id = ?').run(password, port, machineId);
    } else {
        db.prepare('UPDATE machines SET vnc_port = ? WHERE machine_id = ?').run(port, machineId);
    }

    // Always (re-)run setup. The agent script is idempotent: if TightVNC is
    // already installed it just reconfigures and restarts the service. This also
    // ensures a previously failed install (e.g. msiexec 1618) is retried the
    // next time the user opens the remote session, instead of being skipped
    // because a password was already stored.
    const result = sendCommandToAgent(machineId, 'setup_vnc', { password, port });
    res.json({ ok: true, command_id: result.command_id || null, port });
});

// Latest setup_vnc result for a machine, so the remote viewer can surface a real
// install failure instead of spinning on "installing" forever.
router.get('/setup-status/:machineId', requireAuth, (req, res) => {
    const { machineId } = req.params;
    const c = db.prepare(`
        SELECT status, result, completed_at FROM command_log
        WHERE machine_id = ? AND command_type = 'setup_vnc'
        ORDER BY created_at DESC LIMIT 1
    `).get(machineId);
    if (!c) return res.json({ status: 'none', failed: false });
    const failed = c.status === 'failed' || (c.result && /ERROR/i.test(c.result));
    res.json({ status: c.status, failed: !!failed, result: c.result || '' });
});

// Return VNC credentials for a machine (authenticated users only).
router.get('/credentials/:machineId', requireAuth, (req, res) => {
    const { machineId } = req.params;
    const row = db.prepare('SELECT vnc_password, vnc_port FROM machines WHERE machine_id = ?').get(machineId);
    if (!row || !row.vnc_password) return res.status(404).json({ error: 'No VNC credentials configured' });
    res.json({ password: row.vnc_password, port: row.vnc_port || 5900 });
});

module.exports = router;
