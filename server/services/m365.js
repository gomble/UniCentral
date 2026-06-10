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
            'ConsistencyLevel': 'eventual'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
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
    const org = await graph(tenant, 'GET', '/organization?$select=displayName,verifiedDomains');
    const o = (org.value && org.value[0]) || {};
    const primary = (o.verifiedDomains || []).find(d => d.isDefault) || (o.verifiedDomains || [])[0];
    return { displayName: o.displayName || '', defaultDomain: primary ? primary.name : '' };
}

async function listUsers(tenant) {
    const select = 'id,displayName,givenName,surname,userPrincipalName,mail,jobTitle,department,accountEnabled,usageLocation,assignedLicenses';
    const users = await graphAll(tenant, `/users?$select=${select}&$top=999`);
    // Map license SKU ids to names per user for quick display in the table.
    const skus = await listSkus(tenant).catch(() => []);
    const byId = {};
    for (const s of skus) byId[s.skuId] = s.name;
    return users.map(u => ({
        id: u.id,
        display_name: u.displayName || '',
        given_name: u.givenName || '',
        surname: u.surname || '',
        upn: u.userPrincipalName || '',
        mail: u.mail || '',
        job_title: u.jobTitle || '',
        department: u.department || '',
        enabled: !!u.accountEnabled,
        usage_location: u.usageLocation || '',
        licenses: (u.assignedLicenses || []).map(l => byId[l.skuId] || l.skuId)
    }));
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

async function listGroups(tenant) {
    const groups = await graphAll(tenant, '/groups?$select=id,displayName,description,groupTypes,securityEnabled,mailEnabled&$top=999');
    return groups.map(g => ({
        id: g.id,
        display_name: g.displayName || '',
        description: g.description || '',
        security_enabled: !!g.securityEnabled,
        mail_enabled: !!g.mailEnabled,
        assignable: !((g.groupTypes || []).includes('DynamicMembership'))
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

async function createUser(tenant, payload) {
    const body = {
        accountEnabled: payload.enabled !== false,
        displayName: payload.display_name,
        givenName: payload.given_name || undefined,
        surname: payload.surname || undefined,
        userPrincipalName: payload.upn,
        mailNickname: (payload.upn || '').split('@')[0],
        jobTitle: payload.job_title || undefined,
        department: payload.department || undefined,
        usageLocation: payload.usage_location || undefined,
        passwordProfile: {
            password: payload.password,
            forceChangePasswordNextSignIn: payload.force_change !== false
        }
    };
    const user = await graph(tenant, 'POST', '/users', body);

    // Assign licenses (requires usageLocation to be set, which we do above).
    if (Array.isArray(payload.licenses) && payload.licenses.length) {
        await setUserLicenses(tenant, user.id, payload.licenses, []);
    }
    // Add to groups.
    if (Array.isArray(payload.groups)) {
        for (const gid of payload.groups) {
            await addUserToGroup(tenant, user.id, gid).catch(() => {});
        }
    }
    return user;
}

async function updateUser(tenant, userId, payload) {
    const body = {};
    const map = {
        display_name: 'displayName', given_name: 'givenName', surname: 'surname',
        job_title: 'jobTitle', department: 'department', usage_location: 'usageLocation'
    };
    for (const [k, gk] of Object.entries(map)) {
        if (payload[k] !== undefined) body[gk] = payload[k];
    }
    if (payload.enabled !== undefined) body.accountEnabled = !!payload.enabled;
    if (Object.keys(body).length) await graph(tenant, 'PATCH', `/users/${userId}`, body);
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
    listGroups, listDomains, listSkus, createUser, updateUser, resetPassword,
    addUserToGroup, removeUserFromGroup, setUserLicenses, skuName
};
