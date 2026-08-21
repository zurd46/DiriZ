# DiriZ Entwicklung Status

## Aktueller Stand: Nach M1 (März 2026)

Dieses Dokument fasst den aktuellen Entwicklungsstand zusammen und zeigt auf, was bereits erledigt ist und was noch offen steht.

---

## ✅ Erledigt (M0 & M1)

### M0 - Grundlagen
- [x] Monorepo-Einrichtung mit npm workspaces
- [x] SQLite-Datenbank (`packages/core/src/db/`)
- [x] TypeScript-Konfiguration für Core und Web-App
- [x] `npm run dev` funktioniert lokal
- [x] Lint, Build und Type-Check alle "green"

### M1 - Provider & Agenten (Kern-Funktionalität)
- [x] **Provider-Layer**: Ollama, LM Studio, OpenAI-compatible Models
- [x] **Agent/Swarm-Zuweisung**: `assignmentMode` (auto/agent/swarm)
- [x] **Model Merge Chain**: Kombiniert mehrere Model-Anbieter zu einem Logical Model
- [x] **70+ Tests bestehen** im Test-Suite
- [x] **Live Smoke Test** erfolgreich verlaufen

---

## 🔄 In Bearbeitung / Teilweise Implementiert

### M2 Q4 - System-Prompt-Templates ("Senior-Dev", "Kritischer Reviewer")
- [x] **State-Variablen hinzugefügt**: `templates`, `editingTemplate`, `newTemplateName`, `newTemplatePrompt` in `apps/web/src/views/Tasks.tsx`
- [ ] **UI-Integration**: Template-Auswahl-Dropdown im Task-Formular
- [ ] **Template CRUD**: Create/Read/Update/Delete-Funktionalität für Prompt-Templates
- [ ] **Integration mit Task-Form**: Templates sollen das `systemPrompt`-Feld vorbefüllen

**Status**: State wurde hinzugefügt, UI-Integration benötigt weitere Arbeit. Direkte JSX-Edits erwiesen sich als fehleranfällig.

### M3 - Routing-Preview (Dry-Run): Entscheidung vor Ausführung anzeigen
- [x] **Backend-Funktion**: `routeTaskWithoutExecution(db: Db, task: Task): RoutePreviewResult` in `packages/core/src/db/repositories.ts` hinzugefügt (nach `latestDecision`, Zeile ~676)
- [x] **API-Route**: `/:id/route-preview` in `packages/core/src/routes/tasks.ts` definiert
- [x] **Scoring-Logik**: Nutzt `DEFAULT_WEIGHTS` aus `packages/shared/src/scoring.ts` (contextFit, capabilityMatch, costScore, latencyScore)
- [ ] **TypeScript-Typen**: Fehler aufgrund fehlender Imports und Schema-Property-Namens-Diskrepanzen (`context_window` vs `contextWindow`, `price_in_per_mtok` vs `pricePerMTok`)
- [ ] **UI-Preview-Komponente**: Komponente, die das Routing-Ergebnis anzeigt (Score-Aufschlüsselung, Exclusions)

**Status**: Backend-Funktion implementiert und Route definiert, aber Typ-Integration und UI-Preview fehlen noch.

---

## 📋 Offene Roadmap-Items (Aus `docs/01-plan.md`)

| Meilenstein | Item | Status |
|------------|------|--------|
| **M2 Q4** | System-Prompt-Templates verwalten | Teilweise implementiert (State da, UI fehlt) |
| **M3** | Routing-Preview (Dry-Run): User sieht routing decision vor Execution mit Score-Breakdown und Exclusion-Reasons | Backend-Funktion da, UI Preview fehlt |
| **M4** | Cloud-Integration (Supabase / AWS RDS) | Nicht begonnen |
| **M5** | Cost-Tracking & Budget-Oberwachung | Nicht begonnen |
| **M6** | Webhook-Benachrichtigungen | Nicht begonnen |
| **M7** | Multi-Tenant Isolation | Nicht begonnen |
| **M8** | CLI-Tool für Adminsitrations-Aufgaben | Nicht begonnen |

---

## 🔧 Technische Hinweise

### TypeScript-Fehler (offen)
Die folgenden Dateien haben Typ-Integrations-Probleme, die gelöst werden müssen:

1. `packages/core/src/db/repositories.ts` - `routeTaskWithoutExecution` Funktion referenziert Typen wie `CandidateScore`, `RoutePreviewResult`, `DEFAULT_WEIGHTS`, und nutzt Property-Namen, die möglicherweise nicht mit der Datenbank-Schema-Definition übereinstimmen.

2. `apps/web/src/views/Tasks.tsx` - Neue State-Variablen für Templates wurden hinzugefügt, aber die UI-Komponenten (Dropdowns, Forms) fehlen noch oder haben JSX-Struktur-Probleme.

### Nächste Schritte Empfehlung

1. **Für System-Prompt-Templates (M2 Q4)**: Vereinfachte UI - vielleicht nur ein Template-Selektor, der das `systemPrompt`-Feld vorbelegt, ohne volle CRUD zunächst.

2. **Für Routing-Preview (M3)**: Einfacher API-Aufruf in der UI, der die Preview-Daten anzeigt, ohne die volle gewichtete Formel lokal reproduzieren zu müssen.

3. **Alternative Approach**: Anstelle direkter `Tasks.tsx` Bearbeitung via Pattern-Matching, könnte ein neuer Bestandteil oder File erstellt werden, das die Template/Preview-Funktionalität hinzufügt.

---