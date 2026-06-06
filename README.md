# UniCentral

Zentrales Web-Dashboard zur Verwaltung von Windows- und Linux-Maschinen über einen leichtgewichtigen Go-Agenten.

## Features

### Dashboard
- Übersicht aller Maschinen mit Live-CPU, RAM und Festplattenbelegung
- Online/Offline-Status in Echtzeit via WebSocket

### Maschinenverwaltung
- Automatische Registrierung über Enrollment-Key
- Gruppen-Zuweisung
- Maschinendetails: Dienste, Freigaben, Firewall-Regeln, Telemetrie-Verlauf

### Festplatten-Explorer
- TreeSize-ähnliche Ansicht direkt im Browser
- Maschine und Pfad auswählen, Verzeichnis rekursiv analysieren
- Ergebnisse sortiert nach Größe mit visuellem Balkendiagramm
- Drill-Down in Unterverzeichnisse per Klick
- Unterstützt Windows (`C:\`) und Linux (`/`)

### Updates
- Ausstehende Windows- und Linux-Updates einsehen
- Updates einzeln oder per Batch auslösen (mit/ohne Reboot)
- Zeitgesteuerte Update-Pläne

### AD-Verwaltung
- Active-Directory-Benutzer und -Gruppen verwalten (Erstellen, Bearbeiten, Löschen, Verschieben)
- Lokale Benutzerverwaltung auf nicht-DC-Maschinen
- Benutzer-Vorlagen für schnelles Anlegen

### Veeam Backup
- Veeam Backup & Replication Jobs überwachen
- Status, letzte und nächste Ausführung im Überblick

### Benachrichtigungen & Alarme
- E-Mail-Benachrichtigungen (SMTP)
- Alarme bei kritischer Festplattenbelegung, Offline-Maschinen etc.

### Weitere Funktionen
- Remote-Befehle: Neustart, Herunterfahren, Software installieren, Firewall-Regeln
- Remote-Deployment des Agenten auf neue Maschinen
- Netzwerk-Scan zur Erkennung neuer Hosts
- Automatische Agenten-Aktualisierung
- Live-Log-Stream im Browser

## Installation

### Docker (empfohlen)

```yaml
services:
  unicentral:
    image: gomble/unicentral:latest
    container_name: unicentral
    ports:
      - "9100:3000"
    environment:
      - BASE_URL=https://unicentral.example.com
      - ENROLLMENT_KEY=dein-geheimer-key
    volumes:
      - unicentral-data:/app/data
    restart: unless-stopped

volumes:
  unicentral-data:
```

```sh
docker compose up -d
```

### Agent installieren

**Windows (PowerShell als Administrator):**
```powershell
irm https://unicentral.example.com/api/agent/install-script/windows?key=ENROLLMENT_KEY | iex
```

**Linux:**
```bash
curl -fsSL "https://unicentral.example.com/api/agent/install-script/linux?key=ENROLLMENT_KEY" | bash
```

## Anforderungen

- Docker & Docker Compose
- Netzwerkzugriff der Agenten zum UniCentral-Server (Port 9100 oder konfiguriert)
