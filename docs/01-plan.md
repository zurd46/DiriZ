# DiriZ – Plan: Visuelles Orchestrierungssystem für lokale LLM-Systeme

> **Status:** Entwurf zur Abstimmung · **Version:** 0.1 · **Datum:** 21.08.2026
> **Scope:** Dieser Plan beschreibt Vision, Anforderungen, Architektur, Tech-Stack, Datenmodell, API, UI/UX, Sicherheit und die Roadmap für DiriZ v1.

## 1. Vision & Ziele

**DiriZ** (von *Dirigent*) ist ein lokal laufendes, visuelles Steuerungssystem – ein „Control Tower" – für alle verfügbaren LLM-Backends:

- **Lokale Instanzen:** Ollama, LM Studio sowie jeder OpenAI-kompatible Server (vLLM, llama.cpp server, GPT4All, LocalAI, koboldcpp, …)
- **Cloud-APIs:** OpenRouter (Kern), OpenAI (optional)

Kernversprechen in vier Punkten:

1. **Eine Eingabe** – Der Nutzer formuliert eine Aufgabe (Prompt) mit optionalen Metadaten.
2. **Automatische Zuweisung** – DiriZ analysiert die Aufgabe, bewertet alle verfügbaren Instanzen (lokal + Cloud) und wählt die beste.
3. **Automatische Ausführung** – Die Aufgabe wird gestreamt ausgeführt; bei Fehlern erfolgt automatisches Failover auf die nächste Instanz.
4. **Volle Transparenz** – Jeder Schritt ist beobachtbar: Token-Stream, die Routing-Entscheidung („Warum dieses Modell?"), Token-/Kostennutzung, Laufzeit, erzeugte Dateien, Logs.

### 1.1 Nicht-Ziele (v1)

- Kein Training/Fine-Tuning von Modellen.
- Kein Multi-User-/Serverbetrieb (reine Single-User-Local-App, Bind an 127.0.0.1).
- Kein allgemeines Agent-Tool-Framework von Anfang an (v1: Text-I/O + strukturierte Dateiausgabe; Tool-Loop als Ausbaustufe M8).
- Kein Host-GPU-/Hardware-Monitoring in v1 (Provider-eigene Load-Infos reichen).

## 2. Anforderungen

### 2.1 Funktionale Anforderungen

| ID | Anforderung |
|----|-------------|
| F1 | Anbindung lokaler LLM-Server: Ollama, LM Studio, generisch OpenAI-kompatible Endpunkte – beliebige Anzahl, konfigurierbare URLs |
| F2 | Anbindung von Cloud-APIs: OpenRouter (Pflicht), OpenAI (optional); API-Key-Verwaltung mit verschlüsselter Speicherung |
| F3 | Automatische Modell-Erkennung (Discovery) + manuelle Ergänzung; Capability-Tagging (Code, Reasoning, Langtext, Vision, Tools, JSON) inkl. Context Window |
| F4 | **Task-Composer:** freier Prompt-Text + optionale Metadaten (Ziel, Sprache, Constraints, Privacy-Modus, Budget, bevorzugte Instanz) |
| F5 | **Routing-Engine:** analysiert Task → schätzt Anforderungen (Länge, Capabilities, Latenz) → bewertet alle Instanzen → wählt beste → dokumentiert Entscheidung nachvollziehbar |
| F6 | Routing-Modi: **Auto** (Default), **Pinned** (manuelle Instanz), **Round-Robin** (A/B, Lastverteilung), **Cost-Aware** (Sparmodus) |
| F7 | Streaming-Ausführung in Echtzeit (Token-by-Token in der UI) + Abbruch jederzeit |
| F8 | **Failover & Retry:** bei Provider-Fehler/Timeout/Mid-Stream-Abbruch automatischer Wechsel auf die nächste Instanz (max. 2 Hops) |
| F9 | **Monitoring:** Provider-Status (online/offline/degraded, Latenz), geladene Modelle (Ollama `/api/ps`), aktive Ausführungen, Queue, Kosten |
| F10 | **Historie:** alle Tasks/Ausführungen mit Input, Output (Replay), gewählter Instanz, Score-Aufschlüsselung, Tokens, Kosten, Dauer |
| F11 | **Datei-Workspace:** AI-generierte Dateien werden zentral abgelegt; UI-Ansicht mit Baum, Vorschau, Diff zwischen Läufen |
| F12 | Kosten-Tracking (Cloud, pro Execution/Tag) und Token-/TPS-Statistiken (lokal) |
| F13 | **Feedback-Loop:** Bewertung von Ausführungen (1–5) + automatische Signale (Fehler, Abbruch) → Scoring lernt über die Zeit |
| F14 | Konfiguration: Routing-Gewichte, Local-first-Policy, Workspace-Pfad, Health-Intervalle, Export/Import |

### 2.2 Nicht-funktionale Anforderungen

| ID | Anforderung |
|----|-------------|
| N1 | Läuft vollständig lokal auf macOS (arm64); Cloud-Zugriff nur wenn der Nutzer es aktiv erlaubt und konfiguriert |
| N2 | Echtzeit-Updates (Streaming, Status) ohne Page-Reload (SSE) |
| N3 | UI: dunkles „Control-Tower"-Design, schnell, überwiegend deutsche Beschriftung |
| N4 | Persistenz lokal in SQLite; Export/Import von Konfiguration |
| N5 | Sicherheit: Bind nur an 127.0.0.1; API-Keys verschlüsselt (Keychain); keine Telemetrie; Audit-Log aller Cloud-Calls |
| N6 | Start < 5 s; resilient gegen gestoppte Provider (Status „offline", keine Crash-Loops) |
| N7 | Testabdeckung: Routing-Engine & Adapter mit Unit-Tests (Vitest, Mock-Server); E2E-Smoke-Test (Playwright) |

## 3. Architektur

### 3.1 Überblick

```
┌──────────────────────────────────────────────────────────────────┐
│ WEB UI  (React + Vite, http://localhost:5173)                    │
│ Dashboard · Tasks · Instanzen · Monitor · Workspace · Settings   │
└──────────────▲───────────────────────────────▲───────────────────┘
               │ REST (JSON)                   │ SSE (Live-Events)
┌──────────────┴───────────────────────────────┴───────────────────┐
│ DIRIZ CORE  (Node.js 24 + TypeScript + Fastify, :8787)           │
│                                                                  │
│ ┌───────────────┐ ┌───────────────┐ ┌──────────────────────────┐ │
│ │ Provider-     │ │ Routing-Engine│ │ Ausführungs-Engine       │ │
│ │ Schicht       │ │ („Dirigent")  │ │ Queue · Streaming ·      │ │
│ │ Adapter +     │ │ Analyse +     │ │ Retry · Failover         │ │
│ │ Health + CB   │ │ Scoring + FB  │ │                          │ │
│ └──────┬────────┘ └──────┬────────┘ └────────────┬─────────────┘ │
│        │                 │                        │               │
│ ┌──────┴─────────────────┴────────────────────────┴────────────┐ │
│ │ Instance-Registry · Beobachtung (Metriken · Logs · Events)   │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────┐ ┌──────────────────────────────────┐ │
│ │ Persistenz: SQLite      │ │ Datei-Workspace (sandboxed)      │ │
│ │ (better-sqlite3)        │ │ ~/DiriZ/workspace/               │ │
│ └─────────────────────────┘ └──────────────────────────────────┘ │
└───────▲─────────────▲───────────────▲───────────────▲────────────┘
        │             │               │               │
  ┌─────┴─────┐ ┌─────┴─────┐ ┌──────┴─────┐ ┌───────┴────────┐
  │ Ollama    │ │ LM Studio │ │ OpenAI-    │ │ Cloud:         │
  │ :11434    │ │ :1234     │ │ kompat.    │ │ OpenRouter ·   │
  │           │ │           │ │ (vLLM,     │ │ OpenAI · …     │
  └───────────┘ └───────────┘ │ llama.cpp) │ └────────────────┘
                              └────────────┘
```

### 3.2 Komponenten

1. **Web UI** – React-Frontend, konsumiert REST + SSE. Alle Views (§10). Server-State via TanStack Query, UI-State via Zustand.
2. **DiriZ Core** – einziger Prozess, der Provider anbindet und persistiert:
   - **Provider-Schicht:** ein Adapter pro Backend-Typ (§5), Health-Poller, Circuit Breaker.
   - **Instance-Registry:** zentrales Register aller Modelle (Provider × Modell), Status, Capabilities, gemessene Latenz.
   - **Routing-Engine („Der Dirigent"):** Task-Profil-Extraktion, Scoring, Policies, Explainability, Feedback-Loop (§6).
   - **Ausführungs-Engine:** Queue, Lifecycle, Streaming-Pipeline, Failover, Datei-Block-Parser (§7, §9).
   - **Beobachtung:** EventBus (SSE), Metriken-Aggregation, strukturierte Logs (§8).
   - **Persistenz:** SQLite mit versionierten Migrations (§11).

### 3.3 Datenfluss (Auto-Task)

1. UI → `POST /api/tasks` → Task persistiert → Event `task.created`.
2. Routing-Engine: Profil → Gates → Scoring → Entscheidung → Event `routing.decided` (Score-Log persistiert).
3. Ausführungs-Engine: Queue → Adapter-Streaming → Deltas → Event `execution.delta` (an UI + `execution_chunks` für Replay).
4. Fehler mid-stream → Failover auf nächste Instanz → Event `execution.failover`.
5. Abschluss: Usage → Metriken; `file:`-Blöcke → Workspace-Dateien; Event `execution.done`.

## 4. Tech-Stack

| Baustein | Wahl | Begründung / Alternativen |
|---|---|---|
| Sprache (gesamt) | **TypeScript (strict)** | eine Sprache für UI + Core; starkes Ökosystem für LLM-Clients und Streaming |
| Core-Server | **Node.js 24 + Fastify** | schnell, SSE-nativ, Schema-Validierung; Alternativen: Hono, Express |
| Provider-Clients | nativer `fetch` + eigener dünner SSE-Parser | keine schweren SDKs; Adapter bleiben austauschbar |
| Frontend | **React 19 + Vite** | schnell, großes Ökosystem |
| Styling/Komponenten | **Tailwind CSS 4 + shadcn/ui** | konsistentes Control-Panel-Design, Dunkeldesign |
| Server-State | **TanStack Query** | Cache, Retry, SSE-Integration |
| UI-State | **Zustand** | minimal, testbar |
| Charts | **Recharts** | Metriken-Dashboards |
| DB | **SQLite via better-sqlite3** | lokal, null-config, reicht für Single-User; eigene versionierte SQL-Migrations |
| Monorepo | **npm workspaces** | npm 11 installiert (kein pnpm/bun); root-scripts für dev/build/test |
| Tests | **Vitest** (Unit/Integration), **Playwright** (E2E-Smoke) | |
| Lint/Format | **Biome** | ein Tool für Format + Lint, schnell |
| Desktop (Phase 2, M8) | **Tauri 2** | optionale native App; v1 läuft im Browser |

## 5. Provider-Schicht

### 5.1 Adapter-Interface (Kontrakt)

```ts
interface LLMProvider {
  readonly id: string;
  readonly type: 'ollama' | 'lmstudio' | 'openai-compat' | 'openrouter' | 'openai';
  readonly label: string;

  healthCheck(): Promise<HealthStatus>;              // { ok, latencyMs, detail? }
  listModels(): Promise<DiscoveredModel[]>;          // Discovery
  chat(req: ChatRequest): AsyncGenerator<ChatChunk>; // Streaming
  cancel(executionId: string): Promise<void>;        // wo vom Provider unterstützt
  loadInfo?(): Promise<LoadInfo>;                    // z. B. Ollama /api/ps
}

type ChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'done' };
```

### 5.2 Adapter-Matrix

| Adapter | Endpunkt (Default) | Discovery | Streaming | Load-Info | Anmerkungen |
|---|---|---|---|---|---|
| **Ollama** | `http://localhost:11434` | `GET /api/tags` | `POST /api/chat` (NDJSON) | `GET /api/ps` | geladene Modelle + Speicher; `keep_alive` pro Execution |
| **LM Studio** | `http://localhost:1234` | `GET /v1/models` | `POST /v1/chat/completions` (SSE) | – | OpenAI-kompatibel |
| **OpenAI-kompatibel** | konfigurierbar | `GET {base}/v1/models` | SSE | – | deckt vLLM, llama.cpp, GPT4All, LocalAI, koboldcpp ab |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `GET /models` (inkl. Preise) | SSE | – | API-Key; optionale Provider-Prioritäten |
| **OpenAI** | `https://api.openai.com/v1` | `GET /models` | SSE | – | optional, dank Kompatibilität ~2 h Aufwand |

### 5.3 Modell- & Capability-Modell

```ts
interface InstanceModel {
  providerId: string;
  modelId: string;               // z. B. "qwen2.5-coder:32b-instruct"
  displayName: string;
  contextWindow: number;         // aus Discovery, manuell überschreibbar
  capabilities: Capability[];    // 'code' | 'reasoning' | 'longform' | 'vision' | 'tools' | 'json'
  languages: string[];
  quantization?: string;         // z. B. "q4_k_m"
  pricePerMTok?: { in: number; out: number };  // nur Cloud
  source: 'discovered' | 'manual';
  status: 'online' | 'offline' | 'degraded';
  lastSeenAt: string;
}
```

**Discovery- & Inferenzstrategie:**

- **Ollama:** `/api/tags` für die Liste; Größe/Quantisierung aus Modellnamen parsen; Context-Default konservativ (8k), in der UI überschreibbar.
- **LM Studio / OpenAI-kompatibel:** Metadaten aus `/v1/models` wo vorhanden, sonst Defaults.
- **OpenRouter:** vollständige Metadaten + Preise aus `/models`.
- **Capability-Inferenz (3 Stufen):**
  1. Heuristik über Namen (z. B. `*coder*` → code, `*reason*` → reasoning, ≥ 32b → longform-Bonus, `*vl*` → vision).
  2. Manueller Override in der Instanzen-View (Tags, Context, Quantisierung).
  3. Feedback-Loop aus Ausführungen (§6.5) – verbessert `qualityPrior`.
- **Token-Schätzung:** Heuristik (≈ 4 Zeichen/Token) + optionaler lokaler WASM-Tokenizer (z. B. tiktoken) für lange Prompts.

### 5.4 Health, Resilienz & Circuit Breaker

- Health-Pollung pro Provider: alle **15 s** (konfigurierbar), Timeout **3 s**.
- Statusmaschine: `online → offline` (nach 2 Fehlschlägen) `→ recovering → online`.
- **Circuit Breaker** pro Provider: nach 5 Fehlern 60 s gesperrt, danach Half-Open-Probe.
- Gestoppter Provider macht DiriZ **niemals** down – die UI zeigt einfach `offline`.
- Latenz-Messung (p50/p95) pro Provider wird in der Registry gepflegt und fließt ins Scoring ein.

## 6. Routing-Engine („Der Dirigent")

### 6.1 Task-Profil (Anforderungsanalyse)

Jeder Task wird in ein Anforderungsprofil übersetzt:

```ts
interface TaskProfile {
  estTokens: number;              // Prompt + erwartete Antwort (Heuristik + Tokenizer)
  capabilities: Capability[];     // gefordert: 'code' | 'longform' | 'reasoning' | 'vision' | …
  language: string;
  latencySensitive: boolean;
  privacy: 'local-only' | 'allow-cloud';
  budgetUsd?: number;
  userPinnedInstance?: string;
}
```

**Extraktions-Kaskade (günstig → teuer):**

1. **Heuristik (Standard):** Code-Blobs/Dateibelege im Prompt → `code`; Länge über Schwelle → `longform`; Schlüsselwörter („beweise", „analysiere", „vergleiche", „debug") → `reasoning`; Bild-Anhänge → `vision`; kurze Prompt + „schnell" → `latencySensitive`.
2. **Router-Modell (opt-in):** kleines lokales Modell (z. B. `llama3.2:3b`/`qwen2.5:3b`) klassifiziert per JSON-Response, wenn die Heuristik unsicher ist. Default: **aus** (siehe Q2).
3. **Manuell:** Metadaten im Task-Composer überschreiben alles.

### 6.2 Scoring

Jede Kandidaten-Instanz erhält einen Score 0–100:

```
score = 0.30 · contextFit      # 1.0 wenn ctxWindow ≥ 1.3·estTokens, sonst linearer Decay
      + 0.30 · capabilityMatch # Pflicht-Capabilities = hartes Gate; Bonus für Extras
      + 0.20 · qualityPrior    # lernend: Basis + Ratings + Erfolgsquote (EMA)
      + 0.08 · loadScore       # frei: 1.0 · belegt: 0.6 · offline: Ausschluss
      + 0.07 · costScore       # lokal: 1.0 · Cloud: f(Preis, Budget)
      + 0.05 · latencyScore    # aus gemessener p50/p95-Latenz
```

Die Gewichte sind in den Einstellungen justierbar.

**Harte Gates (Ausschluss vor dem Scoring):**

- Instanz offline bzw. Circuit Breaker geschlossen
- `privacy = local-only` → alle Cloud-Instanzen
- geforderte Pflicht-Capability fehlt (z. B. Vision-Task ohne vision-fähiges Modell)
- Context-Window < 1.2 · estTokens
- Cloud-Kosten > Budget (falls gesetzt)

### 6.3 Routing-Policies

| Modus | Verhalten |
|---|---|
| **Auto (Default)** | Top-1 nach Score; die Top-3 werden als Failover-Kette gespeichert |
| **Pinned** | Nutzer wählt Provider + Modell; Routing reduziert sich auf Health-Check |
| **Round-Robin** | Rotation über die Top-N (A/B-Tests, Lastverteilung) |
| **Cost-Aware** | wie Auto, aber cost-Gewicht ×3 (Sparmodus) |

**Local-first-Prinzip:** Standard bevorzugt lokale Instanzen (costScore = 1.0). Cloud wird im Auto-Modus nur genutzt, wenn der Task `allow-cloud` ist – und zusätzlich nur, wenn kein lokales Modell die harten Gates besteht (die UI meldet transparent: „Kein lokales Modell geeignet → Cloud-Fallback").

### 6.4 Explainability („Warum dieses Modell?")

Jede Entscheidung wird persistiert (`routing_decisions`) und in der UI expandierbar gezeigt:

- Score-Tabelle aller Kandidaten (Top-5) mit Aufschlüsselung pro Achse
- alle **ausgeschlossenen** Instanzen mit konkretem Grund (offline, Context, Privacy, Capability, Budget)
- verwendetes Task-Profil und Gewichte

Zusätzlich: `GET /api/routing/preview?prompt=…` = Dry-Run ohne Ausführung – der Composer zeigt die Entscheidung vor dem Absenden an.

### 6.5 Feedback-Loop (lernendes Scoring)

- Nach jeder Ausführung: Nutzer-Rating 1–5 + automatische Signale (Fehler? Abbruch? Failover nötig?).
- `qualityPrior(instance, taskType) = 0.5 · basisPrior + 0.3 · avgRatingNorm + 0.2 · successRate` (EMA, λ = 0.9).
- `basisPrior` kommt aus der Capability-Heuristik; der Anteil aus Feedback wächst mit der Nutzung.

## 7. Ausführungs-Engine

### 7.1 Task-Lifecycle

```
DRAFT → ROUTING → QUEUED → RUNNING → DONE
             │        │        ├──→ FAILED       (Failover-Kette erschöpft)
             │        │        ├──→ CANCELLED
             │        └──→ QUEUED (Provider belegt / Concurrent-Limit)
             └──→ routing_decisions wird persistiert (inkl. Scores & Ausschlüssen)
```

### 7.2 Ablauf (Auto-Modus)

1. Task persistiert → Event `task.created`.
2. Routing: Profil → Gates → Scoring → Entscheidung → Event `routing.decided`.
3. Queue: Concurrent-Limits (Default: **pro Provider 2, global 4**, konfigurierbar).
4. Adapter-Call mit Streaming; jedes Delta → Event `execution.delta` + Persistenz in `execution_chunks` (für Replay).
5. Usage am Ende → Metriken (Tokens, Dauer, TPS, Kosten).
6. **Failover:** Fehler/Timeout mid-stream → nächste Instanz der Kette, mit „Retry-Kontext" (Partial-Output + Fehlergrund); max. 2 Hops.
7. Abschluss: Dateien (§9) verlinken, Event `execution.done`/`execution.failed`, Rating möglich.

### 7.3 SSE-Event-Bus

```
GET /api/stream          # ein globaler SSE-Channel für alle Events
event: task.created        data: {"taskId": "…"}
event: routing.decided     data: {"executionId": "…", "decision": {…}}
event: execution.delta     data: {"executionId": "…", "delta": "…", "tokens": 142}
event: execution.usage     data: {"executionId": "…", "tokensIn": 812, "tokensOut": 1420, "tps": 27.3, "costUsd": 0.0042}
event: execution.failover  data: {"executionId": "…", "from": "…", "to": "…", "reason": "…"}
event: execution.done      data: {…}
event: provider.status     data: {"providerId": "…", "status": "online"}
event: log                 data: {"level": "info", "scope": "routing", "msg": "…"}
```

### 7.4 Abbruch & Robustheit

- **Cancel:** UI-Button → Provider-interner Cancel (wo unterstützt) + Stream-Teardown; Status `CANCELLED`.
- **Core-Neustart:** Executionen in `RUNNING` → `FAILED("core-restart")`; Replay bleibt verfügbar.
- **Timeouts:** Chunk-Timeout 60 s, Gesamt-Timeout konfigurierbar (Default 15 min).
- **Idempotenz:** Task-Erstellung liefert deterministische ID; Doppel-Submit wird dedupliziert.

## 8. Monitoring & Beobachtbarkeit

### 8.1 Dashboards (UI)

1. **Provider-Status:** pro Provider: Status-Dot, Latenz (p50/p95), Modellanzahl, aktive Requests, Queue-Länge; bei Ollama zusätzlich geladene Modelle + Speicherbelegung (`/api/ps`).
2. **Aktive Ausführungen:** Live-Liste mit Token-Fortschritt, TPS, Dauer, Cancel-Button, Failover-Hinweis.
3. **Metriken-Charts** (24 h / 7 t): Requests/min, Tokens/min (lokal vs. Cloud), Fehlerquote, Kosten/Tag (Cloud), TPS pro Instanz.
4. **Live-Logs:** filterbar nach Level/Provider/Task; Export als Datei.

### 8.2 Datenquellen

- **Eigene Metriken (Core):** aus dem Execution-Lifecycle; In-Memory-Ringbuffer + stündliche SQLite-Aggregate (`metrics_hourly`).
- **Provider-Metriken:** Health-Latenz pro Poll, Ollama `/api/ps`.
- **Outlook (M8):** Host-GPU/RAM-Beobachtung – bewusst nicht in v1.

## 9. Datei-Workspace

- **Zentrales Verzeichnis:** `~/DiriZ/workspace/<jjjj-mm-tt>/<task-slug>/` (Pfad in den Einstellungen änderbar).
- **v1 (ohne Tool-Calls):** Das System-Prompt-Template verlangt, generierte Dateien als markierte Blöcke zu liefern:

  ````
  ```file:path=src/auth.py
  …Dateiinhalt…
  ```
  ````

  Der Core parst diese Blöcke, schreibt die Dateien in den Workspace und verlinkt sie an die Execution.
- **v1.5 (M8):** Tool-Call-Support (`write_file`, `read_file`, `list_files`) für Provider mit Function-Calling – die AI steuert Dateien direkt; **jede Operation wird im Monitor geloggt** (volle Transparenz).
- **Datei-Ansicht (UI):** Baumansicht, Vorschau (Code-Highlight, Markdown-Render), **Diff zwischen Versionen desselben Dateipfads** (z. B. mehrere Läufe desselben Tasks), Copy/Download.
- **Sandbox:** AI-Dateien landen ausschließlich im Workspace (v1); v1.5: Whitelist-Verzeichnisse. Keine Pfade außerhalb.

## 10. UI/UX

### 10.1 Layout & Navigation

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◆ DiriZ      [Dashboard] [Tasks] [Instanzen] [Monitor] [Workspace] ⚙ │
├──────────────┬────────────────────────────────────────────────────────┤
│ INSTANZEN    │  TASK-COMPOSER                                         │
│ ● Ollama  12 │  ┌──────────────────────────────────────────────────┐  │
│ ● LM Studio 3│  │ „Refaktorisiere den Auth-Modul auf JWT und      │  │
│ ○ vLLM     0 │  │  schreibe Tests dazu. Projekt liegt in /repo…"  │  │
│ ● OpenRouter │  └──────────────────────────────────────────────────┘  │
│              │  Modus: [AUTO ▾]  Privacy: [local-only ▾]  Budget: [–] │
│              │  Bevorzugt: [–]   Template: [Senior-Dev ▾] [▶ Ausführen]│
│              ├────────────────────────────────────────────────────────┤
│              │  LIVE-VIEW (aktive Execution)                          │
│              │  Routing: qwen2.5-coder:32b (Ollama) · Score 91/100 [?]│
│              │  ▸ Score-Aufschlüsselung (Top-5, expandierbar)         │
│              │  streamt … 1420 Tokens · 27.3 TPS · 00:52        [⏹]  │
│              │  ▸ Dateien (2)   ▸ Logs   ▸ Roh-Antwort               │
├──────────────┴────────────────────────────────────────────────────────┤
│ STATUS: 4 Provider online · 2 aktiv · Queue 0 · heute 0.12 $ (Cloud) │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.2 Screens

1. **Dashboard** – Health-Übersicht aller Provider, aktive Ausführungen, Key-Metriken, letzte 10 Tasks.
2. **Tasks** – Composer (oben) + Historie (Tabelle: Task, Instanz, Status, Dauer, Kosten, Rating) + Detail-Dialog (Stream-Replay, Routing-Entscheidung, Dateien).
3. **Instanzen** – Provider anlegen/löschen/testen, „Modelle neu laden"; Modell-Liste mit Capability-Editing (Tags, Context, Quantisierung, Preis) und Health-Details.
4. **Monitor** – Metriken-Charts, Live-Log, Queue, Circuit-Breaker-Status.
5. **Workspace** – Datei-Baum, Vorschau, Diff.
6. **Einstellungen** – Routing-Gewichte, Policies (Local-first, Default-Budget), Privacy, Workspace-Pfad, Health-Intervalle, Theme, Export/Import.

### 10.3 Design-Prinzipien

- **Dunkles Control-Tower-Theme** (Default; helle Variante optional); Akzent: warmes Orange.
- Statusfarben: grün = online/done · amber = degraded/queued · rot = offline/failed · grau = idle.
- **Echtzeit-First:** alle Änderungen live via SSE, keine manuellen Refresh-Buttons.
- **Erklärbare KI:** jede Routing-Entscheidung mit einem Klick nachvollziehbar.
- **Tastatur-First:** `⌘⏎` ausführen, `⌘K` Task suchen.
- Leere Zustände (kein Provider konfiguriert) führen per Onboarding-Checkliste in < 2 min zum ersten Task.

## 11. Datenmodell (SQLite)

```sql
providers(id, type, label, base_url, api_key_ref, config_json, enabled, created_at)
instances(id, provider_id, model_id, display_name, context_window,
          capabilities_json, languages_json, quantization,
          price_in_per_mtok, price_out_per_mtok, source, status, last_seen_at)
tasks(id, title, prompt, metadata_json, privacy, mode, status,
      created_at, finished_at)
executions(id, task_id, instance_id, provider_id, status,
           started_at, finished_at, tokens_in, tokens_out, tps_avg,
           cost_usd, error, failover_count, rating)
execution_chunks(id, execution_id, seq, delta, created_at)     -- Stream-Replay
routing_decisions(id, execution_id, task_profile_json, scores_json,
                  excluded_json, chosen_instance_id)
files(id, execution_id, task_id, rel_path, size, created_at)
metrics_hourly(bucket, provider_id, kind, value)               -- Aggregat
logs(id, ts, level, scope, message)
settings(key, value_json)
```

- Migrations: versionierte SQL-Dateien (`db/migrations/0001_init.sql`, …), beim Start angewendet, Schema-Version in `settings`.
- `api_key_ref` = Referenz auf den verschlüsselten Key (Keychain/Vault), **nie** der Key selbst.
- `execution_chunks` wird bei großen Executions am Ende verdichtet (Run-Length/Chunking).

## 12. API-Design (REST, `127.0.0.1:8787`)

```
# Provider
POST   /api/providers                    {type, label, baseUrl, apiKey?, config}
GET    /api/providers
PATCH  /api/providers/:id                (enable/disable, config, apiKey)
DELETE /api/providers/:id
POST   /api/providers/:id/refresh        (Modelle neu entdecken)
POST   /api/providers/:id/test           (einmaliger Health-Check)

# Instanzen / Modelle
GET    /api/instances?providerId=
PATCH  /api/instances/:id                (capabilities, contextWindow, quantization, …)

# Tasks & Executions
POST   /api/tasks                        {prompt, metadata, mode, privacy, …} → 202
GET    /api/tasks?limit=&status=
GET    /api/tasks/:id
POST   /api/tasks/:id/executions         (erneute Ausführung)
GET    /api/executions/:id
POST   /api/executions/:id/cancel
POST   /api/executions/:id/rate          {rating: 1..5, comment?}

# Routing
GET    /api/routing/preview?prompt=      (Dry-Run: Entscheidung + Scores, keine Ausführung)

# Monitoring
GET    /api/metrics/summary
GET    /api/metrics/timeseries?kind=&range=
GET    /api/logs?level=&scope=&limit=

# Workspace
GET    /api/workspace/tree
GET    /api/workspace/file?path=
GET    /api/workspace/diff?path=&a=&b=

# Live
GET    /api/stream                       (SSE, alle Events, siehe §7.3)
```

Konventionen: `application/json`; Fehler als `{"error": {"code", "message"}}`; CORS nur für `http://localhost:5173`; Versionierung ab v0.2 via `api_version`-Header.

## 13. Sicherheit & Datenschutz

- **Local-first:** Core bindet ausschließlich an `127.0.0.1`; kein Public-Exposure, kein Tunneling.
- **API-Keys:** verschlüsselt im **macOS Keychain** (Fallback: lokale Datei `chmod 600`, XChaCha20-Poly1305 mit Keychain-abgeleitetem Seed). Keys nie in Logs, nie im Klartext in der UI.
- **Privacy-Policy pro Task:** `local-only` (Default) garantiert, dass kein Byte einen Cloud-Endpunkt erreicht – doppelt erzwungen: Routing-Gate **und** Adapter-Ebene (Cloud-Adapter lehnen Executions ohne `allow-cloud` ab).
- **Datei-Sandbox:** AI-schreibbare Pfade nur im Workspace (v1) bzw. Whitelist (v1.5).
- **Keine Telemetrie**, kein Update-Phoning (manuelle Updates).
- **Audit-Log:** alle Routing-Entscheidungen, Datei-Operationen und Cloud-Calls werden lokal geloggt.

## 14. Projektstruktur (Monorepo, npm workspaces)

```
DiriZ/
├── package.json                  # workspaces: ["packages/*", "apps/*"], root-scripts
├── biome.json
├── docs/
│   └── 01-plan.md                # dieses Dokument
├── packages/
│   ├── shared/                   # gemeinsame Typen, SSE-Event-Kontrakte, Konstanten
│   │   └── src/{types,events,scoring}.ts
│   └── core/                     # DiriZ Core (Fastify)
│       ├── src/
│       │   ├── server.ts         # Einstieg, Middleware, Routen
│       │   ├── providers/
│       │   │   ├── adapter.ts    # LLMProvider-Interface
│       │   │   ├── ollama.ts  lmstudio.ts  openai-compat.ts
│       │   │   ├── openrouter.ts  openai.ts
│       │   │   └── registry.ts   # Health-Pollung, Circuit Breaker, Latenz
│       │   ├── routing/
│       │   │   ├── profile.ts    # Task-Profil-Extraktion
│       │   │   ├── scorer.ts     # Gates + Scoring
│       │   │   ├── policies.ts   # auto / pinned / round-robin / cost-aware
│       │   │   └── feedback.ts   # lernendes qualityPrior
│       │   ├── execution/
│       │   │   ├── engine.ts     # Queue, Lifecycle, Failover
│       │   │   ├── stream.ts     # SSE-EventBus
│       │   │   └── files.ts      # Workspace + file-Block-Parser
│       │   ├── db/               # schema, migrations, Repositories
│       │   └── routes/           # REST-Routen pro Domäne
│       └── test/                 # Vitest: Scoring, Gates, Adapter (Mock-Server)
└── apps/
    └── web/                      # React + Vite
        └── src/
            ├── app/              # TanStack Router, Layout, Theme
            ├── features/
            │   ├── composer/     # Task-Composer
            │   ├── live/         # Live-View, Streaming-Rendering
            │   ├── instances/    # Provider-/Modell-Verwaltung
            │   ├── history/      # Historie + Detail
            │   ├── monitor/      # Charts, Logs, Queue
            │   ├── workspace/    # Datei-Baum, Vorschau, Diff
            │   └── settings/
            ├── api/              # Fetch-Clients, SSE-Client
            └── ui/               # shadcn-Komponenten, Status-Dots, Token
```

## 15. Meilensteine & Roadmap

| M | Meilenstein | Inhalt | Akzeptanzkriterien |
|---|---|---|---|
| **M0** (~1 Tag) | **Setup** | Monorepo (npm workspaces), Biome, TS strict, Vitest, Vite-App, Fastify-Skelett, SQLite-Init, `npm run dev` | UI auf :5173 + Core auf :8787 erreichbar; Health-Endpoint; `lint + test + build` grün |
| **M1** (~2–3 Tage) | **Provider-Schicht** | Adapter Ollama, LM Studio, OpenAI-kompatibel; Discovery; Health-Poller + Circuit Breaker; UI: Instanzen-View | Provider anlegen → Modelle erscheinen; Ollama/LM-Studio Start/Stop wird live korrekt angezeigt; Adapter-Unit-Tests (Mock-Server) grün |
| **M2** (~3 Tage) | **Task + manuelle Ausführung** | Task-Composer, Pinned-Mode, Streaming-Execution, Live-View (Stream, Usage), Abbruch, Historie + Stream-Replay; Prompt-Templates | Task an Ollama-Modell streamt live; Abbruch funktioniert; Replay zeigt vollständigen Output |
| **M3** (~3–4 Tage) | **Routing-Engine („Dirigent")** | Profil-Extraktion, Gates + Scoring, Auto-Mode, Explainability-Panel, Routing-Preview (Dry-Run), Failover-Kette | „Schreibe Code…" → Code-Modell gewinnt; 50k-Token-Prompt → Long-Context-Modell; Provider-Stop mid-task → Failover sichtbar; Score-Panel erklärt jede Entscheidung |
| **M4** (~2 Tage) | **Cloud-Integration** | OpenRouter (+ optional OpenAI), Keychain-Keys, Kosten-Tracking, Privacy local-only/allow-cloud, Cost-Aware | OpenRouter-Task läuft, Kosten pro Execution/Tag sichtbar; Test: local-only-Task trifft nie Cloud |
| **M5** (~2–3 Tage) | **Monitoring** | Dashboard, Metriken-Charts (24 h/7 t), Live-Log, Queue-Ansicht, Ollama-Load (`/api/ps`), Statusleiste | Dashboard zeigt Live-Status; Charts füllen sich über Test-Läufe; Logs filterbar |
| **M6** (~2–3 Tage) | **Datei-Workspace** | `file:`-Block-Parsing, Workspace-Struktur, UI: Baum/Vorschau/Diff, Verlinkung in Executions | Code-Task erzeugt Dateien im Workspace; Diff zwischen zwei Läufen sichtbar |
| **M7** (~2–3 Tage) | **Feedback & Polish** | Ratings, lernendes qualityPrior, Einstellungen (Gewichte, Policies), Export/Import, Onboarding-Empty-States, E2E-Smoke | Nach 10+ Ratings verschiebt sich qualityPrior messbar; Playwright-Smoke (Mock-Provider → Task → Stream → Historie) grün |
| **M8** (optional, Phase 2) | **Desktop & Agentik** | Tauri-Wrapper (native App), Tool-Call-Agent-Loop (`write_file`/`read_file`), Host-GPU/RAM-Monitor | App startet ohne Browser; Agent-Dateioperationen erscheinen live im Monitor |

- **Gesamtumfang v1 (M0–M7):** ca. 3–4 Wochen fokussierte Arbeit.
- **Reihenfolge:** M1 → M2 → M3 bilden das Herzstück (strikt sequenziell); M4–M6 sind voneinander unabhängig und parallelisierbar; M7 am Ende.
- **Jeder Meilenstein** endet mit einem lauffähigen, demonstrierbaren System (keine „stillen" Phasen).

## 16. Risiken & Gegenmaßnahmen

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| Keine verlässlichen Qualitätsdaten lokaler Modelle | Routing trifft suboptimale Wahl | Multi-Quelle (Heuristik + optional Router-Modell + Feedback-Loop); Explainability macht Fehlentscheidungen erkennbar; Pinned-Modus als Ausweg |
| Context-Window-Angaben unzuverlässig (gemeldet 128k, bricht bei 8k ab) | Mid-Task-Abbruch | Sicherheitsfaktor 1.2–1.3×; manuelle Override pro Modell; Failover fängt Rest ab |
| Token-Schätzung ungenau | Falsche Routing-Entscheidung | Heuristik + lokaler WASM-Tokenizer; bewusst konservative Schätzung |
| Apple Silicon: parallele Modelle → RAM/GPU-Contention | Einbrechende Performance | Load-Info (Ollama `/api/ps`), Concurrent-Limits, loadScore im Scoring |
| Ollama/LM-Studio-API-Drift | Adapter-Breaks | Adapter isoliert hinter stabilem Interface; Versionstests gegen Mock; Upgrade-Playbook in der Doku |
| OpenRouter-Preise/Modelle ändern sich | Kostenüberschreitung | Preise live aus `/models`; Budget-Gate; Cost-Aware-Mode |
| SSE bricht (UI-Neustart, Netzwerk) | Stream-Verlust in der Ansicht | Stream-Replay aus `execution_chunks`; UI re-subscribes; Core läuft unabhängig weiter |
| Scope-Creep (Agentik, Multi-User) | Verzögerung | Nicht-Ziele in §1.1 fixiert; Ausbaustufe M8 abgetrennt |

## 17. Annahmen & offene Fragen

**Annahmen (werden so behandelt, falls nicht widersprochen):**

1. Single-User, lokaler macOS-Rechner (arm64); kein Multi-User-Server-Betrieb.
2. UI-Sprache Deutsch (Fachbegriffe englisch, wo üblich).
3. Local-first: Cloud (OpenRouter) ist opt-in pro Task/Provider; Default `local-only`.
4. Reiner Node/TypeScript-Stack (§4) – Projekt startet leer, npm verfügbar; keine Python-Bestandteile.
5. Am 21.08.2026 waren Ollama (`:11434`) und LM Studio (`:1234`) **nicht** erreichbar – M1-Tests laufen zunächst gegen Mock-Server; echte Endpunkte werden verifiziert, sobald die Backends laufen.

**Offene Fragen (bitte vor M0 klären):**

| # | Frage | Empfehlung |
|---|---|---|
| Q1 | Desktop-App (Tauri) in v1 oder erst Phase 2? | Phase 2 (M8); v1 läuft im Browser auf localhost mit Ein-Klick-Start |
| Q2 | Task-Analyse standardmäßig mit kleinem lokalem „Router-Modell" oder rein heuristisch starten? | Heuristik zuerst; Router-Modell als opt-in-Einstellung |
| Q3 | OpenAI neben OpenRouter in v1? | Ja – dank OpenAI-Kompatibilität ~2 h Aufwand |
| Q4 | System-Prompt-Templates verwalten („Senior-Dev", „Kritischer Reviewer")? | Ja, in M2 – kleines Feature, hoher Nutzen |
| Q5 | Task-Vorlagen (parameterisierte, wiederholbare Aufgaben) in v1? | Nein – Phase 2 |

## 18. Nächste Schritte

1. Plan abstimmen – offene Fragen Q1–Q5 entscheiden.
2. **M0** umsetzen: Monorepo-Setup + Skeleton (UI + Core + SQLite).
3. **M1:** Provider-Schicht (Ollama + LM Studio + OpenAI-kompatibel) mit Mock-basierten Tests.
4. Fortsetzung gemäß Roadmap (§15), jeweils mit Demonstrations-Kriterium am Meilenstein-Ende.

---
*Erstellt am 21.08.2026 · DiriZ Projektplan v0.1 · Status: Entwurf zur Abstimmung*
