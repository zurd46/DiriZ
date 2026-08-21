# Instanz-Dokumentation

**Instanz-ID:** lmstudio-ngrok-001  
**Modell:** mixtral-8x7b-instruct-v0:1  
**Provider:** lmstudio  
**Erstellt am:** 21.08.2026

## 📋 Übersicht

Beschreibung dieser KI-Instanz (über NGrok tunnelbar) und ihrer Fähigkeiten innerhalb des DiriZ-Orchestrierungssystems.

---

## ✨ Fähigkeiten / Capabilities

Liste der verfügbaren Fertigkeiten für diese Instanz:
- code: Unterstützung bei Programmieraufgaben
- reasoning: Logisches Denken und Problemlösung  
- longform: Verarbeitung längerer Texte und Geschichten
- vision: (falls unterstützt) Bildanalyse
- tools: Nutzung von Funktionen und Werkzeugen
- json: JSON-Verarbeitung und -Generierung

---

## 🔧 Konfiguration

### Anbieter-Einstellungen
- **Provider-Typ:** lmstudio
- **Endpunkt URL:** http://localhost:1234/v1 (via NGrok Tunnel)
- **API-Schlüssel:** (falls erforderlich, in Keychain gespeichert)
- **Privacy-Modus:** allow-cloud (optional je nach Aufgabe)

### Modell-Eigenschaften
- **Kontext-Fenster:** 16384 Token
- **Quantisierung:** float16 (gute Qualität/RAM-Balance)
- **Verfügbare Sprachen:** deutsch, english, französisch

---

## 📊 Monitoring & Metriken

### Aktueller Status
- **Status:** online
- **Letzte Prüfung:** 21.08.2026
- **Latenz:** ~100-300 ms (abhängig von NGrok Verbindung)

### Token-Nutzung
- **24h Input:** (wird aktualisiert)
- **24h Output:** (wird aktualisiert)
- **Kosten (24h):** (hängt von Nutzung ab, Cloud-Anbieter)

---

## 📁 Workspace

Verzeichnis für von der KI generierte Dateien:
- ~/DiriZ/workspace/lmstudio-ngrok/

### Aktuelle Dateien
Liste der imWorkspace erstellten Dateien wird hier angezeigt.

---

## 🔄 Routing & Entscheidungsfindung

Informationen zur Auswahl dieser Instanz durch das DiriZ-System:
- **Routing-Modus:** auto (automatische Auswahl beste Instanz)
- **Qualitäts-Score:** mittel-hoch
- **Grund für Selektion:** erweiterte Fähigkeiten durch größere Modelle, Cloud-Zugang

---

## ⚠️ Fehlerbehandlung & Failover

- **Max. Failover-Hops:** 2
- **Circuit Breaker Schwelle:** 3 aufeinanderstehende Fehler
- **Verhalten bei Ausfall:** Automatischer Wechsel zur nächsten verfügbaren Instanz (z.B. ollama-local oder OpenRouter)

---

## 📝 Feedback & Bewertung

Mögliche Bewertungen dieser Instanz-Ausführung:
- 1-5 Sterne Bewertung
- Kommentare zur Qualität
- Automatische Signale für Abbruch oder Neu-Routing

---

*Diese Dokumentation wird automatisch aktualisiert bei:*
- Jeder Task-Ausführung
- Parameter-Änderungen
- Status-Änderungen des Providers