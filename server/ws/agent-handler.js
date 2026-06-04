const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { MSG_TYPES, createMessage, parseMessage } = require('./protocol');

const connectedAgents = new Map();

function verifyHmac(machineId, timestamp, signature) {
    const machine = db.prepare('SELECT machine_secret FROM machines WHERE machine_id = ?').get(machineId);
    if (!machine || !machine.machine_secret) return false;
    const expected = crypto.createHmac('sha256', machine.machine_secret)
        .update(`${machineId}:${timestamp}`)
        .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

function generateMachineSecret() {
    return crypto.randomBytes(32).toString('hex');
}

function initAgentWebSocket(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        const pathname = url.parse(request.url).pathname;
        console.log(`[WS] Upgrade request: ${pathname}`);

        if (pathname === '/ws/agent') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (pathname === '/ws/dashboard') {
            sessionMiddleware(request, {}, () => {
                if (!request.session || !request.session.authenticated) {
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(request, socket, head, (ws) => {
                    ws._isDashboard = true;
                    wss.emit('connection', ws, request);
                });
            });
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', (ws, request) => {
        if (ws._isDashboard) {
            handleDashboardConnection(ws);
            return;
        }
        handleAgentConnection(ws, request);
    });

    setInterval(() => checkOfflineMachines(), 30000);

    return wss;
}

function handleAgentConnection(ws, request) {
    const params = new URLSearchParams(url.parse(request.url).query);
    const enrollmentKey = params.get('enrollment_key');
    const machineId = params.get('machine_id');
    const signature = params.get('sig');
    const timestamp = params.get('ts');
    // Legacy support for old token-based registration
    const token = params.get('token');

    console.log(`[WS] Agent connection: machine_id=${machineId || 'none'}, enrollment_key=${enrollmentKey ? 'present' : 'none'}, token=${token ? 'present' : 'none'}`);

    let currentMachineId = null;

    ws.on('message', (raw) => {
        const msg = parseMessage(raw);
        if (!msg) {
            console.log('[WS] Failed to parse message:', raw.toString().slice(0, 200));
            return;
        }
        console.log(`[WS] Message received: type=${msg.type}`);

        switch (msg.type) {
            case MSG_TYPES.REGISTER:
                handleRegister(ws, enrollmentKey || token, msg.payload);
                break;
            case MSG_TYPES.HEARTBEAT:
                handleHeartbeat(currentMachineId || ws._machineId, msg.payload);
                break;
            case MSG_TYPES.TELEMETRY:
                handleTelemetry(currentMachineId || ws._machineId, msg.payload);
                break;
            case MSG_TYPES.COMMAND_RESULT:
                handleCommandResult(currentMachineId || ws._machineId, msg.payload);
                break;
        }
    });

    ws.on('close', () => {
        const id = currentMachineId || ws._machineId;
        if (id) {
            connectedAgents.delete(id);
            broadcastToDashboards({ type: 'machine_disconnected', machineId: id });
        }
    });

    ws.on('error', () => {
        const id = currentMachineId || ws._machineId;
        if (id) connectedAgents.delete(id);
    });

    // Reconnect with HMAC authentication
    if (machineId && signature && timestamp) {
        const tsAge = Math.abs(Date.now() / 1000 - parseInt(timestamp));
        if (tsAge > 300) {
            ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Signature expired' }));
            ws.close();
            return;
        }
        if (!verifyHmac(machineId, timestamp, signature)) {
            ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Invalid signature' }));
            ws.close();
            return;
        }
        const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(machineId);
        if (machine) {
            currentMachineId = machineId;
            connectedAgents.set(machineId, ws);
            ws._machineId = machineId;
            db.prepare('UPDATE machines SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE machine_id = ?')
                .run('online', machineId);
            broadcastToDashboards({ type: 'machine_connected', machineId });
        } else {
            ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Unknown machine' }));
            ws.close();
        }
        return;
    }

    // Legacy: reconnect by machine_id without HMAC (for backwards compat during migration)
    if (machineId && !signature) {
        const machine = db.prepare('SELECT * FROM machines WHERE machine_id = ?').get(machineId);
        if (machine) {
            currentMachineId = machineId;
            connectedAgents.set(machineId, ws);
            ws._machineId = machineId;
            db.prepare('UPDATE machines SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE machine_id = ?')
                .run('online', machineId);
            broadcastToDashboards({ type: 'machine_connected', machineId });
        } else {
            ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Unknown machine' }));
            ws.close();
        }
    }
}

function handleRegister(ws, key, payload) {
    const { hostname, os_type, os_version, agent_version, ip_addresses, category } = payload;
    console.log(`[WS] Register attempt: hostname=${hostname}, os=${os_type}, key_match=${key === config.enrollmentKey}`);

    // Validate enrollment key or legacy token
    if (key === config.enrollmentKey) {
        try {
        // Self-registration with enrollment key - create machine automatically
        const { v4: uuidv4 } = require('uuid');
        const machineId = uuidv4();
        const machineSecret = generateMachineSecret();

        db.prepare(`
            INSERT INTO machines (machine_id, hostname, os_type, category, agent_version, ip_address, status, last_seen, machine_secret)
            VALUES (?, ?, ?, ?, ?, ?, 'online', CURRENT_TIMESTAMP, ?)
        `).run(
            machineId,
            hostname || 'unknown',
            os_type || 'windows',
            category || 'client',
            agent_version || '',
            Array.isArray(ip_addresses) ? ip_addresses.join(', ') : (ip_addresses || ''),
            machineSecret
        );

        ws._machineId = machineId;
        connectedAgents.set(machineId, ws);

        ws.send(createMessage(MSG_TYPES.REGISTERED, {
            machine_id: machineId,
            machine_secret: machineSecret,
            heartbeat_interval: config.heartbeatInterval,
            telemetry_interval: config.telemetryInterval
        }));

        console.log(`[WS] Machine registered: ${machineId} (${hostname})`);
        broadcastToDashboards({ type: 'machine_registered', machineId });
        return;
        } catch (err) {
            console.error('[WS] Registration failed:', err.message);
            ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Registration failed: ' + err.message }));
            ws.close();
            return;
        }
    }

    // Legacy: token-based registration (pre-created machine)
    const machine = db.prepare('SELECT * FROM machines WHERE registration_token = ?').get(key);
    if (!machine) {
        ws.send(createMessage(MSG_TYPES.ERROR, { message: 'Invalid enrollment key or token' }));
        ws.close();
        return;
    }

    const machineSecret = generateMachineSecret();

    db.prepare(`
        UPDATE machines SET
            hostname = ?,
            os_type = ?,
            agent_version = ?,
            ip_address = ?,
            status = 'online',
            last_seen = CURRENT_TIMESTAMP,
            registration_token = NULL,
            machine_secret = ?
        WHERE machine_id = ?
    `).run(
        hostname || machine.hostname,
        os_type || machine.os_type,
        agent_version || '',
        Array.isArray(ip_addresses) ? ip_addresses.join(', ') : (ip_addresses || ''),
        machineSecret,
        machine.machine_id
    );

    ws._machineId = machine.machine_id;
    connectedAgents.set(machine.machine_id, ws);

    ws.send(createMessage(MSG_TYPES.REGISTERED, {
        machine_id: machine.machine_id,
        machine_secret: machineSecret,
        heartbeat_interval: config.heartbeatInterval,
        telemetry_interval: config.telemetryInterval
    }));

    broadcastToDashboards({ type: 'machine_registered', machineId: machine.machine_id });
}

function handleHeartbeat(machineId, payload) {
    if (!machineId) return;

    if (payload.agent_version) {
        db.prepare(`
            UPDATE machines SET
                status = 'online',
                last_seen = CURRENT_TIMESTAMP,
                agent_version = ?
            WHERE machine_id = ?
        `).run(payload.agent_version, machineId);
    } else {
        db.prepare(`
            UPDATE machines SET
                status = 'online',
                last_seen = CURRENT_TIMESTAMP
            WHERE machine_id = ?
        `).run(machineId);
    }

    if (payload.cpu_percent !== undefined) {
        broadcastToDashboards({
            type: 'heartbeat',
            machineId,
            data: payload
        });
    }
}

function handleTelemetry(machineId, payload) {
    if (!machineId) return;

    db.prepare(`
        INSERT INTO machine_telemetry (machine_id, cpu_percent, memory_percent, uptime_seconds, data_json)
        VALUES (?, ?, ?, ?, ?)
    `).run(machineId, payload.cpu_percent, payload.memory_percent, payload.uptime_seconds, JSON.stringify(payload));

    if (payload.disks) {
        db.prepare('DELETE FROM disks WHERE machine_id = ?').run(machineId);
        const stmt = db.prepare(`
            INSERT INTO disks (machine_id, drive_letter, mount_point, total_bytes, free_bytes, health_status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const disk of payload.disks) {
            stmt.run(machineId, disk.drive_letter || '', disk.mount_point || '', disk.total_bytes, disk.free_bytes, disk.health_status || 'unknown');
        }
    }

    if (payload.services) {
        for (const svc of payload.services) {
            db.prepare(`
                INSERT INTO services_monitored (machine_id, service_name, display_name, status, start_type)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(machine_id, service_name) DO UPDATE SET
                    display_name = excluded.display_name,
                    status = excluded.status,
                    start_type = excluded.start_type,
                    updated_at = CURRENT_TIMESTAMP
            `).run(machineId, svc.name, svc.display_name || '', svc.status, svc.start_type || '');
        }
    }

    if (payload.shares) {
        db.prepare('DELETE FROM network_shares WHERE machine_id = ?').run(machineId);
        const stmt = db.prepare('INSERT INTO network_shares (machine_id, share_name, path, description) VALUES (?, ?, ?, ?)');
        for (const share of payload.shares) {
            stmt.run(machineId, share.name, share.path || '', share.description || '');
        }
    }

    if (payload.firewall && payload.firewall.rules) {
        db.prepare('DELETE FROM firewall_rules WHERE machine_id = ?').run(machineId);
        const stmt = db.prepare(`
            INSERT INTO firewall_rules (machine_id, rule_name, direction, action, protocol, port, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const rule of payload.firewall.rules) {
            stmt.run(machineId, rule.name || '', rule.direction || '', rule.action || '', rule.protocol || '', rule.port || '', rule.enabled ? 1 : 0);
        }
    }

    broadcastToDashboards({ type: 'telemetry', machineId, data: payload });
}

function handleCommandResult(machineId, payload) {
    if (!machineId || !payload.command_id) return;

    db.prepare(`
        UPDATE command_log SET
            status = ?,
            result = ?,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND machine_id = ?
    `).run(payload.status || 'completed', payload.result || '', payload.command_id, machineId);

    broadcastToDashboards({ type: 'command_result', machineId, data: payload });
}

function checkOfflineMachines() {
    const threshold = config.offlineThreshold;
    db.prepare(`
        UPDATE machines SET status = 'offline'
        WHERE status = 'online'
        AND last_seen < datetime('now', '-${threshold} seconds')
    `).run();
}

// Dashboard WebSocket connections
const dashboardClients = new Set();

function handleDashboardConnection(ws) {
    dashboardClients.add(ws);
    ws.on('close', () => dashboardClients.delete(ws));
    ws.on('error', () => dashboardClients.delete(ws));
}

function broadcastToDashboards(data) {
    const msg = JSON.stringify(data);
    for (const client of dashboardClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

function sendCommandToAgent(machineId, commandType, parameters) {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Agent not connected' };
    }

    const cmdLog = db.prepare(`
        INSERT INTO command_log (machine_id, command_type, parameters, status, issued_by)
        VALUES (?, ?, ?, 'sent', ?)
    `).run(machineId, commandType, JSON.stringify(parameters), 'system');

    ws.send(createMessage(MSG_TYPES.COMMAND, {
        command_id: cmdLog.lastInsertRowid,
        type: commandType,
        parameters
    }));

    return { success: true, command_id: cmdLog.lastInsertRowid };
}

function getConnectedAgents() {
    return connectedAgents;
}

module.exports = { initAgentWebSocket, sendCommandToAgent, getConnectedAgents };
