const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

router.use(requireAuth);

router.get('/', (req, res) => {
    const machines = db.prepare(`
        SELECT m.*, mg.name as group_name
        FROM machines m
        LEFT JOIN machine_groups mg ON m.group_id = mg.id
        ORDER BY m.status DESC, m.hostname ASC
    `).all();
    res.json(machines);
});

router.get('/:id', (req, res) => {
    const machine = db.prepare(`
        SELECT m.*, mg.name as group_name
        FROM machines m
        LEFT JOIN machine_groups mg ON m.group_id = mg.id
        WHERE m.id = ?
    `).get(req.params.id);

    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    res.json(machine);
});

router.post('/', requireAdmin, (req, res) => {
    const { hostname, os_type, category, group_id, display_name } = req.body;

    if (!hostname || !os_type || !category) {
        return res.status(400).json({ error: 'hostname, os_type, and category required' });
    }

    const machine_id = uuidv4();
    const registration_token = crypto.randomBytes(16).toString('hex');

    db.prepare(`
        INSERT INTO machines (machine_id, hostname, display_name, os_type, category, group_id, registration_token)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(machine_id, hostname, display_name || '', os_type, category, group_id || null, registration_token);

    const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(machine_id);
    res.status(201).json(machine);
});

router.put('/:id', requireAdmin, (req, res) => {
    const { hostname, display_name, category, group_id } = req.body;
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    db.prepare(`
        UPDATE machines SET
            hostname = COALESCE(?, hostname),
            display_name = COALESCE(?, display_name),
            category = COALESCE(?, category),
            group_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(hostname, display_name, category, group_id || null, req.params.id);

    res.json(db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    db.prepare('DELETE FROM machines WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

router.post('/:id/regenerate-token', requireAdmin, (req, res) => {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE machines SET registration_token = ? WHERE id = ?').run(token, req.params.id);

    res.json({ registration_token: token });
});

// Groups
router.get('/groups/list', (req, res) => {
    const groups = db.prepare('SELECT * FROM machine_groups ORDER BY name ASC').all();
    res.json(groups);
});

router.post('/groups', requireAdmin, (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    db.prepare('INSERT INTO machine_groups (name, description) VALUES (?, ?)').run(name, description || '');
    const group = db.prepare('SELECT * FROM machine_groups WHERE name = ?').get(name);
    res.status(201).json(group);
});

router.delete('/groups/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM machine_groups WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
