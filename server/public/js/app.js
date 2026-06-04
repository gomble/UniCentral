const { createApp, ref, reactive, onMounted, onUnmounted, computed } = Vue;

// Wrapper around fetch that redirects to /login.html on 401 (expired session).
async function apiFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        window.location.href = '/login.html';
        return new Response('{}', { status: 401 });
    }
    return res;
}

createApp({
    setup() {
        const view = ref('dashboard');
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

        onMounted(async () => {
            const authRes = await fetch('/auth/check');
            const auth = await authRes.json();
            if (!auth.authenticated) {
                window.location.href = '/login.html';
                return;
            }
            username.value = auth.username;

            await loadDashboard();
            connectWebSocket();
        });

        onUnmounted(() => {
            if (ws) ws.close();
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
                if (p.status === 'completed') {
                    toast(p.result || 'Operation erfolgreich', 'success');
                    loadADUsers();
                } else if (p.status === 'failed') {
                    toast('Fehler: ' + (p.result || 'Unbekannter Fehler'), 'error');
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

        function navigate(target, id) {
            view.value = target;
            if (target === 'machine-detail' && id) {
                loadMachineDetail(id);
            } else if (target === 'command-history') {
                loadCommandHistory();
            } else if (target === 'updates') {
                loadUpdatesMachines();
            } else if (target === 'ad-admin') {
                loadADDomainControllers();
                loadADTemplates();
            }
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
                deployResult.value = { success: true, message: `Deploy gestartet fuer ${data.results.length} Maschine(n). Sie erscheinen in Kuerze im Dashboard.` };
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
            Object.assign(adUserForm, {
                sam_account_name: '', given_name: '', surname: '', display_name: '',
                password: '', email: '', upn: '',
                department: user.department || '',
                title: user.title || '',
                company: user.company || '',
                description: user.description || '',
                office_phone: '', mobile_phone: '', ou: '',
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

        function adAutoDisplayName() {
            const fn = adUserForm.given_name || '';
            const sn = adUserForm.surname || '';
            adUserForm.display_name = (fn + ' ' + sn).trim();
        }

        return {
            view, username, machines, stats, alerts, alertCount,
            showAddMachine, showTokenModal, showAddVeeam, showBatchInstall, showGroupsModal,
            groups, newGroupName, filterGroup, filteredMachines, addGroup, deleteGroup, assignGroup,
            batchInstallPkg, batchInstallMethod, selectedMachines, commandHistory, liveCommand,
            veeamInstances, newVeeam,
            tokenMachine, selectedMachine, machineDisks, machineServices, machineFirewall,
            machineUpdates, machineShares, telemetryHistory, telemetryRange,
            telemetryCanvas, baseUrl, newMachine, settingsForm,
            machineUptime,
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
            deployForm, deployResult, scanNetwork, toggleAllScan, executeBatchDeploy, executeDeploy,
            addVeeamInstance, deleteVeeamInstance,
            saveSettings, testEmail, regenerateEnrollmentKey, acknowledgeAlert, logout,
            loadTelemetryHistory, formatTime, formatBytes, diskPercent, formatUptime,
            adDomainControllers, adSelectedDC, adUsers, adGroups, adUsersLoading, adUsersOutput,
            adTemplates, showADUserModal, showADTemplatesModal, adUserSearch, adUserFormMode,
            adUserFormTab, adEditingUser, adUserForm, adTemplateForm, adFilteredUsers,
            loadADDomainControllers, loadADUsers, loadADGroups,
            openCreateADUser, openEditADUser, openDuplicateADUser, saveADUser, confirmDeleteADUser,
            loadADTemplates, deleteADTemplate, applyADTemplate, saveADTemplateFromForm, adAutoDisplayName,
            toasts, confirmData
        };
    }
}).mount('#app');
