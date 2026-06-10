-- Use the shared machine_groups for M365 tenants instead of a separate
-- m365_tenant_groups concept, so tenants are grouped the same way as machines.
CREATE TABLE m365_tenants_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES machine_groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    default_domain TEXT DEFAULT '',
    status TEXT DEFAULT 'unknown',
    last_error TEXT DEFAULT '',
    last_checked DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Carry over existing tenants; previous group ids referenced the old table, so
-- reset them to NULL (they must be reassigned to a machine group).
INSERT INTO m365_tenants_new (id, group_id, name, tenant_id, client_id, client_secret_enc, default_domain, status, last_error, last_checked, created_at, updated_at)
    SELECT id, NULL, name, tenant_id, client_id, client_secret_enc, default_domain, status, last_error, last_checked, created_at, updated_at FROM m365_tenants;

DROP TABLE m365_tenants;
ALTER TABLE m365_tenants_new RENAME TO m365_tenants;
DROP TABLE IF EXISTS m365_tenant_groups;
