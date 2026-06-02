const { createApp, ref, reactive, onMounted, onUnmounted, computed } = Vue;

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
        const showDeployModal = ref(false);
        const onlineAgents = ref([]);
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
        const tokenMachine = ref({});
        const selectedMachine = ref(null);
        const machineDisks = ref([]);
        const machineServices = ref([]);
        const machineFirewall = ref({ enabled: false, rules: [] });
        const machineUpdates = ref({ available: 0, pending: [], reboot_required: false });
        const machineShares = ref([]);
        const telemetryHistory = ref([]);
        const telemetryRange = ref('24h');
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
                const data = JSON.parse(event.data);
                handleWsEvent(data);
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
            }
        }

        async function loadDashboard() {
            await Promise.all([loadMachines(), loadStats(), loadAlerts(), loadSettings(), loadVeeamInstances(), loadOnlineAgents()]);
        }

        async function loadMachines() {
            const res = await fetch('/api/machines');
            if (res.ok) machines.value = await res.json();
        }

        async function loadStats() {
            const res = await fetch('/api/monitoring/overview');
            if (res.ok) stats.value = await res.json();
        }

        async function loadAlerts() {
            const res = await fetch('/api/monitoring/alerts');
            if (res.ok) alerts.value = await res.json();
        }

        async function loadSettings() {
            const res = await fetch('/api/settings');
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
            }
        }

        async function loadMachineDetail(id) {
            const res = await fetch(`/api/machines/${id}`);
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
            const res = await fetch(`/api/monitoring/machines/${mid}/telemetry?range=${telemetryRange.value}`);
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
            const res = await fetch('/api/machines', {
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
            if (!confirm(`Maschine "${m.hostname}" wirklich entfernen?`)) return;
            await fetch(`/api/machines/${m.id}`, { method: 'DELETE' });
            await loadMachines();
            await loadStats();
        }

        function showToken(m) {
            tokenMachine.value = m;
            showTokenModal.value = true;
        }

        async function sendCommand(type) {
            if (!selectedMachine.value) return;
            if (!confirm(`${type === 'restart' ? 'Neustart' : 'Herunterfahren'} wirklich ausführen?`)) return;

            await fetch(`/api/commands/${selectedMachine.value.machine_id}/${type}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
        }

        async function updateAgent() {
            if (!selectedMachine.value) return;

            const res = await fetch('/api/deploy/update-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_id: selectedMachine.value.machine_id })
            });
            const data = await res.json();

            if (data.success) {
                alert('Update-Befehl gesendet. Agent startet sich in wenigen Sekunden neu.');
            } else if (data.error && data.error.includes('unknown command')) {
                // Old agent doesn't support update_agent - show manual command
                const manRes = await fetch('/api/deploy/update-agent-manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ machine_id: selectedMachine.value.machine_id })
                });
                const manData = await manRes.json();
                alert(`Agent unterstützt Remote-Update noch nicht. Führe diesen Befehl auf der Maschine aus:\n\n${manData.command}`);
            } else {
                alert(data.error || 'Update fehlgeschlagen');
            }
        }

        async function saveSettings() {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settingsForm)
            });
            if (res.ok) alert('Einstellungen gespeichert');
        }

        async function testEmail() {
            const to = prompt('Email-Adresse für Testmail:');
            if (!to) return;
            const res = await fetch('/api/settings/test-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to })
            });
            const data = await res.json();
            alert(data.success ? 'Test-Email gesendet!' : `Fehler: ${data.error}`);
        }

        async function loadOnlineAgents() {
            const res = await fetch('/api/deploy/online-agents');
            if (res.ok) onlineAgents.value = await res.json();
        }

        async function executeDeploy() {
            if (!deployForm.relay_machine_id || !deployForm.target_ip || !deployForm.username) {
                deployResult.value = { success: false, message: 'Relay, Ziel-IP und Benutzername erforderlich' };
                return;
            }
            deployResult.value = null;
            const res = await fetch('/api/deploy/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deployForm)
            });
            const data = await res.json();
            if (data.success) {
                deployResult.value = { success: true, message: 'Deploy-Befehl gesendet! Maschine erscheint in Kürze.' };
            } else {
                deployResult.value = { success: false, message: data.error || 'Deploy fehlgeschlagen' };
            }
        }

        async function loadVeeamInstances() {
            const res = await fetch('/api/veeam/instances');
            if (res.ok) {
                const instances = await res.json();
                for (const inst of instances) {
                    const jobsRes = await fetch(`/api/veeam/instances/${inst.id}/jobs`);
                    inst.jobs = jobsRes.ok ? await jobsRes.json() : [];
                }
                veeamInstances.value = instances;
            }
        }

        async function addVeeamInstance() {
            if (!newVeeam.name || !newVeeam.base_url || !newVeeam.username || !newVeeam.password) {
                alert('Alle Felder ausfüllen'); return;
            }
            const res = await fetch('/api/veeam/instances', {
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
                alert(err.error || 'Fehler beim Hinzufügen');
            }
        }

        async function deleteVeeamInstance(id) {
            if (!confirm('Veeam-Instanz wirklich entfernen?')) return;
            await fetch(`/api/veeam/instances/${id}`, { method: 'DELETE' });
            await loadVeeamInstances();
        }

        async function regenerateEnrollmentKey() {
            if (!confirm('Enrollment Key wirklich neu generieren? Bestehende Install-Befehle werden ungültig.')) return;
            const res = await fetch('/api/settings/regenerate-enrollment-key', { method: 'POST' });
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
            if (!online.length) { alert('Keine der ausgewählten Maschinen ist online.'); return; }
            if (!confirm(`"${type}" auf ${online.length} Maschine(n) ausführen?`)) return;

            for (const mid of online) {
                await fetch(`/api/commands/${mid}/${type}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
            }
            selectedMachines.value = [];
        }

        async function executeBatchInstall() {
            if (!batchInstallPkg.value) { alert('Paketname eingeben'); return; }
            const online = selectedMachines.value.filter(mid => {
                const m = machines.value.find(x => x.machine_id === mid);
                return m && m.status === 'online';
            });
            if (!online.length) { alert('Keine der ausgewählten Maschinen ist online.'); return; }

            for (const mid of online) {
                await fetch(`/api/commands/${mid}/install-software`, {
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
            const res = await fetch('/api/commands/history');
            if (res.ok) commandHistory.value = await res.json();
        }

        async function acknowledgeAlert(id) {
            await fetch(`/api/monitoring/alerts/${id}/acknowledge`, { method: 'POST' });
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

        return {
            view, username, machines, stats, alerts, alertCount,
            showAddMachine, showTokenModal, showAddVeeam, showBatchInstall,
            batchInstallPkg, batchInstallMethod, selectedMachines, commandHistory,
            veeamInstances, newVeeam,
            tokenMachine, selectedMachine, machineDisks, machineServices, machineFirewall,
            machineUpdates, machineShares, telemetryHistory, telemetryRange,
            telemetryCanvas, baseUrl, newMachine, settingsForm,
            navigate, addMachine, deleteMachine, showToken, sendCommand, updateAgent,
            toggleAllMachines, batchCommand, executeBatchInstall,
            showDeployModal, onlineAgents, deployForm, deployResult, executeDeploy,
            addVeeamInstance, deleteVeeamInstance,
            saveSettings, testEmail, regenerateEnrollmentKey, acknowledgeAlert, logout,
            loadTelemetryHistory, formatTime, formatBytes, diskPercent
        };
    }
}).mount('#app');
