const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../auth');
const { config, save } = require('../config');

router.use(requireAdmin);

router.get('/', (req, res) => {
    res.json({
        baseUrl: config.baseUrl,
        enrollmentKey: config.enrollmentKey,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        smtpUser: config.smtpUser,
        smtpFrom: config.smtpFrom,
        smtpTls: config.smtpTls,
        heartbeatInterval: config.heartbeatInterval,
        telemetryInterval: config.telemetryInterval,
        offlineThreshold: config.offlineThreshold
    });
});

router.post('/regenerate-enrollment-key', (req, res) => {
    const crypto = require('crypto');
    config.enrollmentKey = crypto.randomBytes(24).toString('hex');
    save(config);
    res.json({ enrollmentKey: config.enrollmentKey });
});

router.post('/', (req, res) => {
    const allowed = ['enrollmentKey', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'smtpFrom', 'smtpTls',
                     'heartbeatInterval', 'telemetryInterval', 'offlineThreshold'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            config[key] = req.body[key];
        }
    }

    save(config);
    res.json({ success: true });
});

router.post('/test-email', async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient email required' });
    if (!config.smtpHost) return res.status(400).json({ error: 'SMTP not configured' });

    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpPort === 465,
            auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
            tls: { rejectUnauthorized: false }
        });

        await transporter.sendMail({
            from: config.smtpFrom || config.smtpUser,
            to,
            subject: 'UniCentral - Test Email',
            text: 'This is a test email from UniCentral. If you received this, email notifications are working correctly.'
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
