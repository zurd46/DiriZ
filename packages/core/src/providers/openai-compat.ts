/**
 * OpenAI-kompatibler Adapter (`01-plan.md` §5.2) — die Basis für
 * LM Studio, OpenAI und generische OpenAI-Server. OpenRouter erbt von
 * dieser Klasse und ergänzt nur Header + Modell-Metadaten.
 *
 * Streaming: SSE mit `stream_options.include_usage` (Usage-Angabe am Ende).
 */

import type {
	ChatChunk,
	ChatRequest,
	DiscoveredModel,
	HealthStatus,
	LLMProvider,
	ProviderType,
} from "@diriz/shared"
import { errorMessage, fetchJson, ProviderHttpError, sseData } from "./http.js"

export interface OpenAiCompatOptions {
	id: string
	type: ProviderType
	label: string
	/** Beispiel: `http://localhost:1234/v1` */
	baseUrl: string
	apiKey?: string
	extraHeaders?: Record<string, string>
}

interface CompatModel {
	id: string
	name?: string
	context_length?: number
	pricing?: { prompt?: string; completion?: string }
}

interface CompatChunk {
	choices?: { delta?: { content?: string } }[]
	usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class OpenAiCompatProvider implements LLMProvider {
	readonly id: string
	readonly type: ProviderType
	readonly label: string
	private baseUrl: string
	private apiKey?: string
	private extraHeaders: Record<string, string>

	constructor(opts: OpenAiCompatOptions) {
		this.id = opts.id
		this.type = opts.type
		this.label = opts.label
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
		this.apiKey = opts.apiKey
		this.extraHeaders = opts.extraHeaders ?? {}
	}

	protected headers(): Record<string, string> {
		const h: Record<string, string> = { ...this.extraHeaders }
		if (this.apiKey) {
			h.authorization = `Bearer ${this.apiKey}`
		}
		return h
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
		const data = await fetchJson<{ data?: CompatModel[] } | CompatModel[]>(`${this.baseUrl}/models`, {
			headers: this.headers(),
			timeoutMs: 5000,
		})
		const arr = Array.isArray(data) ? data : (data.data ?? [])
		return arr.map((m) => ({
			modelId: m.id,
			displayName: m.name ?? m.id,
			contextWindow: m.context_length,
			pricePerMTok: m.pricing
				? { in: Number(m.pricing.prompt) * 1_000_000, out: Number(m.pricing.completion) * 1_000_000 }
				: undefined,
		}))
	}

	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		// Model-Settings (Provider/Modell/Task) in den OpenAI-`ody mappen;
		// undefined-Felder werden von JSON.stringify automatisch verworfen.
		const s = req.settings ?? {}
		const res = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.headers() },
			body: JSON.stringify({
				model: req.model,
				messages: req.messages,
				stream: true,
				stream_options: { include_usage: true },
				temperature: s.temperature ?? req.temperature,
				max_tokens: s.maxTokens ?? req.maxTokens,
				top_p: s.topP,
				top_k: s.topK,
				presence_penalty: s.presencePenalty,
				frequency_penalty: s.frequencyPenalty,
				seed: s.seed,
				stop: s.stop,
			}),
			signal: req.signal,
		})
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => "")
			throw new ProviderHttpError(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`, res.status)
		}
		for await (const data of sseData(res)) {
			if (data === "[DONE]") {
				break
			}
			let obj: CompatChunk
			try {
				obj = JSON.parse(data) as CompatChunk
			} catch {
				continue
			}
			if (obj.usage) {
				yield {
					type: "usage",
					tokensIn: obj.usage.prompt_tokens ?? 0,
					tokensOut: obj.usage.completion_tokens ?? 0,
				}
				continue
			}
			const text = obj.choices?.[0]?.delta?.content
			if (text) {
				yield { type: "delta", text }
			}
		}
		yield { type: "done" }
	}

	/** Abbruch läuft über das `AbortSignal` des Engines; hier kein Server-Zustand. */
	async cancel(): Promise<void> {
		// no-op
	}
}
