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
| **Anmeldung** | Benutzername und Passwort, verwaltbar in den Einstellungen. Ohne gültige Sitzung beantwortet der Core **keine** Anfrage (ausser Health und Version). Passwörter als scrypt-Hash mit eigenem Salt, Sitzungen als Hash ihres Tokens im HttpOnly-Cookie — die Datenbank enthält nichts, womit man sich anmelden könnte |
| **Routing** | Mehrachsen-Scoring: Context-Fit, Capability-Match, **Eignung** (Stärken/Schwächen aus dem `llm.md`), Qualitäts-Prior, **freier Rechner** (verteilt die Arbeit über alle Maschinen), **gemessenes Tempo** (Token/s aus echten Läufen), Last, Kosten, Latenz, Host-Last — mit harten Policies: Privacy `local-only`, Budget-Gate, Context-Gate, Pinned-Mode. Jede Entscheidung nachvollziehbar erklärt |
| **Ausführung** | Streaming-Live-View, Failover-Kette bei Provider-Ausfall, Abbruch, Concurrent-Limits, Token-/Kosten-Tracking |
| **Agentik** | Opt-in pro Task: Das Modell arbeitet autonom mit `list_files` / `read_file` / `write_file` / **`run_command`** in der Sandbox — jede Operation live sichtbar & geloggt. Mit `run_command` prüft es seine Arbeit wirklich, statt Prüfskripte zu schreiben, die niemand ausführt — **ohne Shell**, nur erlaubte Programme, nur im Task-Ordner, `git` nur lesend, mit Frist und gekappter Ausgabe (einstellbar). Kein Token-Deckel: Was eine Antwort braucht, entscheidet die Aufgabe, die Grenze ist die Laufzeit. Gegen Steckenbleiben zwei Reissleinen: Abbruch nach drei Schritten in Folge ohne erfolgreiche Tool-Operation, und ein Kontext-Budget, das alte Tool-Ergebnisse eindampft, bevor jeder Schritt langsamer wird als der vorige. Dieselbe Datei wird nie zweimal gelesen |
| **Schwarm in Stufen** | Mehrere Spezialisten an einem Auftrag: Was fachlich nebeneinander liegt (bauen und Datenarbeit, prüfen und dokumentieren), läuft **gleichzeitig** auf allen angebundenen Rechnern; die nächste Stufe beginnt, wenn die vorige fertig ist. Alle Schritte teilen sich Arbeitsverzeichnis und Branch — niemand liest das Projekt zweimal |
| **Warmhalten** | Ein Ein-Token-Ping in Abständen hält geladene Modelle im Speicher. Ein kaltes 30-B-Modell kostet beim ersten Aufruf Minuten — Rechner, die gerade arbeiten, werden übersprungen, ein fremdes Modell nie verdrängt |
| **Monitoring** | Dashboard mit Metriken-Karten, 24 h/7-Tage-Charts (Tokens, Requests, Kosten), Ollama-VRAM-Load, System-Karte (Host-RAM/CPU/GPU), Live-Logs, Statusleiste |
| **Workspace** | Versionierte Task-Dateien: Baum-Ansicht, Vorschau mit Zeilennummern, farbiger Diff zwischen beliebigen zwei Versionen |
| **Feedback** | 1–5-Sterne-Ratings pro Execution → exponentiell glättender Qualitäts-Prior, **dauerhaft in der Datenbank**: Gelerntes überlebt den Neustart |
| **GitHub** | Repositories verbinden und **pro Task pinnen**: Die Task arbeitet in einem eigenen Git-Worktree auf eigenem Branch, Änderungen erscheinen als Diff mit Zeilennummern, und lassen sich committen, pushen oder als Pull-Request öffnen — auf Wunsch auch direkt auf den Basis-Branch |
| **Deklaration** | **Rechner und Spezialist** führen `plan.md`, `changelog.md` und `init.md`: `plan.md` wird zur verbindlichen Arbeitsanweisung im System-Prompt, `init.md` setzt die Model-Parameter — Tab **Dokumente**, mit Vorschau und Volltextsuche |
| **Modell-Datenblatt** | Ein **Modell** hat keinen Auftrag, sondern Eigenschaften: `llm.md` (Tab **LLM-Modelle**) beschreibt Familie, Fähigkeiten, Kontext, Werkzeuge, Stärken, Schwächen und Voreinstellungen. Fähigkeiten und Kontext sind harte Routing-Gates, „Gut für"/„Nicht geeignet für" bewegen die Eignungs-Achse, `## Werkzeuge` regelt den Agentik-Modus. Beim Entdecken eines Modells füllt ein eingebauter Katalog das Blatt aus — als Vermutung, gekennzeichnet und korrigierbar |
| **Spezialisten** | Agenten (System-Prompt + Capability-Anforderungen) und Swarms; Auto-Zuordnung per Prompt-Match oder feste Zuweisung |
| **Sicherheit** | Local-first: Cloud nur auf Wunsch. API-Keys AES-256-GCM-verschlüsselt in der DB, nie im Klartext zurückgegeben. Anmeldepflicht mit Sperre nach wiederholten Fehlversuchen |

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

**Erster Start:** Beim ersten Aufruf legst du den ersten Benutzer an — Benutzername und Passwort deiner Wahl. Es gibt kein voreingestelltes Konto; ein Standardpasswort, das jemand stehen lässt, wäre schlimmer als keines. Weitere Benutzer kommen unter **Einstellungen → Benutzer** dazu.

**Erste Task:**
1. Tab **Provider** → Ollama hinzufügen (`http://localhost:11434`) — Modelle werden automatisch entdeckt
2. Tab **LLM-Modelle** → Datenblatt (`llm.md`) prüfen: Fähigkeiten, Stärken, Schwächen. Es ist vorausgefüllt, aber geraten — was du korrigierst, wirkt sofort im Routing
3. Tab **Dokumente** → in `plan.md` des Spezialisten deklarieren, wie gearbeitet werden soll (wirkt direkt im System-Prompt)
4. Tab **Chat** oder **Tasks** → Auftrag eingeben und starten. Im Chat wählen: **Swarm** (mehrere Spezialisten in Stufen) oder **Schnell** (einer, auf dem nachweislich schnellsten Modell)
5. Ergebnis im Live-Stream verfolgen und mit Sternen bewerten — die Bewertung steuert künftige Auswahlen

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
| `DIRIZ_FIRST_CHUNK_MS` | `300000` | Frist bis zum ersten Token — deckt Modell laden und Prompt verarbeiten ab |
| `DIRIZ_CHUNK_MS` | `180000` | Frist zwischen zwei Token. Im Agentik-Modus beginnt sie mit jedem Schritt neu: Jeder Schritt schickt den ganzen Verlauf erneut zur Verarbeitung |
| `DIRIZ_TOTAL_MS` | `900000` | Gesamtdauer einer Ausführung (im Agentik-Modus verdreifacht) |

**Desktop-App (optional):**
```bash
npm run serve    # Core starten — das Fenster zeigt auf ihn
npm run desktop  # Tauri-Fenster um dieselbe Oberfläche
```
Das Fenster lädt `http://127.0.0.1:8787`, nicht ein eigenes Bundle: Nur so gilt
die Anmeldung (das Sitzungs-Cookie gehört der Herkunft des Cores), und es gibt
nur **eine** Oberfläche statt einer zweiten, die still veraltet. Details in
[`apps/desktop/README.md`](apps/desktop/README.md).

## 📁 Projektstruktur

```
DiriZ/
├── apps/web/                  # React-UI (Vite, Zustand, SSE-Live-Events)
│   └── src/views/             # Dashboard · Chat · Provider · LLM-Modelle · Agenten · Tasks · Dokumente · GitHub · Workspace · Logs · Einstellungen
├── apps/desktop/              # Tauri-2-Desktop-Hülle (M8): `npm run desktop`
├── packages/core/             # Fastify-Core: API, Engine, Routing, DB
│   ├── db/migrations/         # SQLite-Migrationen (0001–0016)
│   └── src/
│       ├── execution/         # ExecutionEngine, Failover, Event-Bus, Agent-Loop + Sandbox-Tools, Warmhalten
│       ├── git/               # GitHub-Anbindung: git-Hülle, Worktrees, Diff-Parser, REST-Client
│       ├── monitoring/        # Host-RAM/CPU/GPU-Metriken (M8)
│       ├── providers/         # Adapter: Ollama · LM Studio · OpenAI(-Compat) · OpenRouter
│       ├── routing/           # Profil-Extraktion · Policies · Scoring · Feedback-Prior
│       ├── security/          # API-Key-Verschlüsselung · Passwort-Hashing & Sitzungen
│       └── routes/            # REST-API (auth, tasks, providers, agents, instances, docs, metrics, …)
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
| Anmeldung vergessen | Die Benutzer stehen in `~/.diriz/diriz.sqlite`. Ohne Zugang hilft nur: `sqlite3 ~/.diriz/diriz.sqlite "DELETE FROM users;"` — danach fragt DiriZ beim nächsten Aufruf wieder nach dem ersten Benutzer. |
| Ein Lauf dauert ewig | Tab **LLM-Modelle** → gemessenes Tempo vergleichen. Ein 27-B-Modell schreibt leicht 13 Token/s, ein MoE-Modell mit wenigen aktiven Parametern das Zehnfache. Für kleine Korrekturen im Chat **Schnell** wählen. |
| `Failed to load model … Engine protocol startup was aborted` | Der Server konnte das Modell nicht laden — meist, weil noch ein anderes im Speicher liegt. DiriZ sperrt dieses Modell dann 10 Minuten und weicht auf ein **bereits geladenes** aus. Damit der Wechsel überhaupt gelingt, muss LM Studio das alte Modell räumen dürfen: *Developer → Server Settings → **Auto-evict previously loaded models*** einschalten (bzw. „Max loaded models" auf 1). Sonst versucht LM Studio, beide gleichzeitig zu halten, und beide scheitern. |
| Modell schreibt endlos Prüfskripte | Es will sie ausführen. Einstellungen → **Befehle ausführen** einschalten, und im Datenblatt des Modells muss `run_command` unter `## Werkzeuge` stehen. |
| Lauf bleibt stehen | Der **Fortsetzen**-Knopf an der Antwort legt eine neue Task im selben Arbeitsverzeichnis an, mit dem bisherigen Stand als Vorarbeit. |

## 📚 Dokumentation

- [**STATUS.md**](docs/STATUS.md) — aktueller Stand, abgeschlossene Meilensteine M0–M8
- [**01-plan.md**](docs/01-plan.md) — vollständiger Architekturplan: Routing-Achsen, Policies, Datenmodell, Roadmap M0–M8

## 📄 Lizenz

Privates Projekt. Alle Rechte vorbehalten.