# Instanz-Dokumentation

**Instanz-ID:** ollama-local-001  
**Modell:** llama3:8b  
**Provider:** ollama  
**Erstellt am:** 21.08.2026

## 📋 Übersicht

Beschreibung dieser lokalen KI-Instanz und ihrer Fähigkeiten innerhalb des DiriZ-Orchestrierungssystems.

---

## ✨ Fähigkeiten / Capabilities

Liste der verfügbaren Fertigkeiten für diese Instanz:
- code: Unterstützung bei Programmieraufgaben
- reasoning: Logisches Denken und Problemlösung
- longform: Verarbeitung längerer Texte und Dokumentationen
- vision: (falls unterstützt) Bildanalyse und -verstehen
- tools: Nutzung von Werkzeugen und Funktionen
- json: JSON-Verarbeitung und -Generierung

---

## 🔧 Konfiguration

### Anbieter-Einstellungen
- **Provider-Typ:** ollama
- **Endpunkt URL:** http://localhost:11434
- **API-Schlüssel:** (nicht erforderlich, lokal laufend)
- **Privacy-Modus:** local-only (Standard - keine Cloud-Datenweitergabe)

### Modell-Eigenschaften
- **Kontext-Fenster:** 8192 Token
- **Quantisierung:** q4_0 (effizient ausgewogen)
- **Verfügbare Sprachen:** deutsch, english

---

## 📊 Monitoring & Metriken

### Aktueller Status
- **Status:** online
- **Letzte Prüfung:** 21.08.2026
- **Latenz:** < 50 ms (lokal)

### Token-Nutzung
- **24h Input:** (wird aktualisiert)
- **24h Output:** (wird aktualisiert)
- **Kosten (24h):** 0 € (lokal, keine API-Kosten)

---

## 📁 Workspace

Verzeichnis für von der KI generierte Dateien:
- ~/DiriZ/workspace/ollama-local/

### Aktuelle Dateien
Liste der imWorkspace erstellten Dateien wird hier angezeigt.

---

## 🔄 Routing & Entscheidungsfindung

Informationen zur Auswahl dieser Instanz durch das DiriZ-System:
- **Routing-Modus:** auto (automatische Auswahl beste Instanz)
- **Qualitäts-Score:** hoch
- **Grund für Selektion:** lokale Ausführung, keine Latenz, volle Privatsphäre

---

## ⚠️ Fehlerbehandlung & Failover

- **Max. Failover-Hops:** 2
- **Circuit Breaker Schwelle:** 3 aufeinanderstehende Fehler
- **Verhalten bei Ausfall:** Automatischer Wechsel zur nächsten verfügbaren Instanz (z.B. LM Studio oder Cloud)

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