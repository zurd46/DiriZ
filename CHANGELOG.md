# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/de/2.0.0.html).

## Unreleased

### Added
- Initial setup of instance documentation structure
- CHANGELOG.md creation for tracking changes per AI instance
- README.md enhancements for instance management guidelines

### Changed
- Project structure updated to support per-instance readme and changelog files

### Deprecated
- None

### Removed
- None

### Fixed
- None

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
