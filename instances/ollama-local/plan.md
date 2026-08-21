# Plan – Instanz-spezifische Ausführung

**Instanz-ID:** ollama-local-001  
**Erstellt am:** 21.08.2026  
**Aktualisiert zuletzt:** 21.08.2026

## 1. Aufgabe / Task
Beschreibung der aktuellen Aufgabe, die von dieser Instanz bearbeitet wird.

## 2. Modell-Konfiguration
- **Provider-Typ:** ollama
- **Modell-ID:** llama3:8b
- **Base URL:** http://localhost:11434
- **Privacy-Modus:** local-only (Default)
- **System-Prompt:** Du bist ein hilfreicher Programmier-Assistent.

## 3. Ausführungsparameter
- **Temperature:** 0.7
- **Max Tokens:** 4096
- **Top P:** 1.0
- **Top K:** 40
- **Kontext-Fenster:** 8192

## 4. Routing-Entscheidung
Begründung, warum diese Instanz für die aktuelle Aufgabe gewählt wurde:
- Qualitäts-Score: hoch
- Kontext-Passgenauigkeit: optimal
- Kosten-Prognose: minimal (lokal)

## 5. Status
- **Aktueller Status:** bereit
- **Laufzeit:** 0 ms
- **Token-Nutzung:** Eingänge: 0, Ausgänge: 0

## 6. Fehler-Behandlung
- Failover-Schwelle: 2 Hops
- Circuit Breaker Status: geschlossen
- Letzter Fehler: None

## 7. Workspace-Verzeichnis
Pfad zu lokalem Workspace für diese Instanz:
- ~/DiriZ/workspace/ollama-local

## 8. Spezialanweisungen
Zusätzliche Konfigurationen oder Constraints für diese spezifische Instanz.

---
*Dieser Plan wird automatisch bei Task-Start und bei Änderungen der Routing-Entscheidung aktualisiert.*