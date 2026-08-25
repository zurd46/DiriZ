# DiriZ — Projektstatus

> **Stand: 24.08.2026** · M0–M11 abgeschlossen und verifiziert.

## ⚡ Quick Status

```
Roadmap   ██████████████████████  M0–M11 fertig
Qualität  ██████████████████████  Lint · Typecheck · 331 Unit-Tests · Build · 18 E2E — alles grün
Desktop   ██████████████████████  Tauri-2-Wrapper kompiliert (cargo check ✓)
Schema    ██████████████████████  Migration 0016
```

| Bereich | Status | Details |
|---------|--------|---------|
| Provider & Cloud (M1, M4) | ✅ fertig | Ollama, LM Studio, OpenAI-kompatibel, OpenRouter, OpenAI · verschlüsselte Keys · Kosten-Tracking · Privacy-Gates |
| Tasks & Execution (M2) | ✅ fertig | Composer, Streaming-Live-View, Abbruch, Historie + Replay, Prompt-Templates |
| Routing-Engine (M3) | ✅ fertig | Profil-Extraktion, Policies, gewichtetes Scoring, Failover, Explainability, Dry-Run-Preview |
| Monitoring (M5) | ✅ fertig | Dashboard mit Metriken, 24 h/7-Tage-Charts, Ollama-Load-Karte, Statusleiste, Live-Logs |
| Workspace & Diff (M6) | ✅ fertig | Dateibaum der Sandbox, Vorschau mit Zeilennummern, LCS-Diff zwischen Versionen |
| Feedback & Polish (M7) | ✅ fertig | Sterne-Ratings → lernender Qualitäts-Prior, Routing-Gewichte in Einstellungen, Export/Import, Onboarding |
| Desktop & Agentik (M8) | ✅ fertig | Tauri-2-Desktop-Wrapper · Tool-Call-Agent-Loop (`list_files`/`read_file`/`write_file`) · Host-RAM/CPU/GPU-Monitoring + Routing-Achse „Host-Last“ |
| Deklaration (M9) | ✅ fertig | `plan.md`/`changelog.md`/`init.md` je Rechner und Spezialist · **`llm.md` als Datenblatt je Modell** mit eigener Ansicht „LLM-Modelle“ · Modell-Katalog mit 24 Familien · Dokumente-Ansicht mit Suche |
| GitHub (M10) | ✅ fertig | Repositories verbinden, Task-Worktrees, Diff, Commit, Push, Pull-Request |
| Orchestrierung & Betrieb (M11) | ✅ fertig | **Stufen statt Kette** (parallel über alle Rechner, gemeinsames Arbeitsverzeichnis) · **Anmeldung** mit Benutzerverwaltung · **Warmhalten** geladener Modelle · **gemessener Durchsatz** und **Eignung** als Routing-Achsen · dauerhaftes Feedback · Kontext-Budget · Schnellmodus · Fortsetzen abgebrochener Läufe |

---

## 🚀 Was heute läuft

**End-to-End-Nutzerfluss:** Anmelden → Provider verbinden → Datenblatt (`llm.md`) der entdeckten Modelle prüfen → Auftrag im Chat (Schwarm in Stufen oder Schnellmodus) oder als Task → DiriZ routet auf das beste Modell (lokal oder Cloud) → Live-Stream mit Failover → Ergebnis bewerten (1–5 Sterne) → DiriZ lernt daraus, **dauerhaft**.

**Agentik-Modus (M8):** Im Task-Composer anwählbar — das Modell arbeitet dann autonom mit den Datei-Tools `list_files`, `read_file`, `write_file` in der Task-Sandbox. Jede Operation erscheint live als ✓/✗-Zeile unter dem Stream und wird im Log protokolliert (volle Transparenz). Ein Tool-Budget (24 Schritte, per `DIRIZ_AGENT_MAX_STEPS` anpassbar) schützt vor Endlosschleifen — es begrenzt nur die Tool-Nutzung: Ist es aufgebraucht, folgt ein Abschluss-Schritt **ohne** Tools, in dem das Modell aus dem Gesammelten vollständig antworten muss; bleibt auch der stumm, fasst DiriZ den Arbeitsstand selbst zusammen. Eine abgeschnittene oder leere Antwort gibt es damit nicht. Funktioniert mit Ollama, LM Studio, OpenAI & OpenRouter.

**Dashboard:** Provider-Status, Token-Volumen & Kosten als interaktive Charts (24 h / 7 Tage), Ollama-VRAM-Auslastung pro geladenem Modell, **System-Karte (M8)** mit RAM-Balken, CPU-Last und GPU-Info (Live-Polling alle 5 s).

**Workspace:** Jede Task-Datei ist versioniert — Vorschau mit Zeilennummern und ein farbiger Diff (+/−) zwischen beliebigen zwei Versionen derselben Datei.

**Einstellungen:** Zehn Routing-Gewichte (Context-Fit, Capability-Match, Qualitäts-Prior, **Eignung**, **Rechner frei**, **Tempo (gemessen)**, Last, Kosten, Latenz, Host-Last) live anpassbar — die Engine liest sie pro Entscheidung aus der Datenbank. Dazu Parallelitäts- und GPU-Grenzen, Zeitgrenzen, Warmhalten, **Benutzerverwaltung**, Dokument-Vorlagen und JSON-Export/-Import.

**Desktop (M8):** `npm run desktop` startet die Web-UI in einer nativen Tauri-2-Fenster-Hülle (Dev: Vite; Prod: gebautes Bundle). Der Core läuft weiterhin lokal — die App ist eine schlanke Hülle ohne eigene Logik.

**Erststart:** Ein 4-Schritte-Onboarding erklärt den Workflow (überspringbar, einmalig).

---

## 🔧 Diese Iteration (24.08.2026) — M11: Orchestrierung, Tempo & Zugang

### Neu implementiert
- **`llm.md` — das Datenblatt eines Modells** (`packages/shared/src/models.ts`, Ansicht `apps/web/src/views/Models.tsx`):
  Ein Modell bekommt keinen Auftrag, sondern hat Eigenschaften. Familie, Parameter, Kontext, Quantisierung, Preis,
  Qualitätsklasse, Tempo, Fähigkeiten, Werkzeuge, „Gut für“/„Nicht geeignet für“, Voreinstellungen — ausgefüllt aus
  einem Katalog mit 24 Modellfamilien plus Heuristiken über Parameterzahl, Kontextfenster und Quantisierung.
  Fähigkeiten und Kontext sind harte Routing-Gates, die Angaben werden in die `instances`-Tabelle gespiegelt.
- **Schwarm in Stufen** (`engine.startNextChainStep`): Fachbereiche mit gleicher Stufennummer arbeiten gleichzeitig
  auf allen Rechnern; die nächste Stufe wartet auf alle Geschwister und bekommt deren Ergebnisse gebündelt.
  Alle Schritte teilen sich Arbeitsverzeichnis und Branch — niemand liest das Projekt zweimal.
- **Anmeldung** (`routes/auth.ts`, `security/auth.ts`, Migration 0015): scrypt-Passwörter, Sitzungen als Token-Hash im
  HttpOnly-Cookie, Türsteher vor allen `/api`-Routen, Benutzerverwaltung in den Einstellungen, Sperre nach
  wiederholten Fehlversuchen.
- **Warmhalten** (`execution/warmup.ts`): Ein-Token-Ping in Abständen hält geladene Modelle im Speicher.
  Rechner, die arbeiten, werden übersprungen; ein fremdes Modell wird nie verdrängt.
- **Drei neue Routing-Achsen**: **Eignung** (Stärken/Schwächen aus dem `llm.md` gegen den Prompt),
  **Rechner frei** (verteilt Aufträge über die Maschinen), **Tempo (gemessen)** (Token/s aus echten Läufen —
  in deinem Bestand liegen zwischen zwei Modellen Faktor 10).
- **Kein Token-Deckel mehr** (Migration 0014): Weder Katalog noch Spezialist setzen `maxTokens`. Eine geratene
  Obergrenze schnitt Antworten und Tool-Aufrufe mitten im Satz ab — im Agentik-Modus auch mitten im Dateiinhalt.
- **Robustheit im Agentik-Modus**: Zeitüberwachung beginnt mit jedem Schritt neu (jeder Schritt schickt den ganzen
  Verlauf erneut zur Verarbeitung), Abbruch nach drei erfolglosen Schritten, Kontext-Budget dampft alte
  Tool-Ergebnisse ein, dieselbe Datei wird nie zweimal gelesen.
- **`run_command`** (`execution/tools.ts`): Das Modell kann Programme starten und ihre Ausgabe lesen — der
  Anlass war ein Lauf, der 23 Minuten lang zehn Varianten von `verify_final.mjs` schrieb, weil er sie
  ausführen wollte. Vier Grenzen wirken zusammen: keine Shell (Argument-Liste, `shell: false`),
  Erlaubnisliste ohne Pfade, Sandbox als Arbeitsverzeichnis samt Argument-Prüfung, Frist + gekappte Ausgabe
  + magere Umgebung. `git` nur lesend. Einstellbar unter „Befehle ausführen"; je Modell abwählbar im `llm.md`.
- **Vollständiger Dateizugriff** (`execution/tools.ts`): Lesen (`list_files`, `read_file`, `search_files`,
  `file_info`), Ändern (`write_file`, `edit_file`, `append_file`, `delete_file`, `move_file`, `copy_file`,
  `make_dir`) und Ausführen (`run_command`). Der Satz ist mit Absicht vollständig: Fehlt ein Handgriff, baut
  ein Modell ihn sich schlecht nach — ohne `edit_file` schrieb es zum Ändern einer Zeile die ganze Datei neu
  (51-mal beobachtet), ohne `search_files` las es Datei für Datei, bis der Kontext voll war. Alles bleibt in
  der Sandbox; `list_files` und `search_files` überspringen `node_modules`, `dist`, `.git` & Co.; `read_file`
  liest grosse Dateien abschnittsweise. Nach jeder Änderung verwirft der Agent-Loop gemerkte Lese-Ergebnisse —
  sonst sähe ein Modell nach der eigenen Änderung noch den alten Stand.
- **Dauerhaftes Feedback** (Migration 0016): Erfolge, Fehlschläge und geglättete Bewertung überleben den Neustart.
- **Schnellmodus** im Chat (ein Spezialist, Tempo dreifach gewichtet) und **Fortsetzen** abgebrochener Läufe
  (`POST /api/tasks/:id/resume`, neue Task im selben Arbeitsverzeichnis mit dem bisherigen Stand als Vorarbeit).

### Architektur-Entscheidungen (diese Iteration)
- **Auftrag ≠ Eigenschaft:** Ein Spezialist bekommt `plan.md`, ein Modell `llm.md`. Beides zu vermischen war der
  Fehler — „Wofür wird dieses Modell eingesetzt? / Schritt 1“ ist die Sprache eines Auftrags.
- **Katalog-Werte sind Empfehlung, kein Override:** Parameter aus dem Modell-Katalog stehen als Text im Datenblatt,
  gesetzt wird nur, was jemand einträgt.
- **Warten statt scheitern:** Sind alle Rechner belegt, wartet die Task; fehlt allen Modellen eine Pflicht-Fähigkeit,
  wird das Gate gelockert — aber nie für Modelle ohne jede Fähigkeit (Einbettungs-Modelle liefern keinen Text).
- **Gemessen schlägt geraten:** Durchsatz aus echten Läufen, Fähigkeiten aus dem Provider — beides schlägt den Katalog.

---

## 🔧 Vorige Iteration (22.08.2026) — M8: Desktop & Agentik

### Neu implementiert
- **Tool-Call-Agent-Loop** (`packages/core/src/execution/agent.ts` + `tools.ts`):
  - Drei Sandbox-Tools mit JSON-Schemas; Pfad-Sicherheit doppelt abgesichert (Relativ-Pfad-Validierung + Prefix-Check)
  - Loop: Streamen → Tool-Calls sammeln → ausführen → Ergebnisse als `tool`-Messages zurückgeben → bis finale Antwort oder Tool-Budget (24) erschöpft; danach garantierter Abschluss-Schritt ohne Tools
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