const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const veeamPoller = require('../services/veeam-poller');

router.use(requireAuth);

router.get('/instances', (req, res) => {
    const instances = db.prepare('SELECT id, name, base_url, username, verify_ssl, poll_interval_seconds, last_polled, status, created_at FROM veeam_instances').all();
    res.json(instances);
});

router.post('/instances', requireAdmin, (req, res) => {
    const { name, base_url, username, password, verify_ssl, poll_interval_seconds } = req.body;
    if (!name || !base_url || !username || !password) {
        return res.status(400).json({ error: 'name, base_url, username, and password required' });
    }

    const encrypted = veeamPoller.encrypt(password);
    const result = db.prepare(`
        INSERT INTO veeam_instances (name, base_url, username, password_encrypted, verify_ssl, poll_interval_seconds)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, base_url, username, encrypted, verify_ssl ? 1 : 0, poll_interval_seconds || 300);

    const instance = db.prepare('SELECT * FROM veeam_instances WHERE id = ?').get(result.lastInsertRowid);
    veeamPoller.startPoller(instance);

    res.status(201).json({ id: instance.id, name: instance.name, base_url: instance.base_url, status: instance.status });
});

router.put('/instances/:id', requireAdmin, (req, res) => {
    const { name, base_url, username, password, verify_ssl, poll_interval_seconds } = req.body;
    const instance = db.prepare('SELECT * FROM veeam_instances WHERE id = ?').get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const encrypted = password ? veeamPoller.encrypt(password) : instance.password_encrypted;
    db.prepare(`
        UPDATE veeam_instances SET
            name = COALESCE(?, name),
            base_url = COALESCE(?, base_url),
            username = COALESCE(?, username),
            password_encrypted = ?,
            verify_ssl = ?,
            poll_interval_seconds = ?
        WHERE id = ?
    `).run(name, base_url, username, encrypted, verify_ssl ? 1 : 0, poll_interval_seconds || 300, req.params.id);

    const updated = db.prepare('SELECT * FROM veeam_instances WHERE id = ?').get(req.params.id);
    veeamPoller.startPoller(updated);

    res.json({ success: true });
});

router.delete('/instances/:id', requireAdmin, (req, res) => {
    veeamPoller.stopPoller(parseInt(req.params.id));
    db.prepare('DELETE FROM veeam_instances WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

router.get('/instances/:id/jobs', (req, res) => {
    const jobs = db.prepare(`
        SELECT * FROM backup_jobs
        WHERE veeam_instance_id = ?
        ORDER BY job_name ASC
    `).all(req.params.id);
    res.json(jobs);
});

router.get('/jobs', (req, res) => {
    const jobs = db.prepare(`
        SELECT bj.*, vi.name as instance_name
        FROM backup_jobs bj
        JOIN veeam_instances vi ON bj.veeam_instance_id = vi.id
        ORDER BY bj.last_run_status DESC, bj.job_name ASC
    `).all();
    res.json(jobs);
});

router.post('/instances/:id/test', requireAdmin, async (req, res) => {
    const instance = db.prepare('SELECT * FROM veeam_instances WHERE id = ?').get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    try {
        await veeamPoller.testConnection({
            base_url: instance.base_url,
            username: instance.username,
            password: veeamPoller.decrypt(instance.password_encrypted),
            verify_ssl: instance.verify_ssl
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
