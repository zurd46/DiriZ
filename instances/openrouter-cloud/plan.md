# Plan – Instanz-spezifische Ausführung

**Instanz-ID:** openrouter-cloud-001  
**Erstellt am:** 21.08.2026  
**Aktualisiert zuletzt:** 21.08.2026

## 1. Aufgabe / Task
Beschreibung der aktuellen Aufgabe, die von dieser Instanz bearbeitet wird.

## 2. Modell-Konfiguration
- **Provider-Typ:** openrouter
- **Modell-ID:** meta-llama/llama-3.1-8b-instruct:free
- **Base URL:** https://openrouter.ai/api/v1
- **Privacy-Modus:** allow-cloud (erforderlich für Cloud-Zugang)
- **System-Prompt:** Du bist ein vielseitiger Assistent mit Zugriff auf aktuelle Informationen und vielfältiges Wissen.

## 3. Ausführungsparameter
- **Temperature:** 0.7
- **Max Tokens:** 8192
- **Top P:** 0.9
- **Top K:** 50
- **Kontext-Fenster:** 32768

## 4. Routing-Entscheidung
Begründung, warum diese Instanz für die aktuelle Aufgabe gewählt wurde:
- Qualitäts-Score: hoch (aktuelle SOTA Modelle)
- Kontext-Passgenauigkeit: sehr gut für allgemeine Aufgaben
- Kosten-Prognose: niedrig (kostenlose Modelle verfügbar)

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
- ~/DiriZ/workspace/openrouter-cloud

## 8. Spezialanweisungen
Zusätzliche Konfigurationen oder Constraints für diese spezifische Instanz.

---
*Dieser Plan wird automatisch bei Task-Start und bei Änderungen der Routing-Entscheidung aktualisiert.*