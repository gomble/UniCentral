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
        const tokenMachine = ref({});
        const selectedMachine = ref(null);
        const machineDisks = ref([]);
        const machineServices = ref([]);
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
            await Promise.all([loadMachines(), loadStats(), loadAlerts(), loadSettings()]);
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
            if (res.ok) Object.assign(settingsForm, await res.json());
        }

        function navigate(target, id) {
            view.value = target;
            if (target === 'machine-detail' && id) {
                loadMachineDetail(id);
            }
        }

        async function loadMachineDetail(id) {
            const res = await fetch(`/api/machines/${id}`);
            if (res.ok) {
                selectedMachine.value = await res.json();
                const mid = selectedMachine.value.machine_id;

                const [disksRes, servicesRes] = await Promise.all([
                    fetch(`/api/monitoring/machines/${mid}/disks`),
                    fetch(`/api/monitoring/machines/${mid}/services`)
                ]);
                if (disksRes.ok) machineDisks.value = await disksRes.json();
                if (servicesRes.ok) machineServices.value = await servicesRes.json();
            }
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
            showAddMachine, showTokenModal, showAddVeeam, tokenMachine,
            selectedMachine, machineDisks, machineServices, baseUrl,
            newMachine, settingsForm,
            navigate, addMachine, deleteMachine, showToken, sendCommand,
            saveSettings, testEmail, acknowledgeAlert, logout,
            formatTime, formatBytes, diskPercent
        };
    }
}).mount('#app');
