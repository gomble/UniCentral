const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { sendCommandToAgent } = require('../ws/agent-handler');

router.use(requireAuth);

router.post('/:machineId/restart', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'restart', { delay: req.body.delay || 0 });
    res.json(result);
});

router.post('/:machineId/shutdown', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'shutdown', { delay: req.body.delay || 0 });
    res.json(result);
});

router.post('/:machineId/install-software', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const { package_name, method } = req.body;
    if (!package_name) return res.status(400).json({ error: 'package_name required' });

    const result = sendCommandToAgent(machine.machine_id, 'install_software', {
        package_name,
        method: method || 'auto'
    });
    res.json(result);
});

router.post('/:machineId/firewall/enable', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'enable_firewall', {});
    res.json(result);
});

router.post('/:machineId/firewall/disable', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'disable_firewall', {});
    res.json(result);
});

router.post('/:machineId/firewall/rule', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const { rule_name, direction, action, protocol, port } = req.body;
    if (!rule_name || !direction || !action || !port) {
        return res.status(400).json({ error: 'rule_name, direction, action, and port required' });
    }

    const result = sendCommandToAgent(machine.machine_id, 'add_firewall_rule', {
        rule_name, direction, action, protocol: protocol || 'tcp', port
    });
    res.json(result);
});

router.post('/:machineId/trigger-updates', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'trigger_updates', {});
    res.json(result);
});

router.post('/:machineId/trigger-updates-reboot', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(machine.machine_id, 'trigger_updates_reboot', {});
    res.json(result);
});

router.post('/:machineId/schedule-updates', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const { time } = req.body;
    if (!time) return res.status(400).json({ error: 'time required (HH:MM)' });

    const result = sendCommandToAgent(machine.machine_id, 'schedule_updates', { time });
    res.json(result);
});

router.post('/:machineId/update-agent', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = sendCommandToAgent(machine.machine_id, 'update_agent', { server_url: baseUrl });
    res.json(result);
});

router.post('/:machineId/disk-scan', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const { path } = req.body;
    const result = sendCommandToAgent(machine.machine_id, 'scan_disk', { path: path || '' });
    res.json(result);
});

// Global command history
router.get('/history', (req, res) => {
    const commands = db.prepare(`
        SELECT cl.*, m.hostname, m.display_name
        FROM command_log cl
        LEFT JOIN machines m ON cl.machine_id = m.machine_id
        ORDER BY cl.created_at DESC
        LIMIT 100
    `).all();
    res.json(commands);
});

// Machine-specific command history
router.get('/:machineId/history', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const commands = db.prepare(`
        SELECT * FROM command_log
        WHERE machine_id = ?
        ORDER BY created_at DESC
        LIMIT 50
    `).all(machine.machine_id);

    res.json(commands);
});

module.exports = router;
