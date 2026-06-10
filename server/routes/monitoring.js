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

// Insights - automated analysis
router.get('/insights', (req, res) => {
    const machines = db.prepare(`
        SELECT m.id, m.machine_id, m.hostname, m.display_name, m.status, m.os_type, m.category, m.ip_address,
               m.agent_version, m.last_seen, m.is_veeam_server,
               g.name as group_name
        FROM machines m
        LEFT JOIN machine_groups g ON m.group_id = g.id
    `).all();

    const pkg = require('../../package.json');
    const latestVersion = pkg.version;
    const insights = [];

    for (const m of machines) {
        const name = m.display_name || m.hostname;
        const tel = db.prepare(`
            SELECT data_json, collected_at FROM machine_telemetry
            WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1
        `).get(m.machine_id);

        let data = {};
        if (tel && tel.data_json) {
            try { data = JSON.parse(tel.data_json); } catch {}
        }

        // Offline machines
        if (m.status === 'offline') {
            insights.push({
                severity: 'warning',
                category: 'Verfügbarkeit',
                title: `${name} ist offline`,
                detail: m.last_seen ? `Letzter Kontakt: ${m.last_seen}` : 'Kein Kontakt registriert',
                machine_id: m.machine_id,
                machine_db_id: m.id,
                machine_name: name
            });
        }

        // Agent version
        if (m.agent_version && m.agent_version !== latestVersion && m.status === 'online') {
            insights.push({
                severity: 'info',
                category: 'Administration',
                title: `${name} hat veraltete Agent-Version`,
                detail: `Installiert: ${m.agent_version}, Aktuell: ${latestVersion}`,
                machine_id: m.machine_id,
                machine_db_id: m.id,
                machine_name: name
            });
        }

        // Firewall
        const fw = data.firewall || {};
        if (m.status === 'online' && fw.enabled === false) {
            insights.push({
                severity: 'critical',
                category: 'Sicherheit',
                title: `Firewall deaktiviert auf ${name}`,
                detail: 'Die Windows-Firewall ist nicht aktiv. Das System ist ungeschuetzt.',
                machine_id: m.machine_id,
                machine_db_id: m.id,
                machine_name: name
            });
        }

        // Firewall profiles partially disabled
        if (m.status === 'online' && fw.enabled && Array.isArray(fw.profiles)) {
            const disabled = fw.profiles.filter(p => !p.enabled);
            if (disabled.length > 0 && disabled.length < fw.profiles.length) {
                insights.push({
                    severity: 'warning',
                    category: 'Sicherheit',
                    title: `Firewall-Profile teilweise deaktiviert auf ${name}`,
                    detail: `Deaktiviert: ${disabled.map(p => p.name).join(', ')}`,
                    machine_id: m.machine_id,
                    machine_db_id: m.id,
                    machine_name: name
                });
            }
        }

        // Defender
        const def = data.defender || {};
        if (m.status === 'online' && m.os_type === 'windows') {
            if (def.installed && !def.real_time_enabled) {
                insights.push({
                    severity: 'critical',
                    category: 'Sicherheit',
                    title: `Windows Defender Echtzeitschutz deaktiviert auf ${name}`,
                    detail: 'Der Echtzeitschutz ist nicht aktiv. Das System ist anfällig für Malware.',
                    machine_id: m.machine_id,
                    machine_db_id: m.id,
                    machine_name: name
                });
            }
            if (def.installed && def.last_scan_time) {
                const lastScan = new Date(def.last_scan_time);
                const daysSinceScan = (Date.now() - lastScan.getTime()) / (1000 * 60 * 60 * 24);
                if (daysSinceScan > 14) {
                    insights.push({
                        severity: 'warning',
                        category: 'Sicherheit',
                        title: `Kein aktueller Defender-Scan auf ${name}`,
                        detail: `Letzter Scan vor ${Math.floor(daysSinceScan)} Tagen (${def.last_scan_type || 'Unbekannt'})`,
                        machine_id: m.machine_id,
                        machine_db_id: m.id,
                        machine_name: name
                    });
                }
            }
        }

        // Disk space
        if (Array.isArray(data.disks)) {
            for (const disk of data.disks) {
                if (!disk.total_bytes || disk.total_bytes === 0) continue;
                const usedPercent = ((disk.total_bytes - disk.free_bytes) / disk.total_bytes) * 100;
                const label = disk.drive_letter || disk.mount_point || '?';
                if (usedPercent >= 95) {
                    insights.push({
                        severity: 'critical',
                        category: 'Speicher',
                        title: `Laufwerk ${label} fast voll auf ${name}`,
                        detail: `${usedPercent.toFixed(1)}% belegt, nur noch ${formatBytesServer(disk.free_bytes)} frei`,
                        machine_id: m.machine_id,
                        machine_db_id: m.id,
                        machine_name: name
                    });
                } else if (usedPercent >= 85) {
                    insights.push({
                        severity: 'warning',
                        category: 'Speicher',
                        title: `Laufwerk ${label} wird knapp auf ${name}`,
                        detail: `${usedPercent.toFixed(1)}% belegt, noch ${formatBytesServer(disk.free_bytes)} frei`,
                        machine_id: m.machine_id,
                        machine_db_id: m.id,
                        machine_name: name
                    });
                }
            }
        }

        // Pending updates
        const updates = data.updates || {};
        if (m.status === 'online' && updates.available > 0) {
            insights.push({
                severity: updates.available >= 10 ? 'warning' : 'info',
                category: 'Updates',
                title: `${updates.available} ausstehende Updates auf ${name}`,
                detail: updates.reboot_required ? 'Neustart erforderlich nach Installation' : 'Updates bereit zur Installation',
                machine_id: m.machine_id,
                machine_db_id: m.id,
                machine_name: name
            });
        }
        if (m.status === 'online' && updates.reboot_required) {
            insights.push({
                severity: 'warning',
                category: 'Updates',
                title: `Neustart erforderlich auf ${name}`,
                detail: 'Ein Neustart ist noetig um installierte Updates abzuschliessen.',
                machine_id: m.machine_id,
                machine_db_id: m.id,
                machine_name: name
            });
        }

        // Veeam backup issues
        if (m.is_veeam_server) {
            const failedJobs = db.prepare(`
                SELECT job_name, last_result FROM veeam_agent_jobs
                WHERE machine_id = ? AND last_result IN ('Failed', 'Warning')
            `).all(m.machine_id);
            for (const job of failedJobs) {
                insights.push({
                    severity: job.last_result === 'Failed' ? 'critical' : 'warning',
                    category: 'Backup',
                    title: `Veeam-Job "${job.job_name}" ${job.last_result === 'Failed' ? 'fehlgeschlagen' : 'mit Warnung'} auf ${name}`,
                    detail: `Letztes Ergebnis: ${job.last_result}`,
                    machine_id: m.machine_id,
                    machine_db_id: m.id,
                    machine_name: name
                });
            }
        }

        // Stale telemetry (online but no recent data)
        if (m.status === 'online' && tel) {
            const telAge = (Date.now() - new Date(tel.collected_at).getTime()) / (1000 * 60);
            if (telAge > 30) {
                insights.push({
                    severity: 'info',
                    category: 'Administration',
                    title: `Telemetriedaten veraltet auf ${name}`,
                    detail: `Letzte Daten vor ${Math.floor(telAge)} Minuten empfangen`,
                    machine_id: m.machine_id,
                    machine_db_id: m.id,
                    machine_name: name
                });
            }
        }
    }

    // Sort: critical first, then warning, then info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    insights.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    const summary = {
        critical: insights.filter(i => i.severity === 'critical').length,
        warning: insights.filter(i => i.severity === 'warning').length,
        info: insights.filter(i => i.severity === 'info').length,
        total: insights.length
    };

    res.json({ insights, summary });
});

function formatBytesServer(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

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
