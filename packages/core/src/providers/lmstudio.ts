/**
 * LM-Studio-Adapter (`01-plan.md` §5.3): OpenAI-kompatibel, default
 * `http://localhost:1234/v1`, API-Key optional.
 */

import { OpenAiCompatProvider } from "./openai-compat.js"

export class LmStudioProvider extends OpenAiCompatProvider {
	constructor(id: string, baseUrl = "http://localhost:1234/v1", apiKey?: string) {
		super({ id, type: "lmstudio", label: "LM Studio", baseUrl, apiKey })
	}
}
