# DiriZ — Projektstatus

> **Stand: 21.08.2026** · Alle Kern-Meilensteine M0–M7 sind abgeschlossen und verifiziert.

## ⚡ Quick Status

```
Roadmap   ████████████████████░░  M0–M7 fertig (93 %)   M8 = optional Phase 2
Qualität  ██████████████████████  Lint · Typecheck · 64 Unit-Tests · Build · 2 E2E — alles grün
```

| Bereich | Status | Details |
|---------|--------|---------|
| Provider & Cloud (M1, M4) | ✅ fertig | Ollama, LM Studio, OpenAI-kompatibel, OpenRouter, OpenAI · verschlüsselte Keys · Kosten-Tracking · Privacy-Gates |
| Tasks & Execution (M2) | ✅ fertig | Composer, Streaming-Live-View, Abbruch, Historie + Replay, Prompt-Templates |
| Routing-Engine (M3) | ✅ fertig | Profil-Extraktion, Policies, gewichtetes Scoring, Failover, Explainability, Dry-Run-Preview |
| Monitoring (M5) | ✅ fertig | Dashboard mit Metriken, 24 h/7-Tage-Charts, Ollama-Load-Karte, Statusleiste, Live-Logs |
| Workspace & Diff (M6) | ✅ fertig | Dateibaum der Sandbox, Vorschau mit Zeilennummern, LCS-Diff zwischen Versionen |
| Feedback & Polish (M7) | ✅ fertig | Sterne-Ratings → lernender Qualitäts-Prior, Routing-Gewichte in Einstellungen, Export/Import, Onboarding |
| Desktop & Agentik (M8) | ⏸ optional | Tauri-Wrapper, Tool-Call-Agent-Loop, Host-GPU/RAM-Monitor — Phase 2 |

---

## 🚀 Was heute läuft

**End-to-End-Nutzerfluss:** Provider verbinden → Task anlegen (Prompt, Privatsphäre, Budget, Modus) → DiriZ routet auf das beste Modell (lokal oder Cloud) → Live-Stream mit Failover → Ergebnis bewerten (1–5 Sterne) → DiriZ lernt daraus.

**Dashboard:** Provider-Status, Token-Volumen & Kosten als interaktive Charts (24 h / 7 Tage), Ollama-VRAM-Auslastung pro geladenem Modell, Queue der aktiven Executions.

**Workspace:** Jede Task-Datei ist versioniert — Vorschau mit Zeilennummern und ein farbiger Diff (+/−) zwischen beliebigen zwei Versionen derselben Datei.

**Einstellungen:** Die sechs Routing-Gewichte (Context-Fit, Capability-Match, Qualitäts-Prior, Last, Kosten, Latenz) sind live anpassbar — der Engine liest sie pro Entscheidung aus der Datenbank. Dazu JSON-Export/-Import von Agenten, Swarms, Templates und Settings.

**Erststart:** Ein 4-Schritte-Onboarding erklärt den Workflow (überspringbar, einmalig).

---

## 🔧 Diese Iteration (21.08.2026)

### Neu implementiert
- **M5 Monitoring:** 7-Tage-Zeitreihe (API `hours=168` + clientseitige Tages-Aggregation), Range-Toggle im Dashboard, Ollama-Load-Karte mit VRAM-Fortschrittsbalken (`GET /api/providers/:id/load` → `/api/ps`), fixe Statusleiste (Verbindung, aktive Executions, Provider online)
- **M6 Workspace:** neue `Workspace`-View (Dateibaum + Vorschau + Diff), LCS-Diff-Engine ohne Abhängigkeiten, Versionen-Auswahl pro Datei
- **M7 Feedback & Polish:**
  - Sterne-Ratings in der Task-Detail-Karte → `POST /api/executions/:id/rating` → EMA-glättender Qualitäts-Prior (λ = 0.9)
  - Settings-API (`GET/PUT /api/settings`) + Engine liest Gewichte pro Entscheidung aus der DB (Fallback: Plan-Defaults)
  - Export/Import (`GET /api/export`, `POST /api/import`) — Name-basiertes Upsert, Provider/Keys bewusst ausgeschlossen
  - Onboarding-Overlay mit Schritt-Anzeige
- **Sichtbares Scheitern:** Tasks ohne verfügbare Instanz erzeugen jetzt eine fehlgeschlagene Execution mit Begründung („Keine Instanz verfügbar …") statt eines unsichtbaren Fehlers — in der UI sichtbar und bewertbar

### Behobene Defekte (gefunden durch E2E-Tests)
| Bug | Symptom | Fix |
|-----|---------|-----|
| API-Client setzte `content-type: application/json` auch ohne Body | Fastify lehnte bodylose POSTs (z. B. „Start") mit 400 ab | Content-Type nur bei vorhandenem Body setzen (`apps/web/src/lib/api.ts`) |
| Ollama-Load-Karte lag im Chart-Flex-Row | Layout brach, Karte unsichtbar | Eigene Sektion im Dashboard |
| Verwaistes `FileBrowser`-Component (nie eingebunden) | tote Datei | durch neue Workspace-View ersetzt und entfernt |

### Verifikation (alle grün, 21.08.2026)
| Check | Ergebnis |
|-------|----------|
| `npm run lint` (Biome) | ✅ 82 Dateien, 0 Fehler |
| `npm run typecheck` (shared + core + web) | ✅ 0 Fehler |
| `npm test` (Vitest) | ✅ **64/64** (u. a. neue Tests: Settings-API, Export/Import, sichtbare No-Candidate-Execution) |
| `npm run build` | ✅ Core tsc + Web Vite-Bundle (76 kB gzip) |
| Playwright E2E | ✅ **2/2** — Smoke (Onboarding → Task → Start → Rating) + Workspace-Diff |

### Architektur-Entscheidungen (diese Iteration)
- **Settings in der DB, nicht im Client:** Gewichte werden serverseitig persistiert und vom Engine pro Routing-Entscheidung gelesen — UI und Core können nie driften.
- **Diff clientseitig:** Die LCS-Diff-Engine läuft im Browser (keine neue Abhängigkeit); Dateien sind klein genug für O(n·m) mit 4-Mio-Zellen-Schutz.
- **Import per Name, nicht ID:** IDs sind lokal erzeugt — beim Import wird per Namen gematcht, damit Wiederholungen aktualisieren statt duplizieren.

---

## ⏸ Phase 2 (M8, optional)
- Tauri-Desktop-Wrapper (aktuell: Browser-UI + lokaler Core)
- Tool-Call-Agent-Loop (`write_file` / `read_file`) für autonome Datei-Arbeit
- Host-GPU/RAM-Monitoring als zusätzliche Routing-Achse

## 📚 Dokumentation
- [`01-plan.md`](./01-plan.md) — vollständiger Architektur- & Roadmap-Plan
- [`../README.md`](../README.md) — Setup, Befehle, Architektur-Überblick