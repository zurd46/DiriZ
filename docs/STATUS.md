# DiriZ Entwicklung Status

> **Letzte Aktualisierung: 21.08.2026** — nach Abschluss von M2/Q4 (Prompt-Templates) und M3/Routing-Preview (Backend + UI).

## Aktueller Stand

M0–M3 sind vollständig implementiert. Die zuletzt umgesetzten Plan-Items:

- **M2/Q4 Prompt-Templates** („Senior-Dev“, „Kritischer Reviewer“) — Backend + UI
- **M3 Routing-Preview (Dry-Run)** — Engine-Methode + API + UI

Alle Checks sind grün: `npm run check` (Biome-Lint, Typecheck Core+Web, **74 Tests**) und `npm run build` (Core tsc + Web Vite-Bundle).

---

## ✅ Erledigt

### M0 — Grundlagen
- [x] Monorepo mit npm workspaces (`packages/*`, `apps/*`)
- [x] Biome (Lint+Format), TypeScript strict, Vitest, Vite/React, Fastify-Skelett
- [x] SQLite-Datenbank + Migrationen (`packages/core/db/migrations/`)
- [x] `npm run dev` lokal: Web auf :5173, Core auf :8787

### M1 — Provider-Schicht
- [x] Adapter: Ollama, LM Studio, OpenAI-kompatibel (Discovery + Health-Poller)
- [x] Circuit Breaker / Status-Tracking der Instanzen
- [x] UI: Instanzen-View mit Live-Status

### M2 — Task + manuelle Ausführung
- [x] Task-Composer (Prompt, Pinned-Mode, Overrides für Temp/Max-Tokens/System-Prompt)
- [x] Streaming-Execution mit Live-View (Stream, Usage), Abbruch (`engine.cancel`)
- [x] Historie + Stream-Replay (Executions, Dateien, Decisions in Detail-Karte)

### M2/Q4 — Prompt-Templates (abgeschlossen 21.08.2026)
- [x] Shared-Typ `PromptTemplate` (`packages/shared/src/tasks.ts`)
- [x] Migration `0003_prompt_templates.sql`: Tabelle + Seed-Vorlagen **„Senior-Dev“** und **„Kritischer Reviewer“** (Beispiele aus Plan §Q4)
- [x] Repository-CRUD: `listTemplates`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate` (`packages/core/src/db/repositories.ts`)
- [x] REST-API: `GET/POST /api/templates`, `PATCH/DELETE /api/templates/:id` (`packages/core/src/routes/templates.ts`, registriert in `app.ts`)
- [x] UI (Tasks-Ansicht):
  - Template-Picker „Vorlage → System-Prompt“ befüllt das Override-Feld
  - Verwaltung: Liste aller Vorlagen, Anwenden (Klick auf Namen), Löschen (✕)
  - Aktuelle System-Prompt-Override als neue benannte Vorlage speichern
- [x] Tests: CRUD + Seed-Defaults (`test/db.test.ts`), API-Routen (`test/app.test.ts`)

### M3 — Routing-Engine („Dirigent“) (abgeschlossen 21.08.2026)
- [x] Profil-Extraktion aus Prompt (`routing/profile.ts`, Tests in `test/profile.test.ts`)
- [x] Gates + gewichtetes Scoring (`routing/policies.ts`, `routing/scorer.ts`, Tests in `test/routing.test.ts`)
- [x] Auto-Mode: Agenten-Auswahl als reine Funktion `selectAgent()` extrahiert; Seiteneffekte bleiben in `resolveAgent()` (Testbarkeit)
- [x] Explainability-Panel: `DecisionView` zeigt Kandidaten, Score-Aufschlüsselung pro Steuerungsgröße und Ausschlüsse mit Begründung
- [x] **Routing-Preview / Dry-Run** (neue Implementierung):
  - Shared-Typ `RoutePreview` (`packages/shared/src/tasks.ts`)
  - `engine.preview(taskId)` in `execution/engine.ts`: nutzt die **exakt gleiche Pipeline** wie `runTask` (Profil → Policies → Scoring), aber ohne Execution, ohne Statusänderung, ohne Decision-Event und ohne Round-Robin-Cursor-Verschiebung
  - API: `POST /api/tasks/:id/preview` (`packages/core/src/routes/tasks.ts`)
  - UI: Button „Routing-Vorschau (Dry-Run)“ in der Detail-Karte; Ergebnispanel mit gewähltem Spezialisten + Begründung und vollständiger Entscheidung über `DecisionView`
  - Tests: Preview ohne Seiteneffekte, unbekannte Task → `undefined` (`test/engine.test.ts`)
- [x] Failover-Kette bei Provider-Ausfall (Tests in `test/engine.test.ts`, UI zeigt Failovers im Live-Stream)

---

## 📋 Offene Roadmap-Items (aus `docs/01-plan.md`)

| Meilenstein | Item | Status |
|------------|------|--------|
| **M4** (~2 Tage) | Cloud-Integration: OpenRouter (+ optional OpenAI), Keychain-Keys, Kosten-Tracking, Privacy local-only/allow-cloud, Cost-Aware | Nicht begonnen |
| **M5** (~2–3 Tage) | Monitoring: Dashboard, Metriken-Charts (24 h/7 t), Live-Log, Queue-Ansicht, Ollama-Load (`/api/ps`), Statusleiste | Nicht begonnen |
| **M6** (~2–3 Tage) | Datei-Workspace: `file:`-Block-Parsing, Workspace-Struktur, UI Baum/Vorschau/Diff, Verlinkung in Executions | Teilweise vorhanden (Datei-Ausgabe + Replay existieren; Workspace-UI fehlt) |
| **M7** (~2–3 Tage) | Feedback & Polish: Ratings, lernendes qualityPrior, Einstellungen (Gewichte, Policies), Export/Import, Onboarding, E2E-Smoke | Nicht begonnen |
| **M8** (optional, Phase 2) | Desktop & Agentik: Tauri-Wrapper, Tool-Call-Agent-Loop (`write_file`/`read_file`), Host-GPU/RAM-Monitor | Nicht begonnen |

**Empfohlene Reihenfolge laut Plan:** M4–M6 sind unabhängig und parallelisierbar; M7 am Ende.

---

## 🔧 Technische Hinweise

### Verifikation (21.08.2026)
- `npm run lint` — grün (Biome, keine Fehler)
- `npm run typecheck` — grün (Core + Web)
- `npm test` — **74 Tests grün** (shared: 16, core: 58)
- `npm run build` — grün (Core tsc-Emit + Web Vite-Bundle)

### Architektur-Entscheidungen (diese Iteration)
- **Preview statt Duplikat:** Die Routing-Vorschau ruft dieselbe Engine-Pipeline auf wie die echte Ausführung (`selectAgent()` + Scoring). Damit kann sich Preview und Realität nicht entkoppeln — im Gegensatz zu früheren Ansätzen, die das Scoring in der Repository-Schicht nachgebaut haben.
- **Templates als Override-Befüllung:** Eine Vorlage ersetzt den System-Prompt-Override des Tasks (höchste Priorität laut `TaskMetadata`/Overrides-Kette); sie wird nicht pro Task persistiert, sondern beim Anwenden kopiert.

### Nächste Schritte
1. **M4 Cloud-Integration** starten: OpenRouter-Adapter + Keychain-Keys + Kosten-Tracking (Basis für Cost-Aware-Routing).
2. Alternativ **M5 Monitoring**, falls das Dashboard priorisiert wird.
3. Vor M7: Playwright-E2E-Smoke einrichten (Mock-Provider → Task → Stream → Historie).


---