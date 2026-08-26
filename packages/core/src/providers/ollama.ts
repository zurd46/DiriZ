/**
 * Ollama-Adapter (`01-plan.md` §5.1): NDJSON-Streaming, Load-Balancing
 * über `/api/ps` (VRAM je geladenes Modell), `keep_alive=0` damit Modelle
 * nach dem Request aus dem VRAM gehen.
 */

import type {
	ChatChunk,
	ChatRequest,
	DiscoveredModel,
	HealthStatus,
	LLMProvider,
	LoadInfo,
} from "@diriz/shared"
import { contentText } from "@diriz/shared"
import { errorMessage, fetchJson, jsonLines, ProviderHttpError, statusHint, summarizeBody } from "./http.js"

interface OllamaChatChunk {
	message?: {
		content?: string
		tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[]
	}
	done?: boolean
	prompt_eval_count?: number
	eval_count?: number
}

/**
 * Gemeinsame ChatMessage → Ollama-`messages` (inkl. Tool-Rollen, M8).
 * Vision (T1-2): Ollama nimmt Bilder nicht in die Nachricht, sondern ins
 * `images`-Feld der letzten User-Nachricht — `extractOllamaImages` sammelt
 * sie, hier bleibt nur der Text.
 */
function toOllamaMessages(messages: ChatRequest["messages"]): unknown[] {
	return messages.map((m) => {
		const text = contentText(m.content)
		if (m.role === "tool") {
			return { role: "tool", content: text }
		}
		if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
			return {
				role: "assistant",
				content: text || "",
				tools: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })),
			}
		}
		return { role: m.role, content: text }
	})
}

/**
 * Sammelt alle Bild-URLs aus `ContentPart[]` (T1-2). Ollama erwartet
 * Base64-Strings im `images`-Feld — `data:`-URIs werden entpackt.
 */
export function extractOllamaImages(messages: ChatRequest["messages"]): string[] {
	const images: string[] = []
	for (const m of messages) {
		if (typeof m.content === "string") {
			continue
		}
		for (const part of m.content) {
			if (part.type === "image_url") {
				const url = part.image_url.url
				images.push(url.startsWith("data:") ? url.slice(url.indexOf(";base64,") + 8) : url)
			}
		}
	}
	return images
}

export class OllamaProvider implements LLMProvider {
	readonly id: string
	readonly type = "ollama"
	readonly label: string
	/** M8 Agentik: Ollama ≥ 0.6 unterstützt `tools` im Chat-Request. */
	readonly supportsTools = true
	private baseUrl: string
	private apiKey?: string

	constructor(id: string, baseUrl: string, label = "Ollama", apiKey?: string) {
		this.id = id
		this.baseUrl = baseUrl.replace(/\/+$/, "")
		this.label = label
		this.apiKey = apiKey
	}

	/** Optionaler API-Key (z. B. Auth-Proxy vor Ollama) wird als Bearer-Token gesendet. */
	private headers(): Record<string, string> {
		return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}
	}

	async healthCheck(): Promise<HealthStatus> {
		const t0 = Date.now()
		try {
			await this.listModels()
			return { ok: true, latencyMs: Date.now() - t0 }
		} catch (e) {
			return { ok: false, latencyMs: Date.now() - t0, detail: errorMessage(e) }
		}
	}

	async listModels(): Promise<DiscoveredModel[]> {
		const data = await fetchJson<{ models?: { name: string }[] }>(`${this.baseUrl}/api/tags`, {
			headers: this.headers(),
			timeoutMs: 5000,
		})
		return (data.models ?? []).map((m) => ({ modelId: m.name, displayName: m.name }))
	}

	/** Load-Balancing: geladene Modelle + VRAM-Belegung (`/api/ps`). */
	async loadInfo(): Promise<LoadInfo> {
		const data = await fetchJson<{
			models?: { name: string; size_vram?: number }[]
			size_vram_total?: number
		}>(`${this.baseUrl}/api/ps`, { headers: this.headers(), timeoutMs: 5000 })
		return {
			loadedModels: (data.models ?? []).map((m) => ({ modelId: m.name, memoryBytes: m.size_vram ?? 0 })),
			totalMemoryBytes: data.size_vram_total,
		}
	}

	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		// Model-Settings in Ollama-`options` mappen; undefined wird verworfen.
		const s = req.settings ?? {}
		const body: Record<string, unknown> = {
			model: req.model,
			messages: toOllamaMessages(req.messages),
			stream: true,
			keep_alive: 0,
			options: {
				temperature: s.temperature ?? req.temperature,
				num_predict: s.maxTokens ?? req.maxTokens,
				top_k: s.topK,
				top_p: s.topP,
				min_p: s.minP,
				repeat_penalty: s.repeatPenalty,
				seed: s.seed,
				stop: s.stop,
			},
		}
		if (req.tools && req.tools.length > 0) {
			body.tools = req.tools.map((t) => ({ type: "function", function: t }))
		}
		// T1-2 Vision: Bilder gehören ans `images`-Feld der User-Nachricht.
		const images = extractOllamaImages(req.messages)
		if (images.length > 0) {
			body.images = images
		}
		// T3-12: JSON-Modus (Ollama kennt `format: "json"`).
		if (req.jsonMode) {
			body.format = "json"
		}
		const res = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.headers() },
			body: JSON.stringify(body),
			signal: req.signal,
		})
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => "")
			const detail = summarizeBody(text)
			throw new ProviderHttpError(
				`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}${statusHint(res.status, text)}`,
				res.status,
			)
		}
		let tokensIn = 0
		let tokensOut = 0
		for await (const line of jsonLines(res)) {
			let obj: OllamaChatChunk
			try {
				obj = JSON.parse(line) as OllamaChatChunk
			} catch {
				continue
			}
			const text = obj.message?.content
			if (text) {
				yield { type: "delta", text }
			}
			for (const [i, tc] of (obj.message?.tool_calls ?? []).entries()) {
				yield {
					type: "tool_call",
					call: { id: `ollama_${i}`, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? {} },
				}
			}
			if (obj.done) {
				tokensIn = obj.prompt_eval_count ?? 0
				tokensOut = obj.eval_count ?? 0
			}
		}
		if (tokensIn > 0 || tokensOut > 0) {
			yield { type: "usage", tokensIn, tokensOut }
		}
		yield { type: "done" }
	}

	async cancel(): Promise<void> {
		// Abbruch läuft über das AbortSignal; Ollama hat keinen Cancel-Endpoint.
	}
}
