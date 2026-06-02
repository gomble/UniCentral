const db = require('../db');
const { config } = require('../config');

let interval = null;

function start() {
    interval = setInterval(evaluate, 60000);
    console.log('[Notifications] Engine started (60s interval)');
}

function stop() {
    if (interval) clearInterval(interval);
}

function evaluate() {
    checkOfflineMachines();
    checkDiskSpace();
    checkFailedServices();
}

function checkOfflineMachines() {
    const threshold = config.offlineThreshold || 90;
    const offlineMachines = db.prepare(`
        SELECT machine_id, hostname, display_name, last_seen
        FROM machines
        WHERE status = 'online'
        AND last_seen < datetime('now', '-${threshold} seconds')
    `).all();

    for (const m of offlineMachines) {
        db.prepare("UPDATE machines SET status = 'offline' WHERE machine_id = ?").run(m.machine_id);
        createAlert(m.machine_id, 'offline', 'warning',
            `${m.display_name || m.hostname} ist nicht mehr erreichbar`);
    }
}

function checkDiskSpace() {
    const criticalDisks = db.prepare(`
        SELECT d.*, m.hostname, m.display_name, m.machine_id
        FROM disks d
        JOIN machines m ON d.machine_id = m.machine_id
        WHERE m.status = 'online'
        AND d.total_bytes > 0
        AND (CAST(d.free_bytes AS REAL) / d.total_bytes) < 0.1
    `).all();

    for (const d of criticalDisks) {
        const percent = Math.round((1 - d.free_bytes / d.total_bytes) * 100);
        const existing = db.prepare(`
            SELECT id FROM alerts
            WHERE machine_id = ? AND alert_type = 'disk_space' AND resolved_at IS NULL
            AND message LIKE ?
        `).get(d.machine_id, `%${d.drive_letter || d.mount_point}%`);

        if (!existing) {
            createAlert(d.machine_id, 'disk_space', percent > 95 ? 'critical' : 'warning',
                `${d.display_name || d.hostname}: Laufwerk ${d.drive_letter || d.mount_point} bei ${percent}% belegt`);
        }
    }
}

function checkFailedServices() {
    const failedServices = db.prepare(`
        SELECT s.*, m.hostname, m.display_name
        FROM services_monitored s
        JOIN machines m ON s.machine_id = m.machine_id
        WHERE s.monitored = 1 AND s.status = 'stopped' AND s.start_type = 'automatic'
        AND m.status = 'online'
    `).all();

    for (const s of failedServices) {
        const existing = db.prepare(`
            SELECT id FROM alerts
            WHERE machine_id = ? AND alert_type = 'service_failed' AND resolved_at IS NULL
            AND message LIKE ?
        `).get(s.machine_id, `%${s.service_name}%`);

        if (!existing) {
            createAlert(s.machine_id, 'service_failed', 'warning',
                `${s.display_name || s.hostname}: Dienst "${s.service_name}" ist gestoppt`);
        }
    }
}

function createAlert(machineId, type, severity, message) {
    db.prepare(`
        INSERT INTO alerts (machine_id, alert_type, severity, message)
        VALUES (?, ?, ?, ?)
    `).run(machineId, type, severity, message);

    sendEmailNotification(type, severity, message);
}

async function sendEmailNotification(type, severity, message) {
    if (!config.smtpHost) return;

    const rules = db.prepare(`
        SELECT * FROM notification_rules
        WHERE enabled = 1 AND condition_type = ?
        AND (last_fired IS NULL OR last_fired < datetime('now', '-' || cooldown_minutes || ' minutes'))
    `).all(type);

    if (!rules.length) return;

    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpPort === 465,
            auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
            tls: { rejectUnauthorized: false }
        });

        for (const rule of rules) {
            await transporter.sendMail({
                from: config.smtpFrom || config.smtpUser,
                to: rule.target_email,
                subject: `[UniCentral] ${severity.toUpperCase()}: ${type}`,
                text: message
            });
            db.prepare('UPDATE notification_rules SET last_fired = CURRENT_TIMESTAMP WHERE id = ?').run(rule.id);
        }
    } catch (err) {
        console.error('[Notifications] Email send failed:', err.message);
    }
}

module.exports = { start, stop };
