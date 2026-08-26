/**
 * T1-3 Router-Modell (Kaskade 2, `01-plan.md` §6.1).
 *
 * Wenn die Heuristik aus `profile.ts` unsicher ist — und das Router-Modell
 * ist aktiviert — klassifiziert ein kleines lokales Modell den Auftrag und
 * liefert strukturiertes JSON. Das ist ein **eigener, kurzer Provider-Call**
 * (kein Teil der Task, kein Streaming, keine Failover-Kette): wenige hundert
 * Tokens, harte Frist, und bei jedem Fehler (Timeout, Offline, kaputtes JSON)
 * fällt die Kaskade schlicht auf die Heuristik zurück. Routing darf nie an
 * dem Router scheitern.
 *
 * Einstellungen: `settings.routerModel` — Provider + Modell, Timeout,
 * Mindest-Konfidenz. Default ist **aus**; die Heuristik bleibt der Weg.
 */
import type { Capability, LLMProvider } from "@diriz/shared"

/** Einstellungen des Router-Modells (`settings.routerModel`). */
export interface RouterModelSettings {
	/** Opt-in: ohne aktivierte Auswahl bleibt alles bei der Heuristik. */
	enabled: boolean
	providerId?: string
	modelId?: string
	/** Harte Frist für den ganzen Call (ms). */
	timeoutMs: number
	/**
	 * Mindest-Konfidenz (0–1): Ein Router-Ergebnis mit geringerer
	 * Selbstsicherheit wird verworfen, wenn die Heuristik ohnehin
	 * etwas gefunden hat — sonst würde ein zögerndes Modell ein gutes
	 * heuristisches Profil verwässern.
	 */
	minConfidence: number
}

/** Default: aus. Die Heuristik ist deterministisch und kostet nichts. */
export const DEFAULT_ROUTER_MODEL: RouterModelSettings = {
	enabled: false,
	timeoutMs: 30_000,
	minConfidence: 0.5,
}

/** Das strukturierte Ergebnis des Router-Modells. */
export interface RouterAnalysis {
	/** Pflicht-Fähigkeiten — werden harte Gates im Routing. */
	required: Capability[]
	/** Bonus-Fähigkeiten — nur Scoring-Bonus. */
	preferred: Capability[]
	/** Langformat-Auftrag (Bonus-Ability, nicht Pflicht). */
	longform: boolean
	/** Selbstsicherheit des Modells (0–1). */
	confidence: number
}

const KNOWN_CAPABILITIES: readonly Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]

/**
 * Parst die Modellantwort: JSON zwischen (möglichen) Text-Randspalten,
 * nur bekannte Fähigkeiten, Konfidenz geklemmt auf [0, 1].
 * Gibt `undefined` zurück, wenn die Antwort nicht verwertbar ist.
 */
export function parseRouterResponse(text: string): RouterAnalysis | undefined {
	// JSON-Block rausschneiden — Modelle umhüllen das gern mit Worten oder
	// Markdown-Zaunen, beides ist uns egal.
	const match = text.match(/\{[\s\S]*\}/)
	if (!match) {
		return undefined
	}
	let raw: unknown
	try {
		raw = JSON.parse(match[0])
	} catch {
		return undefined
	}
	if (typeof raw !== "object" || raw === null) {
		return undefined
	}
	const obj = raw as Record<string, unknown>
	const aus = (value: unknown): Capability[] => {
		if (!Array.isArray(value)) {
			return []
		}
		const result: Capability[] = []
		for (const v of value) {
			if (
				typeof v === "string" &&
				KNOWN_CAPABILITIES.includes(v as Capability) &&
				!result.includes(v as Capability)
			) {
				result.push(v as Capability)
			}
		}
		return result
	}
	const confidence =
		typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
			? Math.min(1, Math.max(0, obj.confidence))
			: 0.5
	return {
		required: aus(obj.required),
		preferred: aus(obj.preferred),
		longform: obj.longform === true,
		confidence,
	}
}

/**
 * Instruktion fürs Router-Modell. Deutsch, kurz, ein einziges JSON-Objekt.
 * `vision` ist bewusst dabei, auch wenn die Task selbst keine Bilder hat:
 * Das Modell darf es nur vorschlagen, wenn der Auftrag ausdrücklich danach
 * klingt — sonst bleibt es bei der Heuristik.
 */
function routerInstruction(prompt: string): string {
	return [
		"Du bist der Router einer lokalen LLM-Orchestrierung. Klassifiziere den Auftrag in genau einem JSON-Objekt — kein Markdown, keine Kommentare, kein Text davor oder danach:",
		'{"required":["code"],"preferred":[],"longform":false,"confidence":0.8}',
		"",
		"Felder:",
		'- "required": Pflicht-Fähigkeiten, nur Werte aus: code, reasoning, longform, vision, tools, json. Nur wirklich Pflicht — alles andere gehört nicht hinein.',
		'- "preferred": Bonus-Fähigkeiten, dieselben Werte, leer erlaubt.',
		'- "longform": true, wenn die Antwort ein längeres Dokument sein soll (Bericht, Anleitung, Übersetzung eines Textes).',
		'- "confidence": deine Selbstsicherheit von 0 bis 1.',
		"",
		"Der Auftrag:",
		"<<<",
		prompt,
		">>>",
	].join("\n")
}

export class RouterTimeoutError extends Error {
	constructor(ms: number) {
		super(`Router-Modell-Timeout nach ${ms} ms`)
		this.name = "RouterTimeoutError"
	}
}

/**
 * Führt den Router-Call aus und liefert das geparste Ergebnis.
 * Wirft bei Timeout (`RouterTimeoutError`) oder Provider-Fehler —
 * die Kaskade in `profile.ts` fängt beides und fällt auf die Heuristik zurück.
 */
export async function analyzePromptWithModel(
	provider: LLMProvider,
	settings: RouterModelSettings,
	prompt: string,
): Promise<RouterAnalysis> {
	const controller = new AbortController()
	const stop = setTimeout(() => controller.abort(), settings.timeoutMs)
	try {
		const stream = provider.chat({
			messages: [{ role: "user", content: routerInstruction(prompt) }],
			model: settings.modelId,
			// Das Ergebnis ist ein kurzes JSON-Objekt — 160 Tokens reichen mit
			// grosser Marge, und es zwingt das Modell, sich nicht auszubreiten.
			settings: { maxTokens: 160, temperature: 0 },
			signal: controller.signal,
		})
		let text = ""
		for await (const chunk of stream) {
			if (chunk.type === "delta") {
				text += chunk.text
			} else if (chunk.type === "done") {
				break
			}
		}
		const parsed = parseRouterResponse(text)
		if (!parsed) {
			throw new Error("Router-Modell lieferte kein verwertbares JSON")
		}
		return parsed
	} finally {
		clearTimeout(stop)
	}
}
