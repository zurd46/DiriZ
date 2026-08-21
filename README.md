# DiriZ

Visuelles Orchestrierungssystem ("Dirigent") für lokale LLM-Systeme: Ollama, LM Studio, OpenAI-kompatible Server und Cloud-APIs (OpenRouter, OpenAI).

- **Eine Eingabe** → automatische Zuweisung der besten Instanz → automatische Ausführung
- Volle Transparenz: Live-Streaming, Routing-Explainability, Metriken, Logs, Datei-Workspace
- Local-first: Cloud nur auf Wunsch (Privacy-Modus `local-only` als Default)

## Dokumentation

- [01 – Gesamter Plan, Architektur & Roadmap](docs/01-plan.md)
- [STATUS – Aktueller Entwicklungsstand](docs/STATUS.md)
- [CHANGELOG – Versionsgeschichte](#changelog)

## Instanz-Dokumentations-System

Jede lokale KI-Instanz (egal ob Ollama, LM Studio via NGrok oder Cloud-Anbieter) erhält automatisch drei Markdown-Dateien als Teil ihres System-Prompts:

### 1. `plan.md`
Enthält die aktuelle Aufgabe, Modell-Konfiguration, Ausführungsparameter, Routing-Entscheidung, Status und Workspace-Verzeichnis. Wird bei Task-Start und bei Änderungen automatisch aktualisiert.

### 2. `changelog.md`
Dokumentiert alle bemerkenswerten Änderungen an der Instanz (Format: Keep a Changelog). Wird automatisch aktualisiert bei jeder Task-Ausführung, Modell-Wechsel, Parameter-Anpassungen sowie Fehlern und Failover-Ereignissen.

### 3. `README.md`
Instanz-spezifische Dokumentation mit Übersicht, Fähigkeiten/Kapazitäten, Konfiguration, Monitoring-Metriken, Workspace-Informationen, Routing-Details, Fehlerbehandlung und Feedback-Möglichkeiten. Wird bei jeder relevanten Änderung aktualisiert.

### Instanz-Verzeichnis-Struktur

```
instances/
  ollama-local/          # Lokale Instanz (z.B. Ollama auf localhost)
    plan.md
    changelog.md
    README.md
  lmstudio-ngrok/        # LM Studio via NGrok tunnelbar
    plan.md
    changelog.md
    README.md
  openrouter-cloud/      # Cloud-Anbieter (OpenRouter, OpenAI etc.)
    plan.md
    changelog.md
    README.md
```

Jede Instanz kann ihre drei MD-Dateien im System bearbeiten und aktualisieren. Die Dateien bilden die gesamte Arbeit der Instanz ab und gewährleisten volle Transparenz darüber, wo wie was ausgeführt wurde.

## Status

Plan-Phase (Entwurf v0.1). Die Implementierung startet mit Meilenstein M0 (Setup) – siehe Plan, §15.
