const db = require('../db');
const { decryptSecret } = require('./secret-crypto');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

// In-memory access-token cache keyed by tenant row id: { token, expires }.
const tokenCache = new Map();

// Friendly names for the most common license SKUs. The Graph API only returns
// the GUID/skuPartNumber, so this maps the well-known ones to readable labels.
// Unknown SKUs fall back to their skuPartNumber.
const SKU_NAMES = {
    'ENTERPRISEPACK': 'Office 365 E3',
    'ENTERPRISEPREMIUM': 'Office 365 E5',
    'STANDARDPACK': 'Office 365 E1',
    'SPB': 'Microsoft 365 Business Premium',
    'O365_BUSINESS_PREMIUM': 'Microsoft 365 Business Standard',
    'O365_BUSINESS_ESSENTIALS': 'Microsoft 365 Business Basic',
    'O365_BUSINESS': 'Microsoft 365 Apps for Business',
    'OFFICESUBSCRIPTION': 'Microsoft 365 Apps for Enterprise',
    'SPE_E3': 'Microsoft 365 E3',
    'SPE_E5': 'Microsoft 365 E5',
    'SPE_F1': 'Microsoft 365 F3',
    'EXCHANGESTANDARD': 'Exchange Online (Plan 1)',
    'EXCHANGEENTERPRISE': 'Exchange Online (Plan 2)',
    'FLOW_FREE': 'Power Automate Free',
    'POWER_BI_STANDARD': 'Power BI (Free)',
    'TEAMS_EXPLORATORY': 'Teams Exploratory',
    'DEVELOPERPACK_E5': 'Microsoft 365 E5 Developer',
    'EMS': 'Enterprise Mobility + Security E3',
    'EMSPREMIUM': 'Enterprise Mobility + Security E5',
    'AAD_PREMIUM': 'Entra ID P1',
    'AAD_PREMIUM_P2': 'Entra ID P2'
};

function skuName(partNumber) {
    return SKU_NAMES[partNumber] || partNumber;
}

function getTenantRow(id) {
    const t = db.prepare('SELECT * FROM m365_tenants WHERE id = ?').get(id);
    if (!t) throw new Error('Tenant nicht gefunden');
    return t;
}

// Acquire (and cache) an application access token via the client-credentials
// flow for the given tenant row.
async function getToken(tenant) {
    const cached = tokenCache.get(tenant.id);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;

    const secret = decryptSecret(tenant.client_secret_enc);
    const body = new URLSearchParams({
        client_id: tenant.client_id,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
    });

    const res = await fetch(`${LOGIN}/${encodeURIComponent(tenant.tenant_id)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error_description || data.error || `Token-Anforderung fehlgeschlagen (${res.status})`);
    }
    tokenCache.set(tenant.id, {
        token: data.access_token,
        expires: Date.now() + (data.expires_in || 3600) * 1000
    });
    return data.access_token;
}

// Generic Graph request. Returns parsed JSON (or null for 204). Throws on error
// with the Graph error message.
async function graph(tenant, method, path, body) {
    const token = await getToken(tenant);
    const res = await fetch(GRAPH + path, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept-Charset': 'utf-8',
            'ConsistencyLevel': 'eventual'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
        const msg = (data.error && (data.error.message || data.error.code)) || `Graph-Fehler ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// Follow @odata.nextLink to gather all pages of a collection.
async function graphAll(tenant, path) {
    let url = path;
    const items = [];
    while (url) {
        const data = await graph(tenant, 'GET', url);
        if (Array.isArray(data.value)) items.push(...data.value);
        const next = data['@odata.nextLink'];
        url = next ? next.replace(GRAPH, '') : null;
    }
    return items;
}

async function testConnection(tenant) {
    let org;
    try {
        org = await graph(tenant, 'GET', '/organization?$select=displayName,verifiedDomains');
    } catch (err) {
        // A valid token but a 403 here means the app has no consented application
        // permissions. Point the admin at the actual fix.
        if (err.status === 403 || /privilege/i.test(err.message)) {
            throw new Error('Token gültig, aber fehlende Berechtigungen. Bitte in der App-Registrierung die Microsoft-Graph-Anwendungsberechtigungen (Organization.Read.All, User.ReadWrite.All, Group.ReadWrite.All, Directory.Read.All) hinzufügen und "Administratorzustimmung erteilen".');
        }
        throw err;
    }
    const o = (org.value && org.value[0]) || {};
    const primary = (o.verifiedDomains || []).find(d => d.isDefault) || (o.verifiedDomains || [])[0];
    return { displayName: o.displayName || '', defaultDomain: primary ? primary.name : '' };
}

const USER_SELECT = [
    'id', 'displayName', 'givenName', 'surname', 'userPrincipalName', 'mail',
    'jobTitle', 'department', 'companyName', 'officeLocation', 'businessPhones',
    'mobilePhone', 'faxNumber', 'streetAddress', 'city', 'state', 'postalCode',
    'country', 'accountEnabled', 'usageLocation', 'userType', 'assignedLicenses'
].join(',');

function mapUser(u, skuById, sharedIds) {
    const licenseIds = (u.assignedLicenses || []).map(l => l.skuId);
    const isShared = sharedIds ? sharedIds.has(u.id) : false;
    return {
        id: u.id,
        display_name: u.displayName || '',
        given_name: u.givenName || '',
        surname: u.surname || '',
        upn: u.userPrincipalName || '',
        mail: u.mail || '',
        job_title: u.jobTitle || '',
        department: u.department || '',
        company: u.companyName || '',
        office_location: u.officeLocation || '',
        business_phone: (u.businessPhones && u.businessPhones[0]) || '',
        mobile_phone: u.mobilePhone || '',
        fax: u.faxNumber || '',
        street: u.streetAddress || '',
        city: u.city || '',
        state: u.state || '',
        postal_code: u.postalCode || '',
        country: u.country || '',
        enabled: !!u.accountEnabled,
        usage_location: u.usageLocation || '',
        user_type: u.userType || 'Member',
        is_shared: isShared,
        account_type: u.userType === 'Guest' ? 'Gast' : (isShared ? 'Freigegebenes Postfach' : 'Benutzer'),
        licenses: licenseIds.map(id => (skuById[id] || id))
    };
}

async function listUsers(tenant) {
    const users = await graphAll(tenant, `/users?$select=${USER_SELECT}&$top=999`);
    const skus = await listSkus(tenant).catch(() => []);
    const byId = {};
    for (const s of skus) byId[s.skuId] = s.name;

    const sharedIds = await detectSharedMailboxes(tenant, users);
    return users.map(u => mapUser(u, byId, sharedIds));
}

async function detectSharedMailboxes(tenant, users) {
    const ids = new Set();
    const BATCH_SIZE = 20;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);
        const requests = batch.map((u, idx) => ({
            id: String(idx),
            method: 'GET',
            url: `/users/${u.id}/mailboxSettings`
        }));
        try {
            const res = await graph(tenant, 'POST', '/$batch', { requests });
            for (const r of (res.responses || [])) {
                if (r.body && r.body.userPurpose === 'shared') {
                    ids.add(batch[parseInt(r.id)].id);
                }
            }
        } catch { /* ignore batch errors */ }
    }
    return ids;
}

async function getUserGroups(tenant, userId) {
    const groups = await graphAll(tenant, `/users/${userId}/memberOf?$select=id,displayName,groupTypes,securityEnabled,mailEnabled`);
    return groups
        .filter(g => g['@odata.type'] === undefined || g['@odata.type'].includes('group'))
        .map(g => ({ id: g.id, display_name: g.displayName || '', security_enabled: !!g.securityEnabled, mail_enabled: !!g.mailEnabled }));
}

async function getUserLicenseDetails(tenant, userId) {
    const details = await graphAll(tenant, `/users/${userId}/licenseDetails`);
    return details.map(d => ({ sku_id: d.skuId, name: skuName(d.skuPartNumber), part_number: d.skuPartNumber }));
}

async function listDomains(tenant) {
    const data = await graph(tenant, 'GET', '/domains?$select=id,isDefault,isVerified');
    return (data.value || [])
        .filter(d => d.isVerified)
        .map(d => ({ name: d.id, is_default: !!d.isDefault }))
        .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
}

function classifyGroup(g) {
    const types = g.groupTypes || [];
    const unified = types.includes('Unified');
    const dynamic = types.includes('DynamicMembership');
    let type, type_label;
    if (unified) { type = 'unified'; type_label = 'Microsoft 365-Gruppe'; }
    else if (g.mailEnabled && g.securityEnabled) { type = 'mail_security'; type_label = 'E-Mail-akt. Sicherheitsgruppe'; }
    else if (g.mailEnabled) { type = 'distribution'; type_label = 'Verteilerliste'; }
    else { type = 'security'; type_label = 'Sicherheitsgruppe'; }
    // Graph can only manage membership of (non-dynamic) security and M365 groups.
    // Classic distribution lists / mail-enabled security groups are Exchange-managed.
    const manageable = !dynamic && (type === 'security' || type === 'unified');
    return { type, type_label, dynamic, manageable };
}

async function listGroups(tenant) {
    const groups = await graphAll(tenant, '/groups?$select=id,displayName,description,mail,groupTypes,securityEnabled,mailEnabled&$top=999');
    return groups.map(g => {
        const c = classifyGroup(g);
        return {
            id: g.id,
            display_name: g.displayName || '',
            description: g.description || '',
            mail: g.mail || '',
            security_enabled: !!g.securityEnabled,
            mail_enabled: !!g.mailEnabled,
            type: c.type,
            type_label: c.type_label,
            dynamic: c.dynamic,
            manageable: c.manageable,
            assignable: c.manageable
        };
    }).sort((a, b) => a.display_name.localeCompare(b.display_name, 'de'));
}

async function getGroupMembers(tenant, groupId) {
    const members = await graphAll(tenant, `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,mail`);
    return members.map(m => ({
        id: m.id,
        display_name: m.displayName || '',
        upn: m.userPrincipalName || '',
        mail: m.mail || ''
    })).sort((a, b) => a.display_name.localeCompare(b.display_name, 'de'));
}

// Available license SKUs in the tenant with consumed/total counts.
async function listSkus(tenant) {
    const data = await graph(tenant, 'GET', '/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits');
    return (data.value || []).map(s => ({
        sku_id: s.skuId,
        skuId: s.skuId,
        part_number: s.skuPartNumber,
        name: skuName(s.skuPartNumber),
        consumed: s.consumedUnits || 0,
        total: (s.prepaidUnits && s.prepaidUnits.enabled) || 0,
        available: ((s.prepaidUnits && s.prepaidUnits.enabled) || 0) - (s.consumedUnits || 0)
    })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// Scalar profile attributes shared by create and update (payload key -> Graph key).
const PROFILE_MAP = {
    display_name: 'displayName', given_name: 'givenName', surname: 'surname',
    job_title: 'jobTitle', department: 'department', company: 'companyName',
    office_location: 'officeLocation', mobile_phone: 'mobilePhone', fax: 'faxNumber',
    street: 'streetAddress', city: 'city', state: 'state', postal_code: 'postalCode',
    country: 'country', usage_location: 'usageLocation'
};

// Build the Graph body for the writable profile fields. When `forUpdate` is set,
// only keys present in the payload are included (PATCH semantics).
function profileBody(payload, forUpdate) {
    const body = {};
    for (const [k, gk] of Object.entries(PROFILE_MAP)) {
        if (forUpdate) {
            if (payload[k] !== undefined) body[gk] = payload[k] || null;
        } else if (payload[k]) {
            body[gk] = payload[k];
        }
    }
    if (payload.business_phone !== undefined) {
        body.businessPhones = payload.business_phone ? [payload.business_phone] : [];
    } else if (!forUpdate && payload.business_phone) {
        body.businessPhones = [payload.business_phone];
    }
    return body;
}

async function createUser(tenant, payload) {
    const body = Object.assign(profileBody(payload, false), {
        accountEnabled: payload.enabled !== false,
        userPrincipalName: payload.upn,
        mailNickname: (payload.upn || '').split('@')[0],
        passwordProfile: {
            password: payload.password,
            forceChangePasswordNextSignIn: payload.force_change !== false
        }
    });
    if (!body.displayName) body.displayName = payload.display_name;
    const user = await graph(tenant, 'POST', '/users', body);

    if (Array.isArray(payload.licenses) && payload.licenses.length) {
        await setUserLicenses(tenant, user.id, payload.licenses, []);
    }
    if (Array.isArray(payload.groups)) {
        for (const gid of payload.groups) {
            await addUserToGroup(tenant, user.id, gid).catch(() => {});
        }
    }
    if (payload.manager_id) {
        await setUserManager(tenant, user.id, payload.manager_id).catch(() => {});
    }
    return user;
}

async function updateUser(tenant, userId, payload) {
    const body = profileBody(payload, true);
    if (payload.enabled !== undefined) body.accountEnabled = !!payload.enabled;
    if (Object.keys(body).length) await graph(tenant, 'PATCH', `/users/${userId}`, body);
    return { ok: true };
}

async function getUserManager(tenant, userId) {
    try {
        const m = await graph(tenant, 'GET', `/users/${userId}/manager?$select=id,displayName,userPrincipalName`);
        return { id: m.id, display_name: m.displayName || '', upn: m.userPrincipalName || '' };
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

async function setUserManager(tenant, userId, managerId) {
    if (!managerId) {
        await graph(tenant, 'DELETE', `/users/${userId}/manager/$ref`).catch(err => {
            if (err.status !== 404) throw err;
        });
        return { ok: true };
    }
    await graph(tenant, 'PUT', `/users/${userId}/manager/$ref`, {
        '@odata.id': `${GRAPH}/users/${managerId}`
    });
    return { ok: true };
}

async function resetPassword(tenant, userId, password, forceChange) {
    await graph(tenant, 'PATCH', `/users/${userId}`, {
        passwordProfile: {
            password,
            forceChangePasswordNextSignIn: !!forceChange
        }
    });
    return { ok: true };
}

async function addUserToGroup(tenant, userId, groupId) {
    await graph(tenant, 'POST', `/groups/${groupId}/members/$ref`, {
        '@odata.id': `${GRAPH}/directoryObjects/${userId}`
    });
    return { ok: true };
}

async function removeUserFromGroup(tenant, userId, groupId) {
    await graph(tenant, 'DELETE', `/groups/${groupId}/members/${userId}/$ref`);
    return { ok: true };
}

// Add and/or remove license SKUs for a user in a single Graph call.
async function setUserLicenses(tenant, userId, addSkuIds, removeSkuIds) {
    await graph(tenant, 'POST', `/users/${userId}/assignLicense`, {
        addLicenses: (addSkuIds || []).map(id => ({ skuId: id, disabledPlans: [] })),
        removeLicenses: removeSkuIds || []
    });
    return { ok: true };
}

module.exports = {
    getTenantRow, testConnection, listUsers, getUserGroups, getUserLicenseDetails,
    listGroups, getGroupMembers, listDomains, listSkus, createUser, updateUser, resetPassword,
    getUserManager, setUserManager, addUserToGroup, removeUserFromGroup, setUserLicenses, skuName
};
