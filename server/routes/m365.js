const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { encryptSecret } = require('../services/secret-crypto');
const m365 = require('../services/m365');

router.use(requireAuth);

// Send JSON with non-ASCII characters escaped to \uXXXX for safe transport.
function escapeNonAscii(str) {
    return str.replace(/[^\x20-\x7E]/g, ch => {
        const cp = ch.codePointAt(0);
        if (cp > 0xFFFF) {
            const hi = Math.floor((cp - 0x10000) / 0x400) + 0xD800;
            const lo = ((cp - 0x10000) % 0x400) + 0xDC00;
            return '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
        }
        return '\\u' + cp.toString(16).padStart(4, '0');
    });
}
function sendJson(res, obj) {
    const json = escapeNonAscii(JSON.stringify(obj));
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(json);
}
function handle(res, promise) {
    promise
        .then(data => sendJson(res, data === undefined ? { ok: true } : data))
        .catch(err => res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message }));
}

function publicTenant(t) {
    return {
        id: t.id, group_id: t.group_id, name: t.name, tenant_id: t.tenant_id,
        client_id: t.client_id, default_domain: t.default_domain,
        status: t.status, last_error: t.last_error, last_checked: t.last_checked
    };
}

// ---- Tenants ----
router.get('/tenants', (req, res) => {
    const tenants = db.prepare('SELECT * FROM m365_tenants ORDER BY name ASC').all();
    res.json(tenants.map(publicTenant));
});

router.post('/tenants', requireAdmin, (req, res) => {
    const { name, tenant_id, client_id, client_secret, group_id } = req.body;
    if (!name || !tenant_id || !client_id || !client_secret) {
        return res.status(400).json({ error: 'Name, Tenant-ID, Client-ID und Client-Secret erforderlich' });
    }
    const r = db.prepare(`
        INSERT INTO m365_tenants (group_id, name, tenant_id, client_id, client_secret_enc, status)
        VALUES (?, ?, ?, ?, ?, 'unknown')
    `).run(group_id || null, name, tenant_id, client_id, encryptSecret(client_secret));
    res.status(201).json(publicTenant(db.prepare('SELECT * FROM m365_tenants WHERE id = ?').get(r.lastInsertRowid)));
});

router.put('/tenants/:id', requireAdmin, (req, res) => {
    const t = db.prepare('SELECT * FROM m365_tenants WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tenant nicht gefunden' });
    const { name, tenant_id, client_id, client_secret, group_id } = req.body;
    db.prepare(`
        UPDATE m365_tenants SET name = ?, tenant_id = ?, client_id = ?,
            client_secret_enc = ?, group_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name !== undefined ? name : t.name,
        tenant_id !== undefined ? tenant_id : t.tenant_id,
        client_id !== undefined ? client_id : t.client_id,
        client_secret ? encryptSecret(client_secret) : t.client_secret_enc,
        group_id !== undefined ? (group_id || null) : t.group_id,
        req.params.id
    );
    res.json(publicTenant(db.prepare('SELECT * FROM m365_tenants WHERE id = ?').get(req.params.id)));
});

router.delete('/tenants/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM m365_tenants WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// Test connection and persist status / discovered default domain.
router.post('/tenants/:id/test', requireAdmin, async (req, res) => {
    let tenant;
    try { tenant = m365.getTenantRow(req.params.id); } catch (e) { return res.status(404).json({ error: e.message }); }
    try {
        const info = await m365.testConnection(tenant);
        db.prepare("UPDATE m365_tenants SET status = 'connected', last_error = '', default_domain = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?")
            .run(info.defaultDomain || tenant.default_domain || '', tenant.id);
        res.json({ ok: true, ...info });
    } catch (err) {
        db.prepare("UPDATE m365_tenants SET status = 'error', last_error = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?")
            .run(err.message, tenant.id);
        res.status(400).json({ error: err.message });
    }
});

// Resolve a tenant row or 404. Used by all per-tenant data endpoints.
function tenantOr404(req, res) {
    try { return m365.getTenantRow(req.params.id); }
    catch (e) { res.status(404).json({ error: e.message }); return null; }
}

// ---- Per-tenant directory data ----
router.get('/tenants/:id/users', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.listUsers(t));
});

router.get('/tenants/:id/groups', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.listGroups(t));
});

router.get('/tenants/:id/skus', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.listSkus(t));
});

router.get('/tenants/:id/domains', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.listDomains(t));
});

router.get('/tenants/:id/users/:userId/groups', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.getUserGroups(t, req.params.userId));
});

router.get('/tenants/:id/users/:userId/licenses', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.getUserLicenseDetails(t, req.params.userId));
});

router.get('/tenants/:id/users/:userId/manager', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.getUserManager(t, req.params.userId));
});

router.get('/tenants/:id/groups/:groupId/members', (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.getGroupMembers(t, req.params.groupId));
});

router.post('/tenants/:id/groups/:groupId/members', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    if (!req.body.user_id) return res.status(400).json({ error: 'user_id erforderlich' });
    handle(res, m365.addUserToGroup(t, req.body.user_id, req.params.groupId));
});

router.delete('/tenants/:id/groups/:groupId/members/:userId', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.removeUserFromGroup(t, req.params.userId, req.params.groupId));
});

// ---- User operations ----
router.post('/tenants/:id/users', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.createUser(t, req.body));
});

router.patch('/tenants/:id/users/:userId', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.updateUser(t, req.params.userId, req.body));
});

router.post('/tenants/:id/users/:userId/manager', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.setUserManager(t, req.params.userId, req.body.manager_id || null));
});

router.post('/tenants/:id/users/:userId/password', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    const { password, force_change } = req.body;
    if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });
    handle(res, m365.resetPassword(t, req.params.userId, password, force_change));
});

router.post('/tenants/:id/users/:userId/groups', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.addUserToGroup(t, req.params.userId, req.body.group_id));
});

router.delete('/tenants/:id/users/:userId/groups/:groupId', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    handle(res, m365.removeUserFromGroup(t, req.params.userId, req.params.groupId));
});

router.post('/tenants/:id/users/:userId/licenses', requireAdmin, (req, res) => {
    const t = tenantOr404(req, res); if (!t) return;
    const { add, remove } = req.body;
    handle(res, m365.setUserLicenses(t, req.params.userId, add || [], remove || []));
});

module.exports = router;
