# DiriZ Desktop

Eine native Fenster-Hülle (Tauri 2) um dieselbe Oberfläche, die auch der Browser
zeigt. Keine eigene Logik, kein zweiter Server.

## Warum das Fenster auf den Core zeigt

Das Fenster lädt **`http://127.0.0.1:8787`** — die Oberfläche also vom laufenden
Core, nicht aus dem mitgelieferten Bundle. Das ist eine bewusste Entscheidung:

* **Die Anmeldung funktioniert.** Die Sitzung liegt in einem HttpOnly-Cookie für
  die Herkunft des Cores. Lüde das Fenster die Oberfläche aus dem Bundle
  (`tauri://localhost`), wäre jede API-Anfrage herkunftsfremd — das Cookie
  bliebe zu Hause, und man käme nie über den Anmeldebildschirm hinaus.
* **Es gibt nur eine Oberfläche.** Ein mitgebautes Bundle wäre eine zweite
  Kopie, die still veraltet, sobald der Core neu gebaut wird.

Der Preis: **Der Core muss laufen** (`npm run serve`). Tut er das nicht, zeigt
das Fenster einen Verbindungsfehler — dieselbe Meldung wie ein Browser.

## Betrieb

```bash
npm run serve      # Core starten (liefert Oberfläche und API auf :8787)
npm run desktop    # Fenster öffnen
```

In der Entwicklung nutzt Tauri stattdessen den Vite-Server (`devUrl`,
`http://localhost:5173`) mit Hot-Reload; dessen Proxy leitet `/api` an den Core
weiter, und weil der CORS mit `credentials` erlaubt, funktioniert auch dort die
Anmeldung.

## Anderer Port

Läuft der Core woanders (`DIRIZ_PORT=8788`), muss die URL in
`src-tauri/tauri.conf.json` (`app.windows[0].url`) mitgezogen werden.
