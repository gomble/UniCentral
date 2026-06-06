ALTER TABLE machines ADD COLUMN hardware_id TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_machines_hardware_id ON machines(hardware_id);
