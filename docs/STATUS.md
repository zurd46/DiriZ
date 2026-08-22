# DiriZ — Projektstatus

> **Stand: 22.08.2026** · Alle Meilensteine M0–M8 sind abgeschlossen und verifiziert — das Projekt ist fertig.

## ⚡ Quick Status

```
Roadmap   ██████████████████████  M0–M8 fertig (100 %)
Qualität  ██████████████████████  Lint · Typecheck · 93 Unit-Tests · Build · 3 E2E — alles grün
Desktop   ██████████████████████  Tauri-2-Wrapper kompiliert (cargo check ✓)
```

| Bereich | Status | Details |
|---------|--------|---------|
| Provider & Cloud (M1, M4) | ✅ fertig | Ollama, LM Studio, OpenAI-kompatibel, OpenRouter, OpenAI · verschlüsselte Keys · Kosten-Tracking · Privacy-Gates |
| Tasks & Execution (M2) | ✅ fertig | Composer, Streaming-Live-View, Abbruch, Historie + Replay, Prompt-Templates |
| Routing-Engine (M3) | ✅ fertig | Profil-Extraktion, Policies, gewichtetes Scoring, Failover, Explainability, Dry-Run-Preview |
| Monitoring (M5) | ✅ fertig | Dashboard mit Metriken, 24 h/7-Tage-Charts, Ollama-Load-Karte, Statusleiste, Live-Logs |
| Workspace & Diff (M6) | ✅ fertig | Dateibaum der Sandbox, Vorschau mit Zeilennummern, LCS-Diff zwischen Versionen |
| Feedback & Polish (M7) | ✅ fertig | Sterne-Ratings → lernender Qualitäts-Prior, Routing-Gewichte in Einstellungen, Export/Import, Onboarding |
| Desktop & Agentik (M8) | ✅ fertig | Tauri-2-Desktop-Wrapper · Tool-Call-Agent-Loop (`list_files`/`read_file`/`write_file`) · Host-RAM/CPU/GPU-Monitoring + 7. Routing-Achse „Host-Last“ |

---

## 🚀 Was heute läuft

**End-to-End-Nutzerfluss:** Provider verbinden → Task anlegen (Prompt, Privatsphäre, Budget, Modus, optional Agentik) → DiriZ routet auf das beste Modell (lokal oder Cloud) → Live-Stream mit Failover → Ergebnis bewerten (1–5 Sterne) → DiriZ lernt daraus.

**Agentik-Modus (M8):** Im Task-Composer anwählbar — das Modell arbeitet dann autonom mit den Datei-Tools `list_files`, `read_file`, `write_file` in der Task-Sandbox. Jede Operation erscheint live als ✓/✗-Zeile unter dem Stream und wird im Log protokolliert (volle Transparenz). Schritt-Limit (8) schützt vor Endlosschleifen; funktioniert mit Ollama, LM Studio, OpenAI & OpenRouter.

**Dashboard:** Provider-Status, Token-Volumen & Kosten als interaktive Charts (24 h / 7 Tage), Ollama-VRAM-Auslastung pro geladenem Modell, **System-Karte (M8)** mit RAM-Balken, CPU-Last und GPU-Info (Live-Polling alle 5 s).

**Workspace:** Jede Task-Datei ist versioniert — Vorschau mit Zeilennummern und ein farbiger Diff (+/−) zwischen beliebigen zwei Versionen derselben Datei.

**Einstellungen:** Die sieben Routing-Gewichte (Context-Fit, Capability-Match, Qualitäts-Prior, Last, Kosten, Latenz, **Host-Last**) sind live anpassbar — die Engine liest sie pro Entscheidung aus der Datenbank. Dazu JSON-Export/-Import von Agenten, Swarms, Templates und Settings.

**Desktop (M8):** `npm run desktop` startet die Web-UI in einer nativen Tauri-2-Fenster-Hülle (Dev: Vite; Prod: gebautes Bundle). Der Core läuft weiterhin lokal — die App ist eine schlanke Hülle ohne eigene Logik.

**Erststart:** Ein 4-Schritte-Onboarding erklärt den Workflow (überspringbar, einmalig).

---

## 🔧 Diese Iteration (22.08.2026) — M8: Desktop & Agentik

### Neu implementiert
- **Tool-Call-Agent-Loop** (`packages/core/src/execution/agent.ts` + `tools.ts`):
  - Drei Sandbox-Tools mit JSON-Schemas; Pfad-Sicherheit doppelt abgesichert (Relativ-Pfad-Validierung + Prefix-Check)
  - Loop: Streamen → Tool-Calls sammeln → ausführen → Ergebnisse als `tool`-Messages zurückgeben → bis finale Antwort oder Schritt-Limit (8)
  - Neue SSE-Event-Art `tool.call` — jede Operation live in der UI (✓/✗ + Pfad) und im Log
  - Adapter-Support: OpenAI-kompatibel (LM Studio/OpenAI/OpenRouter, inkl. Fragment-Akkumulation gestreamter `tool_calls`) + Ollama (`message.tool_calls`); Flag `supportsTools` am Provider-Kontrakt
  - UI: „Agentik“-Checkbox im Task-Composer → `metadata.agentMode`; Live-Anzeige der Operationen in der Task-Detail
- **Host-GPU/RAM-Monitoring** (`packages/core/src/monitoring/host.ts`):
  - `GET /api/host/metrics`: RAM (total/used/%), CPU-Kerne + Load, Uptime; GPU via `nvidia-smi` auf Linux, sonst null (Metal hat keine CLI-API — VRAM kommt aus Ollama `/api/ps`)
  - Dashboard-System-Karte mit farbigem RAM-Balken (>85 % rot, >60 % gelb), 5-s-Polling
  - **7. Routing-Achse „Host-Last“**: bestraft lokale Instanzen bei hoher Host-RAM-Belegung (Swap/OOM-Risiko); Cloud bleibt neutral; Default-Gewicht 0 = aus; Slider in den Einstellungen; Backward-kompatibel mit alten Settings (fehlendes Feld → 0)
- **Tauri-2-Desktop-Wrapper** (`apps/desktop/`):
  - `tauri dev` / `tauri build`, Fenster-Hülle um die Web-UI, generierte Ikonensets (PNG/ICNS/ICO), Root-Skript `npm run desktop`
  - `cargo check` grün; bewusst schlank: keine Rust-Logik, Core bleibt der einzige Server

### Architektur-Entscheidungen (diese Iteration)
- **Agentik als Modus, nicht als Pflicht:** Standard-Verhalten (Text-I/O + File-Blöcke) bleibt unverändert; `agentMode` ist opt-in pro Task. Provider ohne Tool-Support degradieren sanft in den Text-Modus.
- **Tools strikt sandboxed:** Alle Pfade relativ zur Task-Sandbox, doppelte Absicherung — das Modell kann keine Datei außerhalb anrühren.
- **Host-Metriken nie werfend:** Routing scheitert nicht an fehlenden Metriken (Fallback: Achse neutral = 1.0).
- **Desktop als Hülle:** Keine Duplizierung von Logik in Rust; die App zeigt exakt dieselbe UI wie der Browser.

### Verifikation (alle grün, 22.08.2026)
| Check | Ergebnis |
|-------|----------|
| `npm run lint` (Biome) | ✅ 92 Dateien, 0 Fehler |
| `npm run typecheck` (shared + core + web) | ✅ 0 Fehler |
| `npm test` (Vitest) | ✅ **93/93** (18 shared + 75 core — u. a. neu: Sandbox-Tools, Agent-Loop, Engine-Agentik-Integration, Host-Metriken-Route, hostLoad-Renormierung) |
| `npm run build` | ✅ Core tsc + Web Vite-Bundle (76.9 kB gzip) |
| Playwright E2E | ✅ **3/3** — Smoke · Workspace-Diff · M8 (System-Karte + Agentik-Checkbox + Host-Last-Slider + API) |
| Tauri Desktop | ✅ `cargo check` EXIT 0 (428 Pakete) |

---

## 📚 Dokumentation
- [`01-plan.md`](./01-plan.md) — vollständiger Architektur- & Roadmap-Plan
- [`../README.md`](../README.md) — Setup, Befehle, Architektur-Überblick