ALTER TABLE machines ADD COLUMN is_domain_controller INTEGER DEFAULT 0;
ALTER TABLE machines ADD COLUMN domain_name TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS ad_user_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    properties_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
