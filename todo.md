# DiriZ — Lücken-Ausbau: Plan & Checklist

> **Stand:** 27.08.2026 · Basis: M0–M11 abgeschlossen (docs/STATUS.md)
> **Ziel:** Alle identifizierten Lücken umsetzen — Priorität T1 → T4.
> **Regel:** Jeder Block endet mit grünem `npm run check` (lint + typecheck + test).

## T1 — Killer-Features

### ✅ T1-1 A/B-Vergleich ("Modell-Duell") — fertig 26.08.2026
Gleiche Anfrage an zwei verschiedene Modelle, Ergebnis-Vergleich + Gewichtung.

### ✅ T1-2 Vision-Anhänge — fertig 26.08.2026
UI: Bild-Upload/Paste im Composer (File-Input + Drag&Drop), Thumbnail-Vorschau, Grössen-Limit (8 MB) ← HIGHEST
Test: Adapter-Unit mit Mock (Vision-Request korrekt formatiert)
`npm run check` grün

### ✅ T1-3 Router-Modell — fertig 26.08.2026
Kleines lokales Modell klassifiziert unsichere Prompts (01-plan.md §6.1 Kaskade 2).
- [x] Core: `routing/llmRouter.ts` — Prompt → JSON `{capabilities, longform, latencySensitive}` via Chat-Call (eigener Provider-Call, nicht die Task) ✅ DONE
- [x] Settings: `routerModel` (Provider + Modell, Default aus), Timeout, "nur bei Unsicherheit" ✅ DONE
- [x] profile.ts: Kaskade Heuristik → (opt-in) LLM → manuell ✅ DONE
- [x] UI: Einstellungen → Abschnitt "Router-Modell" mit Auswahl + Toggle ✅ DONE
- [x] Test: Unit (Mock-Provider liefert JSON, Fallback bei Fehler/Timeout) ✅ DONE
- [x] `npm run check` grün ✅ DONE (27.08.2026, 486 Tests grün)

### ✅ T1-4 Scheduling (geplante & wiederkehrende Tasks) — fertig 27.08.2026
- [x] Migration: `schedules(id, title, prompt, agentId, mode, privacy, pinned*, cron|everyMinutes, nextRunAt, enabled, lastRunTaskId, lastRunAt)`
- [x] Core: Scheduler-Timer (30 s), prüft fällige Schedules → Task erzeugen + starten
- [x] Core: Routen CRUD `GET/POST/PATCH/DELETE /api/schedules` + `POST /api/schedules/:id/run-now`
- [x] UI: Neue View "Zeitplan" (Listen, Anlegen, Pausieren, löschen, "jetzt starten", letzte Ausführung mit Link zur Task) ✅ DONE
- [x] UI: Nav-Eintrag + Icon ✅ DONE
- [x] Test: Unit (Fälligkeit, Repeated, Run-now) ✅ DONE — `packages/core/test/scheduler.test.ts`, `npm run check` grün

### ✅ T1-5 Modell-Benchmarks — fertig 27.08.2026
- [x] shared: `BENCHMARK_SUITE` — 10 kurze Standard-Aufgaben (Code, Reasoning, Sprache) mit erwarteten Merkmalen
- [x] Core: `POST /api/benchmarks/:instanceId` (oder `/api/benchmarks?model=`) → läuft Suite mit begrenztem Output, sammelt TPS, Fehler, grobe Qualität (Keyword-Treffer)
- [x] Test: Unit (Suite, Teilmenge, TPS, Timeout, 409-Doppelstart) ✅ DONE — `packages/core/test/benchmarks.test.ts` (18 Tests), `npm run check` grün

**T1-5 API-Vertrag:** `POST /api/benchmarks/:instanceId` → `202` (asynchron), optional `tasks: string[]` als Teilmenge (unbekannte IDs sanft ignoriert, leer → ganze Suite). `GET /api/benchmarks/:instanceId/last` → Status (`running`) + letztes Ergebnis (`erg` mit TPS/Qualität pro Aufgabe). `GET /api/benchmarks/suite` → Aufgaben für die UI. Doppelstart derselben Instanz → `409`.

## T2 — UX & Robustheit

### ✅ T2-7 Light-Theme — fertig 27.08.2026
- [x] Core: Theme-Einstellungen lesen/speichern via Settings-API (`GET/PUT /api/settings` → `theme: "dark" | "light"`, Default dark, 400 bei fremdem Wert) ✅ DONE
- [x] UI: Dark/Light Mode Toggle in Einstellungen (Card "Aussehen" mit Vorschau-Kacheln) ✅ DONE
- [x] UI: Nav-Eintrag für Theme-Wechsel (Sidebar-Fuß, Sonne/Mond) ✅ DONE
- [x] CSS: `:root` Dark-Tokens + `:root[data-theme='light']` Light-Überschreibungen (Flächen, Linien, Text, Akzent, Semantik, Schatten) ✅ DONE
- [x] Persistenz: `uiTheme` in Core-Settings + `localStorage` (`diriz-theme`) gegen Theme-Blitz beim Start ✅ DONE
- [x] Test: Unit (Default, Wechsel, 400) ✅ DONE — `packages/core/test/app.test.ts`
- [x] `npm run check` grün ✅ DONE (27.08.2026, 488 Tests grün) + `npm run build` grün

### ☐ T2-8 OpenAPI-Spec — sollte nach T4-17 sein (Tokens gehören in die Spec)
### ☐ T2-9 Weitere UX Verbesserungen...

## T3 — Robustheit & System

### ✅ T3-13 Stromkosten für lokale Modelle
- [x] Settings: `electricityCentsPerKwh`, `systemWatts` (Default 60 W)
- [x] Core: Kosten = Cloud-Preis + lokale Laufzeit × Watt/1000 × Preis; in Execution-Kosten + Metriken
- [x] UI: Dashboard-Karte "Kosten inkl. Strom", Settings-Eingabe
- [x] Test: Unit (Formel), `npm run check` grün

### ☐ T3-14 Batterie/Thermal-Gate (macOS)
- [ ] Core: `monitoring/host.ts` liest `pmset -g batt` (Akkubetrieb %) + `pmset -g therm` (Drosselung) — nur macOS, sonst null
- [ ] Core: Routing-Achse `powerState` (lokal + Akkubetrieb/Thermal → Bestrafung; Cloud neutral)
- [ ] UI: System-Karte zeigt "Akkubetrieb" / "thermisch gedrosselt"
- [ ] Test: Unit (Mock), `npm run check` grün

### ☐ T3-15 Parallel-Tool-Execution — offen (in todo.md fälschlich Test als ✅ markiert, kein Parallel-Code in agent.ts)
- [ ] agent.ts: unabhängige `read_file`/`list_files`/`search_files`-Calls im selben Schritt parallel (Promise.all), Mutationen bleiben sequentiell
- [ ] Fortschritts-Detection (nochmalGeschrieben, wirkungsloserBefehl) bleibt korrekt
- [ ] Test: Unit (Parallel-Lese-Batch)
- [ ] `npm run check` grün

## T4 — Nice-to-Haves

### ☐ T4-16 OpenAPI-Spec — offen (in todo.md fälschlich als ✅ markiert, kein OpenAPI-Code im Repo)
- [ ] Core: `GET /api/openapi.json` (Fastify `@fastify/swagger` ODER manuelle Spec aus Routen) + `GET /docs` (Swagger-UI via CDN)
- [ ] `npm run check` grün

### ☐ T4-17 Personal API Tokens — nicht begonnen
- [ ] Migration: `api_tokens(id, name, tokenHash, createdAt, lastUsedAt, revokedAt)`
- [ ] Core: Auth-Hook akzeptiert `Authorization: Bearer <token>` (neben Cookie); Routen CRUD
- [ ] UI: Einstellungen → "API-Tokens" (anlegen mit Namen, zeigen-once, widerrufen)
- [ ] Test: Unit (Bearer-Login, Revocation), `npm run check` grün

### ☐ T4-18 Token-Counter (echter Tokenizer) — nicht begonnen
- [ ] `js-tiktoken` o.ä. als Dependency; `estimateTokens` nutzt ihn (Fallback: Zeichen/3.5)
- [ ] UI: Token-Counter im Composer (Prompt + geschätzter Output)
- [ ] Test: Unit (bekannte Strings), `npm run check` grün

### ☐ T4-19 Kosten-Alerte während des Laufs — nicht begonnen
- [ ] Core: bei `execution.usage` → wenn kumulierte Kosten Budget überschreiten → Event `execution.budget.warn`
- [ ] UI: Warnung im Live-Stream + Toast
- [ ] `npm run check` grün

### ☐ T4-20 Queue-Priorität — nicht begonnen
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
