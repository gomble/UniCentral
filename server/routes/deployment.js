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

router.post('/update-agent', (req, res) => {
    const { machine_id } = req.body;

    if (!machine_id) {
        return res.status(400).json({ error: 'machine_id required' });
    }

    const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    if (machine.status !== 'online') {
        return res.status(400).json({ error: 'Machine is not online' });
    }

    const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;
    const arch = 'amd64';
    const downloadUrl = `${baseUrl}/api/agent/download/${machine.os_type}/${arch}`;

    const result = sendCommandToAgent(machine_id, 'update_agent', {
        download_url: downloadUrl
    });

    res.json(result);
});

router.post('/update-agent-manual', (req, res) => {
    const { machine_id } = req.body;

    const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;

    let command;
    if (machine.os_type === 'windows') {
        command = `Stop-Service UniCentralAgent -Force; Invoke-WebRequest -Uri '${baseUrl}/api/agent/download/windows/amd64' -OutFile 'C:\\Program Files\\UniCentral\\unicentral-agent.exe' -UseBasicParsing; Start-Service UniCentralAgent`;
    } else {
        command = `systemctl stop unicentral-agent && curl -sL '${baseUrl}/api/agent/download/linux/amd64' -o /usr/local/bin/unicentral-agent && chmod +x /usr/local/bin/unicentral-agent && systemctl start unicentral-agent`;
    }

    res.json({ command, os_type: machine.os_type });
});

router.get('/online-agents', (req, res) => {
    const agents = db.prepare("SELECT id, machine_id, hostname, display_name, os_type FROM machines WHERE status = 'online'").all();
    res.json(agents);
});

module.exports = router;
