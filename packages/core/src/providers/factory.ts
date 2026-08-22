/**
 * Adapter-Fabrik (`01-plan.md` §4.2): Provider-Typ → konkrete Implementierung.
 */

import type { LLMProvider } from "@diriz/shared"
import { LmStudioProvider } from "./lmstudio.js"
import { OllamaProvider } from "./ollama.js"
import { OpenAIProvider } from "./openai.js"
import { OpenAiCompatProvider } from "./openai-compat.js"
import { OpenRouterProvider } from "./openrouter.js"

export function createProvider(
	id: string,
	type: string,
	baseUrl: string,
	apiKey?: string,
	label?: string,
): LLMProvider {
	switch (type) {
		case "ollama":
			return new OllamaProvider(id, baseUrl, label, apiKey)
		case "lmstudio":
			return new LmStudioProvider(id, baseUrl, apiKey)
		case "openai-compat":
			return new OpenAiCompatProvider({
				id,
				type: "openai-compat",
				label: label ?? "OpenAI-kompatibel",
				baseUrl,
				apiKey,
			})
		case "openrouter":
			if (!apiKey) {
				throw new Error("OpenRouter benötigt einen API-Key")
			}
			return new OpenRouterProvider(id, apiKey, baseUrl || undefined)
		case "openai":
			if (!apiKey) {
				throw new Error("OpenAI benötigt einen API-Key")
			}
			return new OpenAIProvider(id, apiKey, baseUrl || undefined)
		default:
			throw new Error(`Unbekannter Provider-Typ: ${type}`)
	}
}
