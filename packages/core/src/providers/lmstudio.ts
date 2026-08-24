/**
 * LM-Studio-Adapter (`01-plan.md` §5.3): OpenAI-kompatibel, default
 * `http://localhost:1234/v1`, API-Key optional.
 *
 * Für die **Discovery** wird bevorzugt die native REST-API `/api/v0/models`
 * abgefragt: Nur sie meldet die tatsächliche Kontextgröße (`max_context_length`),
 * die Quantisierung und den Modelltyp. Der OpenAI-kompatible Endpunkt
 * `/v1/models` liefert davon nichts — deshalb landeten bisher alle Modelle mit
 * dem Fallback-Wert 8192 in der Datenbank, obwohl sie ein Vielfaches können.
 */

import type { Capability, DiscoveredModel } from "@diriz/shared"
import { errorMessage, fetchJson } from "./http.js"
import { OpenAiCompatProvider } from "./openai-compat.js"

/**
 * LM Studio bedient die OpenAI-kompatiblen Endpunkte unter `/v1` (bzw.
 * `/api/v1`). Fehlt der Versions-Pfad in der Base-URL, wird er ergänzt —
 * sonst antwortet der Server auf z. B. `GET /models` mit HTTP 200 +
 * Fehler-JSON, was als „online, aber 0 Modelle" durchgeht.
 */
function withV1(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "")
	return /\/(api\/)?v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/** Wurzel des Servers ohne Versions-Pfad — Basis für `/api/v0/…`. */
function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/(api\/)?v\d+$/, "")
}

/** Antwort von `GET /api/v0/models`. */
interface NativeModel {
	id: string
	type?: string
	arch?: string
	quantization?: string
	state?: string
	max_context_length?: number
	loaded_context_length?: number
	publisher?: string
}

/**
 * Modelltyp und Architektur verraten die Fähigkeiten, die LM Studio selbst
 * kennt. Mehr wird bewusst nicht geraten — der Rest wird in der Oberfläche
 * gepflegt.
 */
function capabilitiesOf(m: NativeModel): Capability[] | undefined {
	const caps: Capability[] = []
	const name = `${m.id} ${m.arch ?? ""}`.toLowerCase()
	if (m.type === "vlm") {
		caps.push("vision")
	}
	if (/coder|code|deepseek|qwen.*code/.test(name)) {
		caps.push("code")
	}
	return caps.length > 0 ? caps : undefined
}

export class LmStudioProvider extends OpenAiCompatProvider {
	private readonly root: string

	constructor(id: string, baseUrl = "http://localhost:1234/v1", apiKey?: string) {
		super({ id, type: "lmstudio", label: "LM Studio", baseUrl: withV1(baseUrl), apiKey })
		this.root = serverRoot(withV1(baseUrl))
	}

	/**
	 * Erst die native API (mit Kontextgröße und Quantisierung), sonst der
	 * OpenAI-kompatible Weg. Ältere LM-Studio-Versionen kennen `/api/v0` nicht.
	 */
	async listModels(): Promise<DiscoveredModel[]> {
		try {
			const data = await fetchJson<{ data?: NativeModel[] }>(`${this.root}/api/v0/models`, {
				headers: this.headers(),
				timeoutMs: 8000,
			})
			const models = data.data
			if (Array.isArray(models) && models.length > 0) {
				return (
					models
						// Embedding-Modelle können nicht chatten — sie gehören nicht ins Routing.
						.filter((m) => m.type !== "embeddings")
						.map((m) => ({
							modelId: m.id,
							displayName: m.id,
							contextWindow: m.max_context_length ?? m.loaded_context_length,
							quantization: m.quantization,
							capabilities: capabilitiesOf(m),
						}))
				)
			}
		} catch (e) {
			// Kein Beinbruch: Der kompatible Endpunkt liefert wenigstens die Namen.
			void errorMessage(e)
		}
		return super.listModels()
	}
}
