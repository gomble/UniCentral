const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../auth');
const { config } = require('../config');
const { sendCommandToAgent, getConnectedAgents } = require('../ws/agent-handler');

router.use(requireAdmin);

router.post('/deploy', (req, res) => {
    const { target_ip, target_os, username, password, category, relay_machine_id } = req.body;

    if (!target_ip || !username) {
        return res.status(400).json({ error: 'target_ip and username required' });
    }

    if (!relay_machine_id) {
        return res.status(400).json({ error: 'relay_machine_id required (agent to deploy from)' });
    }

    const relay = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(relay_machine_id);
    if (!relay || relay.status !== 'online') {
        return res.status(400).json({ error: 'Relay machine not online' });
    }

    const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;

    const result = sendCommandToAgent(relay_machine_id, 'deploy_neighbor', {
        target_ip,
        target_os: target_os || 'windows',
        username,
        password: password || '',
        server_url: baseUrl,
        enrollment_key: config.enrollmentKey,
        category: category || 'client'
    });

    res.json(result);
});

router.get('/online-agents', (req, res) => {
    const agents = db.prepare("SELECT id, machine_id, hostname, display_name, os_type FROM machines WHERE status = 'online'").all();
    res.json(agents);
});

module.exports = router;
