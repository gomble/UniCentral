const { createApp, ref, reactive, onMounted, onUnmounted, computed, nextTick } = Vue;

// Wrapper around fetch that redirects to /login.html on 401 (expired session).
async function apiFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        window.location.href = '/login.html';
        return new Response('{}', { status: 401 });
    }
    return res;
}

// Reusable table component: global search, click-to-sort headers and optional
// per-column value filters. Cells are rendered through scoped slots named
// "cell-<key>" so each table keeps full control over its markup.
// Column shape: { key, label, sortable?, searchable?, filter?, value?(row),
//   sortValue?(row), thStyle?, tdStyle?, tdClass?, stopClick?, placeholder? }
const DataTable = {
    name: 'DataTable',
    props: {
        rows: { type: Array, default: () => [] },
        columns: { type: Array, required: true },
        rowKey: { type: String, default: 'id' },
        rowClickable: { type: Boolean, default: false },
        search: { type: Boolean, default: true },
        searchPlaceholder: { type: String, default: 'Suchen...' },
        initialSortKey: { type: String, default: '' },
        initialSortDir: { type: String, default: 'asc' },
        emptyText: { type: String, default: 'Keine Eintraege vorhanden.' },
        tableClass: { type: String, default: 'machine-table' },
        tableStyle: { type: [String, Object], default: '' }
    },
    emits: ['row-click'],
    setup(props, { emit }) {
        const q = ref('');
        const sortKey = ref(props.initialSortKey);
        const sortDir = ref(props.initialSortDir === 'desc' ? 'desc' : 'asc');
        const colFilters = reactive({});

        const toStr = (v) => (v === null || v === undefined ? '' : String(v));
        const cellValue = (row, col) => (typeof col.value === 'function' ? col.value(row) : row[col.key]);
        const sortBase = (row, col) => (typeof col.sortValue === 'function' ? col.sortValue(row) : cellValue(row, col));
        const isSortable = (col) => col.sortable !== false && !!col.key;

        function toggleSort(col) {
            if (!isSortable(col)) return;
            if (sortKey.value === col.key) {
                sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
            } else {
                sortKey.value = col.key;
                sortDir.value = 'asc';
            }
        }
        function onCellClick(e, col) { if (col.stopClick) e.stopPropagation(); }
        function onRowClick(row) { if (props.rowClickable) emit('row-click', row); }
        function rowKeyOf(row, i) {
            const k = row[props.rowKey];
            return k !== undefined && k !== null ? k : i;
        }
        function display(row, col) {
            const v = cellValue(row, col);
            return v === null || v === undefined || v === '' ? (col.placeholder || '') : v;
        }
        function distinctValues(col) {
            const set = new Set();
            props.rows.forEach(r => {
                const v = cellValue(r, col);
                if (v !== null && v !== undefined && v !== '') set.add(String(v));
            });
            return [...set].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
        }

        const searchCols = computed(() =>
            props.columns.filter(c => c.searchable !== false && (c.key || typeof c.value === 'function'))
        );

        const viewRows = computed(() => {
            let list = props.rows.slice();
            const term = q.value.trim().toLowerCase();
            if (term) {
                list = list.filter(r => searchCols.value.some(c => toStr(cellValue(r, c)).toLowerCase().includes(term)));
            }
            for (const key of Object.keys(colFilters)) {
                const fv = colFilters[key];
                if (!fv) continue;
                const col = props.columns.find(c => c.key === key);
                if (col) list = list.filter(r => toStr(cellValue(r, col)) === fv);
            }
            if (sortKey.value) {
                const col = props.columns.find(c => c.key === sortKey.value);
                if (col) {
                    const dir = sortDir.value === 'desc' ? -1 : 1;
                    list.sort((a, b) => {
                        const av = sortBase(a, col), bv = sortBase(b, col);
                        const ae = av === null || av === undefined || av === '';
                        const be = bv === null || bv === undefined || bv === '';
                        if (ae && be) return 0;
                        if (ae) return 1;
                        if (be) return -1;
                        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                        return toStr(av).localeCompare(toStr(bv), 'de', { numeric: true }) * dir;
                    });
                }
            }
            return list;
        });

        return { q, sortKey, sortDir, colFilters, cellValue, isSortable, toggleSort,
            onCellClick, onRowClick, rowKeyOf, display, distinctValues, viewRows };
    },
    template: `
    <div class="data-table">
        <div class="dt-toolbar" v-if="search || $slots.toolbar">
            <input v-if="search" class="dt-search" type="text" v-model="q" :placeholder="searchPlaceholder">
            <slot name="toolbar"></slot>
            <span class="dt-count">{{ viewRows.length }}<template v-if="viewRows.length !== rows.length"> / {{ rows.length }}</template></span>
        </div>
        <table :class="tableClass" :style="tableStyle">
            <thead>
                <tr>
                    <th v-for="col in columns" :key="col.key || col.label" :style="col.thStyle" :class="[{ 'dt-sortable': isSortable(col) }, col.thClass]">
                        <span class="dt-th-label" @click="toggleSort(col)">
                            <slot :name="'header-' + col.key" :col="col">{{ col.label }}</slot>
                            <span v-if="col.key && sortKey === col.key" class="dt-sort">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                        </span>
                        <select v-if="col.filter" class="dt-col-filter" v-model="colFilters[col.key]" @click.stop>
                            <option value="">Alle</option>
                            <option v-for="v in distinctValues(col)" :key="v" :value="v">{{ v }}</option>
                        </select>
                    </th>
                </tr>
            </thead>
            <tbody>
                <template v-for="(row, i) in viewRows" :key="rowKeyOf(row, i)">
                    <tr :class="{ 'dt-row-clickable': rowClickable }" @click="onRowClick(row)">
                        <td v-for="col in columns" :key="col.key || col.label" :style="col.tdStyle" :class="col.tdClass" :data-label="col.label" @click="onCellClick($event, col)">
                            <slot :name="'cell-' + col.key" :row="row" :value="cellValue(row, col)">{{ display(row, col) }}</slot>
                        </td>
                    </tr>
                    <slot name="row-extra" :row="row"></slot>
                </template>
            </tbody>
        </table>
        <p v-if="!viewRows.length" class="dt-empty">{{ emptyText }}</p>
    </div>`
};

const app = createApp({
    setup() {
        const view = ref('dashboard');
        const sidebarOpen = ref(false);
        const username = ref('');
        const machines = ref([]);
        const stats = ref({});
        const alerts = ref([]);
        const alertCount = computed(() => alerts.value.filter(a => !a.acknowledged).length);

        const showVnc = ref(false);
        const vncSrc = ref('');
        const vncHostname = ref('');
        const vncPort = ref(5900);
        const vncPreparing = ref(false);
        const vncPrepareStatus = ref('');
        let _vncMachineId = '';

        async function openVNC(machine, port) {
            const machineId = machine.machine_id;
            const name = machine.display_name || machine.hostname;

            if (machine.os_type === 'linux') {
                const shellUrl = `/shell.html?machineId=${encodeURIComponent(machineId)}&hostname=${encodeURIComponent(name)}`;
                window.open(shellUrl, `shell_${machineId}`, 'width=1000,height=600,menubar=no,toolbar=no,location=no,status=no');
                return;
            }

            const vncP = port || 5900;
            try {
                const r = await apiFetch(`/api/vnc/prepare/${encodeURIComponent(machineId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ port: vncP })
                });
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    toast(`VNC-Fehler: ${e.error || r.status}`, 'error');
                    return;
                }
            } catch (e) {
                toast(`VNC-Fehler: ${e.message}`, 'error');
                return;
            }

            const url = `/vnc.html?machineId=${encodeURIComponent(machineId)}&hostname=${encodeURIComponent(name)}`;
            window.open(url, `vnc_${machineId}`, 'width=1280,height=800,menubar=no,toolbar=no,location=no,status=no');
        }

        function closeVnc() {
            showVnc.value = false;
            vncSrc.value = '';
            vncPreparing.value = false;
        }

        function reconnectVnc() {
            vncPreparing.value = false;
            vncSrc.value = `/vnc.html?machineId=${encodeURIComponent(_vncMachineId)}&hostname=${encodeURIComponent(vncHostname.value)}`;
        }

        const showAddMachine = ref(false);
        const showTokenModal = ref(false);
        const showAddVeeam = ref(false);
        const veeamInstances = ref([]);
        const newVeeam = reactive({
            name: '', base_url: '', username: '', password: '',
            poll_interval_seconds: 300, verify_ssl: false
        });
        const veeamServers = ref([]);
        const showVeeamHistory = ref(false);
        const veeamHistoryJob = ref(null);
        const veeamHistorySessions = ref([]);
        const veeamHistoryLoading = ref(false);
        const showGroupsModal = ref(false);
        const groups = ref([]);
        const newGroupName = ref('');
        const filterGroup = ref(null);
        const filteredMachines = computed(() => {
            if (filterGroup.value === null) return machines.value;
            if (filterGroup.value === 'ungrouped') return machines.value.filter(m => !m.group_id);
            return machines.value.filter(m => m.group_id === filterGroup.value);
        });
        const showEditMachine = ref(false);
        const editMachineForm = reactive({ display_name: '', hostname: '', category: '', group_id: '' });
        const showDeployModal = ref(false);
        const onlineAgents = ref([]);
        const scanning = ref(false);
        const scanDone = ref(false);
        const scanResults = ref([]);
        const deployTargets = ref([]);
        const deployForm = reactive({
            relay_machine_id: '', target_ip: '', target_os: 'windows',
            username: '', password: '', category: 'client'
        });
        const deployResult = ref(null);
        const deployCommandMap = ref({});
        const showBatchInstall = ref(false);
        const batchInstallPkg = ref('');
        const batchInstallMethod = ref('auto');
        const selectedMachines = ref([]);
        const commandHistory = ref([]);
        const liveCommand = ref(null);

        // Updates tab state
        const updatesOsTab = ref('windows');
        const updatesMachines = ref([]);
        const updatesSelected = ref([]);
        const updatesBatchTime = ref('');
        const updatesBatchReboot = ref(true);
        const updatesLogMachine = ref(null);
        const updatesLogs = ref([]);
        const updatesLogsLoading = ref(false);
        const updatesScheduleMachine = ref(null);
        const updatesPendingModal = ref(null);
        const updatesScheduleForm = reactive({ time: '', reboot: true });
        const updatesLiveStreams = ref({});
        const batchJobResults = ref(null);
        const tokenMachine = ref({});
        const selectedMachine = ref(null);
        const machineDisks = ref([]);
        const machineServices = ref([]);
        const machineFirewall = ref({ enabled: false, rules: [] });
        const machineUpdates = ref({ available: 0, pending: [], reboot_required: false });
        const machineShares = ref([]);
        const telemetryHistory = ref([]);
        const telemetryRange = ref('24h');
        const scheduleTime = ref('');
        const telemetryCanvas = ref(null);
        const baseUrl = ref(window.location.origin);

        const newMachine = reactive({
            hostname: '',
            os_type: 'windows',
            category: 'server',
            display_name: ''
        });

        // Disk Explorer state
        const diskExplorerMachineId = ref('');
        const diskExplorerPath = ref('');
        const diskExplorerLoading = ref(false);
        const diskExplorerData = ref(null);
        const diskExplorerHistory = ref([]);
        const showDiskExplorer = ref(false);

        const diskExplorerBreadcrumbs = computed(() => {
            if (!diskExplorerData.value) return [];
            const path = diskExplorerData.value.path;
            const isWin = /^[A-Za-z]:\\/i.test(path);
            if (isWin) {
                const parts = path.split('\\').filter(Boolean);
                return parts.map((part, i) => ({
                    label: i === 0 ? part + '\\' : part,
                    path: i === 0 ? part + '\\' : parts.slice(0, i + 1).join('\\')
                }));
            }
            const parts = path.split('/').filter(Boolean);
            const crumbs = [{ label: '/', path: '/' }];
            return crumbs.concat(parts.map((part, i) => ({
                label: part,
                path: '/' + parts.slice(0, i + 1).join('/')
            })));
        });

        const settingsForm = reactive({
            smtpHost: '',
            smtpPort: 587,
            smtpUser: '',
            smtpPassword: '',
            smtpFrom: '',
            smtpTls: true,
            heartbeatInterval: 30,
            telemetryInterval: 300,
            offlineThreshold: 90,
            autoInstallDefenderUpdates: true
        });

        const toasts = ref([]);
        const confirmData = ref(null);

        function toast(message, type = 'info') {
            const id = Date.now();
            toasts.value.push({ id, message, type });
            setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, 4000);
        }

        function confirmDialog(message) {
            return new Promise(resolve => {
                confirmData.value = { message, resolve };
            });
        }

        let ws = null;
        let popstateHandler = null;

        onMounted(async () => {
            const authRes = await fetch('/auth/check');
            const auth = await authRes.json();
            if (!auth.authenticated) {
                window.location.href = '/login.html';
                return;
            }
            username.value = auth.username;

            const hash = location.hash.replace('#', '');
            let initialView = 'dashboard';
            let initialId = null;
            if (hash) {
                const parts = hash.split('/');
                initialView = parts[0] || 'dashboard';
                initialId = parts[1] || null;
            }
            history.replaceState({ view: initialView, id: initialId }, '', '#' + initialView + (initialId ? '/' + initialId : ''));
            navigateInternal(initialView, initialId);

            popstateHandler = (e) => {
                if (e.state && e.state.view) navigateInternal(e.state.view, e.state.id);
                else navigateInternal('dashboard');
            };
            window.addEventListener('popstate', popstateHandler);

            await loadDashboard();
            connectWebSocket();
        });

        onUnmounted(() => {
            if (ws) ws.close();
            disconnectLogStream();
            if (popstateHandler) window.removeEventListener('popstate', popstateHandler);
        });

        let wsEverConnected = false;
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws/dashboard`);

            ws.onopen = () => {
                if (wsEverConnected) {
                    loadMachines();
                    loadStats();
                }
                wsEverConnected = true;
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleWsEvent(data);
                } catch {}
            };

            ws.onclose = () => {
                setTimeout(connectWebSocket, 3000);
            };
        }

        function handleWsEvent(data) {
            if (data.type === 'machine_connected' || data.type === 'machine_disconnected' || data.type === 'machine_registered') {
                if (data.type === 'machine_disconnected' && batchJobResults.value) {
                    const entry = batchJobResults.value.machines.find(m => m.machine_id === data.machineId);
                    if (entry && ['sent', 'running'].includes(entry.status)) {
                        entry.status = 'disconnected';
                        entry.completedAt = new Date().toISOString();
                    }
                }
                loadMachines();
                loadStats();
            } else if (data.type === 'heartbeat') {
                const m = machines.value.find(x => x.machine_id === data.machineId);
                if (m) m.status = 'online';
            } else if (data.type === 'telemetry') {
                if (view.value === 'machine-detail' && selectedMachine.value && selectedMachine.value.machine_id === data.machineId) {
                    loadMachineDetail(selectedMachine.value.id);
                    rescanLoading.value = false;
                }
            } else if (data.type === 'command_result') {
                handleCommandResultEvent(data);
            } else if (data.type === 'veeam_updated') {
                if (view.value === 'veeam') loadVeeamServers();
            }
        }

        function handleCommandResultEvent(data) {
            const p = data.data || {};

            // AD command results
            if (p.command_type === 'ad_list_users') {
                if (p.status === 'completed') {
                    try {
                        const parsed = JSON.parse(p.result);
                        adUsers.value = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                        adUsersOutput.value = '';
                    } catch { adUsersOutput.value = 'Fehler beim Verarbeiten der Benutzerliste'; }
                    adUsersLoading.value = false;
                } else if (p.status === 'failed') {
                    adUsersLoading.value = false;
                    adUsersOutput.value = '';
                    toast('Benutzer-Abruf fehlgeschlagen: ' + (p.result || ''), 'error');
                }
            }
            if (['ad_create_user', 'ad_update_user', 'ad_delete_user'].includes(p.command_type)) {
                if (p.status === 'completed') { toast(p.result || 'Operation erfolgreich', 'success'); loadADUsers(); }
                else if (p.status === 'failed') { toast('Fehler: ' + (p.result || 'Unbekannter Fehler'), 'error'); }
            }
            if (p.command_type === 'ad_list_ous') {
                if (p.status === 'completed') { try { const parsed = JSON.parse(p.result); adOUs.value = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []); } catch {} }
            }
            if (p.command_type === 'ad_move_user') {
                if (p.status === 'completed') { toast('Benutzer erfolgreich verschoben', 'success'); loadADUsers(); }
                else if (p.status === 'failed') { toast('Fehler: ' + (p.result || ''), 'error'); }
            }
            if (p.command_type === 'local_list_users') {
                if (p.status === 'completed') { try { const parsed = JSON.parse(p.result); localUsers.value = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []); } catch {} localUsersLoading.value = false; }
                else if (p.status === 'failed') { localUsersLoading.value = false; toast('Fehler: ' + (p.result || ''), 'error'); }
            }
            if (['local_create_user', 'local_update_user', 'local_delete_user'].includes(p.command_type)) {
                if (p.status === 'completed') { toast(p.result || 'Operation erfolgreich', 'success'); loadLocalUsers(); }
                else if (p.status === 'failed') { toast('Fehler: ' + (p.result || ''), 'error'); }
            }
            if (p.command_type === 'scan_disk' && data.machineId === diskExplorerMachineId.value) {
                if (p.status === 'completed') {
                    try { diskExplorerData.value = JSON.parse(p.result); } catch {}
                    diskExplorerLoading.value = false;
                } else if (p.status === 'failed') {
                    toast('Scan fehlgeschlagen: ' + (p.result || ''), 'error');
                    diskExplorerLoading.value = false;
                }
            }

            // Live progress for machine-detail view
            if (selectedMachine.value && selectedMachine.value.machine_id === data.machineId) {
                if (!liveCommand.value || liveCommand.value.command_id === p.command_id || p.status === 'running') {
                    liveCommand.value = {
                        command_id: p.command_id,
                        status: p.status,
                        result: p.result || '',
                        machine_id: data.machineId
                    };
                }
            }

            // Track live streams for Updates tab (all command types)
            updatesLiveStreams.value = {
                ...updatesLiveStreams.value,
                [data.machineId]: { command_id: p.command_id, status: p.status, output: p.result || '' }
            };

            // On terminal status: refresh the updates machine list row + logs if open
            const isUpdateCmd = ['trigger_updates', 'trigger_updates_reboot', 'install_defender_updates'].includes(p.command_type);
            if (isUpdateCmd && (p.status === 'completed' || p.status === 'failed')) {
                loadUpdatesMachines();
                if (updatesLogMachine.value && updatesLogMachine.value.machine_id === data.machineId) {
                    loadMachineUpdateLogs(data.machineId);
                }
            }

            // Update batch job results panel
            if (batchJobResults.value && isUpdateCmd) {
                const entry = batchJobResults.value.machines.find(m => m.machine_id === data.machineId);
                if (entry) {
                    entry.status = p.status || 'completed';
                    if (p.result) entry.output = p.result;
                    if (!['sent', 'running'].includes(entry.status)) entry.completedAt = new Date().toISOString();
                }
            }

            // Update deploy modal results
            if (p.command_id && deployCommandMap.value[p.command_id] && deployResult.value && deployResult.value.details) {
                const ip = deployCommandMap.value[p.command_id];
                const d = deployResult.value.details.find(x => x.ip === ip);
                if (d && (p.status === 'completed' || p.status === 'failed')) {
                    d.success = p.status === 'completed';
                    d.message = p.result || p.status;
                    const done = deployResult.value.details.filter(x => x.success !== null).length;
                    const ok = deployResult.value.details.filter(x => x.success === true).length;
                    deployResult.value.message = `${done}/${deployResult.value.details.length} abgeschlossen, ${ok} erfolgreich`;
                    if (done === deployResult.value.details.length) loadMachines();
                }
            }

            // Keep command history in sync
            const row = commandHistory.value.find(c => c.id === p.command_id);
            if (row) {
                row.status = p.status;
                row.result = p.result || row.result;
            }
        }

        async function loadDashboard() {
            await Promise.all([loadMachines(), loadStats(), loadAlerts(), loadSettings(), loadVeeamInstances(), loadVeeamServers(), loadOnlineAgents(), loadGroups()]);
        }

        async function loadGroups() {
            const res = await apiFetch('/api/machines/groups/list');
            if (res.ok) groups.value = await res.json();
        }

        async function addGroup() {
            if (!newGroupName.value) return;
            await apiFetch('/api/machines/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newGroupName.value })
            });
            newGroupName.value = '';
            await loadGroups();
        }

        async function deleteGroup(id) {
            if (!await confirmDialog('Gruppe entfernen?')) return;
            await apiFetch(`/api/machines/groups/${id}`, { method: 'DELETE' });
            await loadGroups();
            await loadMachines();
        }

        async function assignGroup(machineId, groupId) {
            await apiFetch(`/api/machines/${machineId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId || null })
            });
            await loadMachines();
        }

        async function loadMachines() {
            const res = await apiFetch('/api/machines');
            if (res.ok) {
                machines.value = await res.json();
                loadDashboardTelemetry();
            }
        }

        async function loadDashboardTelemetry() {
            const res = await apiFetch('/api/monitoring/dashboard-telemetry');
            if (res.ok) {
                const tel = await res.json();
                for (const m of machines.value) {
                    m._telemetry = tel[m.machine_id] || null;
                }
            }
        }

        async function loadStats() {
            const res = await apiFetch('/api/monitoring/overview');
            if (res.ok) stats.value = await res.json();
        }

        async function loadAlerts() {
            const res = await apiFetch('/api/monitoring/alerts');
            if (res.ok) alerts.value = await res.json();
        }

        async function loadSettings() {
            const res = await apiFetch('/api/settings');
            if (res.ok) {
                const data = await res.json();
                Object.assign(settingsForm, data);
                if (data.baseUrl) baseUrl.value = data.baseUrl;
            }
        }

        function navigateInternal(target, id) {
            view.value = target;
            if (target === 'machine-detail' && id) {
                loadMachineDetail(id);
            } else if (target === 'machines' || target === 'dashboard') {
                disconnectLogStream();
                loadMachines();
                loadStats();
            } else if (target === 'command-history') {
                disconnectLogStream();
                loadCommandHistory();
            } else if (target === 'updates') {
                disconnectLogStream();
                loadUpdatesMachines();
            } else if (target === 'ad-admin') {
                disconnectLogStream();
                loadADDomainControllers();
                loadADTemplates();
            } else if (target === 'logs') {
                connectLogStream();
                loadCommandHistory();
            } else if (target === 'm365') {
                disconnectLogStream();
                loadM365();
            } else if (target === 'veeam') {
                disconnectLogStream();
                loadVeeamInstances();
                loadVeeamServers();
            } else if (target === 'security') {
                disconnectLogStream();
                loadSecurityOverview();
            } else if (target === 'insights') {
                disconnectLogStream();
                loadInsights();
            } else {
                disconnectLogStream();
            }
        }

        function navigate(target, id) {
            sidebarOpen.value = false;
            history.pushState({ view: target, id: id || null }, '', '#' + target + (id ? '/' + id : ''));
            navigateInternal(target, id);
        }

        async function loadUpdatesMachines() {
            const res = await apiFetch('/api/updates/machines');
            if (res.ok) updatesMachines.value = await res.json();
        }

        const updatesFilteredMachines = computed(() =>
            updatesMachines.value.filter(m => m.os_type === updatesOsTab.value)
        );

        function updatesToggleAll(e) {
            const ids = updatesFilteredMachines.value.map(m => m.machine_id);
            updatesSelected.value = e.target.checked ? ids : [];
        }

        async function triggerBatchUpdates() {
            const online = updatesSelected.value.filter(mid => {
                const m = updatesMachines.value.find(x => x.machine_id === mid);
                return m && m.status === 'online';
            });
            if (!online.length) { toast('Keine der ausgewählten Maschinen ist online.', 'error'); return; }
            const label = updatesBatchReboot.value ? 'Updates installieren + Neustart bei Bedarf' : 'Updates installieren (ohne Neustart)';
            if (!await confirmDialog(`${label} auf ${online.length} Maschine(n)?`)) return;

            const res = await apiFetch('/api/updates/trigger-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_ids: online, reboot: updatesBatchReboot.value })
            });
            if (res.ok) {
                const r = await res.json();
                const ok = r.results.filter(x => x.success).length;
                toast(`Update-Befehl gesendet an ${ok} Maschine(n).`, 'success');
                batchJobResults.value = {
                    triggeredAt: new Date().toISOString(),
                    label,
                    machines: online.map(mid => {
                        const m = updatesMachines.value.find(x => x.machine_id === mid);
                        const sent = r.results.find(x => x.machine_id === mid);
                        return {
                            machine_id: mid,
                            hostname: m ? (m.display_name || m.hostname) : mid,
                            os_type: m?.os_type || '',
                            sendSuccess: sent?.success ?? false,
                            sendError: sent?.error || '',
                            status: sent?.success ? 'sent' : 'error',
                            output: '',
                            completedAt: null
                        };
                    })
                };
                updatesSelected.value = [];
                await loadUpdatesMachines();
            }
        }

        async function triggerSingleUpdate(machineId, reboot) {
            const res = await apiFetch('/api/updates/trigger-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_ids: [machineId], reboot })
            });
            if (res.ok) toast('Update-Befehl gesendet.', 'success');
        }

        async function openUpdateLog(machine) {
            updatesLogMachine.value = machine;
            updatesLogs.value = [];
            updatesLogsLoading.value = true;
            await loadMachineUpdateLogs(machine.machine_id);
        }

        async function loadMachineUpdateLogs(machineId) {
            updatesLogsLoading.value = true;
            const res = await apiFetch(`/api/updates/logs/${machineId}`);
            if (res.ok) updatesLogs.value = await res.json();
            updatesLogsLoading.value = false;
        }

        function openScheduleModal(machine) {
            updatesScheduleMachine.value = machine;
            updatesScheduleForm.time = machine.schedule_time || '';
            updatesScheduleForm.reboot = machine.schedule_reboot !== 0;
        }

        async function saveSchedule() {
            const m = updatesScheduleMachine.value;
            if (!m || !updatesScheduleForm.time) return;
            const res = await apiFetch('/api/updates/schedules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_id: m.machine_id, schedule_time: updatesScheduleForm.time, reboot: updatesScheduleForm.reboot })
            });
            if (res.ok) {
                toast(`Zeitplan gesetzt: ${updatesScheduleForm.time} Uhr täglich.`, 'success');
                updatesScheduleMachine.value = null;
                await loadUpdatesMachines();
            }
        }

        async function removeSchedule(machineId) {
            if (!await confirmDialog('Zeitplan für diese Maschine entfernen?')) return;
            await apiFetch(`/api/updates/schedules/${machineId}`, { method: 'DELETE' });
            updatesScheduleMachine.value = null;
            await loadUpdatesMachines();
        }

        async function setBatchSchedule() {
            if (!updatesBatchTime.value) { toast('Bitte eine Uhrzeit eingeben.', 'error'); return; }
            if (!updatesSelected.value.length) { toast('Keine Maschinen ausgewählt.', 'error'); return; }
            if (!await confirmDialog(`Zeitplan ${updatesBatchTime.value} Uhr für ${updatesSelected.value.length} Maschine(n) setzen?`)) return;
            for (const mid of updatesSelected.value) {
                await apiFetch('/api/updates/schedules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ machine_id: mid, schedule_time: updatesBatchTime.value, reboot: updatesBatchReboot.value })
                });
            }
            toast(`Zeitplan gesetzt für ${updatesSelected.value.length} Maschine(n).`, 'success');
            updatesSelected.value = [];
            await loadUpdatesMachines();
        }

        async function loadMachineDetail(id) {
            const res = await apiFetch(`/api/machines/${id}`);
            if (res.ok) {
                selectedMachine.value = await res.json();
                const mid = selectedMachine.value.machine_id;

                const [disksRes, servicesRes, firewallRes, updatesRes, sharesRes] = await Promise.all([
                    fetch(`/api/monitoring/machines/${mid}/disks`),
                    fetch(`/api/monitoring/machines/${mid}/services`),
                    fetch(`/api/monitoring/machines/${mid}/firewall-status`),
                    fetch(`/api/monitoring/machines/${mid}/updates`),
                    fetch(`/api/monitoring/machines/${mid}/shares`)
                ]);
                if (disksRes.ok) machineDisks.value = await disksRes.json();
                if (servicesRes.ok) machineServices.value = await servicesRes.json();
                if (firewallRes.ok) machineFirewall.value = await firewallRes.json();
                if (updatesRes.ok) machineUpdates.value = await updatesRes.json();
                if (sharesRes.ok) machineShares.value = await sharesRes.json();

                await loadTelemetryHistory();
            }
        }

        async function loadTelemetryHistory() {
            if (!selectedMachine.value) return;
            const mid = selectedMachine.value.machine_id;
            const res = await apiFetch(`/api/monitoring/machines/${mid}/telemetry?range=${telemetryRange.value}`);
            if (res.ok) {
                telemetryHistory.value = await res.json();
                setTimeout(() => drawChart(), 50);
            }
        }

        function drawChart() {
            const canvas = telemetryCanvas.value;
            if (!canvas || !telemetryHistory.value.length) return;

            const ctx = canvas.getContext('2d');
            const rect = canvas.parentElement.getBoundingClientRect();
            canvas.width = rect.width;
            canvas.height = rect.height;

            const data = telemetryHistory.value;
            const w = canvas.width;
            const h = canvas.height;
            const padding = { top: 20, right: 10, bottom: 30, left: 40 };
            const chartW = w - padding.left - padding.right;
            const chartH = h - padding.top - padding.bottom;

            ctx.clearRect(0, 0, w, h);

            // Grid
            ctx.strokeStyle = '#2a3a4e';
            ctx.lineWidth = 0.5;
            for (let i = 0; i <= 4; i++) {
                const y = padding.top + (chartH / 4) * i;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(w - padding.right, y);
                ctx.stroke();
                ctx.fillStyle = '#5c6f82';
                ctx.font = '10px sans-serif';
                ctx.fillText((100 - i * 25) + '%', 5, y + 4);
            }

            // CPU line
            ctx.beginPath();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 1.5;
            data.forEach((d, i) => {
                const x = padding.left + (i / (data.length - 1)) * chartW;
                const y = padding.top + chartH - (d.cpu_percent / 100) * chartH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Memory line
            ctx.beginPath();
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 1.5;
            data.forEach((d, i) => {
                const x = padding.left + (i / (data.length - 1)) * chartW;
                const y = padding.top + chartH - (d.memory_percent / 100) * chartH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Legend
            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(padding.left, h - 15, 12, 3);
            ctx.fillStyle = '#8899aa';
            ctx.font = '11px sans-serif';
            ctx.fillText('CPU', padding.left + 16, h - 10);

            ctx.fillStyle = '#22c55e';
            ctx.fillRect(padding.left + 60, h - 15, 12, 3);
            ctx.fillStyle = '#8899aa';
            ctx.fillText('RAM', padding.left + 76, h - 10);
        }

        async function addMachine() {
            const res = await apiFetch('/api/machines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newMachine)
            });
            if (res.ok) {
                const machine = await res.json();
                showAddMachine.value = false;
                newMachine.hostname = '';
                newMachine.display_name = '';
                await loadMachines();
                tokenMachine.value = machine;
                showTokenModal.value = true;
            }
        }

        async function deleteMachine(m) {
            if (!await confirmDialog('Maschine "' + m.hostname + '" wirklich entfernen?')) return;
            await apiFetch(`/api/machines/${m.id}`, { method: 'DELETE' });
            await loadMachines();
            await loadStats();
        }

        function showToken(m) {
            tokenMachine.value = m;
            showTokenModal.value = true;
        }

        const rescanLoading = ref(false);

        async function triggerRescan(machine) {
            if (!machine || machine.status !== 'online') return;
            rescanLoading.value = true;
            try {
                const r = await apiFetch(`/api/commands/${machine.machine_id}/rescan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                if (r.ok) {
                    toast('Scan gestartet, Daten werden aktualisiert...', 'success');
                } else {
                    toast('Scan fehlgeschlagen', 'error');
                }
            } catch {
                toast('Scan fehlgeschlagen', 'error');
            }
            setTimeout(() => { rescanLoading.value = false; }, 3000);
        }

        async function sendCommand(type) {
            if (!selectedMachine.value) return;
            if (!await confirmDialog(type === 'restart' ? 'Neustart ausfuehren?' : 'Herunterfahren ausfuehren?')) return;

            await apiFetch(`/api/commands/${selectedMachine.value.machine_id}/${type}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
        }

        function openEditMachine() {
            if (!selectedMachine.value) return;
            editMachineForm.display_name = selectedMachine.value.display_name || '';
            editMachineForm.hostname = selectedMachine.value.hostname || '';
            editMachineForm.category = selectedMachine.value.category || 'client';
            editMachineForm.group_id = selectedMachine.value.group_id || '';
            showEditMachine.value = true;
        }

        async function saveEditMachine() {
            if (!selectedMachine.value) return;
            await apiFetch(`/api/machines/${selectedMachine.value.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editMachineForm)
            });
            showEditMachine.value = false;
            await loadMachineDetail(selectedMachine.value.id);
            await loadMachines();
        }

        async function triggerUpdates(mode) {
            if (!selectedMachine.value) return;
            const endpoint = mode === 'reboot' ? 'trigger-updates-reboot' : 'trigger-updates';
            const msg = mode === 'reboot' ? 'Updates installieren und danach neustarten?' : 'Updates installieren (ohne Neustart)?';
            if (!await confirmDialog(msg)) return;
            liveCommand.value = { command_id: null, status: 'sent', result: 'Update-Befehl gesendet, warte auf Agent...', machine_id: selectedMachine.value.machine_id };
            const res = await apiFetch(`/api/commands/${selectedMachine.value.machine_id}/${endpoint}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            try {
                const r = await res.json();
                if (r && r.command_id && liveCommand.value) liveCommand.value.command_id = r.command_id;
                if (r && r.success === false) { liveCommand.value = null; toast('Fehler: ' + (r.error || 'Befehl nicht gesendet'), 'error'); return; }
            } catch {}
            toast('Update-Befehl gesendet.', 'success');
        }

        async function scheduleUpdates() {
            if (!selectedMachine.value || !scheduleTime.value) return;
            if (!await confirmDialog('Updates + Neustart fuer ' + scheduleTime.value + ' Uhr planen?')) return;
            await apiFetch(`/api/commands/${selectedMachine.value.machine_id}/schedule-updates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: scheduleTime.value })
            });
            toast(`Update geplant fuer ${scheduleTime.value} Uhr.`, 'success');
        }

        async function updateAgent() {
            if (!selectedMachine.value) return;

            const res = await apiFetch('/api/deploy/update-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_id: selectedMachine.value.machine_id })
            });
            const data = await res.json();

            if (data.success) {
                toast('Update-Befehl gesendet. Agent startet neu.', 'success');
            } else if (data.error && data.error.includes('unknown command')) {
                // Old agent doesn't support update_agent - show manual command
                const manRes = await apiFetch('/api/deploy/update-agent-manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ machine_id: selectedMachine.value.machine_id })
                });
                const manData = await manRes.json();
                toast('Agent unterstuetzt Remote-Update noch nicht. Manueller Befehl in Konsole kopiert.', 'warning');
                navigator.clipboard.writeText(manData.command).catch(() => {});
            } else {
                toast(data.error || 'Update fehlgeschlagen', 'error');
            }
        }

        async function saveSettings() {
            const res = await apiFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settingsForm)
            });
            if (res.ok) toast('Einstellungen gespeichert', 'success');
        }

        async function testEmail() {
            const to = prompt('Email-Adresse fuer Testmail:');
            if (!to) return;
            const res = await apiFetch('/api/settings/test-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to })
            });
            const data = await res.json();
            toast(data.success ? 'Test-Email gesendet!' : 'Fehler: ' + data.error, data.success ? 'success' : 'error');
        }

        async function loadOnlineAgents() {
            const res = await apiFetch('/api/deploy/online-agents');
            if (res.ok) onlineAgents.value = await res.json();
        }

        async function scanNetwork() {
            if (!deployForm.relay_machine_id) return;
            scanning.value = true;
            scanDone.value = false;
            scanResults.value = [];
            deployTargets.value = [];
            deployResult.value = null;

            const res = await apiFetch('/api/deploy/scan-network', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ relay_machine_id: deployForm.relay_machine_id })
            });
            const data = await res.json();

            if (data.success) {
                // Poll command result for up to 60 seconds
                const cmdId = data.command_id;
                for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const checkRes = await apiFetch(`/api/commands/${deployForm.relay_machine_id}/history`);
                    if (checkRes.ok) {
                        const cmds = await checkRes.json();
                        const cmd = cmds.find(c => c.id === cmdId);
                        if (cmd && cmd.status === 'completed') {
                            try {
                                const hosts = JSON.parse(cmd.result);
                                // Filter out already registered machines
                                const registered = machines.value.map(m => m.ip_address).join(',');
                                scanResults.value = hosts.filter(h => !registered.includes(h.ip)).map(h => ({
                                    ...h,
                                    category: h.os_guess === 'windows' ? 'client' : 'server'
                                }));
                            } catch { scanResults.value = []; }
                            break;
                        } else if (cmd && cmd.status === 'failed') {
                            deployResult.value = { success: false, message: 'Scan fehlgeschlagen: ' + (cmd.result || '') };
                            break;
                        }
                    }
                }
            } else {
                deployResult.value = { success: false, message: data.error || 'Scan konnte nicht gestartet werden' };
            }

            scanning.value = false;
            scanDone.value = true;
        }

        function toggleAllScan(e) {
            if (e.target.checked) {
                deployTargets.value = scanResults.value.map(h => h.ip);
            } else {
                deployTargets.value = [];
            }
        }

        async function executeBatchDeploy() {
            if (!deployForm.username) {
                deployResult.value = { success: false, message: 'Benutzername erforderlich' };
                return;
            }
            deployResult.value = null;

            const targets = scanResults.value.filter(h => deployTargets.value.includes(h.ip));

            const res = await apiFetch('/api/deploy/batch-deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    relay_machine_id: deployForm.relay_machine_id,
                    targets,
                    username: deployForm.username,
                    password: deployForm.password
                })
            });
            const data = await res.json();
            if (data.success) {
                const details = data.results.map(r => ({ ip: r.ip, command_id: r.command_id, success: null, message: 'Läuft...' }));
                deployResult.value = { success: true, message: `Deploy läuft auf ${data.results.length} Maschine(n)...`, details };
                deployCommandMap.value = {};
                for (const r of data.results) {
                    if (r.command_id) deployCommandMap.value[r.command_id] = r.ip;
                }
                deployTargets.value = [];
            } else {
                deployResult.value = { success: false, message: data.error || 'Batch-Deploy fehlgeschlagen' };
            }
        }

        async function executeDeploy() {
            if (!deployForm.relay_machine_id || !deployForm.target_ip || !deployForm.username) {
                deployResult.value = { success: false, message: 'Relay, Ziel-IP und Benutzername erforderlich' };
                return;
            }
            deployResult.value = null;
            const res = await apiFetch('/api/deploy/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deployForm)
            });
            const data = await res.json();
            if (data.success) {
                deployResult.value = { success: true, message: 'Deploy-Befehl gesendet! Maschine erscheint in Kuerze.' };
            } else {
                deployResult.value = { success: false, message: data.error || 'Deploy fehlgeschlagen' };
            }
        }

        async function loadVeeamInstances() {
            const res = await apiFetch('/api/veeam/instances');
            if (res.ok) {
                const instances = await res.json();
                for (const inst of instances) {
                    const jobsRes = await apiFetch(`/api/veeam/instances/${inst.id}/jobs`);
                    inst.jobs = jobsRes.ok ? await jobsRes.json() : [];
                }
                veeamInstances.value = instances;
            }
        }

        async function addVeeamInstance() {
            if (!newVeeam.name || !newVeeam.base_url || !newVeeam.username || !newVeeam.password) {
                toast('Alle Felder ausfuellen', 'error'); return;
            }
            const res = await apiFetch('/api/veeam/instances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newVeeam)
            });
            if (res.ok) {
                showAddVeeam.value = false;
                newVeeam.name = ''; newVeeam.base_url = ''; newVeeam.username = ''; newVeeam.password = '';
                await loadVeeamInstances();
            } else {
                const err = await res.json();
                toast(err.error || 'Fehler beim Hinzufuegen', 'error');
            }
        }

        async function deleteVeeamInstance(id) {
            if (!await confirmDialog('Veeam-Instanz wirklich entfernen?')) return;
            await apiFetch(`/api/veeam/instances/${id}`, { method: 'DELETE' });
            await loadVeeamInstances();
        }

        async function loadVeeamServers() {
            const res = await apiFetch('/api/veeam/servers');
            if (res.ok) veeamServers.value = await res.json();
        }

        async function openVeeamHistory(server, job) {
            veeamHistoryJob.value = { ...job, _server: server };
            veeamHistorySessions.value = [];
            showVeeamHistory.value = true;
            veeamHistoryLoading.value = true;
            const res = await apiFetch(`/api/veeam/servers/${server.machine_id}/sessions?job_id=${encodeURIComponent(job.job_id)}`);
            const rows = res.ok ? await res.json() : [];
            veeamHistorySessions.value = rows.map(s => ({
                ...s,
                tasks: (() => { try { return JSON.parse(s.tasks_json || '[]'); } catch { return []; } })(),
                warnings: (() => { try { return JSON.parse(s.warnings_json || '[]'); } catch { return []; } })(),
                _open: false
            }));
            veeamHistoryLoading.value = false;
        }

        function veeamRepoPercent(repo) {
            if (!repo.capacity_bytes) return 0;
            return Math.min(100, Math.round((repo.used_bytes / repo.capacity_bytes) * 100));
        }
        function veeamRepoColor(repo) {
            const pct = veeamRepoPercent(repo);
            if (pct >= 90) return 'var(--danger)';
            if (pct >= 75) return 'var(--warning)';
            return 'var(--success)';
        }
        function veeamResultClass(result) {
            if (/success/i.test(result)) return 'online';
            if (/warning/i.test(result)) return 'warning';
            if (/failed/i.test(result)) return 'offline';
            return 'warning';
        }
        function veeamJobTypeLabel(job) {
            if (job.is_copy_job) return 'Backup Copy';
            const map = { AgentBackup: 'Agent Backup', Backup: 'Backup', BackupSync: 'Backup Copy', EpAgentManagement: 'Agent', Replica: 'Replikation', FileCopy: 'Dateikopie', BackupToTape: 'Tape' };
            return map[job.job_type] || job.job_type || '–';
        }

        async function regenerateEnrollmentKey() {
            if (!await confirmDialog('Enrollment Key neu generieren? Bestehende Install-Befehle werden ungueltig.')) return;
            const res = await apiFetch('/api/settings/regenerate-enrollment-key', { method: 'POST' });
            const data = await res.json();
            if (data.enrollmentKey) {
                settingsForm.enrollmentKey = data.enrollmentKey;
            }
        }

        function toggleAllMachines(e) {
            if (e.target.checked) {
                selectedMachines.value = machines.value.map(m => m.machine_id);
            } else {
                selectedMachines.value = [];
            }
        }

        async function batchCommand(type) {
            const online = selectedMachines.value.filter(mid => {
                const m = machines.value.find(x => x.machine_id === mid);
                return m && m.status === 'online';
            });
            if (!online.length) { toast('Keine der ausgewaehlten Maschinen ist online.', 'error'); return; }
            if (!await confirmDialog(type + ' auf ' + online.length + ' Maschine(n) ausfuehren?')) return;

            for (const mid of online) {
                await apiFetch(`/api/commands/${mid}/${type}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
            }
            selectedMachines.value = [];
        }

        async function executeBatchInstall() {
            if (!batchInstallPkg.value) { toast('Paketname eingeben', 'error'); return; }
            const online = selectedMachines.value.filter(mid => {
                const m = machines.value.find(x => x.machine_id === mid);
                return m && m.status === 'online';
            });
            if (!online.length) { toast('Keine der ausgewaehlten Maschinen ist online.', 'error'); return; }

            for (const mid of online) {
                await apiFetch(`/api/commands/${mid}/install-software`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ package_name: batchInstallPkg.value, method: batchInstallMethod.value })
                });
            }
            showBatchInstall.value = false;
            batchInstallPkg.value = '';
            selectedMachines.value = [];
        }

        async function loadCommandHistory() {
            const res = await apiFetch('/api/commands/history');
            if (res.ok) commandHistory.value = await res.json();
        }

        // Insights tab state
        const insightsData = ref([]);
        const insightsSummary = ref({ critical: 0, warning: 0, info: 0, total: 0 });
        const insightsFilter = ref('all');
        const insightsCategoryFilter = ref('');

        async function loadInsights() {
            const res = await apiFetch('/api/monitoring/insights');
            if (res.ok) {
                const result = await res.json();
                insightsData.value = result.insights || [];
                insightsSummary.value = result.summary || { critical: 0, warning: 0, info: 0, total: 0 };
            }
        }

        const insightsCategories = computed(() => {
            const cats = new Set(insightsData.value.map(i => i.category).filter(Boolean));
            return [...cats].sort();
        });

        const insightsFiltered = computed(() => {
            return insightsData.value.filter(i => {
                if (insightsFilter.value !== 'all' && i.severity !== insightsFilter.value) return false;
                if (insightsCategoryFilter.value && i.category !== insightsCategoryFilter.value) return false;
                return true;
            });
        });

        const insightsGrouped = computed(() => {
            const groups = {};
            for (const i of insightsFiltered.value) {
                const cat = i.category || 'Sonstiges';
                if (!groups[cat]) groups[cat] = { category: cat, items: [], collapsed: false };
                groups[cat].items.push(i);
            }
            const order = ['Sicherheit', 'Speicher', 'Updates', 'Backup', 'Verfuegbarkeit', 'Administration'];
            return Object.values(groups).sort((a, b) => {
                const ai = order.indexOf(a.category);
                const bi = order.indexOf(b.category);
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });
        });

        // Security tab state
        const securityData = ref([]);
        const securityDetailMachine = ref(null);
        const securityDetail = ref({ firewall: { enabled: false, profiles: [], rules: [], ports: [] }, defender: {} });

        async function loadSecurityOverview() {
            const res = await apiFetch('/api/monitoring/security-overview');
            if (res.ok) securityData.value = await res.json();
        }

        async function openSecurityDetail(machine) {
            securityDetailMachine.value = machine;
            const res = await apiFetch(`/api/monitoring/machines/${machine.machine_id}/security-detail`);
            if (res.ok) securityDetail.value = await res.json();
        }

        async function securityToggleFirewall(machine) {
            const action = machine.firewall_enabled ? 'disable_firewall' : 'enable_firewall';
            const label = machine.firewall_enabled ? 'Firewall deaktivieren' : 'Firewall aktivieren';
            if (!await confirmDialog(`${label} auf "${machine.display_name || machine.hostname}"?`)) return;
            const res = await apiFetch(`/api/commands/${machine.machine_id}/${action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            if (res.ok) {
                toast('Befehl gesendet.', 'success');
                setTimeout(() => loadSecurityOverview(), 3000);
            }
        }

        async function securityToggleDefender(machine) {
            const action = machine.defender_realtime ? 'disable_defender' : 'enable_defender';
            const label = machine.defender_realtime ? 'Defender deaktivieren' : 'Defender aktivieren';
            if (!await confirmDialog(`${label} auf "${machine.display_name || machine.hostname}"?`)) return;
            const res = await apiFetch(`/api/commands/${machine.machine_id}/${action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            if (res.ok) {
                toast('Befehl gesendet.', 'success');
                setTimeout(() => loadSecurityOverview(), 3000);
            }
        }

        const alertFilter = ref('open');
        const alertGroupFilter = ref('');
        const alertTypeFilter = ref('');
        const alertSelected = ref([]);

        const alertTypes = computed(() => {
            const types = new Set(alerts.value.map(a => a.alert_type).filter(Boolean));
            return [...types].sort();
        });

        const alertFilteredList = computed(() => {
            let list = alerts.value;
            if (alertFilter.value === 'open') list = list.filter(a => !a.acknowledged);
            else if (alertFilter.value === 'critical') list = list.filter(a => a.severity === 'critical');
            else if (alertFilter.value === 'warning') list = list.filter(a => a.severity === 'warning');
            else if (alertFilter.value === 'info') list = list.filter(a => a.severity === 'info');
            if (alertGroupFilter.value) list = list.filter(a => a.group_name === alertGroupFilter.value);
            if (alertTypeFilter.value) list = list.filter(a => a.alert_type === alertTypeFilter.value);
            return list;
        });

        const alertGroupedEntries = computed(() => {
            const map = {};
            for (const a of alertFilteredList.value) {
                const key = a.group_name || 'Ohne Gruppe';
                if (!map[key]) map[key] = { label: key, items: [], collapsed: false };
                map[key].items.push(a);
            }
            const groups = Object.values(map);
            groups.sort((a, b) => {
                if (a.label === 'Ohne Gruppe') return 1;
                if (b.label === 'Ohne Gruppe') return -1;
                return a.label.localeCompare(b.label);
            });
            return groups;
        });

        function toggleAlertSelect(id) {
            const idx = alertSelected.value.indexOf(id);
            if (idx >= 0) alertSelected.value.splice(idx, 1);
            else alertSelected.value.push(id);
        }

        async function acknowledgeAlert(id) {
            await apiFetch(`/api/monitoring/alerts/${id}/acknowledge`, { method: 'POST' });
            await loadAlerts();
            alertSelected.value = alertSelected.value.filter(x => x !== id);
        }

        async function alertAcknowledgeSelected() {
            if (!alertSelected.value.length) return;
            await apiFetch('/api/monitoring/alerts/acknowledge-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: alertSelected.value })
            });
            alertSelected.value = [];
            await loadAlerts();
        }

        async function alertAcknowledgeAll() {
            await apiFetch('/api/monitoring/alerts/acknowledge-all', { method: 'POST' });
            alertSelected.value = [];
            await loadAlerts();
        }

        async function alertAcknowledgeGroup(items) {
            const ids = items.filter(a => !a.acknowledged).map(a => a.id);
            if (!ids.length) return;
            await apiFetch('/api/monitoring/alerts/acknowledge-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });
            alertSelected.value = alertSelected.value.filter(x => !ids.includes(x));
            await loadAlerts();
        }

        async function logout() {
            await fetch('/auth/logout', { method: 'POST' });
            window.location.href = '/login.html';
        }

        function formatTime(t) {
            if (!t) return '–';
            const d = new Date(t + 'Z');
            if (isNaN(d.getTime())) return '–';
            const now = new Date();
            const diff = (now - d) / 1000;
            if (Math.abs(diff) < 60) return 'gerade eben';
            if (diff > 0) {
                if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
                if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
            } else {
                const f = -diff;
                if (f < 3600) return `in ${Math.floor(f / 60)} Min.`;
                if (f < 86400) return `in ${Math.floor(f / 3600)} Std.`;
            }
            return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }

        function formatBytes(bytes) {
            if (!bytes) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0;
            let val = bytes;
            while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
            return val.toFixed(1) + ' ' + units[i];
        }

        function diskPercent(d) {
            if (!d.total_bytes) return 0;
            return Math.round(((d.total_bytes - d.free_bytes) / d.total_bytes) * 100);
        }

        function formatUptime(seconds) {
            if (!seconds) return '–';
            const d = Math.floor(seconds / 86400);
            const h = Math.floor((seconds % 86400) / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            if (d > 0) return `${d}T ${h}h ${m}m`;
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        }

        const machineUptime = computed(() => {
            if (!selectedMachine.value) return 0;
            const m = machines.value.find(x => x.machine_id === selectedMachine.value.machine_id);
            return m && m._telemetry ? m._telemetry.uptime || 0 : 0;
        });

        const machineLatestMetrics = computed(() => {
            if (!telemetryHistory.value.length) return null;
            return telemetryHistory.value[telemetryHistory.value.length - 1];
        });

        const detailServicesClosed = ref(true);
        const detailFirewallClosed = ref(true);

        // AD-Verwaltung state
        const adDomainControllers = ref([]);
        const adSelectedDC = ref('');
        const adUsers = ref([]);
        const adGroups = ref([]);
        const adUsersLoading = ref(false);
        const adUsersOutput = ref('');
        const adTemplates = ref([]);
        const showADUserModal = ref(false);
        const showADTemplatesModal = ref(false);
        const adUserSearch = ref('');
        const adUserFormMode = ref('create');
        const adUserFormTab = ref('general');
        const adEditingUser = ref(null);
        const adDuplicateSource = ref(null);
        const adShowPassword = ref(false);
        const adUserForm = reactive({
            sam_account_name: '', given_name: '', surname: '', display_name: '',
            password: '', email: '', upn: '', department: '', title: '', company: '',
            description: '', office_phone: '', mobile_phone: '', ou: '',
            enabled: true, password_never_expires: false, change_password_at_logon: true,
            cannot_change_password: false, groups: []
        });
        const adTemplateForm = reactive({ name: '', description: '' });

        const adGroupSearch = ref('');

        const adGroupsFiltered = computed(() => {
            let groups = adGroups.value;
            if (adGroupSearch.value) {
                const q = adGroupSearch.value.toLowerCase();
                groups = groups.filter(g =>
                    (g.sam_account_name || '').toLowerCase().includes(q) ||
                    (g.name || '').toLowerCase().includes(q) ||
                    (g.description || '').toLowerCase().includes(q)
                );
            }
            return [...groups].sort((a, b) => {
                const aChecked = adUserForm.groups.includes(a.sam_account_name) ? 0 : 1;
                const bChecked = adUserForm.groups.includes(b.sam_account_name) ? 0 : 1;
                if (aChecked !== bChecked) return aChecked - bChecked;
                return (a.name || a.sam_account_name).localeCompare(b.name || b.sam_account_name, 'de');
            });
        });

        function removeFromADGroup(groupName) {
            adUserForm.groups = adUserForm.groups.filter(g => g !== groupName);
        }

        const adFilteredUsers = computed(() => {
            if (!adUserSearch.value) return adUsers.value;
            const q = adUserSearch.value.toLowerCase();
            return adUsers.value.filter(u =>
                (u.sam_account_name || '').toLowerCase().includes(q) ||
                (u.display_name || '').toLowerCase().includes(q) ||
                (u.given_name || '').toLowerCase().includes(q) ||
                (u.surname || '').toLowerCase().includes(q) ||
                (u.email || '').toLowerCase().includes(q) ||
                (u.department || '').toLowerCase().includes(q)
            );
        });

        async function loadADDomainControllers() {
            const res = await apiFetch('/api/ad/domain-controllers');
            if (res.ok) adDomainControllers.value = await res.json();
        }

        async function loadADUsers() {
            if (!adSelectedDC.value) return;
            adUsersLoading.value = true;
            adUsersOutput.value = 'Verbinde mit Domänen Controller...';
            const res = await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ad_list_users', parameters: {} })
            });
            if (!res.ok) {
                adUsersLoading.value = false;
                adUsersOutput.value = '';
                toast('Fehler beim Senden des Befehls', 'error');
            }
        }

        async function loadADGroups() {
            if (!adSelectedDC.value) return;
            const res = await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ad_list_groups', parameters: {} })
            });
            const data = await res.json();
            if (!data.success) { toast('Fehler beim Laden der Gruppen', 'error'); return; }

            const cmdId = data.command_id;
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const checkRes = await apiFetch(`/api/commands/${adSelectedDC.value}/history`);
                if (checkRes.ok) {
                    const cmds = await checkRes.json();
                    const cmd = cmds.find(c => c.id === cmdId);
                    if (cmd && cmd.status === 'completed') {
                        try {
                            const parsed = JSON.parse(cmd.result);
                            adGroups.value = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                            toast(`${adGroups.value.length} Gruppen geladen.`, 'success');
                        } catch { toast('Fehler beim Parsen der Gruppen', 'error'); }
                        break;
                    } else if (cmd && cmd.status === 'failed') {
                        toast('Gruppen-Abruf fehlgeschlagen: ' + (cmd.result || ''), 'error');
                        break;
                    }
                }
            }
        }

        function openCreateADUser() {
            adUserFormMode.value = 'create';
            adUserFormTab.value = 'general';
            Object.assign(adUserForm, {
                sam_account_name: '', given_name: '', surname: '', display_name: '',
                password: '', email: '', upn: '', department: '', title: '', company: '',
                description: '', office_phone: '', mobile_phone: '', ou: '',
                enabled: true, password_never_expires: false, change_password_at_logon: true,
                cannot_change_password: false, groups: []
            });
            adEditingUser.value = null;
            adDuplicateSource.value = null;
            adShowPassword.value = false;
            showADUserModal.value = true;
        }

        function openEditADUser(user) {
            adUserFormMode.value = 'edit';
            adUserFormTab.value = 'general';
            adEditingUser.value = user;
            adDuplicateSource.value = null;
            Object.assign(adUserForm, {
                sam_account_name: user.sam_account_name || '',
                given_name: user.given_name || '',
                surname: user.surname || '',
                display_name: user.display_name || '',
                password: '',
                email: user.email || '',
                upn: user.upn || '',
                department: user.department || '',
                title: user.title || '',
                company: user.company || '',
                description: user.description || '',
                office_phone: user.office_phone || '',
                mobile_phone: user.mobile_phone || '',
                ou: '',
                enabled: user.enabled !== false,
                password_never_expires: user.password_never_expires || false,
                change_password_at_logon: false,
                cannot_change_password: user.cannot_change_password || false,
                groups: Array.isArray(user.groups) ? [...user.groups] : []
            });
            showADUserModal.value = true;
        }

        function openDuplicateADUser(user) {
            adUserFormMode.value = 'duplicate';
            adUserFormTab.value = 'general';
            adEditingUser.value = null;
            adShowPassword.value = false;
            // Eltern-Container/OU = alles nach dem ersten CN=<Name>-Bestandteil.
            // Funktioniert sowohl fuer OU=... als auch fuer Container wie CN=Users.
            let ou = '';
            if (user.distinguished_name) {
                const idx = user.distinguished_name.indexOf(',');
                if (idx > -1) ou = user.distinguished_name.substring(idx + 1);
                // Auf die exakte Schreibweise einer geladenen OU normalisieren,
                // damit das Dropdown den Wert korrekt auswaehlt.
                const match = adOUs.value.find(o => o.distinguished_name.toLowerCase() === ou.toLowerCase());
                if (match) ou = match.distinguished_name;
            }
            Object.assign(adUserForm, {
                sam_account_name: user.sam_account_name || '',
                given_name: user.given_name || '',
                surname: user.surname || '',
                display_name: user.display_name || '',
                password: '',
                email: user.email || '',
                upn: user.upn || '',
                department: user.department || '',
                title: user.title || '',
                company: user.company || '',
                description: user.description || '',
                office_phone: user.office_phone || '',
                mobile_phone: user.mobile_phone || '',
                ou,
                enabled: user.enabled !== false,
                password_never_expires: user.password_never_expires || false,
                change_password_at_logon: true,
                cannot_change_password: user.cannot_change_password || false,
                groups: Array.isArray(user.groups) ? [...user.groups] : []
            });
            adDuplicateSource.value = user;
            showADUserModal.value = true;
        }

        async function saveADUser() {
            if (!adUserForm.given_name || !adUserForm.surname || !adUserForm.sam_account_name) {
                toast('Vorname, Nachname und Benutzername sind erforderlich', 'error');
                return;
            }
            if (adUserFormMode.value !== 'edit' && !adUserForm.password) {
                toast('Passwort ist erforderlich', 'error');
                return;
            }

            let type, parameters;
            if (adUserFormMode.value === 'edit') {
                const originalGroups = adEditingUser.value?.groups || [];
                const newGroups = adUserForm.groups;
                const addGroups = newGroups.filter(g => !originalGroups.includes(g));
                const removeGroups = originalGroups.filter(g => !newGroups.includes(g));
                type = 'ad_update_user';
                parameters = { ...adUserForm, add_groups: addGroups, remove_groups: removeGroups };
                delete parameters.groups;
                // Passwort nur uebermitteln, wenn ein neues eingegeben wurde
                if (!parameters.password) {
                    delete parameters.password;
                    delete parameters.change_password_at_logon;
                } else if (parameters.password_never_expires) {
                    parameters.change_password_at_logon = false;
                }
            } else {
                type = 'ad_create_user';
                parameters = { ...adUserForm };
                // AD verbietet ChangePasswordAtLogon zusammen mit PasswordNeverExpires
                if (parameters.password_never_expires) parameters.change_password_at_logon = false;
            }

            const res = await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, parameters })
            });
            showADUserModal.value = false;
            if (res.ok) toast('Befehl gesendet, warte auf Ergebnis...', 'info');
            else toast('Fehler beim Senden des Befehls', 'error');
        }

        async function confirmDeleteADUser(user) {
            if (!await confirmDialog(`Benutzer "${user.display_name || user.sam_account_name}" wirklich löschen?`)) return;
            await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ad_delete_user', parameters: { sam_account_name: user.sam_account_name } })
            });
            toast('Löschbefehl gesendet...', 'info');
        }

        async function loadADTemplates() {
            const res = await apiFetch('/api/ad/templates');
            if (res.ok) adTemplates.value = await res.json();
        }

        async function deleteADTemplate(id) {
            if (!await confirmDialog('Vorlage wirklich löschen?')) return;
            await apiFetch(`/api/ad/templates/${id}`, { method: 'DELETE' });
            await loadADTemplates();
        }

        function applyADTemplate(templateId) {
            if (!templateId) return;
            const t = adTemplates.value.find(x => x.id === parseInt(templateId));
            if (!t || !t.properties) return;
            const p = t.properties;
            if (p.department !== undefined) adUserForm.department = p.department;
            if (p.title !== undefined) adUserForm.title = p.title;
            if (p.company !== undefined) adUserForm.company = p.company;
            if (p.ou !== undefined) adUserForm.ou = p.ou;
            if (p.enabled !== undefined) adUserForm.enabled = p.enabled;
            if (p.password_never_expires !== undefined) adUserForm.password_never_expires = p.password_never_expires;
            if (Array.isArray(p.groups)) adUserForm.groups = [...p.groups];
        }

        async function saveADTemplateFromForm() {
            const name = prompt('Name der Vorlage:');
            if (!name) return;
            const properties = {
                department: adUserForm.department,
                title: adUserForm.title,
                company: adUserForm.company,
                ou: adUserForm.ou,
                enabled: adUserForm.enabled,
                password_never_expires: adUserForm.password_never_expires,
                change_password_at_logon: adUserForm.change_password_at_logon,
                cannot_change_password: adUserForm.cannot_change_password,
                groups: [...adUserForm.groups]
            };
            await apiFetch('/api/ad/templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, properties })
            });
            await loadADTemplates();
            toast(`Vorlage "${name}" gespeichert.`, 'success');
        }

        // Live log viewer
        const logTab = ref('command');          // 'command' | 'agent' | 'container'
        const logEntries = ref([]);
        const logFilter = ref('');
        const logSearch = ref('');
        const logAutoScroll = ref(true);
        const logContainer = ref(null);
        let logEventSource = null;

        // Command log filters
        const cmdLogSearch = ref('');
        const cmdLogStatus = ref('');
        const cmdLogType = ref('');

        const commandTypes = computed(() =>
            [...new Set(commandHistory.value.map(c => c.command_type).filter(Boolean))].sort()
        );

        const filteredCommandHistory = computed(() => {
            let list = commandHistory.value;
            if (cmdLogStatus.value) list = list.filter(c => c.status === cmdLogStatus.value);
            if (cmdLogType.value) list = list.filter(c => c.command_type === cmdLogType.value);
            if (cmdLogSearch.value) {
                const q = cmdLogSearch.value.toLowerCase();
                list = list.filter(c =>
                    (c.command_type || '').toLowerCase().includes(q) ||
                    (c.result || '').toLowerCase().includes(q) ||
                    (c.hostname || '').toLowerCase().includes(q) ||
                    (c.display_name || '').toLowerCase().includes(q) ||
                    (c.machine_id || '').toLowerCase().includes(q)
                );
            }
            return list;
        });

        // Console split: agent activity ([WS]) vs. container/server output (everything else)
        const filteredLogEntries = computed(() => {
            let list = logTab.value === 'agent'
                ? logEntries.value.filter(e => e.text.includes('[WS]'))
                : logEntries.value.filter(e => !e.text.includes('[WS]'));
            if (logFilter.value === 'info' || logFilter.value === 'warn' || logFilter.value === 'error') {
                list = list.filter(e => (e.level || 'info') === logFilter.value);
            }
            if (logSearch.value) {
                const q = logSearch.value.toLowerCase();
                list = list.filter(e => e.text.toLowerCase().includes(q));
            }
            return list;
        });

        function setLogTab(tab) {
            logTab.value = tab;
            if (tab === 'command') {
                loadCommandHistory();
            } else {
                connectLogStream();
                scrollLogsToBottom();
            }
        }

        const cmdLogDetail = ref(null);

        function openCmdDetail(c) {
            cmdLogDetail.value = c;
        }

        function formatCmdParams(raw) {
            try {
                return JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
                return raw;
            }
        }

        function copyText(text) {
            navigator.clipboard.writeText(text).then(
                () => toast('In Zwischenablage kopiert.', 'success'),
                () => toast('Kopieren fehlgeschlagen.', 'error')
            );
        }

        function connectLogStream() {
            if (logEventSource) { logEventSource.close(); logEventSource = null; }
            const res = fetch('/api/logs').then(r => r.ok ? r.json() : []).then(data => {
                logEntries.value = data;
                scrollLogsToBottom();
            }).catch(() => {});

            logEventSource = new EventSource('/api/logs/stream');
            logEventSource.onmessage = (event) => {
                try {
                    const e = JSON.parse(event.data);
                    // Deduplicate: skip if already loaded via /api/logs
                    if (logEntries.value.length && logEntries.value[logEntries.value.length - 1].ts >= e.ts && logEntries.value.some(x => x.ts === e.ts && x.text === e.text)) return;
                    logEntries.value.push(e);
                    if (logEntries.value.length > 1200) logEntries.value.splice(0, 200);
                    if (logAutoScroll.value) scrollLogsToBottom();
                } catch {}
            };
        }

        function scrollLogsToBottom() {
            nextTick(() => {
                const el = logContainer.value;
                if (el) el.scrollTop = el.scrollHeight;
            });
        }

        function disconnectLogStream() {
            if (logEventSource) { logEventSource.close(); logEventSource = null; }
        }

        function formatLogTime(ts) {
            const d = new Date(ts);
            return d.toLocaleTimeString('de-DE', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
        }

        function logLineColor(e) {
            const t = e.text;
            if (e.level === 'error' || t.includes('rejected') || t.includes('Failed') || t.includes('failed') || t.includes('Invalid')) return '#fca5a5';
            if (e.level === 'warn') return '#fde68a';
            if (t.includes('registered') || t.includes('Connected') || t.includes('installed')) return '#86efac';
            if (t.includes('[WS]')) return '#93c5fd';
            if (t.includes('[DB]')) return '#c4b5fd';
            return '#cbd5e1';
        }

        const adPasswordWords = [
            'Apfel', 'Brücke', 'Sonne', 'Wolke', 'Garten', 'Feder', 'Anker', 'Lampe',
            'Berg', 'Fluss', 'Stern', 'Blume', 'Tiger', 'Adler', 'Falke', 'Pinguin',
            'Kompass', 'Hammer', 'Schlüssel', 'Fenster', 'Kerze', 'Spiegel', 'Hafen',
            'Wald', 'Insel', 'Brunnen', 'Turm', 'Segel', 'Donner', 'Regen', 'Kristall',
            'Drache', 'Phönix', 'Komet', 'Planet', 'Magnet', 'Pinsel', 'Trommel', 'Gitarre'
        ];

        function generateADPassword() {
            const symbols = '!?#$%&*+';
            const w1 = adPasswordWords[Math.floor(Math.random() * adPasswordWords.length)];
            let w2 = adPasswordWords[Math.floor(Math.random() * adPasswordWords.length)];
            while (w2 === w1) w2 = adPasswordWords[Math.floor(Math.random() * adPasswordWords.length)];
            const num = Math.floor(Math.random() * 90 + 10); // 10–99
            const sym = symbols[Math.floor(Math.random() * symbols.length)];
            // z.B. "Sonne-Anker42!" – gut lesbar und leicht zu merken
            adUserForm.password = `${w1}-${w2}${num}${sym}`;
            adShowPassword.value = true;
        }

        function adAutoDisplayName() {
            const fn = adUserForm.given_name || '';
            const sn = adUserForm.surname || '';
            adUserForm.display_name = (fn + ' ' + sn).trim();
        }

        // OU tree
        const adOUs = ref([]);
        const adSelectedOU = ref(null);
        const adShowMoveModal = ref(false);
        const adMoveUser = ref(null);
        const adMoveTargetOU = ref('');

        const ouTreeFlat = computed(() => {
            if (!adOUs.value.length) return [];
            const rootDN = adOUs.value[0].distinguished_name.split(',')
                .filter(p => /^DC=/i.test(p)).join(',');
            function getChildren(parentDN) {
                return adOUs.value.filter(ou => {
                    const parts = ou.distinguished_name.split(',');
                    return parts.slice(1).join(',').toLowerCase() === parentDN.toLowerCase();
                }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
            }
            const result = [];
            function flatten(pDN, level) {
                for (const ou of getChildren(pDN)) { result.push({ ...ou, level }); flatten(ou.distinguished_name, level + 1); }
            }
            flatten(rootDN, 0);
            return result;
        });

        // Optionen fuer das OU-Dropdown im Benutzerformular. Enthaelt zusaetzlich
        // den aktuell gesetzten Wert (z.B. Container CN=Users), falls dieser nicht
        // in der OU-Liste vorkommt, damit er angezeigt und beibehalten wird.
        const adOuSelectOptions = computed(() => {
            const opts = ouTreeFlat.value.map(ou => ({
                value: ou.distinguished_name,
                label: '  '.repeat(ou.level) + ou.name
            }));
            const cur = adUserForm.ou;
            if (cur && !opts.some(o => o.value.toLowerCase() === cur.toLowerCase())) {
                const name = (cur.split(',')[0] || cur).replace(/^(OU|CN)=/i, '');
                opts.unshift({ value: cur, label: name + ' (aktueller Pfad)' });
            }
            return opts;
        });

        const adUsersForOU = computed(() => {
            let users = adFilteredUsers.value;
            if (adSelectedOU.value) {
                users = users.filter(u => u.distinguished_name &&
                    u.distinguished_name.toLowerCase().endsWith(',' + adSelectedOU.value.toLowerCase()));
            }
            return users;
        });

        async function loadADOUs() {
            if (!adSelectedDC.value) return;
            const res = await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ad_list_ous', parameters: {} })
            });
            if (!res.ok) toast('Fehler beim Laden der OUs', 'error');
        }

        function openMoveUser(user) {
            adMoveUser.value = user;
            adMoveTargetOU.value = '';
            adShowMoveModal.value = true;
        }

        async function confirmMoveUser() {
            if (!adMoveUser.value || !adMoveTargetOU.value) return;
            await apiFetch(`/api/ad/${adSelectedDC.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ad_move_user', parameters: { user_dn: adMoveUser.value.distinguished_name, target_ou: adMoveTargetOU.value } })
            });
            adShowMoveModal.value = false;
            toast('Verschieben-Befehl gesendet...', 'info');
        }

        // AD admin tabs
        const adAdminTab = ref('ad');

        function openUserAdmin(machine) {
            adAdminTab.value = machine.is_domain_controller ? 'ad' : 'local';
            if (!machine.is_domain_controller) {
                localMachineId.value = machine.machine_id;
                loadLocalUsers();
                loadLocalGroups();
            } else {
                adSelectedDC.value = machine.machine_id;
            }
            navigate('ad-admin');
        }

        // ===== Microsoft 365 =====
        const m365Tenants = ref([]);
        const m365SelectedTenant = ref(null);
        const m365Users = ref([]);
        const m365Skus = ref([]);
        const m365Groups = ref([]);
        const m365Domains = ref([]);
        const m365UsersLoading = ref(false);
        const m365UsersOutput = ref('');
        const m365Testing = ref(false);
        const m365Saving = ref(false);
        const m365UserSearch = ref('');
        const m365GroupSearch = ref('');
        const m365ShowPassword = ref(false);

        const showM365TenantModal = ref(false);
        const showM365UserModal = ref(false);
        const showM365PasswordModal = ref(false);

        const m365TenantForm = reactive({ id: null, name: '', tenant_id: '', client_id: '', client_secret: '', group_id: null });
        const m365UserMode = ref('create');
        const m365UserTab = ref('general');
        const m365EditingUser = ref(null);
        const m365DuplicateSource = ref(null);
        const m365UserForm = reactive({
            given_name: '', surname: '', display_name: '', upn_local: '', upn_domain: '', upn: '',
            password: '', force_change: true, job_title: '', department: '', company: '',
            office_location: '', business_phone: '', mobile_phone: '', fax: '',
            street: '', city: '', state: '', postal_code: '', country: '',
            manager_id: '', usage_location: 'DE', enabled: true, licenses: [], groups: []
        });
        // Verteiler & Gruppen
        const m365Tab = ref('users');
        const m365SelectedGroup = ref(null);
        const m365GroupMembers = ref([]);
        const m365GroupMembersLoading = ref(false);
        const m365GroupSearchList = ref('');
        const m365AddMemberId = ref('');
        const showM365MembersModal = ref(false);

        const m365GroupColumns = [
            { key: 'display_name', label: 'Name' },
            { key: 'type_label', label: 'Typ', filter: true },
            { key: 'mail', label: 'E-Mail-Adresse' },
            { key: 'description', label: 'Beschreibung' },
            { key: '_actions', label: '', sortable: false, searchable: false, stopClick: true }
        ];

        const m365GroupsForList = computed(() => {
            if (!m365GroupSearchList.value) return m365Groups.value;
            const q = m365GroupSearchList.value.toLowerCase();
            return m365Groups.value.filter(g =>
                (g.display_name || '').toLowerCase().includes(q) ||
                (g.mail || '').toLowerCase().includes(q) ||
                (g.type_label || '').toLowerCase().includes(q));
        });

        // Users that are not yet members of the selected group (for the add dropdown).
        const m365NonMembers = computed(() => {
            const ids = new Set(m365GroupMembers.value.map(m => m.id));
            return m365Users.value.filter(u => !ids.has(u.id));
        });
        const m365PasswordUser = ref(null);
        const m365PasswordValue = ref('');
        const m365PasswordForceChange = ref(true);

        const m365UserColumns = [
            { key: 'display_name', label: 'Name' },
            { key: 'upn', label: 'UPN' },
            { key: 'account_type', label: 'Typ', filter: true },
            { key: 'department', label: 'Abteilung', filter: true },
            { key: 'enabled', label: 'Status', filter: true, value: r => r.enabled ? 'Aktiv' : 'Deaktiviert' },
            { key: 'licenses', label: 'Lizenzen', value: r => (r.licenses || []).join(', ') },
            { key: '_actions', label: '', sortable: false, searchable: false, stopClick: true }
        ];

        const m365CurrentTenant = computed(() => m365Tenants.value.find(t => t.id === m365SelectedTenant.value) || null);

        const m365TenantsGrouped = computed(() => {
            const grouped = groups.value.map(g => ({
                id: g.id, name: g.name,
                tenants: m365Tenants.value.filter(t => t.group_id === g.id)
            })).filter(g => g.tenants.length);
            const ungrouped = m365Tenants.value.filter(t => !t.group_id);
            if (ungrouped.length) grouped.push({ id: 0, name: 'Ohne Gruppe', tenants: ungrouped });
            return grouped;
        });

        const m365FilteredUsers = computed(() => {
            if (!m365UserSearch.value) return m365Users.value;
            const q = m365UserSearch.value.toLowerCase();
            return m365Users.value.filter(u =>
                (u.display_name || '').toLowerCase().includes(q) ||
                (u.upn || '').toLowerCase().includes(q) ||
                (u.mail || '').toLowerCase().includes(q) ||
                (u.department || '').toLowerCase().includes(q));
        });

        const m365GroupsFiltered = computed(() => {
            let groups = m365Groups.value;
            if (m365GroupSearch.value) {
                const q = m365GroupSearch.value.toLowerCase();
                groups = groups.filter(g => (g.display_name || '').toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q));
            }
            return [...groups].sort((a, b) => {
                const ac = m365UserForm.groups.includes(a.id) ? 0 : 1;
                const bc = m365UserForm.groups.includes(b.id) ? 0 : 1;
                if (ac !== bc) return ac - bc;
                return a.display_name.localeCompare(b.display_name, 'de');
            });
        });

        async function loadM365() {
            const tasks = [apiFetch('/api/m365/tenants')];
            if (!groups.value.length) tasks.push(loadGroups());
            const [tn] = await Promise.all(tasks);
            if (tn.ok) m365Tenants.value = await tn.json();
        }

        function onM365TenantChange() {
            m365Users.value = [];
            m365Skus.value = [];
            m365Groups.value = [];
            m365Domains.value = [];
            m365UsersOutput.value = '';
            if (m365CurrentTenant.value && m365CurrentTenant.value.status === 'connected') {
                loadM365Users();
                loadM365Skus();
                loadM365Groups();
                loadM365Domains();
            }
        }

        async function testM365Tenant(tenant) {
            m365Testing.value = true;
            const res = await apiFetch(`/api/m365/tenants/${tenant.id}/test`, { method: 'POST' });
            m365Testing.value = false;
            const data = await res.json().catch(() => ({}));
            await loadM365();
            if (res.ok) {
                toast(`Verbunden mit ${data.displayName || tenant.name}`, 'success');
                if (m365SelectedTenant.value === tenant.id) onM365TenantChange();
            } else {
                toast('Verbindung fehlgeschlagen: ' + (data.error || ''), 'error');
            }
        }

        async function loadM365Users() {
            const t = m365CurrentTenant.value; if (!t) return;
            m365UsersLoading.value = true;
            m365UsersOutput.value = 'Lade Benutzer aus Microsoft 365...';
            const res = await apiFetch(`/api/m365/tenants/${t.id}/users`);
            m365UsersLoading.value = false;
            if (res.ok) { m365Users.value = await res.json(); m365UsersOutput.value = ''; }
            else { const e = await res.json().catch(() => ({})); m365UsersOutput.value = ''; toast('Fehler: ' + (e.error || ''), 'error'); }
        }

        async function loadM365Skus() {
            const t = m365CurrentTenant.value; if (!t) return;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/skus`);
            if (res.ok) m365Skus.value = await res.json();
        }

        async function loadM365Groups() {
            const t = m365CurrentTenant.value; if (!t) return;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/groups`);
            if (res.ok) m365Groups.value = await res.json();
        }

        async function loadM365Domains() {
            const t = m365CurrentTenant.value; if (!t) return;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/domains`);
            if (res.ok) m365Domains.value = (await res.json()).map(d => d.name);
        }

        function openM365TenantModal(tenant) {
            if (tenant) {
                Object.assign(m365TenantForm, { id: tenant.id, name: tenant.name, tenant_id: tenant.tenant_id, client_id: tenant.client_id, client_secret: '', group_id: tenant.group_id || null });
            } else {
                Object.assign(m365TenantForm, { id: null, name: '', tenant_id: '', client_id: '', client_secret: '', group_id: null });
            }
            showM365TenantModal.value = true;
        }

        async function saveM365Tenant() {
            const f = m365TenantForm;
            if (!f.name || !f.tenant_id || !f.client_id || (!f.id && !f.client_secret)) {
                toast('Bitte alle Pflichtfelder ausfüllen', 'error');
                return;
            }
            const body = { name: f.name, tenant_id: f.tenant_id, client_id: f.client_id, group_id: f.group_id };
            if (f.client_secret) body.client_secret = f.client_secret;
            const url = f.id ? `/api/m365/tenants/${f.id}` : '/api/m365/tenants';
            const res = await apiFetch(url, { method: f.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) { const e = await res.json().catch(() => ({})); toast('Fehler: ' + (e.error || ''), 'error'); return; }
            const saved = await res.json();
            showM365TenantModal.value = false;
            await loadM365();
            // Auto-test new/updated tenant for immediate feedback.
            await testM365Tenant(saved);
            if (!f.id) m365SelectedTenant.value = saved.id;
        }

        async function deleteM365Tenant(tenant) {
            if (!await confirmDialog(`Mandant "${tenant.name}" wirklich entfernen?`)) return;
            await apiFetch(`/api/m365/tenants/${tenant.id}`, { method: 'DELETE' });
            showM365TenantModal.value = false;
            if (m365SelectedTenant.value === tenant.id) m365SelectedTenant.value = null;
            await loadM365();
            toast('Mandant entfernt', 'success');
        }

        function m365MakePassword() {
            const words = ['Apfel', 'Sonne', 'Wolke', 'Garten', 'Anker', 'Stern', 'Falke', 'Hafen', 'Kompass', 'Drache', 'Komet', 'Kristall'];
            const sym = '!?#$%&*+';
            const w1 = words[Math.floor(Math.random() * words.length)];
            let w2 = words[Math.floor(Math.random() * words.length)];
            while (w2 === w1) w2 = words[Math.floor(Math.random() * words.length)];
            return `${w1}-${w2}${Math.floor(Math.random() * 90 + 10)}${sym[Math.floor(Math.random() * sym.length)]}`;
        }

        function m365GeneratePassword() { m365UserForm.password = m365MakePassword(); m365ShowPassword.value = true; }

        function m365AutoFields() {
            const fn = m365UserForm.given_name || '';
            const sn = m365UserForm.surname || '';
            m365UserForm.display_name = (fn + ' ' + sn).trim();
            if (m365UserMode.value !== 'edit' && fn && sn) {
                m365UserForm.upn_local = (fn[0] + '.' + sn).toLowerCase().replace(/[^a-z0-9.\-]/g, '');
                m365UpdateUpn();
            }
        }

        function m365UpdateUpn() { /* UPN is assembled from local + domain on save */ }

        function m365ResetUserForm() {
            const dom = m365Domains.value[0] || (m365CurrentTenant.value && m365CurrentTenant.value.default_domain) || '';
            Object.assign(m365UserForm, {
                given_name: '', surname: '', display_name: '', upn_local: '', upn_domain: dom, upn: '',
                password: '', force_change: true, job_title: '', department: '', company: '',
                office_location: '', business_phone: '', mobile_phone: '', fax: '',
                street: '', city: '', state: '', postal_code: '', country: '',
                manager_id: '', usage_location: 'DE', enabled: true, licenses: [], groups: []
            });
        }

        // Copy the editable contact/org fields of a source user into the form.
        function m365CopyContactFields(user) {
            Object.assign(m365UserForm, {
                job_title: user.job_title || '', department: user.department || '', company: user.company || '',
                office_location: user.office_location || '', street: user.street || '', city: user.city || '',
                state: user.state || '', postal_code: user.postal_code || '', country: user.country || '',
                usage_location: user.usage_location || 'DE'
            });
        }

        function openCreateM365User() {
            m365UserMode.value = 'create';
            m365UserTab.value = 'general';
            m365EditingUser.value = null;
            m365DuplicateSource.value = null;
            m365ShowPassword.value = false;
            m365ResetUserForm();
            showM365UserModal.value = true;
        }

        async function openEditM365User(user) {
            m365UserMode.value = 'edit';
            m365UserTab.value = 'general';
            m365EditingUser.value = user;
            m365DuplicateSource.value = null;
            const [local, domain] = (user.upn || '').split('@');
            m365ResetUserForm();
            Object.assign(m365UserForm, {
                given_name: user.given_name || '', surname: user.surname || '',
                display_name: user.display_name || '', upn_local: local || '', upn_domain: domain || '',
                upn: user.upn || '', force_change: false,
                job_title: user.job_title || '', department: user.department || '', company: user.company || '',
                office_location: user.office_location || '', business_phone: user.business_phone || '',
                mobile_phone: user.mobile_phone || '', fax: user.fax || '', street: user.street || '',
                city: user.city || '', state: user.state || '', postal_code: user.postal_code || '',
                country: user.country || '', usage_location: user.usage_location || 'DE',
                enabled: user.enabled !== false, licenses: [], groups: [], manager_id: ''
            });
            showM365UserModal.value = true;
            // Load current licenses, groups and manager for this user.
            const t = m365CurrentTenant.value;
            const [lic, grp, mgr] = await Promise.all([
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/licenses`),
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/groups`),
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/manager`)
            ]);
            if (lic.ok) m365UserForm.licenses = (await lic.json()).map(l => l.sku_id);
            if (grp.ok) m365UserForm.groups = (await grp.json()).map(g => g.id);
            let managerId = '';
            if (mgr.ok) { const m = await mgr.json(); managerId = (m && m.id) || ''; }
            m365UserForm.manager_id = managerId;
            m365EditingUser.value = { ...user, _licenses: [...m365UserForm.licenses], _groups: [...m365UserForm.groups], _manager: managerId };
        }

        async function openDuplicateM365User(user) {
            m365UserMode.value = 'duplicate';
            m365UserTab.value = 'general';
            m365EditingUser.value = null;
            m365ShowPassword.value = false;
            m365ResetUserForm();
            m365UserForm.upn_domain = (user.upn || '').split('@')[1] || m365Domains.value[0] || '';
            // Carry over org/address fields so a new colleague starts pre-filled.
            // Personal data (name, UPN, phones, password) stays empty.
            m365CopyContactFields(user);
            m365DuplicateSource.value = user;
            showM365UserModal.value = true;
            // Carry over the source user's licenses, groups and manager as a starting point.
            const t = m365CurrentTenant.value;
            const [lic, grp, mgr] = await Promise.all([
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/licenses`),
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/groups`),
                apiFetch(`/api/m365/tenants/${t.id}/users/${user.id}/manager`)
            ]);
            if (lic.ok) m365UserForm.licenses = (await lic.json()).map(l => l.sku_id);
            if (grp.ok) m365UserForm.groups = (await grp.json()).map(g => g.id);
            if (mgr.ok) { const m = await mgr.json(); m365UserForm.manager_id = (m && m.id) || ''; }
        }

        async function saveM365User() {
            const f = m365UserForm;
            const t = m365CurrentTenant.value;
            if (!f.display_name || !f.upn_local || !f.upn_domain) { toast('Anzeigename und UPN sind erforderlich', 'error'); return; }
            if (m365UserMode.value !== 'edit' && !f.password) { toast('Passwort ist erforderlich', 'error'); return; }
            m365Saving.value = true;
            try {
                // Shared profile/contact attributes sent on both create and update.
                const profile = {
                    display_name: f.display_name, given_name: f.given_name, surname: f.surname,
                    job_title: f.job_title, department: f.department, company: f.company,
                    office_location: f.office_location, business_phone: f.business_phone,
                    mobile_phone: f.mobile_phone, fax: f.fax, street: f.street, city: f.city,
                    state: f.state, postal_code: f.postal_code, country: f.country,
                    usage_location: f.usage_location
                };
                if (m365UserMode.value === 'edit') {
                    const u = m365EditingUser.value;
                    const upd = await apiFetch(`/api/m365/tenants/${t.id}/users/${u.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...profile, enabled: f.enabled })
                    });
                    if (!upd.ok) throw new Error((await upd.json()).error || 'Update fehlgeschlagen');
                    await m365SyncLicensesGroups(t, u.id, u._licenses || [], u._groups || []);
                    if (f.manager_id !== (u._manager || '')) {
                        await apiFetch(`/api/m365/tenants/${t.id}/users/${u.id}/manager`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ manager_id: f.manager_id || null })
                        });
                    }
                    toast('Benutzer aktualisiert', 'success');
                } else {
                    const res = await apiFetch(`/api/m365/tenants/${t.id}/users`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...profile, upn: f.upn_local + '@' + f.upn_domain, password: f.password,
                            force_change: f.force_change, enabled: true,
                            licenses: f.licenses, groups: f.groups, manager_id: f.manager_id || null
                        })
                    });
                    if (!res.ok) throw new Error((await res.json()).error || 'Erstellen fehlgeschlagen');
                    toast('Benutzer erstellt', 'success');
                }
                showM365UserModal.value = false;
                await loadM365Users();
                await loadM365Skus();
            } catch (e) {
                toast('Fehler: ' + e.message, 'error');
            } finally {
                m365Saving.value = false;
            }
        }

        // Apply license and group differences for an existing user.
        async function m365SyncLicensesGroups(tenant, userId, origLicenses, origGroups) {
            const addLic = m365UserForm.licenses.filter(l => !origLicenses.includes(l));
            const remLic = origLicenses.filter(l => !m365UserForm.licenses.includes(l));
            if (addLic.length || remLic.length) {
                await apiFetch(`/api/m365/tenants/${tenant.id}/users/${userId}/licenses`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: addLic, remove: remLic })
                });
            }
            const addGrp = m365UserForm.groups.filter(g => !origGroups.includes(g));
            const remGrp = origGroups.filter(g => !m365UserForm.groups.includes(g));
            for (const gid of addGrp) {
                await apiFetch(`/api/m365/tenants/${tenant.id}/users/${userId}/groups`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: gid })
                });
            }
            for (const gid of remGrp) {
                await apiFetch(`/api/m365/tenants/${tenant.id}/users/${userId}/groups/${gid}`, { method: 'DELETE' });
            }
        }

        function openM365Password(user) {
            m365PasswordUser.value = user;
            m365PasswordValue.value = m365MakePassword();
            m365PasswordForceChange.value = true;
            m365ShowPassword.value = true;
            showM365PasswordModal.value = true;
        }

        async function saveM365Password() {
            const t = m365CurrentTenant.value;
            const u = m365PasswordUser.value;
            if (!m365PasswordValue.value) { toast('Passwort erforderlich', 'error'); return; }
            const res = await apiFetch(`/api/m365/tenants/${t.id}/users/${u.id}/password`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: m365PasswordValue.value, force_change: m365PasswordForceChange.value })
            });
            if (res.ok) { showM365PasswordModal.value = false; toast('Passwort zurückgesetzt', 'success'); }
            else { const e = await res.json().catch(() => ({})); toast('Fehler: ' + (e.error || ''), 'error'); }
        }

        // ---- Verteiler & Gruppen ----
        async function openM365Group(group) {
            m365SelectedGroup.value = group;
            m365AddMemberId.value = '';
            showM365MembersModal.value = true;
            await loadM365GroupMembers();
            if (!m365Users.value.length) await loadM365Users();
        }

        async function loadM365GroupMembers() {
            const t = m365CurrentTenant.value;
            const g = m365SelectedGroup.value;
            if (!t || !g) return;
            m365GroupMembersLoading.value = true;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/groups/${g.id}/members`);
            m365GroupMembersLoading.value = false;
            if (res.ok) m365GroupMembers.value = await res.json();
            else { const e = await res.json().catch(() => ({})); toast('Fehler: ' + (e.error || ''), 'error'); }
        }

        async function addM365Member() {
            const t = m365CurrentTenant.value;
            const g = m365SelectedGroup.value;
            if (!m365AddMemberId.value) return;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/groups/${g.id}/members`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: m365AddMemberId.value })
            });
            if (res.ok) { m365AddMemberId.value = ''; await loadM365GroupMembers(); toast('Mitglied hinzugefügt', 'success'); }
            else { const e = await res.json().catch(() => ({})); toast('Fehler: ' + (e.error || ''), 'error'); }
        }

        async function removeM365Member(userId) {
            const t = m365CurrentTenant.value;
            const g = m365SelectedGroup.value;
            const res = await apiFetch(`/api/m365/tenants/${t.id}/groups/${g.id}/members/${userId}`, { method: 'DELETE' });
            if (res.ok) { await loadM365GroupMembers(); toast('Mitglied entfernt', 'success'); }
            else { const e = await res.json().catch(() => ({})); toast('Fehler: ' + (e.error || ''), 'error'); }
        }

        // Local user management
        const localMachineId = ref('');
        const localUsers = ref([]);
        const localGroups = ref([]);
        const localUsersLoading = ref(false);
        const showLocalUserModal = ref(false);
        const localUserFormMode = ref('create');
        const localUserFormTab = ref('general');
        const localEditingUser = ref(null);
        const localUserForm = reactive({
            name: '', full_name: '', description: '', password: '',
            enabled: true, password_never_expires: false, groups: []
        });
        const localUserSearch = ref('');
        const localGroupSearch = ref('');

        const localFilteredUsers = computed(() => {
            if (!localUserSearch.value) return localUsers.value;
            const q = localUserSearch.value.toLowerCase();
            return localUsers.value.filter(u =>
                (u.name || '').toLowerCase().includes(q) ||
                (u.full_name || '').toLowerCase().includes(q));
        });

        const localGroupsFiltered = computed(() => {
            let list = localGroups.value;
            if (localGroupSearch.value) {
                const q = localGroupSearch.value.toLowerCase();
                list = list.filter(g => (g.name || '').toLowerCase().includes(q));
            }
            return [...list].sort((a, b) => {
                const aChk = localUserForm.groups.includes(a.name) ? 0 : 1;
                const bChk = localUserForm.groups.includes(b.name) ? 0 : 1;
                if (aChk !== bChk) return aChk - bChk;
                return (a.name || '').localeCompare(b.name || '', 'de');
            });
        });

        async function loadLocalUsers() {
            if (!localMachineId.value) return;
            localUsersLoading.value = true;
            const res = await apiFetch(`/api/ad/${localMachineId.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'local_list_users', parameters: {} })
            });
            if (!res.ok) { localUsersLoading.value = false; toast('Fehler', 'error'); }
        }

        async function loadLocalGroups() {
            if (!localMachineId.value) return;
            const res = await apiFetch(`/api/ad/${localMachineId.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'local_list_groups', parameters: {} })
            });
            const data = await res.json();
            if (!data.success) return;
            const cmdId = data.command_id;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const cr = await apiFetch(`/api/commands/${localMachineId.value}/history`);
                if (cr.ok) {
                    const cmds = await cr.json();
                    const cmd = cmds.find(c => c.id === cmdId);
                    if (cmd && cmd.status === 'completed') {
                        try { const p = JSON.parse(cmd.result); localGroups.value = Array.isArray(p) ? p : (p ? [p] : []); } catch {}
                        break;
                    } else if (cmd && cmd.status === 'failed') break;
                }
            }
        }

        function openCreateLocalUser() {
            localUserFormMode.value = 'create'; localUserFormTab.value = 'general';
            localEditingUser.value = null;
            Object.assign(localUserForm, { name: '', full_name: '', description: '', password: '', enabled: true, password_never_expires: false, groups: [] });
            showLocalUserModal.value = true;
        }

        function openEditLocalUser(user) {
            localUserFormMode.value = 'edit'; localUserFormTab.value = 'general';
            localEditingUser.value = user;
            Object.assign(localUserForm, { name: user.name || '', full_name: user.full_name || '', description: user.description || '', password: '', enabled: user.enabled !== false, password_never_expires: user.password_never_expires || false, groups: Array.isArray(user.groups) ? [...user.groups] : [] });
            showLocalUserModal.value = true;
        }

        function openDuplicateLocalUser(user) {
            localUserFormMode.value = 'create'; localUserFormTab.value = 'general';
            localEditingUser.value = null;
            Object.assign(localUserForm, { name: '', full_name: '', description: user.description || '', password: '', enabled: user.enabled !== false, password_never_expires: user.password_never_expires || false, groups: Array.isArray(user.groups) ? [...user.groups] : [] });
            showLocalUserModal.value = true;
        }

        async function saveLocalUser() {
            if (!localUserForm.name) { toast('Benutzername erforderlich', 'error'); return; }
            if (localUserFormMode.value !== 'edit' && !localUserForm.password) { toast('Passwort erforderlich', 'error'); return; }
            let type, parameters;
            if (localUserFormMode.value === 'edit') {
                const orig = localEditingUser.value?.groups || [];
                type = 'local_update_user';
                parameters = { ...localUserForm, add_groups: localUserForm.groups.filter(g => !orig.includes(g)), remove_groups: orig.filter(g => !localUserForm.groups.includes(g)) };
                delete parameters.groups;
            } else {
                type = 'local_create_user'; parameters = { ...localUserForm };
            }
            const res = await apiFetch(`/api/ad/${localMachineId.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, parameters })
            });
            showLocalUserModal.value = false;
            if (res.ok) toast('Befehl gesendet...', 'info'); else toast('Fehler', 'error');
        }

        async function confirmDeleteLocalUser(user) {
            if (!await confirmDialog(`Benutzer "${user.name}" wirklich löschen?`)) return;
            await apiFetch(`/api/ad/${localMachineId.value}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'local_delete_user', parameters: { name: user.name } })
            });
            toast('Löschbefehl gesendet...', 'info');
        }

        function removeFromLocalGroup(g) { localUserForm.groups = localUserForm.groups.filter(x => x !== g); }

        // ---- Disk Explorer ----
        function openDiskExplorer(drive) {
            diskExplorerMachineId.value = selectedMachine.value.machine_id;
            let startPath = drive.drive_letter || drive.mount_point;
            // Ensure Windows drive letters have a trailing backslash (C: → C:\)
            if (startPath && /^[A-Za-z]:$/.test(startPath)) startPath += '\\';
            diskExplorerPath.value = startPath;
            diskExplorerData.value = null;
            diskExplorerHistory.value = [];
            showDiskExplorer.value = true;
            startDiskScan(startPath);
        }

        function diskExplorerGoTo(path) {
            diskExplorerData.value = null;
            diskExplorerHistory.value = [];
            diskExplorerPath.value = path;
            startDiskScan(path);
        }

        async function startDiskScan(customPath) {
            if (!diskExplorerMachineId.value) { toast('Bitte eine Maschine auswählen', 'error'); return; }
            const path = customPath !== undefined ? customPath : diskExplorerPath.value;
            diskExplorerLoading.value = true;
            diskExplorerData.value = null;
            const res = await apiFetch(`/api/commands/${diskExplorerMachineId.value}/disk-scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            if (!res.ok) {
                diskExplorerLoading.value = false;
                toast('Fehler beim Starten des Scans', 'error');
            }
        }

        function diskExplorerDrillDown(entry) {
            if (!entry.is_dir) return;
            diskExplorerHistory.value.push(diskExplorerData.value ? diskExplorerData.value.path : diskExplorerPath.value);
            diskExplorerPath.value = entry.path;
            startDiskScan(entry.path);
        }

        function diskExplorerBack() {
            if (!diskExplorerHistory.value.length) return;
            const prev = diskExplorerHistory.value.pop();
            diskExplorerPath.value = prev;
            startDiskScan(prev);
        }

        function diskExplorerMaxSize() {
            if (!diskExplorerData.value || !diskExplorerData.value.entries.length) return 1;
            return diskExplorerData.value.entries[0].size || 1;
        }

        function diskExplorerBarWidth(entry) {
            const pct = Math.round((entry.size / diskExplorerMaxSize()) * 100);
            return Math.max(pct, entry.size > 0 ? 1 : 0);
        }

        function diskExplorerBarColor(entry) {
            const pct = diskExplorerBarWidth(entry);
            if (pct > 70) return 'var(--danger)';
            if (pct > 35) return 'var(--warning)';
            return 'var(--accent)';
        }

        // ---- Table column definitions (used with <data-table>) ----
        const M = 'dt-hide-mobile';
        const machineColumns = [
            { key: '_select', label: '', sortable: false, searchable: false, stopClick: true, thStyle: 'width:36px' },
            { key: 'status', label: 'Status', filter: true },
            { key: 'name', label: 'Hostname', value: m => m.display_name || m.hostname },
            { key: 'os_type', label: 'OS', filter: true, thClass: M, tdClass: M },
            { key: 'category', label: 'Typ', filter: true, thClass: M, tdClass: M },
            { key: 'group_name', label: 'Gruppe', filter: true, placeholder: '–', thClass: M, tdClass: M },
            { key: 'agent_version', label: 'Agent', placeholder: '–', thClass: M, tdClass: M },
            { key: 'uptime', label: 'Laufzeit', value: m => (m._telemetry && m._telemetry.uptime ? formatUptime(m._telemetry.uptime) : '–'), sortValue: m => (m._telemetry && m._telemetry.uptime) || 0, thClass: M, tdClass: M },
            { key: '_actions', label: 'Aktionen', sortable: false, searchable: false, stopClick: true }
        ];
        const updatesColumns = [
            { key: '_select', label: '', sortable: false, searchable: false, stopClick: true, thStyle: 'width:36px' },
            { key: 'status', label: 'Status', filter: true },
            { key: 'name', label: 'Maschine', value: m => m.display_name || m.hostname },
            { key: 'updates_available', label: 'Ausstehend', sortValue: m => m.updates_available || 0 },
            { key: 'last_run_at', label: 'Letzter Lauf', sortValue: m => m.last_run_at || '', searchable: false, thClass: M, tdClass: M },
            { key: 'schedule_time', label: 'Zeitplan', placeholder: '–', thClass: M, tdClass: M },
            { key: '_actions', label: 'Aktionen', sortable: false, searchable: false, stopClick: true }
        ];
        const commandLogColumns = [
            { key: 'created_at', label: 'Zeitpunkt', value: c => formatTime(c.created_at), sortValue: c => c.created_at || '', thStyle: 'white-space:nowrap' },
            { key: 'machine', label: 'Maschine', value: c => c.display_name || c.hostname || (c.machine_id || '').slice(0, 8) },
            { key: 'command_type', label: 'Befehl', filter: true },
            { key: 'status', label: 'Status', filter: true },
            { key: 'result', label: 'Ergebnis', placeholder: '–', thClass: M, tdClass: M }
        ];
        const servicesColumns = [
            { key: 'name', label: 'Dienst', value: s => s.display_name || s.service_name },
            { key: 'status', label: 'Status', filter: true },
            { key: 'start_type', label: 'Starttyp', filter: true }
        ];
        const firewallColumns = [
            { key: 'name', label: 'Regel', value: r => r.rule_name || r.name },
            { key: 'direction', label: 'Richtung', filter: true },
            { key: 'action', label: 'Aktion', filter: true },
            { key: 'port', label: 'Port', placeholder: '–', thClass: M, tdClass: M }
        ];
        const sharesColumns = [
            { key: 'share_name', label: 'Freigabe' },
            { key: 'path', label: 'Pfad' },
            { key: 'description', label: 'Beschreibung', placeholder: '–' }
        ];
        const veeamJobColumns = [
            { key: 'job_name', label: 'Job' },
            { key: 'job_type', label: 'Typ', filter: true, placeholder: '–' },
            { key: 'last_run_status', label: 'Letzter Status', filter: true, placeholder: 'Unbekannt' },
            { key: 'last_run_time', label: 'Letzte Ausfuehrung', value: j => formatTime(j.last_run_time), sortValue: j => j.last_run_time || '', thClass: M, tdClass: M },
            { key: 'next_run_time', label: 'Naechster Lauf', value: j => formatTime(j.next_run_time), sortValue: j => j.next_run_time || '', thClass: M, tdClass: M }
        ];
        const veeamServerJobColumns = [
            { key: 'job_name', label: 'Job' },
            { key: 'job_type', label: 'Typ', filter: true },
            { key: 'last_result', label: 'Ergebnis', filter: true, placeholder: 'Nie gelaufen' },
            { key: 'last_run', label: 'Letzter Lauf', value: j => formatTime(j.last_run), sortValue: j => j.last_run || '', thClass: M, tdClass: M },
            { key: 'next_run', label: 'Nächster Lauf', value: j => formatTime(j.next_run), sortValue: j => j.next_run || '', thClass: M, tdClass: M },
            { key: 'target_repo', label: 'Ziel', placeholder: '–', thClass: M, tdClass: M },
            { key: '_actions', label: '', sortable: false, searchable: false, stopClick: true }
        ];
        const adUserColumns = [
            { key: 'sam_account_name', label: 'Benutzername' },
            { key: 'name', label: 'Name', value: u => u.display_name || ((u.given_name || '') + ' ' + (u.surname || '')).trim() },
            { key: 'email', label: 'E-Mail', placeholder: '–', thClass: M, tdClass: M },
            { key: 'department', label: 'Abteilung', filter: true, placeholder: '–', thClass: M, tdClass: M },
            { key: 'status', label: 'Status', filter: true, value: u => (u.enabled ? 'Aktiv' : 'Deakt.'), sortValue: u => (u.enabled ? 1 : 0) },
            { key: '_actions', label: 'Aktionen', sortable: false, searchable: false, stopClick: true }
        ];
        const localUserColumns = [
            { key: 'name', label: 'Benutzername' },
            { key: 'full_name', label: 'Anzeigename', placeholder: '–' },
            { key: 'description', label: 'Beschreibung', placeholder: '–', thClass: M, tdClass: M },
            { key: 'status', label: 'Status', filter: true, value: u => (u.enabled ? 'Aktiv' : 'Deakt.'), sortValue: u => (u.enabled ? 1 : 0) },
            { key: '_actions', label: 'Aktionen', sortable: false, searchable: false, stopClick: true }
        ];
        const scanResultColumns = [
            { key: '_select', label: '', sortable: false, searchable: false, stopClick: true, thStyle: 'width:36px' },
            { key: 'ip', label: 'IP' },
            { key: 'hostname', label: 'Hostname', placeholder: '–' },
            { key: 'os_guess', label: 'OS', filter: true },
            { key: 'category', label: 'Kategorie', filter: true, thClass: M, tdClass: M }
        ];
        const securityColumns = [
            { key: 'status', label: 'Status', filter: true },
            { key: 'name', label: 'Maschine', value: m => m.display_name || m.hostname },
            { key: 'os_type', label: 'OS', filter: true, thClass: M, tdClass: M },
            { key: 'firewall', label: 'Firewall', value: m => m.firewall_enabled ? 'Aktiv' : 'Inaktiv', filter: true },
            { key: 'profiles', label: 'Profile', sortable: false, searchable: false, thClass: M, tdClass: M },
            { key: 'defender', label: 'Defender', value: m => m.os_type === 'windows' ? (m.defender_realtime ? 'Aktiv' : 'Inaktiv') : '–', filter: true },
            { key: 'ports', label: 'Ports', value: m => m.firewall_ports_count || 0, thClass: M, tdClass: M },
            { key: 'rules', label: 'Regeln', value: m => m.firewall_rules_count || 0, thClass: M, tdClass: M },
            { key: '_actions', label: 'Aktionen', sortable: false, searchable: false, stopClick: true }
        ];
        const securityPortColumns = [
            { key: 'port', label: 'Port', sortValue: p => p.port },
            { key: 'protocol', label: 'Protokoll' },
            { key: 'address', label: 'Adresse', placeholder: '–' },
            { key: 'process', label: 'Prozess', placeholder: '–' }
        ];
        const securityRuleColumns = [
            { key: 'name', label: 'Regel' },
            { key: 'direction', label: 'Richtung', filter: true },
            { key: 'action', label: 'Aktion', filter: true },
            { key: 'protocol', label: 'Protokoll', placeholder: '–', thClass: M, tdClass: M },
            { key: 'port', label: 'Port', placeholder: '*', thClass: M, tdClass: M }
        ];

        return {
            view, sidebarOpen, username, machines, stats, alerts, alertCount,
            showAddMachine, showTokenModal, showAddVeeam, showBatchInstall, showGroupsModal,
            groups, newGroupName, filterGroup, filteredMachines, addGroup, deleteGroup, assignGroup,
            batchInstallPkg, batchInstallMethod, selectedMachines, commandHistory, liveCommand,
            veeamInstances, newVeeam,
            veeamServers, showVeeamHistory, veeamHistoryJob, veeamHistorySessions, veeamHistoryLoading,
            loadVeeamServers, openVeeamHistory, veeamRepoPercent, veeamRepoColor, veeamResultClass, veeamJobTypeLabel,
            veeamServerJobColumns,
            tokenMachine, selectedMachine, machineDisks, machineServices, machineFirewall,
            machineUpdates, machineShares, telemetryHistory, telemetryRange,
            telemetryCanvas, baseUrl, newMachine, settingsForm,
            machineUptime, machineLatestMetrics, detailServicesClosed, detailFirewallClosed,
            updatesPendingModal,
            navigate, addMachine, deleteMachine, showToken, sendCommand, updateAgent,
            showEditMachine, editMachineForm, openEditMachine, saveEditMachine,
            triggerUpdates, scheduleUpdates, scheduleTime,
            toggleAllMachines, batchCommand, executeBatchInstall,
            updatesOsTab, updatesMachines, updatesSelected, updatesBatchTime, updatesBatchReboot,
            updatesFilteredMachines, updatesToggleAll, triggerBatchUpdates, triggerSingleUpdate, batchJobResults,
            updatesLogMachine, updatesLogs, updatesLogsLoading, openUpdateLog, loadMachineUpdateLogs,
            updatesScheduleMachine, updatesScheduleForm, openScheduleModal, saveSchedule, removeSchedule,
            setBatchSchedule, updatesLiveStreams,
            showDeployModal, onlineAgents, scanning, scanDone, scanResults, deployTargets,
            deployForm, deployResult, deployCommandMap, scanNetwork, toggleAllScan, executeBatchDeploy, executeDeploy,
            addVeeamInstance, deleteVeeamInstance,
            saveSettings, testEmail, regenerateEnrollmentKey, acknowledgeAlert, logout,
            alertFilter, alertGroupFilter, alertTypeFilter, alertSelected, alertTypes,
            alertFilteredList, alertGroupedEntries, toggleAlertSelect,
            alertAcknowledgeSelected, alertAcknowledgeAll, alertAcknowledgeGroup,
            loadTelemetryHistory, formatTime, formatBytes, diskPercent, formatUptime,
            logTab, setLogTab, logEntries, logFilter, logSearch, logAutoScroll, logContainer, filteredLogEntries,
            connectLogStream, formatLogTime, logLineColor, scrollLogsToBottom,
            cmdLogSearch, cmdLogStatus, cmdLogType, commandTypes, filteredCommandHistory,
            cmdLogDetail, openCmdDetail, formatCmdParams, copyText,
            adDomainControllers, adSelectedDC, adUsers, adGroups, adUsersLoading, adUsersOutput,
            adTemplates, showADUserModal, showADTemplatesModal, adUserSearch, adUserFormMode,
            adUserFormTab, adEditingUser, adDuplicateSource, adShowPassword, adUserForm, adTemplateForm, adFilteredUsers,
            adGroupSearch, adGroupsFiltered, removeFromADGroup,
            loadADDomainControllers, loadADUsers, loadADGroups,
            openCreateADUser, openEditADUser, openDuplicateADUser, saveADUser, confirmDeleteADUser,
            loadADTemplates, deleteADTemplate, applyADTemplate, saveADTemplateFromForm, adAutoDisplayName, generateADPassword,
            adOUs, adSelectedOU, adShowMoveModal, adMoveUser, adMoveTargetOU, ouTreeFlat, adOuSelectOptions, adUsersForOU,
            loadADOUs, openMoveUser, confirmMoveUser, adAdminTab, openUserAdmin,
            m365Tenants, m365SelectedTenant, m365Users, m365Skus, m365Groups, m365Domains,
            m365UsersLoading, m365UsersOutput, m365Testing, m365Saving, m365UserSearch, m365GroupSearch, m365ShowPassword,
            showM365TenantModal, showM365UserModal, showM365PasswordModal,
            m365TenantForm, m365UserMode, m365UserTab, m365EditingUser, m365DuplicateSource, m365UserForm,
            m365PasswordUser, m365PasswordValue, m365PasswordForceChange, m365UserColumns,
            m365CurrentTenant, m365TenantsGrouped, m365FilteredUsers, m365GroupsFiltered,
            loadM365, onM365TenantChange, testM365Tenant, loadM365Users,
            openM365TenantModal, saveM365Tenant, deleteM365Tenant,
            openCreateM365User, openEditM365User, openDuplicateM365User, m365AutoFields, m365UpdateUpn,
            m365GeneratePassword, m365MakePassword, saveM365User, openM365Password, saveM365Password,
            m365Tab, m365SelectedGroup, m365GroupMembers, m365GroupMembersLoading, m365GroupSearchList,
            m365AddMemberId, showM365MembersModal, m365GroupColumns, m365GroupsForList, m365NonMembers,
            openM365Group, loadM365GroupMembers, addM365Member, removeM365Member,
            localMachineId, localUsers, localGroups, localUsersLoading, showLocalUserModal,
            localUserFormMode, localUserFormTab, localEditingUser, localUserForm,
            localUserSearch, localGroupSearch, localFilteredUsers, localGroupsFiltered,
            loadLocalUsers, loadLocalGroups, openCreateLocalUser, openEditLocalUser,
            openDuplicateLocalUser, saveLocalUser, confirmDeleteLocalUser, removeFromLocalGroup,
            toasts, confirmData,
            insightsData, insightsSummary, insightsFilter, insightsCategoryFilter,
            insightsCategories, insightsFiltered, insightsGrouped, loadInsights,
            securityData, securityDetailMachine, securityDetail,
            loadSecurityOverview, openSecurityDetail, securityToggleFirewall, securityToggleDefender,
            machineColumns, updatesColumns, commandLogColumns, servicesColumns,
            firewallColumns, sharesColumns, veeamJobColumns, adUserColumns,
            localUserColumns, scanResultColumns, securityColumns, securityPortColumns, securityRuleColumns,
            diskExplorerMachineId, diskExplorerPath, diskExplorerLoading, diskExplorerData, diskExplorerHistory,
            showDiskExplorer, openDiskExplorer, diskExplorerGoTo, startDiskScan, diskExplorerDrillDown, diskExplorerBack,
            diskExplorerBreadcrumbs, diskExplorerBarWidth, diskExplorerBarColor,
            showVnc, vncSrc, vncHostname, vncPort, vncPreparing, vncPrepareStatus,
            openVNC, closeVnc, reconnectVnc,
            rescanLoading, triggerRescan
        };
    }
});

app.component('data-table', DataTable);
app.mount('#app');
