/**
 * LM-Studio-Adapter (`01-plan.md` §5.3): OpenAI-kompatibel, default
 * `http://localhost:1234/v1`, API-Key optional.
 */

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

export class LmStudioProvider extends OpenAiCompatProvider {
	constructor(id: string, baseUrl = "http://localhost:1234/v1", apiKey?: string) {
		super({ id, type: "lmstudio", label: "LM Studio", baseUrl: withV1(baseUrl), apiKey })
	}
}
