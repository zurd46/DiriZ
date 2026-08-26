/**
 * Adapter-Fabrik (`01-plan.md` §4.2): Provider-Typ → konkrete Implementierung.
 */

import type { LLMProvider } from "@diriz/shared"
import { log } from "../logger.js"
import { LmStudioProvider } from "./lmstudio.js"
import { OllamaProvider } from "./ollama.js"
import { OpenAIProvider } from "./openai.js"
import { OpenAiCompatProvider } from "./openai-compat.js"
import { OpenRouterProvider } from "./openrouter.js"

/**
 * Zeigt diese Adresse auf den eigenen Rechner?
 *
 * Für einen Cloud-Dienst ist das nie richtig — und es kam vor: Die
 * Eingabemaske füllte „Base URL" mit `http://localhost:11434` vor (dem
 * Ollama-Standard) und schickte den Wert auch dann mit, wenn der Typ
 * `openrouter` gewählt war. Der Eintrag sah gültig aus, jede Anfrage lief ins
 * lokale Ollama.
 */
function zeigtAufDenEigenenRechner(url: string): boolean {
	try {
		const host = new URL(url).hostname
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
	} catch {
		return false
	}
}

/**
 * Basis-Adresse eines Cloud-Dienstes — oder `undefined` für dessen Standard.
 *
 * Eine lokale Adresse wird verworfen **und gemeldet**: Stillschweigend
 * umzuleiten wäre schlimmer als der Fehler, denn dann stünde in den
 * Einstellungen weiter etwas anderes als das, was DiriZ tut.
 */
function cloudBasis(id: string, type: string, baseUrl: string, label?: string): string | undefined {
	if (baseUrl && zeigtAufDenEigenenRechner(baseUrl)) {
		log(
			"warn",
			"provider",
			`${label ?? id} (${type}): „${baseUrl}" zeigt auf diesen Rechner und kann kein ${type} sein — ` +
				"es wird die offizielle Adresse des Dienstes verwendet. Bitte den Eintrag korrigieren.",
		)
		return undefined
	}
	return baseUrl || undefined
}

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
			return new OpenRouterProvider(id, apiKey, cloudBasis(id, type, baseUrl, label))
		case "openai":
			if (!apiKey) {
				throw new Error("OpenAI benötigt einen API-Key")
			}
			return new OpenAIProvider(id, apiKey, cloudBasis(id, type, baseUrl, label))
		default:
			throw new Error(`Unbekannter Provider-Typ: ${type}`)
	}
}
