# Plan – Instanz-spezifische Ausführung

**Instanz-ID:** lmstudio-ngrok-001  
**Erstellt am:** 21.08.2026  
**Aktualisiert zuletzt:** 21.08.2026

## 1. Aufgabe / Task
Beschreibung der aktuellen Aufgabe, die von dieser Instanz bearbeitet wird.

## 2. Modell-Konfiguration
- **Provider-Typ:** lmstudio
- **Modell-ID:** mixtral-8x7b-instruct-v0:1
- **Base URL:** http://localhost:1234/v1 (via NGrok Tunnel)
- **Privacy-Modus:** allow-cloud (optional für spezifische Aufgaben)
- **System-Prompt:** Du bist ein kreativer Schreib-Assistent mit Fokus auf Storytelling.

## 3. Ausführungsparameter
- **Temperature:** 0.85
- **Max Tokens:** 2048
- **Top P:** 0.95
- **Top K:** 50
- **Kontext-Fenster:** 16384

## 4. Routing-Entscheidung
Begründung, warum diese Instanz für die aktuelle Aufgabe gewählt wurde:
- Qualitäts-Score: mittel-hoch
- Kontext-Passgenauigkeit: gut für kreative Aufgaben
- Kosten-Prognose: moderat (Cloud-Anbieter)

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
- ~/DiriZ/workspace/lmstudio-ngrok

## 8. Spezialanweisungen
Zusätzliche Konfigurationen oder Constraints für diese spezifische Instanz.

---
*Dieser Plan wird automatisch bei Task-Start und bei Änderungen der Routing-Entscheidung aktualisiert.*