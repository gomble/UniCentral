const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const defaults = {
    port: 3000,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    heartbeatInterval: 30,
    telemetryInterval: 300,
    offlineThreshold: 90,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPassword: '',
    smtpFrom: '',
    smtpTls: true
};

function load() {
    let saved = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) {
            console.error('[Config] Failed to parse config.json:', e.message);
        }
    }

    const config = { ...defaults, ...saved };

    config.port = parseInt(process.env.PORT || config.port, 10);
    config.sessionSecret = process.env.SESSION_SECRET || config.sessionSecret;
    config.smtpHost = process.env.SMTP_HOST || config.smtpHost;
    config.smtpPort = parseInt(process.env.SMTP_PORT || config.smtpPort, 10);
    config.smtpUser = process.env.SMTP_USER || config.smtpUser;
    config.smtpPassword = process.env.SMTP_PASSWORD || config.smtpPassword;
    config.smtpFrom = process.env.SMTP_FROM || config.smtpFrom;

    return config;
}

function save(config) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = load();

module.exports = { config, save, load };
