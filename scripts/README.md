# Manuelle Live-Tests

Einmalige Diagnose-Skripte gegen **echte** lokale Backends (LM Studio auf
`http://127.0.0.1:1234`). Sie gehören bewusst nicht in die Unit-Tests — die
laufen gegen Mocks — und sind aus dem Lint-Pfad ausgeschlossen
(`biome.json` → `files.includes`), weil sie als Werkbank dienen dürfen.

| Skript | Zweck |
|--------|-------|
| `live-500.mjs` | Rekonstruiert die Anfrage, die LM Studio mit HTTP 500 beantwortet, und zeigt die vollständige Fehlerantwort |
| `live-abfolge.mjs` | Zwei Anfragen unmittelbar nacheinander (wie Stufe 1 → Stufe 2 eines Schwarms) |
| `live-chain.mjs` | Echte Kette der ganzen Stufen: Routing → Agentik → Übergabe, mit eigener DB und eigenem Workspace |

**Voraussetzung:** gebauter Core (`npm run build`) und ein laufender LM-Studio-Server.

```bash
node scripts/live-chain.mjs   # LAUT=1 zeigt alle Log-Zeilen
```
