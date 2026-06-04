const db = require('../db');

let _sendCommand = null;

function checkSchedules() {
    if (!_sendCommand) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);

    const due = db.prepare(`
        SELECT us.machine_id, us.reboot, m.status AS machine_status
        FROM update_schedules us
        JOIN machines m ON m.machine_id = us.machine_id
        WHERE us.enabled = 1
          AND us.schedule_time = ?
          AND (us.last_run_date IS NULL OR us.last_run_date != ?)
    `).all(hhmm, today);

    for (const row of due) {
        if (row.machine_status !== 'online') continue;

        const cmdType = row.reboot ? 'trigger_updates_reboot' : 'trigger_updates';
        _sendCommand(row.machine_id, cmdType, {});

        db.prepare('UPDATE update_schedules SET last_run_date = ? WHERE machine_id = ?')
            .run(today, row.machine_id);

        console.log(`[UpdateScheduler] Triggered ${cmdType} for ${row.machine_id} at ${hhmm}`);
    }
}

function start(sendCommandToAgent) {
    _sendCommand = sendCommandToAgent;
    setInterval(checkSchedules, 60 * 1000);
    // Delay first check so agent WS connections can be established after restart
    setTimeout(checkSchedules, 15 * 1000);
}

module.exports = { start };
