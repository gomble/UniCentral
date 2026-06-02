CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret TEXT DEFAULT '',
    role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'viewer')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machine_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT UNIQUE NOT NULL,
    hostname TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    os_type TEXT NOT NULL CHECK(os_type IN ('windows', 'linux')),
    category TEXT NOT NULL CHECK(category IN ('server', 'client')),
    group_id INTEGER REFERENCES machine_groups(id) ON DELETE SET NULL,
    ip_address TEXT DEFAULT '',
    agent_version TEXT DEFAULT '',
    last_seen DATETIME,
    status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'warning')),
    registration_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machine_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cpu_percent REAL,
    memory_percent REAL,
    uptime_seconds INTEGER,
    data_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_machine_time ON machine_telemetry(machine_id, collected_at);

CREATE TABLE IF NOT EXISTS disks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    drive_letter TEXT,
    mount_point TEXT,
    total_bytes INTEGER,
    free_bytes INTEGER,
    health_status TEXT DEFAULT 'unknown' CHECK(health_status IN ('healthy', 'warning', 'critical', 'unknown')),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services_monitored (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    status TEXT DEFAULT 'unknown',
    start_type TEXT DEFAULT '',
    monitored INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(machine_id, service_name)
);

CREATE TABLE IF NOT EXISTS firewall_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    rule_name TEXT NOT NULL,
    direction TEXT CHECK(direction IN ('inbound', 'outbound')),
    action TEXT CHECK(action IN ('allow', 'block')),
    protocol TEXT,
    port TEXT,
    enabled INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS network_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    share_name TEXT NOT NULL,
    path TEXT,
    description TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT REFERENCES machines(machine_id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    severity TEXT DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
    message TEXT NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

CREATE TABLE IF NOT EXISTS notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    condition_params TEXT DEFAULT '{}',
    target_email TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    cooldown_minutes INTEGER DEFAULT 60,
    last_fired DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS command_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    command_type TEXT NOT NULL,
    parameters TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'completed', 'failed')),
    result TEXT DEFAULT '',
    issued_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
