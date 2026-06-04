const MAX = 600;
const entries = [];
const listeners = new Set();

function push(level, text) {
    const e = { ts: Date.now(), level, text };
    entries.push(e);
    if (entries.length > MAX) entries.shift();
    listeners.forEach(fn => fn(e));
}

function intercept() {
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a) => { orig.log(...a); push('info', a.map(String).join(' ')); };
    console.error = (...a) => { orig.error(...a); push('error', a.map(String).join(' ')); };
    console.warn = (...a) => { orig.warn(...a); push('warn', a.map(String).join(' ')); };
}

function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

module.exports = { entries, intercept, subscribe };
