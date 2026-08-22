# DiriZ

**Der Dirigent für deine LLM-Orchester.** DiriZ ist ein lokales Orchestrierungssystem, das jede Task automatisch dem besten Modell zuweist — lokal (Ollama, LM Studio) oder Cloud (OpenRouter, OpenAI) — mit vollem Live-Monitoring, Explainability und lernendem Routing.

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│  React-UI   │ SSE │      DiriZ Core          │ HTTP│  Ollama · LM Studio │
│  :5173      │◄────►│  Fastify · SQLite :8787  │◄───►│  OpenRouter · OpenAI│
└─────────────┘     │  Routing-Engine + Failover│     └─────────────────────┘
                    └──────────────────────────┘
```

## ✨ Features

| Bereich | Was es kann |
|---------|------------|
| **Routing** | Mehrachsen-Scoring (Context-Fit, Capability-Match, Qualitäts-Prior, Last, Kosten, Latenz, Host-Last) mit harten Policies: Privacy `local-only`, Budget-Gate, Context-Gate, Pinned-Mode — jede Entscheidung nachvollziehbar erklärt |
| **Ausführung** | Streaming-Live-View, Failover-Kette bei Provider-Ausfall, Abbruch, Concurrent-Limits, Token-/Kosten-Tracking |
| **Agentik (M8)** | Opt-in pro Task: Das Modell arbeitet autonom mit `list_files` / `read_file` / `write_file` in der Sandbox — jede Operation live sichtbar & geloggt; Schritt-Limit gegen Endlosschleifen |
| **Monitoring** | Dashboard mit Metriken-Karten, 24 h/7-Tage-Charts (Tokens, Requests, Kosten), Ollama-VRAM-Load, System-Karte (Host-RAM/CPU/GPU), Live-Logs, Statusleiste |
| **Workspace** | Versionierte Task-Dateien: Baum-Ansicht, Vorschau mit Zeilennummern, farbiger Diff zwischen beliebigen zwei Versionen |
| **Feedback** | 1–5-Sterne-Ratings pro Execution → exponentiell glättender Qualitäts-Prior — DiriZ wird mit jedem Feedback besser |
| **Spezialisten** | Agenten (System-Prompt + Capability-Anforderungen) und Swarms; Auto-Zuordnung per Prompt-Match oder feste Zuweisung |
| **Sicherheit** | Local-first: Cloud nur auf Wunsch. API-Keys AES-256-GCM-verschlüsselt in der DB, nie im Klartext zurückgegeben |

## 🚀 Quickstart

**Voraussetzungen:** Node.js ≥ 22 · ein lokeller LLM-Server (z. B. [Ollama](https://ollama.com)) oder Cloud-API-Key

```bash
# 1) Abhängigkeiten installieren
npm install

# 2) Entwicklung starten (Core :8787 + Web :5173, mit HMR)
npm run dev

# 3) Browser öffnen → http://localhost:5173
```

**Erste Task:**
1. Tab **Provider** → Ollama hinzufügen (`http://localhost:11434`) — Modelle werden automatisch entdeckt
2. Tab **Tasks** → „+ Neue Task“ → Prompt eingeben → anlegen & starten
3. Ergebnis im Live-Stream verfolgen, in der Detail-Karte mit Sternen bewerten

**Produktions-Build:**
```bash
npm run build   # Core (tsc) + Web (Vite)
npm start       # Core aus dist/ starten
```

**Desktop-App (optional, M8):**
```bash
npm run desktop  # Tauri-Fenster um die Web-UI (Dev: Vite; Prod: npm run build vorher)
```

## 📁 Projektstruktur

```
DiriZ/
├── apps/web/                  # React-UI (Vite, Zustand, SSE-Live-Events)
│   └── src/views/             # Dashboard · Provider · Agenten · Tasks · Workspace · Logs · Einstellungen
├── apps/desktop/              # Tauri-2-Desktop-Hülle (M8): `npm run desktop`
├── packages/core/             # Fastify-Core: API, Engine, Routing, DB
│   ├── db/migrations/         # SQLite-Migrationen (0001–0004)
│   └── src/
│       ├── execution/         # ExecutionEngine, Failover, Event-Bus, Agent-Loop + Sandbox-Tools
│       ├── monitoring/        # Host-RAM/CPU/GPU-Metriken (M8)
│       ├── providers/         # Adapter: Ollama · LM Studio · OpenAI(-Compat) · OpenRouter
│       ├── routing/           # Profil-Extraktion · Policies · Scoring · Feedback-Prior
│       └── routes/            # REST-API (tasks, providers, agents, metrics, host, workspace, settings, …)
├── packages/shared/           # Gemeinsame Typen, Event-Kontrakte, Scoring-Formeln (UI ≡ Core)
├── docs/                      # 01-plan.md (Architektur & Roadmap) · STATUS.md (aktueller Stand)
└── playwright.config.ts       # E2E-Smoke-Tests
```

**Designprinzip:** Die Scoring-Formeln und Event-Typen leben in `@diriz/shared` — UI und Core können nie auseinanderdriften. Was die Explainability-Ansicht zeigt, ist exakt das, was der Engine berechnet hat.

## 🛠️ Befehle

| Befehl | Wirkung |
|--------|---------|
| `npm run dev` | Core + Web parallel (tsx watch + Vite HMR) |
| `npm run desktop` | Tauri-2-Fenster um die Web-UI (M8) |
| `npm run check` | **Lint + Typecheck + Tests** — der tägliche Qualitäts-Gate |
| `npm test` | Vitest: shared + core (93 Tests) |
| `npx playwright test` | E2E-Smoke gegen laufende Dev-Server |
| `npm run build` / `npm start` | Produktions-Build bzw. Core starten |

## 📚 Dokumentation

- [**STATUS.md**](docs/STATUS.md) — aktueller Stand, abgeschlossene Meilensteine M0–M8
- [**01-plan.md**](docs/01-plan.md) — vollständiger Architekturplan: Routing-Achsen, Policies, Datenmodell, Roadmap M0–M8

## 📄 Lizenz

Privates Projekt. Alle Rechte vorbehalten.