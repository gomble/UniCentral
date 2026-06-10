const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const defaults = {
    port: 3000,
    baseUrl: '',
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    enrollmentKey: crypto.randomBytes(24).toString('hex'),
    heartbeatInterval: 30,
    telemetryInterval: 300,
    offlineThreshold: 90,
    autoInstallDefenderUpdates: true,
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
    config.baseUrl = process.env.BASE_URL || config.baseUrl;
    config.sessionSecret = process.env.SESSION_SECRET || config.sessionSecret;
    if (process.env.ENROLLMENT_KEY) config.enrollmentKey = process.env.ENROLLMENT_KEY;
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

// Persist config on first run to ensure enrollmentKey and sessionSecret are stable
if (!fs.existsSync(CONFIG_PATH)) {
    save(config);
}

module.exports = { config, save, load };
