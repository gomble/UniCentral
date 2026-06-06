ALTER TABLE machines ADD COLUMN is_veeam_server INTEGER DEFAULT 0;
ALTER TABLE machines ADD COLUMN veeam_version TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS veeam_agent_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    job_type TEXT DEFAULT '',
    is_copy_job INTEGER DEFAULT 0,
    last_result TEXT DEFAULT '',
    last_state TEXT DEFAULT '',
    last_run DATETIME,
    next_run DATETIME,
    schedule_enabled INTEGER DEFAULT 1,
    target_repo TEXT DEFAULT '',
    repo_id TEXT DEFAULT '',
    description TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(machine_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_veeam_jobs_machine ON veeam_agent_jobs(machine_id);

CREATE TABLE IF NOT EXISTS veeam_agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    job_name TEXT DEFAULT '',
    result TEXT DEFAULT '',
    state TEXT DEFAULT '',
    start_time DATETIME,
    end_time DATETIME,
    UNIQUE(machine_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_veeam_sessions_machine_job ON veeam_agent_sessions(machine_id, job_id);

CREATE TABLE IF NOT EXISTS veeam_agent_repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    repo_type TEXT DEFAULT '',
    path TEXT DEFAULT '',
    capacity_bytes INTEGER DEFAULT 0,
    free_bytes INTEGER DEFAULT 0,
    used_bytes INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(machine_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_veeam_repos_machine ON veeam_agent_repositories(machine_id);
