# DiriZ

**Der Dirigent für deine LLM-Orchester.** DiriZ ist ein lokales Orchestrierungssystem, das jede Task automatisch dem besten Modell zuweist — lokal (Ollama, LM Studio) oder Cloud (OpenRouter, OpenAI) — mit vollem Live-Monitoring, Explainability und lernendem Routing.

```
Betrieb — ein Prozess, ein Port:

   Browser  ──────────────►  DiriZ Core :8787  ──────────►  Ollama · LM Studio
   (UI + API, gleiche Herkunft)  Fastify · SQLite · SSE      OpenRouter · OpenAI
                                 Routing-Engine + Failover

Entwicklung — Vite davor, mit HMR:

   Browser :5173  ──/api──►  DiriZ Core :8787  ──────────►  LLM-Backends
```

## ✨ Features

| Bereich | Was es kann |
|---------|------------|
| **Routing** | Mehrachsen-Scoring (Context-Fit, Capability-Match, Qualitäts-Prior, Last, Kosten, Latenz, Host-Last) mit harten Policies: Privacy `local-only`, Budget-Gate, Context-Gate, Pinned-Mode — jede Entscheidung nachvollziehbar erklärt |
| **Ausführung** | Streaming-Live-View, Failover-Kette bei Provider-Ausfall, Abbruch, Concurrent-Limits, Token-/Kosten-Tracking |
| **Agentik (M8)** | Opt-in pro Task: Das Modell arbeitet autonom mit `list_files` / `read_file` / `write_file` in der Sandbox — jede Operation live sichtbar & geloggt; Schritt-Limit gegen Endlosschleifen — es begrenzt nur die Tool-Nutzung, nie die Antwort: Am Limit folgt ein Abschluss-Schritt ohne Tools, die Antwort ist nie abgeschnitten oder leer |
| **Monitoring** | Dashboard mit Metriken-Karten, 24 h/7-Tage-Charts (Tokens, Requests, Kosten), Ollama-VRAM-Load, System-Karte (Host-RAM/CPU/GPU), Live-Logs, Statusleiste |
| **Workspace** | Versionierte Task-Dateien: Baum-Ansicht, Vorschau mit Zeilennummern, farbiger Diff zwischen beliebigen zwei Versionen |
| **Feedback** | 1–5-Sterne-Ratings pro Execution → exponentiell glättender Qualitäts-Prior — DiriZ wird mit jedem Feedback besser |
| **GitHub** | Repositories verbinden und **pro Task pinnen**: Die Task arbeitet in einem eigenen Git-Worktree auf eigenem Branch, Änderungen erscheinen als Diff mit Zeilennummern, und lassen sich committen, pushen oder als Pull-Request öffnen — auf Wunsch auch direkt auf den Basis-Branch |
| **Deklaration** | `plan.md`, `changelog.md` und `init.md` je Rechner, Modell und Spezialist. `plan.md` wird zur verbindlichen Arbeitsanweisung im System-Prompt, `init.md` setzt die Model-Parameter — bearbeitbar im Tab **Dokumente** mit Vorschau und Volltextsuche |
| **Spezialisten** | Agenten (System-Prompt + Capability-Anforderungen) und Swarms; Auto-Zuordnung per Prompt-Match oder feste Zuweisung |
| **Sicherheit** | Local-first: Cloud nur auf Wunsch. API-Keys AES-256-GCM-verschlüsselt in der DB, nie im Klartext zurückgegeben |

## 🚀 Quickstart

**Voraussetzungen:** Node.js ≥ 22 · ein lokaler LLM-Server (z. B. [Ollama](https://ollama.com)) oder ein Cloud-API-Key

```bash
npm install       # Abhängigkeiten
npm run serve     # baut alles und startet DiriZ auf http://127.0.0.1:8787
```

Der Core liefert die Oberfläche selbst aus — **ein Prozess, ein Port, eine URL.**
Beim Start schreibt er Port, Datenverzeichnis und Workspace ins Terminal:

```
DiriZ Core  ·  Schema v8
  URL         http://127.0.0.1:8787
  Oberfläche  …/apps/web/dist
  Daten       ~/.diriz
  Workspace   ~/DiriZ/workspace
```

**Erste Task:**
1. Tab **Provider** → Ollama hinzufügen (`http://localhost:11434`) — Modelle werden automatisch entdeckt
2. Tab **Dokumente** → in `plan.md` deklarieren, wie das Modell arbeiten soll (wirkt direkt im System-Prompt)
3. Tab **Tasks** → „+ Neue Task" → Prompt eingeben → anlegen & starten
4. Ergebnis im Live-Stream verfolgen und mit Sternen bewerten

**Entwicklung (mit Hot-Reload):**
```bash
npm run dev       # Core :8787 (tsx watch) + Vite :5173 (HMR) → http://localhost:5173
```

**Konfiguration** (alles optional, per Environment):

| Variable | Default | Wirkung |
|----------|---------|---------|
| `DIRIZ_PORT` | `8787` | Port des Cores |
| `DIRIZ_HOST` | `127.0.0.1` | Bind-Adresse — bewusst nur lokal |
| `DIRIZ_DATA_DIR` | `~/.diriz` | SQLite-Datenbank und Verschlüsselungs-Secret |
| `DIRIZ_WORKSPACE_DIR` | `~/DiriZ/workspace` | Sandbox für AI-generierte Dateien |
| `DIRIZ_WEB_DIR` | `apps/web/dist` | Verzeichnis der gebauten Oberfläche |
| `DIRIZ_REPOS_DIR` | `<data>/repos` | Lokale Klone der verbundenen GitHub-Repositories |
| `DIRIZ_GIT_NAME` / `DIRIZ_GIT_EMAIL` | `DiriZ` / `diriz@localhost` | Autor der von DiriZ erzeugten Commits |

**Desktop-App (optional, M8):**
```bash
npm run desktop  # Tauri-Fenster um die Web-UI (Dev: Vite; Prod: npm run build vorher)
```

## 📁 Projektstruktur

```
DiriZ/
├── apps/web/                  # React-UI (Vite, Zustand, SSE-Live-Events)
│   └── src/views/             # Dashboard · Provider · Agenten · Tasks · Dokumente · Workspace · Logs · Einstellungen
├── apps/desktop/              # Tauri-2-Desktop-Hülle (M8): `npm run desktop`
├── packages/core/             # Fastify-Core: API, Engine, Routing, DB
│   ├── db/migrations/         # SQLite-Migrationen (0001–0009)
│   └── src/
│       ├── execution/         # ExecutionEngine, Failover, Event-Bus, Agent-Loop + Sandbox-Tools
│       ├── git/               # GitHub-Anbindung: git-Hülle, Worktrees, Diff-Parser, REST-Client
│       ├── monitoring/        # Host-RAM/CPU/GPU-Metriken (M8)
│       ├── providers/         # Adapter: Ollama · LM Studio · OpenAI(-Compat) · OpenRouter
│       ├── routing/           # Profil-Extraktion · Policies · Scoring · Feedback-Prior
│       └── routes/            # REST-API (tasks, providers, agents, metrics, host, workspace, settings, …)
├── packages/shared/           # Gemeinsame Typen, Event-Kontrakte, Scoring-Formeln (UI ≡ Core)
├── .github/workflows/         # CI: Lint · Typecheck · Tests · Build · Server-Rauchtest
├── docs/                      # 01-plan.md (Architektur & Roadmap) · STATUS.md (aktueller Stand)
└── playwright.config.ts       # E2E-Smoke-Tests
```

**Designprinzip:** Die Scoring-Formeln und Event-Typen leben in `@diriz/shared` — UI und Core können nie auseinanderdriften. Was die Explainability-Ansicht zeigt, ist exakt das, was der Engine berechnet hat.

## 🛠️ Befehle

| Befehl | Wirkung |
|--------|---------|
| `npm run serve` | Build + Start — **der Weg in den Betrieb** |
| `npm run dev` | Core + Web parallel (tsx watch + Vite HMR) |
| `npm start` | Startet den bereits gebauten Core (inkl. Oberfläche) |
| `npm run build` | Produktions-Build von Core, Shared und Web |
| `npm run check` | **Lint + Typecheck + Unit-Tests** — das tägliche Qualitäts-Gate |
| `npm test` | Vitest: shared + core |
| `npm run test:e2e` | Playwright-E2E; startet den Dev-Stack selbst, wenn nötig |
| `npm run desktop` | Tauri-2-Fenster um die Web-UI |

Jeder Push und Pull-Request durchläuft dieselben Schritte in der
[CI](.github/workflows/ci.yml) — zuzüglich eines Rauchtests, der den
**gebauten** Server startet und prüft, dass er Oberfläche und API ausliefert.

## 🔧 Fehlersuche

| Symptom | Ursache & Behebung |
|---------|--------------------|
| API antwortet mit **404** auf neue Routen | Es läuft noch ein **älterer Prozess** auf dem Port. `lsof -nP -iTCP:8787 -sTCP:LISTEN` zeigt ihn; beenden und neu starten. `GET /api/version` nennt den tatsächlich laufenden Stand — auch in der Statusleiste sichtbar. |
| `Port 8787 ist bereits belegt` | Ein zweiter Start (oft `npm start` **und** `npm run dev`). Einen beenden oder `DIRIZ_PORT=8788 npm start`. |
| UI zeigt „Die Oberfläche wurde noch nicht gebaut" | `npm run build` — oder in der Entwicklung `npm run dev` und http://localhost:5173 nutzen. |
| Provider bleibt „offline" | Base-URL prüfen (LM Studio braucht `/v1`), dann Tab **Provider** → Health-Check. Details im Tab **Logs**. |

## 📚 Dokumentation

- [**STATUS.md**](docs/STATUS.md) — aktueller Stand, abgeschlossene Meilensteine M0–M8
- [**01-plan.md**](docs/01-plan.md) — vollständiger Architekturplan: Routing-Achsen, Policies, Datenmodell, Roadmap M0–M8

## 📄 Lizenz

Privates Projekt. Alle Rechte vorbehalten.