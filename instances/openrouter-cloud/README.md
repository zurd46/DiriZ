# Instanz-Dokumentation

**Instanz-ID:** openrouter-cloud-001  
**Modell:** meta-llama/llama-3.1-8b-instruct:free  
**Provider:** openrouter  
**Erstellt am:** 21.08.2026

## 📋 Übersicht

Beschreibung dieser Cloud-KI-Instanz und ihrer Fähigkeiten innerhalb des DiriZ-Orchestrierungssystems.

---

## ✨ Fähigkeiten / Capabilities

Liste der verfügbaren Fertigkeiten für diese Instanz:
- code: Unterstützung bei Programmieraufgaben mit aktuellen Bibliotheken
- reasoning: Logisches Denken mit neuesten Erkenntnissen
- longform: Verarbeitung längerer Texte mit aktuellem Wissen
- vision: (falls unterstützt) Bildanalyse mit aktuellen Modellen
- tools: Nutzung von Funktionen und externen Diensten
- json: JSON-Verarbeitung und -Generierung

---

## 🔧 Konfiguration

### Anbieter-Einstellungen
- **Provider-Typ:** openrouter
- **Endpunkt URL:** https://openrouter.ai/api/v1
- **API-Schlüssel:** (in Keychain/Secure Storage verschlüsselt gespeichert)
- **Privacy-Modus:** allow-cloud (erforderlich für Cloud-Zugang)

### Modell-Eigenschaften
- **Kontext-Fenster:** 32768 Token
- **Quantisierung:** basiert auf Modell-Spezifikation
- **Verfügbare Sprachen:** deutsch, english, französisch, spanisch und weitere

---

## 📊 Monitoring & Metriken

### Aktueller Status
- **Status:** online
- **Letzte Prüfung:** 21.08.2026
- **Latenz:** ~200-800 ms (abhängig von Internetverbindung und Last)

### Token-Nutzung
- **24h Input:** (wird aktualisiert)
- **24h Output:** (wird aktualisiert)
- **Kosten (24h):** (abhängig von Nutzung, kostenlose Modelle verfügbar mit Limits)

---

## 📁 Workspace

Verzeichnis für von der KI generierte Dateien:
- ~/DiriZ/workspace/openrouter-cloud/

### Aktuelle Dateien
Liste der imWorkspace erstellten Dateien wird hier angezeigt.

---

## 🔄 Routing & Entscheidungsfindung

Informationen zur Auswahl dieser Instanz durch das DiriZ-System:
- **Routing-Modus:** auto (automatische Auswahl beste Instanz basierend auf Cost-Aware-Routing)
- **Qualitäts-Score:** hoch
- **Grund für Selektion:** Zugriff auf aktuellste Modelle, breite Abdeckung von Fähigkeiten

---

## ⚠️ Fehlerbehandlung & Failover

- **Max. Failover-Hops:** 2
- **Circuit Breaker Schwelle:** 3 aufeinanderstehende Fehler
- **Verhalten bei Ausfall:** Automatischer Wechsel zur nächsten verfügbaren Instanz (z.B. lokale Ollama oder LM Studio Instanzen als Fallback)

---

## 📝 Feedback & Bewertung

Mögliche Bewertungen dieser Instanz-Ausführung:
- 1-5 Sterne Bewertung
- Kommentare zur Qualität und Aktualität
- Automatische Signale für Abbruch oder Neu-Routing

---

*Diese Dokumentation wird automatisch aktualisiert bei:*
- Jeder Task-Ausführung
- Parameter-Änderungen
- Modell-Verfügbarkeits-Änderungen
- Kosten-Grenzen überschritten