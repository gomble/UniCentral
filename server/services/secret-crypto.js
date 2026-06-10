const crypto = require('crypto');
const { config } = require('../config');

// Derive a stable 32-byte key from the server's session secret. The session
// secret is persisted in config.json, so encrypted values stay decryptable
// across restarts as long as that file is intact.
const KEY = crypto.createHash('sha256').update(String(config.sessionSecret) + ':m365').digest();

// Encrypt a UTF-8 string with AES-256-GCM. Output format: iv:tag:ciphertext
// (all hex), so the IV and auth tag travel with the value.
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(stored) {
    if (!stored) return '';
    const parts = String(stored).split(':');
    if (parts.length !== 3) return '';
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
