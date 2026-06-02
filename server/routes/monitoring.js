const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');
const { getConnectedAgents } = require('../ws/agent-handler');

router.use(requireAuth);

router.get('/overview', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as count FROM machines').get().count;
    const online = db.prepare("SELECT COUNT(*) as count FROM machines WHERE status = 'online'").get().count;
    const offline = db.prepare("SELECT COUNT(*) as count FROM machines WHERE status = 'offline'").get().count;
    const servers = db.prepare("SELECT COUNT(*) as count FROM machines WHERE category = 'server'").get().count;
    const clients = db.prepare("SELECT COUNT(*) as count FROM machines WHERE category = 'client'").get().count;
    const activeAlerts = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0 AND resolved_at IS NULL").get().count;

    res.json({ total, online, offline, servers, clients, activeAlerts });
});

router.get('/machines/:machineId/disks', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const disks = db.prepare('SELECT * FROM disks WHERE machine_id = ?').all(machine.machine_id);
    res.json(disks);
});

router.get('/machines/:machineId/services', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const services = db.prepare('SELECT * FROM services_monitored WHERE machine_id = ? ORDER BY service_name').all(machine.machine_id);
    res.json(services);
});

router.get('/machines/:machineId/firewall', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const rules = db.prepare('SELECT * FROM firewall_rules WHERE machine_id = ? ORDER BY rule_name').all(machine.machine_id);
    res.json(rules);
});

router.get('/machines/:machineId/shares', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const shares = db.prepare('SELECT * FROM network_shares WHERE machine_id = ?').all(machine.machine_id);
    res.json(shares);
});

router.get('/machines/:machineId/telemetry', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const range = req.query.range || '24h';
    let hours = 24;
    if (range === '1h') hours = 1;
    else if (range === '6h') hours = 6;
    else if (range === '7d') hours = 168;

    const telemetry = db.prepare(`
        SELECT * FROM machine_telemetry
        WHERE machine_id = ? AND collected_at > datetime('now', '-${hours} hours')
        ORDER BY collected_at ASC
    `).all(machine.machine_id);

    res.json(telemetry);
});

router.get('/machines/:machineId/updates', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const latest = db.prepare(`
        SELECT data_json FROM machine_telemetry
        WHERE machine_id = ?
        ORDER BY collected_at DESC LIMIT 1
    `).get(machine.machine_id);

    if (latest && latest.data_json) {
        const data = JSON.parse(latest.data_json);
        res.json(data.updates || { available: 0, pending: [], reboot_required: false });
    } else {
        res.json({ available: 0, pending: [], reboot_required: false });
    }
});

router.get('/machines/:machineId/firewall-status', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const latest = db.prepare(`
        SELECT data_json FROM machine_telemetry
        WHERE machine_id = ?
        ORDER BY collected_at DESC LIMIT 1
    `).get(machine.machine_id);

    if (latest && latest.data_json) {
        const data = JSON.parse(latest.data_json);
        res.json(data.firewall || { enabled: false, rules: [] });
    } else {
        res.json({ enabled: false, rules: [] });
    }
});

// Alerts
router.get('/alerts', (req, res) => {
    const alerts = db.prepare(`
        SELECT a.*, m.hostname, m.display_name
        FROM alerts a
        LEFT JOIN machines m ON a.machine_id = m.machine_id
        ORDER BY a.created_at DESC
        LIMIT 100
    `).all();
    res.json(alerts);
});

router.post('/alerts/:id/acknowledge', (req, res) => {
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
