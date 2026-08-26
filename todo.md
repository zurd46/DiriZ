# DiriZ — Lücken-Ausbau: Plan & Checklist

> **Stand:** 26.08.2026 · Basis: M0–M11 abgeschlossen (docs/STATUS.md)
> **Ziel:** Alle identifizierten Lücken umsetzen — Priorität T1 → T4.
> **Regel:** Jeder Block endet mit grünem `npm run check` (lint + typecheck + test).
> **Legende:** ☐ offen · ▶ in Arbeit · ✅ fertig · ⚠️ mit Einschränkung fertig · ✗ verworfen

## T1 — Killer-Features

### ✅ T1-1 A/B-Vergleich ("Modell-Duell") — fertig 26.08.2026
Gleichen Auftrag parallel auf 2–4 Modellen, Ergebnis + Tempo + Kosten nebeneinander.
- [x] Core: `POST /api/compare` (prompt + N Instanzen → N Tasks, gemeinsame `compareId` in metadata, 2–4 Instanzen, Duplikat-Ablehnung) + `GET /api/compare/recent`
- [x] Core: `GET /api/compare/:compareId` (Status + Resultate aller Mitglieder: Output, Fehler, Tokens, TPS, Kosten, Dauer, allFinished)
- [x] UI: Composer-Option "Vergleich" mit Modell-Chip-Auswahl (2–4, Limite sichtbar)
- [x] UI: Compare-View: Spalten pro Modell, Live-Stream pro Spalte, TPS/Kosten/Dauer, Abbrechen pro Spalte, Wort-Diff der Ergebnisse gegen wählbare Referenz
- [ ] UI: Statusleiste/Dashboard zeigt aktive Vergleiche (nächster T1-Schritt)
- [x] ⚠️ Score-Aufschlüsselung pro Spalte fehlt noch (TPS/Kosten/Dauer/Output sind da; die Routing-Achsen-Details je Spalte nicht)
- [x] Test: 3 Unit-Tests (Validierung, Persistenz + compareId-Gruppierung + Ergebnis-View + Recent, 404)
- [x] `npm run check` grün (26 Dateien, 433 Tests) + Build grün

### ▶ T1-2 Vision-Anhänge — in Arbeit 26.08.2026
Bilder in Prompts senden (Capability `vision` wird real).
- [x] shared: `ChatMessage.content` wird `string | ContentPart[]` (text + image_url/base64), `contentText()`-Helper, `LLMProvider.supportsVision` im Provider-Kontrakt
- [x] Core: Ollama-Adapter (`extractOllamaImages` → `images`-Feld), OpenAI-Compat-Adapter (`ContentPart[]` direkt) — beide `supportsVision=true`
- [x] Core: Routing-Gate `vision` — `extractProfile(task, attachmentCount)` setzt `hasAttachments`, `applyPolicies` exkludiert Modelle ohne `vision`
- [x] Core: `attachments`-Tabelle (0021), `createTask`-Persistenz, `listAttachmentsByTask`, Engine baut `ContentPart[]` für User-Nachricht (inkl. Agent-Loop)
- [ ] UI: Bild-Upload/Paste im Composer (File-Input + Drag&Drop), Thumbnail-Vorschau, Grössen-Limit (8 MB)
- [ ] Test: Adapter-Unit mit Mock (Vision-Request korrekt formatiert)
- [ ] `npm run check` grün

### ☐ T1-3 Router-Modell (opt-in)
Kleines lokales Modell klassifiziert unsichere Prompts (01-plan.md §6.1 Kaskade 2).
- [ ] Core: `routing/llmRouter.ts` — Prompt → JSON `{capabilities, longform, latencySensitive}` via Chat-Call (eigener Provider-Call, nicht die Task)
- [ ] Settings: `routerModel` (Provider + Modell, Default aus), Timeout, "nur bei Unsicherheit"
- [ ] profile.ts: Kaskade Heuristik → (opt-in) LLM → manuell
- [ ] UI: Einstellungen → Abschnitt "Router-Modell" mit Auswahl + Toggle
- [ ] Test: Unit (Mock-Provider liefert JSON, Fallback bei Fehler/Timeout)
- [ ] `npm run check` grün

### ☐ T1-4 Scheduling (geplante & wiederkehrende Tasks)
- [ ] Migration: `schedules(id, title, prompt, agentId, mode, privacy, pinned*, cron|everyMinutes, nextRunAt, enabled, lastRunTaskId, lastRunAt)`
- [ ] Core: Scheduler-Timer (30 s), prüft fällige Schedules → Task erzeugen + starten
- [ ] Core: Routen CRUD `GET/POST/PATCH/DELETE /api/schedules` + `POST /api/schedules/:id/run-now`
- [ ] UI: Neue View "Zeitplan" (Listen, Anlegen, Pausieren, löschen, "jetzt starten", letzte Ausführung mit Link zur Task)
- [ ] UI: Nav-Eintrag + Icon
- [ ] Test: Unit (Fälligkeit, Repeated, Run-now), `npm run check` grün

### ☐ T1-5 Modell-Benchmarks
- [ ] shared: `BENCHMARK_SUITE` — 10 kurze Standard-Aufgaben (Code, Reasoning, Sprache) mit erwarteten Merkmalen
- [ ] Core: `POST /api/benchmarks/:instanceId` (oder `/api/benchmarks?model=`) → läuft Suite mit begrenztem Output, sammelt TPS, Fehler, grobe Qualität (Keyword-Treffer)
- [ ] Core: Ergebnis in `qualityPrior` einspeisen (Feedback-DB) + persistieren (`benchmark_results`)
- [ ] UI: LLM-Modelle-View: "Benchmark starten" pro Modell, Fortschritt, Ergebnis-Karte (TPS, Ø-Korrekt, Fehler)
- [ ] Test: Unit (Suite-Validierung, Prior-Anpassung), `npm run check` grün

## T2 — UX-Versprechen aus dem eigenen Plan

### ☐ T2-6 ⌘K Command Palette + Task-Suche
(01-plan.md §10.3 "Tastatur-First")
- [ ] Core: `GET /api/tasks?q=…` (LIKE über title+prompt) und `GET /api/search?q=…` (Tasks, Dokumente, Modelle, Repos)
- [ ] UI: `⌘K`-Palette (eigene Kompo, keine Abhängigkeit): Tasks springen, Views öffnen, Aktionen (Provider neu laden, Benchmark, Vergleich starten)
- [ ] UI: Task-Suchbox in Tasks-View (Client-Filter + Server-`q`)
- [ ] Test: Unit (Suche), `npm run check` grün

### ☐ T2-7 Browser-Benachrichtigungen
- [ ] UI: "Benachrichtigungen" in Settings (Browser-Permission anfragen, pro Task/Chat opt-out)
- [ ] UI: Bei `execution.done`/`execution.failed` (Tab unsichtbar) → `Notification` mit Titel + Status
- [ ] Test: manuell (Browser), `npm run check` grün

### ☐ T2-8 Helles Theme
- [ ] `index.css`: Farbvariablen für `:root[data-theme="light"]` (aktuell nur dunkel)
- [ ] UI: Theme-Toggle in Settings + Statusleiste, `localStorage`-Persistenz, `prefers-color-scheme` als Default
- [ ] `npm run check` grün

### ☐ T2-9 Modell-Verwaltung: Pull & Unload
- [ ] Core: Ollama `POST /api/providers/:id/models/pull` (`/api/pull`, Namen + Tag) und `DELETE /api/providers/:id/models/:model` (unload via `/api/ps` + `keep_alive=0`)
- [ ] Core: OpenAI-Compat: `POST /v1/models`? — nur wo unterstützt; sonst saubere 501
- [ ] UI: Provider-View: Modell-Liste mit "Laden"/"Räumen"-Buttons + Status (geladen/nicht geladen)
- [ ] Test: Unit (Ollama-Mock), `npm run check` grün

## T3 — Robustheit & Betrieb

### ☐ T3-10 SQLite-Backup
- [ ] Core: `GET /api/settings/backup` → `VACUUM INTO` in `<dataDir>/backups/diriz-<ts>.sqlite`, max. N behalten (einstellbar)
- [ ] UI: Einstellungen → "Daten & Backup": Backup jetzt, Liste, Download, löschen
- [ ] Test: Unit (Backup-Datei existiert, ist lesbar), `npm run check` grün

### ☐ T3-11 SSE-Sequenzen (lückenlose Reconnect)
- [ ] Core: EventBus emittiert `seq` (pro Session monoton), `Last-Event-ID` bei Reconnect → Replay aus Ringbuffer (z.B. 500 Events)
- [ ] UI: `sse.ts` sendet `Last-Event-ID`, `onerror` bleibt
- [ ] Test: Unit (Replay-Fenster), `npm run check` grün

### ☐ T3-12 Strukturierte Ausgabe (JSON mode)
- [ ] shared: `ChatRequest.jsonMode?: boolean`
- [ ] Core: OpenAI-Compat `response_format: {type:"json_object"}`, Ollama `format:"json"`, Provider-Flag `supportsJsonMode`
- [ ] Test: Adapter-Unit, `npm run check` grün

### ☐ T3-13 Stromkosten für lokale Modelle
- [ ] Settings: `electricityCentsPerKwh`, `systemWatts` (Default 60 W)
- [ ] Core: Kosten = Cloud-Preis + lokale Laufzeit × Watt/1000 × Preis; in Execution-Kosten + Metriken
- [ ] UI: Dashboard-Karte "Kosten inkl. Strom", Settings-Eingabe
- [ ] Test: Unit (Formel), `npm run check` grün

### ☐ T3-14 Batterie/Thermal-Gate (macOS)
- [ ] Core: `monitoring/host.ts` liest `pmset -g batt` (Akkubetrieb %) + `pmset -g therm` (Drosselung) — nur macOS, sonst null
- [ ] Core: Routing-Achse `powerState` (lokal + Akkubetrieb/Thermal → Bestrafung; Cloud neutral)
- [ ] UI: System-Karte zeigt "Akkubetrieb" / "thermisch gedrosselt"
- [ ] Test: Unit (Mock), `npm run check` grün

### ☐ T3-15 Parallel-Tool-Execution
- [ ] agent.ts: unabhängige `read_file`/`list_files`/`search_files`-Calls im selben Schritt parallel (Promise.all), Mutationen bleiben sequentiell
- [ ] Fortschritts-Detection (nochmalGeschrieben, wirkungsloserBefehl) bleibt korrekt
- [ ] Test: Unit (Parallel-Lese-Batch), `npm run check` grün

## T4 — Nice-to-Haves

### ☐ T4-16 OpenAPI-Spec
- [ ] Core: `GET /api/openapi.json` (Fastify `@fastify/swagger` ODER manuelle Spec aus Routen) + `GET /docs` (Swagger-UI via CDN)
- [ ] `npm run check` grün

### ☐ T4-17 Personal API Tokens
- [ ] Migration: `api_tokens(id, name, tokenHash, createdAt, lastUsedAt, revokedAt)`
- [ ] Core: Auth-Hook akzeptiert `Authorization: Bearer <token>` (neben Cookie); Routen CRUD
- [ ] UI: Einstellungen → "API-Tokens" (anlegen mit Namen, zeigen-once, widerrufen)
- [ ] Test: Unit (Bearer-Login, Revocation), `npm run check` grün

### ☐ T4-18 Token-Counter (echter Tokenizer)
- [ ] `js-tiktoken` o.ä. als Dependency; `estimateTokens` nutzt ihn (Fallback: Zeichen/3.5)
- [ ] UI: Token-Counter im Composer (Prompt + geschätzter Output)
- [ ] Test: Unit (bekannte Strings), `npm run check` grün

### ☐ T4-19 Kosten-Alerte während des Laufs
- [ ] Core: bei `execution.usage` → wenn kumulierte Kosten Budget überschreiten → Event `execution.budget.warn`
- [ ] UI: Warnung im Live-Stream + Toast
- [ ] `npm run check` grün

### ☐ T4-20 Queue-Priorität
- [ ] Migration: `tasks.priority` (0 normal, 1 high) + `drainQueued` sortiert danach (dann createdAt)
- [ ] UI: Composer-Option "Priorität hoch"
- [ ] Test: Unit (Sortierung), `npm run check` grün

## Abschluss
- [ ] Alle Blöcke ✅/⚠️
- [ ] `npm run check` + `npm run build` grün
- [ ] `docs/STATUS.md` um neue Iteration ergänzen (M12)
- [ ] README-Features-Tabelle aktualisieren
- [ ] E2E-Smoke (`npm run test:e2e`) grün

## Risiken & Abhängigkeiten
- T1-2 (Vision) und T1-3 (Router-Modell) brauchen beide Adapter-Anpassungen → in derselben Iteration zusammen testen.
- T3-15 (Parallel-Tools) berührt die Agentik-Schleife → erst nach T1-2/3, damit keine doppelten Änderungen an agent.ts.
- T2-8 (Light-Theme) ist reine CSS-Arbeit → kann parallel zu Core-Blöcken laufen, aber nach T2-7 (benutzt dieselben CSS-Variablen).
- T4-16 (OpenAPI) sollte nach T4-17 sein (Tokens gehören in die Spec).
