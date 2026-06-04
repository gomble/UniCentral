const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { sendCommandToAgent } = require('../ws/agent-handler');

router.use(requireAuth);

// Machines with their update status, last run and schedule
router.get('/machines', (req, res) => {
    const machines = db.prepare(`
        SELECT
            m.machine_id, m.hostname, m.display_name, m.os_type, m.status, m.ip_address,
            us.schedule_time, us.reboot AS schedule_reboot,
            us.enabled AS schedule_enabled, us.last_run_date,
            cl.id AS last_run_id, cl.status AS last_run_status,
            cl.command_type AS last_run_type,
            cl.created_at AS last_run_at, cl.completed_at AS last_run_completed_at
        FROM machines m
        LEFT JOIN update_schedules us ON us.machine_id = m.machine_id
        LEFT JOIN command_log cl ON cl.id = (
            SELECT id FROM command_log
            WHERE machine_id = m.machine_id
              AND command_type IN ('trigger_updates', 'trigger_updates_reboot')
            ORDER BY created_at DESC LIMIT 1
        )
        ORDER BY m.os_type ASC, m.hostname ASC
    `).all();

    for (const m of machines) {
        const tel = db.prepare(`
            SELECT data_json FROM machine_telemetry
            WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1
        `).get(m.machine_id);
        m.updates_available = 0;
        m.updates_pending = [];
        m.updates_reboot_required = false;
        if (tel) {
            try {
                const data = JSON.parse(tel.data_json || '{}');
                if (data.updates) {
                    m.updates_available = data.updates.available || 0;
                    m.updates_pending = data.updates.pending || [];
                    m.updates_reboot_required = !!data.updates.reboot_required;
                }
            } catch {}
        }
    }

    res.json(machines);
});

// Last 20 update runs for a machine
router.get('/logs/:machineId', (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ? OR machine_id = ?')
        .get(req.params.machineId, req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const logs = db.prepare(`
        SELECT id, command_type, status, result, created_at, completed_at
        FROM command_log
        WHERE machine_id = ? AND command_type IN ('trigger_updates', 'trigger_updates_reboot')
        ORDER BY created_at DESC LIMIT 20
    `).all(machine.machine_id);

    res.json(logs);
});

// Upsert schedule for a single machine
router.post('/schedules', requireAdmin, (req, res) => {
    const { machine_id, schedule_time, reboot } = req.body;
    if (!machine_id || !schedule_time) return res.status(400).json({ error: 'machine_id and schedule_time required' });
    if (!/^\d{2}:\d{2}$/.test(schedule_time)) return res.status(400).json({ error: 'Invalid time format (HH:MM)' });

    db.prepare(`
        INSERT INTO update_schedules (machine_id, schedule_time, reboot, enabled)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(machine_id) DO UPDATE SET
            schedule_time = excluded.schedule_time,
            reboot        = excluded.reboot,
            enabled       = 1,
            updated_at    = CURRENT_TIMESTAMP
    `).run(machine_id, schedule_time, reboot ? 1 : 0);

    res.json({ success: true });
});

// Remove schedule for a machine
router.delete('/schedules/:machineId', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM update_schedules WHERE machine_id = ?').run(req.params.machineId);
    res.json({ success: true });
});

// Batch trigger updates on a list of machines
router.post('/trigger-batch', requireAdmin, (req, res) => {
    const { machine_ids, reboot } = req.body;
    if (!Array.isArray(machine_ids) || machine_ids.length === 0)
        return res.status(400).json({ error: 'machine_ids array required' });

    const results = [];
    const cmdType = reboot ? 'trigger_updates_reboot' : 'trigger_updates';
    for (const mid of machine_ids) {
        const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(mid);
        if (!machine) { results.push({ machine_id: mid, success: false, error: 'Not found' }); continue; }
        const r = sendCommandToAgent(mid, cmdType, {});
        results.push({ machine_id: mid, ...r });
    }

    res.json({ results });
});

module.exports = router;
