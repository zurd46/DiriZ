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
import { errorMessage, fetchJson, jsonLines, ProviderHttpError } from "./http.js"

interface OllamaChatChunk {
	message?: { content?: string }
	done?: boolean
	prompt_eval_count?: number
	eval_count?: number
}

export class OllamaProvider implements LLMProvider {
	readonly id: string
	readonly type = "ollama"
	readonly label: string
	private baseUrl: string

	constructor(id: string, baseUrl: string, label = "Ollama") {
		this.id = id
		this.baseUrl = baseUrl.replace(/\/+$/, "")
		this.label = label
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
			timeoutMs: 5000,
		})
		return (data.models ?? []).map((m) => ({ modelId: m.name, displayName: m.name }))
	}

	/** Load-Balancing: geladene Modelle + VRAM-Belegung (`/api/ps`). */
	async loadInfo(): Promise<LoadInfo> {
		const data = await fetchJson<{
			models?: { name: string; size_vram?: number }[]
			size_vram_total?: number
		}>(`${this.baseUrl}/api/ps`, { timeoutMs: 5000 })
		return {
			loadedModels: (data.models ?? []).map((m) => ({ modelId: m.name, memoryBytes: m.size_vram ?? 0 })),
			totalMemoryBytes: data.size_vram_total,
		}
	}

	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		// Model-Settings in Ollama-`options` mappen; undefined wird verworfen.
		const s = req.settings ?? {}
		const res = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: req.model,
				messages: req.messages,
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
			}),
			signal: req.signal,
		})
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => "")
			throw new ProviderHttpError(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`, res.status)
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
