const axios = require('axios');
const db = require('../db');

const pollers = new Map();

function start() {
    const instances = db.prepare('SELECT * FROM veeam_instances').all();
    for (const instance of instances) {
        startPoller(instance);
    }
    console.log(`[Veeam] Started ${instances.length} poller(s)`);
}

function stop() {
    for (const [id, timer] of pollers) {
        clearInterval(timer);
    }
    pollers.clear();
}

function startPoller(instance) {
    if (pollers.has(instance.id)) {
        clearInterval(pollers.get(instance.id));
    }

    pollInstance(instance);
    const timer = setInterval(() => pollInstance(instance), (instance.poll_interval_seconds || 300) * 1000);
    pollers.set(instance.id, timer);
}

function stopPoller(instanceId) {
    if (pollers.has(instanceId)) {
        clearInterval(pollers.get(instanceId));
        pollers.delete(instanceId);
    }
}

async function pollInstance(instance) {
    try {
        const token = await authenticate(instance);
        if (!token) return;

        const jobs = await fetchJobs(instance, token);
        updateJobs(instance.id, jobs);

        db.prepare("UPDATE veeam_instances SET status = 'connected', last_polled = CURRENT_TIMESTAMP WHERE id = ?")
            .run(instance.id);
    } catch (err) {
        console.error(`[Veeam] Poll failed for ${instance.name}:`, err.message);
        db.prepare("UPDATE veeam_instances SET status = 'error' WHERE id = ?").run(instance.id);
    }
}

async function authenticate(instance) {
    const url = `${instance.base_url}/api/oauth2/token`;
    try {
        const res = await axios.post(url, 'grant_type=password&username=' +
            encodeURIComponent(instance.username) + '&password=' +
            encodeURIComponent(decrypt(instance.password_encrypted)), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: !!instance.verify_ssl })
        });
        return res.data.access_token;
    } catch (err) {
        throw new Error(`Auth failed: ${err.message}`);
    }
}

async function fetchJobs(instance, token) {
    const url = `${instance.base_url}/api/v1/jobs`;
    const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: !!instance.verify_ssl })
    });

    const jobs = res.data.data || res.data || [];

    // Fetch last session for each job
    const enriched = [];
    for (const job of jobs) {
        let lastStatus = '';
        let lastRunTime = null;
        try {
            const sessionsUrl = `${instance.base_url}/api/v1/jobs/${job.id}/includes`;
            // Try to get session info from the job object itself
            lastStatus = job.lastRun?.status || job.lastResult || '';
            lastRunTime = job.lastRun?.endTime || job.nextRun || null;
        } catch {}

        enriched.push({
            job_id: job.id || job.uid || String(Math.random()),
            job_name: job.name || 'Unknown',
            job_type: job.type || '',
            last_run_status: lastStatus,
            last_run_time: lastRunTime,
            next_run_time: job.nextRun || job.scheduledRunTime || null,
            target_name: job.virtualMachines?.[0]?.name || '',
            data_json: JSON.stringify(job)
        });
    }

    return enriched;
}

function updateJobs(instanceId, jobs) {
    for (const job of jobs) {
        db.prepare(`
            INSERT INTO backup_jobs (veeam_instance_id, job_id, job_name, job_type, last_run_status, last_run_time, next_run_time, target_name, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(veeam_instance_id, job_id) DO UPDATE SET
                job_name = excluded.job_name,
                job_type = excluded.job_type,
                last_run_status = excluded.last_run_status,
                last_run_time = excluded.last_run_time,
                next_run_time = excluded.next_run_time,
                target_name = excluded.target_name,
                data_json = excluded.data_json,
                updated_at = CURRENT_TIMESTAMP
        `).run(instanceId, job.job_id, job.job_name, job.job_type, job.last_run_status,
            job.last_run_time, job.next_run_time, job.target_name, job.data_json);
    }
}

function encrypt(text) {
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update(require('../config').config.sessionSecret).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
    if (!encrypted) return '';
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update(require('../config').config.sessionSecret).digest();
    const parts = encrypted.split(':');
    if (parts.length < 2) return encrypted;
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function testConnection(instance) {
    const token = await authenticate({ ...instance, password_encrypted: encrypt(instance.password) });
    return !!token;
}

module.exports = { start, stop, startPoller, stopPoller, encrypt, decrypt, testConnection };
