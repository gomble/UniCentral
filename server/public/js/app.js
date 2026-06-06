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

        const showAddMachine = ref(false);
        const showTokenModal = ref(false);
        const showAddVeeam = ref(false);
        const veeamInstances = ref([]);
        const newVeeam = reactive({
            name: '', base_url: '', username: '', password: '',
            poll_interval_seconds: 300, verify_ssl: false
        });
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
            offlineThreshold: 90
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

            history.replaceState({ view: 'dashboard', id: null }, '', '#dashboard');
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

        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws/dashboard`);

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
                loadMachines();
                loadStats();
            } else if (data.type === 'heartbeat') {
                const m = machines.value.find(x => x.machine_id === data.machineId);
                if (m) m.status = 'online';
            } else if (data.type === 'command_result') {
                handleCommandResultEvent(data);
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
            const isUpdateCmd = ['trigger_updates', 'trigger_updates_reboot'].includes(p.command_type);
            if (isUpdateCmd && (p.status === 'completed' || p.status === 'failed')) {
                loadUpdatesMachines();
                if (updatesLogMachine.value && updatesLogMachine.value.machine_id === data.machineId) {
                    loadMachineUpdateLogs(data.machineId);
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
            await Promise.all([loadMachines(), loadStats(), loadAlerts(), loadSettings(), loadVeeamInstances(), loadOnlineAgents(), loadGroups()]);
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

        async function acknowledgeAlert(id) {
            await apiFetch(`/api/monitoring/alerts/${id}/acknowledge`, { method: 'POST' });
            await loadAlerts();
        }

        async function logout() {
            await fetch('/auth/logout', { method: 'POST' });
            window.location.href = '/login.html';
        }

        function formatTime(t) {
            if (!t) return '–';
            const d = new Date(t + 'Z');
            const now = new Date();
            const diff = (now - d) / 1000;
            if (diff < 60) return 'gerade eben';
            if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
            if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
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
            showADUserModal.value = true;
        }

        function openEditADUser(user) {
            adUserFormMode.value = 'edit';
            adUserFormTab.value = 'general';
            adEditingUser.value = user;
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
            let ou = '';
            if (user.distinguished_name) {
                const parts = user.distinguished_name.split(',');
                const ouStart = parts.findIndex(p => /^(ou|dc)=/i.test(p));
                if (ouStart > 0) ou = parts.slice(ouStart).join(',');
            }
            Object.assign(adUserForm, {
                sam_account_name: '', given_name: '', surname: '', display_name: '',
                password: '', email: '', upn: '',
                department: user.department || '',
                title: user.title || '',
                company: user.company || '',
                description: user.description || '',
                office_phone: '', mobile_phone: '', ou,
                enabled: user.enabled !== false,
                password_never_expires: user.password_never_expires || false,
                change_password_at_logon: true,
                cannot_change_password: user.cannot_change_password || false,
                groups: Array.isArray(user.groups) ? [...user.groups] : []
            });
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
                delete parameters.password;
            } else {
                type = 'ad_create_user';
                parameters = { ...adUserForm };
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

        return {
            view, sidebarOpen, username, machines, stats, alerts, alertCount,
            showAddMachine, showTokenModal, showAddVeeam, showBatchInstall, showGroupsModal,
            groups, newGroupName, filterGroup, filteredMachines, addGroup, deleteGroup, assignGroup,
            batchInstallPkg, batchInstallMethod, selectedMachines, commandHistory, liveCommand,
            veeamInstances, newVeeam,
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
            updatesFilteredMachines, updatesToggleAll, triggerBatchUpdates, triggerSingleUpdate,
            updatesLogMachine, updatesLogs, updatesLogsLoading, openUpdateLog, loadMachineUpdateLogs,
            updatesScheduleMachine, updatesScheduleForm, openScheduleModal, saveSchedule, removeSchedule,
            setBatchSchedule, updatesLiveStreams,
            showDeployModal, onlineAgents, scanning, scanDone, scanResults, deployTargets,
            deployForm, deployResult, deployCommandMap, scanNetwork, toggleAllScan, executeBatchDeploy, executeDeploy,
            addVeeamInstance, deleteVeeamInstance,
            saveSettings, testEmail, regenerateEnrollmentKey, acknowledgeAlert, logout,
            loadTelemetryHistory, formatTime, formatBytes, diskPercent, formatUptime,
            logTab, setLogTab, logEntries, logFilter, logSearch, logAutoScroll, logContainer, filteredLogEntries,
            connectLogStream, formatLogTime, logLineColor, scrollLogsToBottom,
            cmdLogSearch, cmdLogStatus, cmdLogType, commandTypes, filteredCommandHistory,
            cmdLogDetail, openCmdDetail, formatCmdParams, copyText,
            adDomainControllers, adSelectedDC, adUsers, adGroups, adUsersLoading, adUsersOutput,
            adTemplates, showADUserModal, showADTemplatesModal, adUserSearch, adUserFormMode,
            adUserFormTab, adEditingUser, adUserForm, adTemplateForm, adFilteredUsers,
            adGroupSearch, adGroupsFiltered, removeFromADGroup,
            loadADDomainControllers, loadADUsers, loadADGroups,
            openCreateADUser, openEditADUser, openDuplicateADUser, saveADUser, confirmDeleteADUser,
            loadADTemplates, deleteADTemplate, applyADTemplate, saveADTemplateFromForm, adAutoDisplayName,
            adOUs, adSelectedOU, adShowMoveModal, adMoveUser, adMoveTargetOU, ouTreeFlat, adUsersForOU,
            loadADOUs, openMoveUser, confirmMoveUser, adAdminTab, openUserAdmin,
            localMachineId, localUsers, localGroups, localUsersLoading, showLocalUserModal,
            localUserFormMode, localUserFormTab, localEditingUser, localUserForm,
            localUserSearch, localGroupSearch, localFilteredUsers, localGroupsFiltered,
            loadLocalUsers, loadLocalGroups, openCreateLocalUser, openEditLocalUser,
            openDuplicateLocalUser, saveLocalUser, confirmDeleteLocalUser, removeFromLocalGroup,
            toasts, confirmData,
            machineColumns, updatesColumns, commandLogColumns, servicesColumns,
            firewallColumns, sharesColumns, veeamJobColumns, adUserColumns,
            localUserColumns, scanResultColumns,
            diskExplorerMachineId, diskExplorerPath, diskExplorerLoading, diskExplorerData, diskExplorerHistory,
            showDiskExplorer, openDiskExplorer, diskExplorerGoTo, startDiskScan, diskExplorerDrillDown, diskExplorerBack,
            diskExplorerBreadcrumbs, diskExplorerBarWidth, diskExplorerBarColor
        };
    }
});

app.component('data-table', DataTable);
app.mount('#app');
