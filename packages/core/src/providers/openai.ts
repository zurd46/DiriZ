/**
 * OpenAI-Adapter (`01-plan.md` §5.5): OpenAI-kompatibel,
 * `Authorization: Bearer <key>`, optional eigener Base-URL (Azure-kompatibel).
 */

import { OpenAiCompatProvider } from "./openai-compat.js"

export class OpenAIProvider extends OpenAiCompatProvider {
	constructor(id: string, apiKey: string, baseUrl = "https://api.openai.com/v1") {
		super({ id, type: "openai", label: "OpenAI", baseUrl, apiKey })
	}
}
