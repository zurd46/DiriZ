/**
 * LM Link: Welches Modell rechnet auf **welchem** Rechner?
 *
 * ## Warum das nötig ist
 *
 * LM Studio kann Modelle über „LM Link" von einer anderen Maschine
 * durchreichen. Der Endpunkt bleibt `127.0.0.1:1234`, gerechnet wird aber
 * anderswo. DiriZ zeigte deshalb „nvidia-nemotron … auf MacDani" für ein
 * Modell, das auf `LokalAI_Server1` lief — eine Anzeige, die beim Suchen nach
 * Engpässen in die Irre führt.
 *
 * ## Warum über die Kommandozeile
 *
 * Nicht aus Bequemlichkeit: Die HTTP-API von LM Studio kennt das Gerät nicht.
 * `/api/v0/models` liefert Zustand, Kontext und Quantisierung — kein Feld
 * nennt die Maschine, und `/api/v0/link`, `/api/v0/devices`, `/api/v0/system`
 * gibt es nicht (nachgeprüft). Der `lms`-Befehl weiss es, und er liegt auf
 * demselben Rechner wie der Core.
 *
 * ## Grenzen
 *
 * Nur für **lokale** Endpunkte: Über einen Tunnel befragt `lms` den falschen
 * Rechner — den eigenen. Schlägt etwas fehl (kein LM Studio installiert,
 * andere Version, veränderte Ausgabe), bleibt alles wie zuvor: Dann steht eben
 * der Provider-Name da. Eine Zusatzauskunft darf nie die Modellerkennung
 * gefährden.
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Frist je Aufruf — die Auskunft ist Beiwerk, sie darf nichts aufhalten. */
const TIMEOUT_MS = 4000

/** So lange gilt die Auskunft als frisch. Geräte wechseln nicht im Sekundentakt. */
const CACHE_MS = 60_000

let cache: { at: number; devices: Map<string, string> } | undefined

/** Ist dieser Endpunkt der Rechner, auf dem DiriZ läuft? */
export function isLocalEndpoint(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
	} catch {
		return false
	}
}

/** Pfad zum `lms`-Befehl, sofern vorhanden. */
function lmsPfad(): string | undefined {
	const kandidaten = [
		process.env.DIRIZ_LMS_PATH,
		path.join(os.homedir(), ".lmstudio", "bin", "lms"),
		path.join(os.homedir(), ".cache", "lm-studio", "bin", "lms"),
	].filter((p): p is string => Boolean(p))
	return kandidaten.find((p) => {
		try {
			return fs.statSync(p).isFile()
		} catch {
			return false
		}
	})
}

interface LmsModel {
	modelKey?: string
	deviceIdentifier?: string | null
}

/**
 * Liest die Zuordnung Modell → Gerätename.
 *
 * Zwei Aufrufe, weil LM Studio sie getrennt hält: `ls --json` nennt je Modell
 * eine Geräte-Kennung (oder `null` für „hier"), `link status` übersetzt die
 * Kennungen in Namen und nennt den eigenen Rechner.
 */
export async function readDeviceMap(): Promise<Map<string, string>> {
	if (cache && Date.now() - cache.at < CACHE_MS) {
		return cache.devices
	}
	const lms = lmsPfad()
	const devices = new Map<string, string>()
	if (!lms) {
		cache = { at: Date.now(), devices }
		return devices
	}
	try {
		const [liste, status] = await Promise.all([
			run(lms, ["ls", "--json"], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }),
			run(lms, ["link", "status"], { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 }),
		])
		// `lms link status` schreibt seine Auskunft auf **stderr**, nicht auf
		// stdout — jedenfalls ohne Terminal. Gemessen, nicht vermutet: Über
		// `execFile` kam stdout leer zurück und der ganze Text auf stderr.
		// Deshalb beide lesen; welcher Kanal es ist, darf uns egal sein.
		const { eigener, namen } = parseLinkStatus(`${status.stdout}\n${status.stderr}`)
		for (const m of JSON.parse(liste.stdout) as LmsModel[]) {
			if (!m.modelKey) {
				continue
			}
			// `null` heisst: liegt auf diesem Rechner. Ein fremdes Gerät gewinnt,
			// falls dasselbe Modell doppelt geführt wird — der Speicher, der bei
			// einer Verdrängung leidet, ist der des fremden Rechners.
			const name = m.deviceIdentifier ? (namen.get(m.deviceIdentifier) ?? "LM Link") : eigener
			if (name && (!devices.has(m.modelKey) || m.deviceIdentifier)) {
				devices.set(m.modelKey, name)
			}
		}
	} catch {
		// Kein LM Studio, andere Version, veränderte Ausgabe — dann eben nicht.
	}
	cache = { at: Date.now(), devices }
	return devices
}

/**
 * Zerlegt die Ausgabe von `lms link status`.
 *
 * ```
 * This device: MacBook-Pro-von-Daniel.local
 *   - LokalAI_Server1
 *     Identifier: dc6370d36a292bacd8e25a52652e3b70
 * ```
 */
export function parseLinkStatus(text: string): { eigener?: string; namen: Map<string, string> } {
	const namen = new Map<string, string>()
	const eigener = text.match(/^This device:\s*(.+)$/m)?.[1]?.trim()
	const zeilen = text.split(/\r?\n/)
	let letzterName: string | undefined
	for (const zeile of zeilen) {
		const name = zeile.match(/^\s*-\s+(\S.*)$/)?.[1]?.trim()
		// Die Modell-Liste unter „Loaded Models Instances" sieht wie ein Gerät
		// aus. Sie zählt nicht: Nur ein Name, auf den eine Kennung folgt, ist
		// ein Gerät.
		if (name && !/^Status:/.test(name)) {
			letzterName = name
			continue
		}
		const kennung = zeile.match(/^\s*Identifier:\s*([0-9a-f]{8,})\s*$/i)?.[1]
		if (kennung && letzterName) {
			namen.set(kennung, letzterName)
			letzterName = undefined
		}
	}
	return { eigener, namen }
}

/** Nur für Tests: den Zwischenspeicher leeren. */
export function resetDeviceCache(): void {
	cache = undefined
}
