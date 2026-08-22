# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/de/2.0.0.html).

## Unreleased

### Added
- Spezialisten (Agenten) sind jetzt **bearbeitbar** — Name, Beschreibung, System-Prompt, Fähigkeiten, Privacy und Rechner-/Modell-Pins lassen sich nachträglich ändern (Seite „Agenten“)
- Agenten-Dokumente `plan.md`, `changelog.md` und `init.md` pro Spezialist — direkt in der UI editierbar (neue Routen `GET /api/agents/:id/docs`, `PUT /api/agents/:id/docs/:kind`, Migration `0006_agent_docs.sql`)
- `init.md` setzt die Voreinstellungen des LLM-Modells (Temperature, Max-Tokens, Top-P, Stop-Wörter, System-Prompt). Neue Auflösungskette: Provider-Default ← Modell-Override ← **Agent (`init.md`)** ← Task-Override
- `changelog.md` eines Spezialisten wird bei jeder Bearbeitung automatisch mit einem Eintrag ergänzt
- Bearbeiten auf allen weiteren Seiten: Swarms (Name, Beschreibung, Mitglieder), Provider (Name, Base-URL, API-Key ersetzen/entfernen, aktiv), Modelle (Anzeigename, Kontext-Fenster, Fähigkeiten, Sprachen, Preise), Tasks (Titel, Prompt, Zuweisung, Overrides) und Prompt-Vorlagen (Name & Prompt)
- **`plan.md` ist wirksam**: Auftrag, Vorgehen und Leitplanken werden als verbindliche Arbeitsanweisung in den System-Prompt übernommen — das Modell arbeitet genau so, wie das System es deklariert. Unausgefüllte Vorlagen-Zeilen (`Schritt 1`, Titel, Erstell-Datum) filtert DiriZ heraus, damit nie Boilerplate beim Modell landet
- **Dokumente je LLM-Instanz**: jedes Modell auf jedem Rechner führt eigene `plan.md`, `changelog.md` und `init.md` — angelegt beim Entdecken, editierbar unter Provider → Modell → „📄 Dokumente“ (neue Routen `GET /api/instances/:id/docs`, `PUT /api/instances/:id/docs/:kind`, Migration `0007_instance_docs.sql`)
- **Systemweit einstellbare Vorlagen** für alle drei Dokumente, getrennt nach Rechner, LLM-Modell und Spezialist (Einstellungen → „Dokument-Vorlagen“, Platzhalter `{{name}}`, `{{datum}}`, `{{datei}}`; `PUT /api/settings` mit `docTemplates`)
- **Eigene Ansicht „Dokumente“**: alle Deklarations-Dokumente des Systems an einem Ort — Liste über alle drei Ebenen, Volltextsuche über sämtliche Inhalte (zeigt an, in welchem Dokument der Treffer steckt), Markdown-Vorschau (Bearbeiten / Geteilt / Vorschau), großes Editorfenster und Entwürfe, die beim Wechseln zwischen Dokumenten erhalten bleiben (neuer Sammel-Endpunkt `GET /api/docs`)
- **Dokumente je Rechner (Provider)**: auch die oberste Ebene führt `plan.md`, `changelog.md` und `init.md` — angelegt beim Anbinden (neue Routen `GET /api/providers/:id/docs`, `PUT /api/providers/:id/docs/:kind`, Migration `0008_provider_docs.sql`). Damit deklarieren alle drei Ebenen der Auflösungskette gleichermaßen: Rechner ← Modell ← Spezialist
- Markdown-Vorschau ohne Fremd-Abhängigkeit und ohne `dangerouslySetInnerHTML` — aus einem Dokument kann kein Markup in die Oberfläche gelangen
- Live-Vorschau im Dokument-Editor: `plan.md` zeigt, welcher Text tatsächlich an das Modell geht; `init.md` zeigt die erkannten Voreinstellungen
- `changelog.md` einer LLM-Instanz wird bei jeder Bearbeitung automatisch fortgeschrieben (wie beim Spezialisten)
- Export/Import nimmt die Agenten-Dokumente und die Dokument-Vorlagen mit
- Initial setup of instance documentation structure
- CHANGELOG.md creation for tracking changes per AI instance
- README.md enhancements for instance management guidelines

### Changed
- Auflösung der Model-Settings läuft jetzt komplett über die Dokumente: **Provider (`init.md`)** ← **Instanz (`init.md`)** ← **Agent (`init.md`)** ← Task-Override. `PATCH` auf Provider und Instanz schreibt `modelSettings` in das jeweilige `init.md` — das Dokument ist die einzige Quelle der Wahrheit
- Bestehende Overrides wandern beim Nachrüsten der Dokumente automatisch ins `init.md`, statt beim ersten Speichern verloren zu gehen
- `PATCH /api/providers/:id` validiert jetzt Base-URL und Name (vorher wurden ungültige Werte übernommen)
- Project structure updated to support per-instance readme and changelog files

### Deprecated
- None

### Removed
- None

### Fixed
- System-Prompt-Auflösung: das Agenten-Feld überschrieb bisher **jeden** anderen System-Prompt — ein Task-Override oder ein `## System-Prompt` aus `init.md` wurde stillschweigend verworfen. Jetzt gilt durchgängig „späterer Eintrag gewinnt“ (Provider ← Instanz ← Agent-`init.md` ← Agenten-Feld ← Task)
- LM Studio Provider: Base-URLs ohne Versions-Pfad werden jetzt automatisch mit `/v1` ergänzt — zuvor antwortete LM Studio auf unbekannte Endpunkte (z. B. `GET /models`) mit HTTP 200 + Fehler-JSON, was als „online, aber 0 Modelle“ durchging und Routing scheitern ließ („Keine Instanz verfügbar“)
- OpenAI-kompatibler Adapter: `listModels()` meldt Antworten ohne Modellliste (z. B. 200 + Fehler-JSON) jetzt als Fehler statt einer leeren Liste — der Health-Check zeigt solche Endpunkte nicht mehr fälschlich als „online“ an

---

# DiriZ - Visuelles Orchestrierungssystem für lokale LLM-Systeme

**Version:** 0.1  
**Status:** Plan-Phase (Entwurf v0.1)  
**Letzte Aktualisierung:** 21.08.2026

---

## Vision

**DiriZ** (von *Dirigent*) ist ein lokal laufendes, visuelles Steuerungssystem – ein „Control Tower“ – für alle verfügbaren LLM-Backends:

- **Lokale Instanzen:** Ollama, LM Studio sowie jeder OpenAI-kompatible Server (vLLM, llama.cpp server, GPT4All, LocalAI, koboldcpp, …)
- **Cloud-APIs:** OpenRouter (Kern), OpenAI (optional)

## Kernversprechen in vier Punkten:

1. **Eine Eingabe** – Der Nutzer formuliert eine Aufgabe (Prompt) mit optionalen Metadaten.
2. **Automatische Zuweisung** – DiriZ analysiert die Aufgabe, bewertet alle verfügbaren Instanzen (lokal + Cloud) und wählt die beste.
3. **Automatische Ausführung** – Die Aufgabe wird gestreamt ausgeführt; bei Fehlern erfolgt automatisches Failover auf die nächste Instanz.
4. **Volle Transparenz** – Jeder Schritt ist beobachtbar: Token-Stream, die Routing‑Entscheidung („Warum dieses Modell?“), Token-/Kostennutzung, Laufzeit, erzeugte Dateien, Logs.

---

## Dokumentation

- [01 – Gesamter Plan, Architektur & Roadmap](docs/01-plan.md)
- [STATUS – Aktueller Entwicklungsstand](docs/STATUS.md)
- [CHANGELOG – Versionsgeschichte](#changelog)

---

## Status

Plan-Phase (Entwurf v0.1). Die Implementierung startet mit Meilenstein M0 (Setup) – siehe Plan, §15.
