const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');
const { getConnectedAgents } = require('../ws/agent-handler');

router.use(requireAuth);

router.get('/dashboard-telemetry', (req, res) => {
    const machines = db.prepare("SELECT machine_id FROM machines WHERE status = 'online'").all();
    const result = {};
    for (const m of machines) {
        const tel = db.prepare(`
            SELECT cpu_percent, memory_percent, uptime_seconds, data_json FROM machine_telemetry
            WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1
        `).get(m.machine_id);
        if (tel) {
            let diskPercent = 0;
            try {
                const data = JSON.parse(tel.data_json || '{}');
                if (data.disks && data.disks.length) {
                    const totalAll = data.disks.reduce((s, d) => s + (d.total_bytes || 0), 0);
                    const freeAll = data.disks.reduce((s, d) => s + (d.free_bytes || 0), 0);
                    diskPercent = totalAll > 0 ? ((totalAll - freeAll) / totalAll) * 100 : 0;
                }
            } catch {}
            result[m.machine_id] = { cpu: tel.cpu_percent, mem: tel.memory_percent, disk: diskPercent, uptime: tel.uptime_seconds || 0 };
        }
    }
    res.json(result);
});

router.get('/overview', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as count FROM machines').get().count;
    const online = db.prepare("SELECT COUNT(*) as count FROM machines WHERE status = 'online'").get().count;
    const offline = db.prepare("SELECT COUNT(*) as count FROM machines WHERE status = 'offline'").get().count;
    const servers = db.prepare("SELECT COUNT(*) as count FROM machines WHERE category = 'server'").get().count;
    const clients = db.prepare("SELECT COUNT(*) as count FROM machines WHERE category = 'client'").get().count;
    const activeAlerts = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0 AND resolved_at IS NULL").get().count;

    const pkg = require('../../package.json');
    res.json({ total, online, offline, servers, clients, activeAlerts, agentVersion: pkg.version });
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

// Security overview
router.get('/security-overview', (req, res) => {
    const machines = db.prepare(`
        SELECT m.id, m.machine_id, m.hostname, m.display_name, m.status, m.os_type, m.category, m.ip_address,
               g.name as group_name
        FROM machines m
        LEFT JOIN machine_groups g ON m.group_id = g.id
        ORDER BY m.hostname
    `).all();

    const result = machines.map(m => {
        const tel = db.prepare(`
            SELECT data_json FROM machine_telemetry
            WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1
        `).get(m.machine_id);

        let firewall = { enabled: false, profiles: [], rules: [], ports: [] };
        let defender = { installed: false, enabled: false, real_time_enabled: false };

        if (tel && tel.data_json) {
            try {
                const data = JSON.parse(tel.data_json);
                if (data.firewall) firewall = data.firewall;
                if (data.defender) defender = data.defender;
            } catch {}
        }

        return {
            ...m,
            firewall_enabled: firewall.enabled,
            firewall_profiles: firewall.profiles || [],
            firewall_rules_count: (firewall.rules || []).length,
            firewall_ports_count: (firewall.ports || []).length,
            defender_installed: defender.installed,
            defender_enabled: defender.enabled,
            defender_realtime: defender.real_time_enabled,
            defender_last_scan: defender.last_scan_time || '',
            defender_engine: defender.engine_version || '',
            defender_definitions: defender.definition_version || ''
        };
    });

    res.json(result);
});

router.get('/machines/:machineId/security-detail', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?').get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const tel = db.prepare(`
        SELECT data_json FROM machine_telemetry
        WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1
    `).get(machine.machine_id);

    let firewall = { enabled: false, profiles: [], rules: [], ports: [] };
    let defender = { installed: false, enabled: false, real_time_enabled: false };

    if (tel && tel.data_json) {
        try {
            const data = JSON.parse(tel.data_json);
            if (data.firewall) firewall = data.firewall;
            if (data.defender) defender = data.defender;
        } catch {}
    }

    res.json({ firewall, defender });
});

// Alerts
router.get('/alerts', (req, res) => {
    const alerts = db.prepare(`
        SELECT a.*, m.id as machine_db_id, m.hostname, m.display_name, m.os_type, m.category,
               g.name as group_name
        FROM alerts a
        LEFT JOIN machines m ON a.machine_id = m.machine_id
        LEFT JOIN machine_groups g ON m.group_id = g.id
        ORDER BY a.created_at DESC
        LIMIT 500
    `).all();
    res.json(alerts);
});

router.post('/alerts/:id/acknowledge', (req, res) => {
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

router.post('/alerts/acknowledge-bulk', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
    const stmt = db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?');
    const run = db.transaction((list) => { for (const id of list) stmt.run(id); });
    run(ids);
    res.json({ success: true, count: ids.length });
});

router.post('/alerts/acknowledge-all', (req, res) => {
    const result = db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run();
    res.json({ success: true, count: result.changes });
});

module.exports = router;
