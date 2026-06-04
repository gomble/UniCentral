const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { sendCommandToAgent } = require('../ws/agent-handler');

router.use(requireAuth);

router.get('/domain-controllers', (req, res) => {
    const dcs = db.prepare(`
        SELECT id, machine_id, hostname, display_name, domain_name, status
        FROM machines
        WHERE is_domain_controller = 1
        ORDER BY hostname ASC
    `).all();
    res.json(dcs);
});

router.post('/:machineId/command', requireAdmin, (req, res) => {
    const { type, parameters } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });

    const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const result = sendCommandToAgent(req.params.machineId, type, parameters || {});
    res.json(result);
});

router.get('/templates', (req, res) => {
    const templates = db.prepare('SELECT * FROM ad_user_templates ORDER BY name ASC').all();
    res.json(templates.map(t => ({ ...t, properties: JSON.parse(t.properties_json || '{}') })));
});

router.post('/templates', requireAdmin, (req, res) => {
    const { name, description, properties } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const stmt = db.prepare('INSERT INTO ad_user_templates (name, description, properties_json) VALUES (?, ?, ?)');
    const result = stmt.run(name, description || '', JSON.stringify(properties || {}));

    const tmpl = db.prepare('SELECT * FROM ad_user_templates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...tmpl, properties: JSON.parse(tmpl.properties_json || '{}') });
});

router.put('/templates/:id', requireAdmin, (req, res) => {
    const { name, description, properties } = req.body;
    const tmpl = db.prepare('SELECT * FROM ad_user_templates WHERE id = ?').get(req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    db.prepare('UPDATE ad_user_templates SET name = ?, description = ?, properties_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(
            name !== undefined ? name : tmpl.name,
            description !== undefined ? description : tmpl.description,
            properties !== undefined ? JSON.stringify(properties) : tmpl.properties_json,
            req.params.id
        );

    const updated = db.prepare('SELECT * FROM ad_user_templates WHERE id = ?').get(req.params.id);
    res.json({ ...updated, properties: JSON.parse(updated.properties_json || '{}') });
});

router.delete('/templates/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM ad_user_templates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
