CREATE TABLE IF NOT EXISTS veeam_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    verify_ssl INTEGER DEFAULT 0,
    poll_interval_seconds INTEGER DEFAULT 300,
    last_polled DATETIME,
    status TEXT DEFAULT 'unknown' CHECK(status IN ('connected', 'error', 'unknown')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS backup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veeam_instance_id INTEGER NOT NULL REFERENCES veeam_instances(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    job_type TEXT DEFAULT '',
    last_run_status TEXT DEFAULT '',
    last_run_time DATETIME,
    next_run_time DATETIME,
    target_name TEXT DEFAULT '',
    data_json TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(veeam_instance_id, job_id)
);
