const { v4: uuidv4 } = require('uuid');

const MSG_TYPES = {
    // Agent -> Server
    REGISTER: 'register',
    HEARTBEAT: 'heartbeat',
    TELEMETRY: 'telemetry',
    COMMAND_RESULT: 'command_result',

    // Server -> Agent
    REGISTERED: 'registered',
    COMMAND: 'command',
    UPDATE_AGENT: 'update_agent',
    CONFIG_UPDATE: 'config_update',
    ERROR: 'error'
};

function createMessage(type, payload) {
    return JSON.stringify({
        type,
        id: uuidv4(),
        timestamp: Math.floor(Date.now() / 1000),
        payload
    });
}

function parseMessage(raw) {
    try {
        const msg = JSON.parse(raw);
        if (!msg.type || !msg.payload) return null;
        return msg;
    } catch {
        return null;
    }
}

module.exports = { MSG_TYPES, createMessage, parseMessage };
