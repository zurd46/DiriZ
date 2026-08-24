# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/de/2.0.0.html).

## Unreleased

### Added
- **GPU-Schutz im Routing:** Ein Rechner führt nie zwei **verschiedene** Modelle gleichzeitig aus — jedes zusätzliche Modell belegt eigenen Grafikspeicher, und zwei Modelle auf einer Karte bedeuten Auslagern, Ladezeiten von Minuten oder einen Absturz
  - Zwei harte Gates vor dem Scoring: „Rechner ausgelastet" (gleichzeitige Ausführungen) und „GPU-Schutz: Rechner führt bereits N Modell(e) aus". Beide schliessen nur diesen einen Rechner aus — **andere bleiben Kandidaten, die Arbeit verteilt sich automatisch**
  - Neue Einstellungen (Einstellungen → „Parallelität & GPU-Schutz", `PUT /api/settings` mit `concurrency`): Modelle je Rechner gleichzeitig (Default **1**), Aufträge je Rechner (2), Aufträge insgesamt (4). Das bisher nur deklarierte `perProvider`-Limit wird damit erstmals durchgesetzt
  - LM Studio meldet jetzt, **welche Modelle geladen sind** (`state` der nativen API) — vorher hatte DiriZ ausserhalb von Ollama keinerlei Sicht darauf. Die Ladeinfo wird vor jeder Routing-Entscheidung aufgefrischt (höchstens alle 5 s)

### Fixed
- **Die Last-Achse war invertiert:** Ein bereits geladenes Modell wurde *bestraft*, obwohl seine Nutzung keinen zusätzlichen Grafikspeicher und keinen Ladevorgang kostet. Jetzt misst der Lastfaktor, wie stark ein Rechner durch **fremde** Modelle belegt ist — geladene Modelle werden bevorzugt, was genau die Erst-Token-Zeitüberschreitungen vermeidet, die beim Modellwechsel auftreten
- **Neue Ansicht „Chat" — der einfache Einstieg:** Aufgabe in ein Textfeld schreiben, DiriZ sucht den passenden Spezialisten und arbeitet damit
  - Drei Ziele bestimmen, was der Spezialist anfassen darf: **Nur antworten** (Text, kein Dateizugriff), **Projekt anlegen** (Agentik-Modus im Workspace — er schreibt Dateien) und **Repository ändern** (Agentik-Modus im Git-Worktree eines verbundenen Repos)
  - Live-Ausgabe Token für Token, dazu der Name des automatisch gewählten Spezialisten samt Begründung, seine Dateioperationen, Failover und die erzeugten Dateien
  - Jede Chat-Nachricht ist eine ganz normale Task (`assignmentMode: "auto"`) — also unter „Tasks" mit Routing-Entscheidung und Ausführungen vollständig nachvollziehbar. Es gibt bewusst keinen zweiten Ausführungsweg, der auseinanderdriften könnte
  - „Verlauf mitsenden" hängt die letzten beiden Frage/Antwort-Paare gekürzt an den Prompt, damit Rückfragen funktionieren; abschaltbar
  - Enter sendet, Umschalt+Enter macht eine neue Zeile; ein laufender Auftrag lässt sich abbrechen
- `routing.decided` trägt jetzt die `taskId` — ohne sie kann eine Ansicht einen Live-Stream nicht ihrer eigenen Task zuordnen

### Fixed
- Der SSE-Client hatte eine **eigene Kopie der Event-Namen** und verschluckte damit `tool.call` und `task.pushed` — die Dateioperationen des Agentik-Modus erreichten die Oberfläche nie. Die Namen kommen jetzt aus dem Kontrakt (`CORE_EVENT_NAMES`)
- **Eingebautes Software-Team (Team-Katalog): 42 Spezialisten und 8 Swarms** — von der Anforderung bis zum Betrieb, beim Start automatisch angelegt
  - **Produkt & Analyse:** Requirements-Analyst, Product-Owner, Agile-Coach & Projektplaner
  - **Architektur & Design:** Software-Architekt, API-Designer, Datenbank-Architekt, UX-Designer, Accessibility-Spezialist, Tech-Lead & Mentor
  - **Implementierung:** Frontend-, Backend-, Mobile-, Desktop-, Systems-, Embedded/IoT- und Integrations-Entwickler, Build- & Tooling-Engineer, Git-Spezialist
  - **Daten & KI:** Daten-Ingenieur, Datenanalyst & BI, ML-Ingenieur, LLM- & Prompt-Ingenieur
  - **Qualität:** Code-Reviewer, Test-Engineer, E2E-Testautomatisierer, Debugging-, Refactoring- und Migrations-/Upgrade-Spezialist, Performance- und Security-Engineer
  - **Betrieb & Auslieferung:** DevOps-Engineer, Cloud- & Infrastruktur-Engineer, Site-Reliability-Engineer, Release-Manager, Datenbank-Administrator, Netzwerk- & TLS-Engineer, SecOps- & Incident-Response-Analyst, Support- & Second-Level-Engineer, FinOps- & Kosten-Spezialist
  - **Dokumentation & Governance:** Technischer Redakteur, i18n- & Lokalisierungs-Spezialist, Compliance- & Datenschutz-Spezialist
  - Jeder Spezialist kommt vollständig deklariert: Rolle (System-Prompt), ausgefülltes `plan.md` (Auftrag, Vorgehen, Leitplanken — wirksam als Arbeitsanweisung), `init.md` mit rollengerechter Temperatur und Max-Tokens (Reviewer und Security kühl, UX-Design wärmer), Pflicht- und Wunsch-Fähigkeiten sowie Privacy (Security und Datenschutz laufen `local-only`)
  - Ein Swarm je Fachbereich plus „Software-Team (komplett)“ — im Modus `swarm` wählt die Engine daraus automatisch das passende Mitglied
  - Das Seeding ist **einmalig und nicht übergriffig**: bestehende und namensgleiche eigene Spezialisten bleiben unangetastet, gelöschte Katalog-Einträge kommen nicht von selbst zurück, später ergänzte Katalog-Mitglieder werden in bestehende Swarms nachgetragen
  - Ohne Neustart nachladbar: `GET /api/agents/catalog` (was ist installiert, was fehlt), `POST /api/agents/catalog` und der Knopf „Team-Katalog laden“ auf der Seite „Spezialisten“
- **Fähigkeitsbasierte Auto-Zuordnung:** Das Scoring bewertet jetzt, ob die Fähigkeiten eines Spezialisten zur Task passen — voller Treffer gibt einen Bonus, geforderte aber ungenutzte Fähigkeiten kosten Punkte (sie verengen sonst das Routing-Gate und schließen Modelle ohne Nutzen aus). Damit setzt DiriZ den richtigen Spezialisten automatisch, statt bei mehreren Kandidaten alphabetisch zu würfeln; ein Test prüft für jeden der 42 Spezialisten einen typischen Prompt
- **GitHub-Anbindung (M10) — das volle Programm:** Repositories verbinden, pro Task pinnen, Änderungen als Diff ansehen, committen, pushen und Pull-Requests öffnen
  - **Task-Pinning:** Jede Task lässt sich an ein Repository binden. Ihr Arbeitsverzeichnis **ist** dann ein Git-Worktree auf einem eigenen Branch (`diriz/<slug>`) — das Modell schreibt also direkt im echten Projekt, und mehrere Tasks arbeiten parallel ohne sich zu stören (ein Klon, viele Worktrees)
  - **Diff-Ansicht** wie auf GitHub: Datei für Datei, mit alter und neuer Zeilennummer, Farbmarkierung, Zeilenbilanz, Erkennung von Anlegen/Löschen/Umbenennen/Binärdateien; sehr große Diffs werden gekürzt statt den Browser zu blockieren
  - **Direkt pushen:** Arbeitsbranch pushen (committet offene Änderungen auf Wunsch mit), Pull-Request öffnen (ein bereits offener wird erkannt statt als Fehler gemeldet), Rebase auf den Basis-Branch — und, ausdrücklich bestätigt, **direkt auf den Basis-Branch** pushen
  - Neue Ansicht **GitHub**: Konto per Personal Access Token verbinden, eigene Repositories auflisten und mit einem Klick anbinden, Klon-Zustand und Fehler sichtbar
  - Neue Routen: `GET/PUT/DELETE /api/github`, `GET /api/github/repos`, `GET/POST/DELETE /api/repos`, `POST /api/repos/:id/sync`, `PUT /api/tasks/:id/repo`, `GET /api/tasks/:id/git`, `GET /api/tasks/:id/git/diff`, `POST /api/tasks/:id/git/{commit,push,pull-request,rebase}` (Migration `0009_repos.sql`)
  - **Token-Sicherheit:** Der Personal Access Token liegt AES-256-GCM-verschlüsselt in der Datenbank, wird nie ausgegeben und erreicht `git` ausschließlich über Umgebungsvariablen — er steht damit weder in der Prozessliste noch in einer `.git/config` noch in einer Log-Zeile
- **Ein Prozess, ein Port:** Der Core liefert die gebaute Oberfläche jetzt selbst aus (`@fastify/static`) — `npm run serve` baut alles und startet DiriZ unter <http://127.0.0.1:8787>. Deep-Links funktionieren über einen SPA-Fallback, gehashte Assets werden dauerhaft gecacht, `index.html` nie
- **Echtes URL-Routing** in der Oberfläche: jede Ansicht hat einen Pfad (`/tasks`, `/docs`, …), Neuladen bleibt in der Ansicht, Zurück/Vorwärts funktionieren, der Browser-Tab trägt den Ansichtsnamen
- **Startbanner**: Der Core nennt beim Start Port, Datenverzeichnis, Workspace und Herkunft der Oberfläche — vorher startete er stumm. Startfehler werden übersetzt statt als Stacktrace geworfen (belegter Port nennt den Prüfbefehl und den Verdacht auf einen alten Prozess)
- **`GET /api/version`** und Anzeige des laufenden Stands in der Statusleiste — daran erkennt man sofort einen veralteten Prozess
- **Fehlergrenze (Error Boundary)**: Ein Fehler in einer Ansicht zeigt eine Karte mit Ursache und Wiederholen-Knopf, statt die ganze Oberfläche zu leeren
- **Meldungen (Toasts)**: Fehler und Erfolge erscheinen sichtbar unten rechts, statt nur in der gerade geöffneten Ansicht zu liegen
- **Mobile Navigation**: Sidebar klappt unter 860 px ein, mit Umschalter, Abdunklung und „Zum Inhalt springen"-Link
- **CI** (`.github/workflows/ci.yml`): Lint, Typecheck, Unit-Tests, Produktions-Build und ein Rauchtest, der den **gebauten** Server startet und Oberfläche wie API prüft
- **E2E gegen das gebaute Artefakt**: Playwright startet `npm run serve` mit eigenem Port und Wegwerf-Datenverzeichnis; neue Rauchtests prüfen Navigation, Deep-Links, Zurück-Button, Konsolenfehler und die Einführung
- Spezialisten (Agenten) sind jetzt **bearbeitbar** — Name, Beschreibung, System-Prompt, Fähigkeiten, Privacy und Rechner-/Modell-Pins lassen sich nachträglich ändern (Seite „Agenten“)
- Agenten-Dokumente `plan.md`, `changelog.md` und `init.md` pro Spezialist — direkt in der UI editierbar (neue Routen `GET /api/agents/:id/docs`, `PUT /api/agents/:id/docs/:kind`, Migration `0006_agent_docs.sql`)
- `init.md` setzt die Voreinstellungen des LLM-Modells (Temperature, Max-Tokens, Top-P, Stop-Wörter, System-Prompt). Neue Auflösungskette: Provider-Default ← Modell-Override ← **Agent (`init.md`)** ← Task-Override
- `changelog.md` eines Spezialisten wird bei jeder Bearbeitung automatisch mit einem Eintrag ergänzt
- Bearbeiten auf allen weiteren Seiten: Swarms (Name, Beschreibung, Mitglieder), Provider (Name, Base-URL, API-Key ersetzen/entfernen, aktiv), Modelle (Anzeigename, Kontext-Fenster, Fähigkeiten, Sprachen, Preise), Tasks (Titel, Prompt, Zuweisung, Overrides) und Prompt-Vorlagen (Name & Prompt)
- **`plan.md` ist wirksam**: Auftrag, Vorgehen und Leitplanken werden als verbindliche Arbeitsanweisung in den System-Prompt übernommen — das Modell arbeitet genau so, wie das System es deklariert. Unausgefüllte Vorlagen-Zeilen (`Schritt 1`, Titel, Erstell-Datum) filtert DiriZ heraus, damit nie Boilerplate beim Modell landet
- **Dokumente je LLM-Instanz**: jedes Modell auf jedem Rechner führt eigene `plan.md`, `changelog.md` und `init.md` — angelegt beim Entdecken, editierbar unter Provider → Modell → „📄 Dokumente“ (neue Routen `GET /api/instances/:id/docs`, `PUT /api/instances/:id/docs/:kind`, Migration `0007_instance_docs.sql`)
- **Systemweit einstellbare Vorlagen** für alle drei Dokumente, getrennt nach Rechner, LLM-Modell und Spezialist (Einstellungen → „Dokument-Vorlagen“, Platzhalter `{{name}}`, `{{datum}}`, `{{datei}}`; `PUT /api/settings` mit `docTemplates`)
- **Eigene Ansicht „Dokumente“**: alle Deklarations-Dokumente des Systems an einem Ort — Liste über alle drei Ebenen, Volltextsuche über sämtliche Inhalte (zeigt an, in welchem Dokument der Treffer steckt), Markdown-Vorschau (Bearbeiten / Geteilt / Vorschau), großes Editorfenster und Entwürfe, die beim Wechseln zwischen Dokumenten erhalten bleiben (neuer Sammel-Endpunkt `GET /api/docs`)
- **Dokumente je Rechner (Provider)**: auch die oberste Ebene führt `plan.md`, `changelog.md` und `init.md` — angelegt beim Anbinden (neue Routen `GET /api/providers/:id/docs`, `PUT /api/providers/:id/docs/:kind`, Migration `0008_provider_docs.sql`). Damit deklarieren alle drei Ebenen der Auflösungskette gleichermaßen: Rechner ← Modell ← Spezialist
- Markdown-Vorschau ohne Fremd-Abhängigkeit und ohne `dangerouslySetInnerHTML` — aus einem Dokument kann kein Markup in die Oberfläche gelangen
- Live-Vorschau im Dokument-Editor: `plan.md` zeigt, welcher Text tatsächlich an das Modell geht; `init.md` zeigt die erkannten Voreinstellungen
- `changelog.md` einer LLM-Instanz wird bei jeder Bearbeitung automatisch fortgeschrieben (wie beim Spezialisten)
- Export/Import nimmt die Agenten-Dokumente und die Dokument-Vorlagen mit
- Initial setup of instance documentation structure
- CHANGELOG.md creation for tracking changes per AI instance
- README.md enhancements for instance management guidelines

### Changed
- Auflösung der Model-Settings läuft jetzt komplett über die Dokumente: **Provider (`init.md`)** ← **Instanz (`init.md`)** ← **Agent (`init.md`)** ← Task-Override. `PATCH` auf Provider und Instanz schreibt `modelSettings` in das jeweilige `init.md` — das Dokument ist die einzige Quelle der Wahrheit
- Bestehende Overrides wandern beim Nachrüsten der Dokumente automatisch ins `init.md`, statt beim ersten Speichern verloren zu gehen
- `PATCH /api/providers/:id` validiert jetzt Base-URL und Name (vorher wurden ungültige Werte übernommen)
- Project structure updated to support per-instance readme and changelog files

### Deprecated
- None

### Removed
- None

### Fixed
- **Der Chunk-Timeout traf die Zeit bis zum ersten Token.** 60 Sekunden gelten sinnvollerweise für die Pause *zwischen* zwei Tokens — bis zum *ersten* lädt der Server womöglich erst das Modell und verarbeitet den ganzen Prompt, was bei großen Modellen Minuten dauert. Beides ist jetzt getrennt (`firstChunkMs`, Default 5 min, gegenüber `chunkMs` mit 60 s) und über `DIRIZ_FIRST_CHUNK_MS`, `DIRIZ_CHUNK_MS` und `DIRIZ_TOTAL_MS` einstellbar. Die Fehlermeldung benennt jetzt auch, welcher der beiden Fälle eingetreten ist
- **LM-Studio-Discovery meldete für jedes Modell 8192 Tokens Kontext.** Abgefragt wurde nur der OpenAI-kompatible Endpunkt `/v1/models`, der keine Kontextgröße liefert — also griff überall der Fallback. DiriZ nutzt jetzt zuerst LM Studios native API `/api/v0/models` und übernimmt von dort die echte Kontextgröße, die Quantisierung sowie erkennbare Fähigkeiten (Vision, Code); Embedding-Modelle werden aussortiert, weil sie nicht chatten können. Ältere LM-Studio-Versionen fallen weiterhin auf `/v1/models` zurück
- Die Kontextgröße wird zusätzlich aus den Schreibweisen anderer Server gelesen (`context_length`, `max_context_length`, `max_model_len`, `context_window`, `n_ctx`)
- **Die Kontext-Schätzung des Routings ignorierte den System-Prompt.** Gerechnet wurde nur mit dem Task-Prompt — seit `plan.md` als Arbeitsanweisung mitgeschickt wird, fehlten dadurch mehrere tausend Tokens, und das Context-Gate ließ zu kleine Modelle durch. System-Prompt und `plan.md` des Spezialisten zählen jetzt mit
- **Code-Blöcke in `plan.md` wurden beim Übernehmen zerstört:** Die ```` ``` ````-Zeile galt nach dem Entfernen der Markdown-Deko als leer und flog heraus, wodurch der Block aufbrach. Code-Blöcke werden jetzt unverändert durchgereicht
- **Gliederungs-Überschriften verschwanden aus der Arbeitsanweisung**, wenn direkt eine Unterüberschrift folgte (`# 2. Phasen` gefolgt von `## Phase 1`). Nur noch wirklich leere Abschnitte fallen weg
- Das Arbeitsverzeichnis einer Task hing vom Pin-Zustand ab und wanderte damit beim Pinnen — der frisch angelegte Worktree lag dann woanders als der Arbeitsstand. Der Pfad ist jetzt über die gesamte Lebensdauer stabil
- Gleichzeitiges Klonen und Synchronisieren desselben Repositories ließ den zweiten Aufruf scheitern; Synchronisierungen laufen jetzt pro Repository serialisiert
- `vitest run` an der Wurzel brach ab, weil es die Playwright-Dateien einsammelte („Playwright Test did not expect test() to be called here"). Neue `vitest.config.ts` trennt Unit- und E2E-Tests sauber
- Die Einführung ließ sich nur mit der Maus schließen — jetzt schließt Escape sie, und der Dialog nimmt beim Öffnen den Fokus
- System-Prompt-Auflösung: das Agenten-Feld überschrieb bisher **jeden** anderen System-Prompt — ein Task-Override oder ein `## System-Prompt` aus `init.md` wurde stillschweigend verworfen. Jetzt gilt durchgängig „späterer Eintrag gewinnt“ (Provider ← Instanz ← Agent-`init.md` ← Agenten-Feld ← Task)
- LM Studio Provider: Base-URLs ohne Versions-Pfad werden jetzt automatisch mit `/v1` ergänzt — zuvor antwortete LM Studio auf unbekannte Endpunkte (z. B. `GET /models`) mit HTTP 200 + Fehler-JSON, was als „online, aber 0 Modelle“ durchging und Routing scheitern ließ („Keine Instanz verfügbar“)
- OpenAI-kompatibler Adapter: `listModels()` meldt Antworten ohne Modellliste (z. B. 200 + Fehler-JSON) jetzt als Fehler statt einer leeren Liste — der Health-Check zeigt solche Endpunkte nicht mehr fälschlich als „online“ an

---

# DiriZ - Visuelles Orchestrierungssystem für lokale LLM-Systeme

**Version:** 0.1  
**Status:** Plan-Phase (Entwurf v0.1)  
**Letzte Aktualisierung:** 21.08.2026

---

## Vision

**DiriZ** (von *Dirigent*) ist ein lokal laufendes, visuelles Steuerungssystem – ein „Control Tower“ – für alle verfügbaren LLM-Backends:

- **Lokale Instanzen:** Ollama, LM Studio sowie jeder OpenAI-kompatible Server (vLLM, llama.cpp server, GPT4All, LocalAI, koboldcpp, …)
- **Cloud-APIs:** OpenRouter (Kern), OpenAI (optional)

## Kernversprechen in vier Punkten:

1. **Eine Eingabe** – Der Nutzer formuliert eine Aufgabe (Prompt) mit optionalen Metadaten.
2. **Automatische Zuweisung** – DiriZ analysiert die Aufgabe, bewertet alle verfügbaren Instanzen (lokal + Cloud) und wählt die beste.
3. **Automatische Ausführung** – Die Aufgabe wird gestreamt ausgeführt; bei Fehlern erfolgt automatisches Failover auf die nächste Instanz.
4. **Volle Transparenz** – Jeder Schritt ist beobachtbar: Token-Stream, die Routing‑Entscheidung („Warum dieses Modell?“), Token-/Kostennutzung, Laufzeit, erzeugte Dateien, Logs.

---

## Dokumentation

- [01 – Gesamter Plan, Architektur & Roadmap](docs/01-plan.md)
- [STATUS – Aktueller Entwicklungsstand](docs/STATUS.md)
- [CHANGELOG – Versionsgeschichte](#changelog)

---

## Status

Plan-Phase (Entwurf v0.1). Die Implementierung startet mit Meilenstein M0 (Setup) – siehe Plan, §15.
