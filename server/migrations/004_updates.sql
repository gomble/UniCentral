-- Recreate command_log with 'running' added to status constraint
ALTER TABLE command_log RENAME TO command_log_old;

CREATE TABLE command_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    command_type TEXT NOT NULL,
    parameters TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'running', 'completed', 'failed')),
    result TEXT DEFAULT '',
    issued_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

INSERT INTO command_log SELECT * FROM command_log_old;
DROP TABLE command_log_old;

-- Recurring update schedules (one row per machine, fires daily at schedule_time)
CREATE TABLE IF NOT EXISTS update_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL UNIQUE REFERENCES machines(machine_id) ON DELETE CASCADE,
    schedule_time TEXT NOT NULL,
    reboot INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    last_run_date TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
