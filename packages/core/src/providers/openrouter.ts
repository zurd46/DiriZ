/**
 * OpenRouter-Adapter (`01-plan.md` §5.4): OpenAI-kompatibel +
 * `Authorization: Bearer <key>`, `X-Title: DiriZ`, Preis-Metadaten aus
 * dem `/models`-Endpoint (pricing.prompt/completion, $/Token).
 */

import { OpenAiCompatProvider } from "./openai-compat.js"

export class OpenRouterProvider extends OpenAiCompatProvider {
	constructor(id: string, apiKey: string, baseUrl = "https://openrouter.ai/api/v1") {
		super({
			id,
			type: "openrouter",
			label: "OpenRouter",
			baseUrl,
			apiKey,
			extraHeaders: { "x-title": "DiriZ" },
		})
	}
}
