const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

router.use(requireAuth);

router.get('/rules', (req, res) => {
    const rules = db.prepare('SELECT * FROM notification_rules ORDER BY created_at DESC').all();
    res.json(rules);
});

router.post('/rules', requireAdmin, (req, res) => {
    const { name, condition_type, condition_params, target_email, cooldown_minutes } = req.body;
    if (!name || !condition_type || !target_email) {
        return res.status(400).json({ error: 'name, condition_type, and target_email required' });
    }

    db.prepare(`
        INSERT INTO notification_rules (name, condition_type, condition_params, target_email, cooldown_minutes)
        VALUES (?, ?, ?, ?, ?)
    `).run(name, condition_type, JSON.stringify(condition_params || {}), target_email, cooldown_minutes || 60);

    res.status(201).json({ success: true });
});

router.put('/rules/:id', requireAdmin, (req, res) => {
    const { name, condition_type, target_email, enabled, cooldown_minutes } = req.body;
    db.prepare(`
        UPDATE notification_rules SET
            name = COALESCE(?, name),
            condition_type = COALESCE(?, condition_type),
            target_email = COALESCE(?, target_email),
            enabled = COALESCE(?, enabled),
            cooldown_minutes = COALESCE(?, cooldown_minutes)
        WHERE id = ?
    `).run(name, condition_type, target_email, enabled, cooldown_minutes, req.params.id);

    res.json({ success: true });
});

router.delete('/rules/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM notification_rules WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
