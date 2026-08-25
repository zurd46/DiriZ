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
import { errorMessage, fetchJson, ProviderHttpError, sseData, statusHint, summarizeBody } from "./http.js"

export interface OpenAiCompatOptions {
	id: string
	type: ProviderType
	label: string
	/** Beispiel: `http://localhost:1234/v1` */
	baseUrl: string
	apiKey?: string
	extraHeaders?: Record<string, string>
}

/**
 * Ein Modell, wie ein OpenAI-kompatibler Server es meldet.
 *
 * Die Kontextgröße heißt je nach Server anders — OpenRouter nennt sie
 * `context_length`, LM Studio `max_context_length`, vLLM `max_model_len`,
 * llama.cpp `n_ctx`. Wird keines der Felder gefunden, greift der Fallback
 * beim Anlegen der Instanz; deshalb standen zuvor überall 8192.
 */
interface CompatModel {
	id: string
	name?: string
	context_length?: number
	max_context_length?: number
	loaded_context_length?: number
	max_model_len?: number
	context_window?: number
	n_ctx?: number
	quantization?: string
	pricing?: { prompt?: string; completion?: string }
}

/** Erste plausible Kontextangabe aus den bekannten Feldnamen. */
export function readContextWindow(m: CompatModel): number | undefined {
	const candidates = [
		m.context_length,
		m.max_context_length,
		m.max_model_len,
		m.context_window,
		m.n_ctx,
		m.loaded_context_length,
	]
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value
		}
	}
	return undefined
}

/** `delta.tool_calls`-Fragment eines Streaming-Chunks (OpenAI-Format). */
interface CompatToolCallDelta {
	index: number
	id?: string
	function?: { name?: string; arguments?: string }
}

interface CompatChunk {
	choices?: {
		delta?: {
			content?: string
			/** Reasoning-Modelle (LM Studio, DeepSeek, Qwen-Thinking …). */
			reasoning_content?: string
			reasoning?: string
			tool_calls?: CompatToolCallDelta[]
		}
	}[]
	usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Gemeinsame ChatMessage → OpenAI-`messages` (inkl. Tool-Rollen, M8). */
function toOpenAiMessages(messages: ChatRequest["messages"]): unknown[] {
	return messages.map((m) => {
		if (m.role === "tool") {
			return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content }
		}
		if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
			return {
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
				})),
			}
		}
		return { role: m.role, content: m.content }
	})
}

export class OpenAiCompatProvider implements LLMProvider {
	readonly id: string
	readonly type: ProviderType
	readonly label: string
	/** M8 Agentik: OpenAI-`tools` wird von allen kompatiblen Servern verstanden. */
	readonly supportsTools = true
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
		const arr = Array.isArray(data) ? data : (data.data ?? null)
		if (!arr) {
			// Manche Server (z. B. LM Studio ohne `/v1`-Pfad) antworten mit
			// HTTP 200 + Fehler-JSON — das muss als Fehler durchgehen, nicht
			// als „online, aber 0 Modelle".
			throw new ProviderHttpError(
				`Unerwartete Antwort von ${this.baseUrl}/models (keine Modellliste): ${JSON.stringify(data).slice(0, 200)}`,
			)
		}
		return arr.map((m) => ({
			modelId: m.id,
			displayName: m.name ?? m.id,
			contextWindow: readContextWindow(m),
			quantization: m.quantization,
			pricePerMTok: m.pricing
				? { in: Number(m.pricing.prompt) * 1_000_000, out: Number(m.pricing.completion) * 1_000_000 }
				: undefined,
		}))
	}

	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		// Model-Settings (Provider/Modell/Task) in den OpenAI-`ody mappen;
		// undefined-Felder werden von JSON.stringify automatisch verworfen.
		const s = req.settings ?? {}
		const body: Record<string, unknown> = {
			model: req.model,
			messages: toOpenAiMessages(req.messages),
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
		}
		if (req.tools && req.tools.length > 0) {
			body.tools = req.tools.map((t) => ({ type: "function", function: t }))
		}
		const res = await fetch(`${this.baseUrl}/chat/completions`, {
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
		// Tool-Calls werden pro Index akkumuliert (Name + Argumente streamen in Fragmenten).
		const pending = new Map<number, { id: string; name: string; argsBuf: string }>()
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
			const delta = obj.choices?.[0]?.delta
			if (delta) {
				if (delta.content) {
					yield { type: "delta", text: delta.content }
				}
				// Denk-Tokens getrennt melden: Sie zählen zur Abrechnung, gehören
				// aber nicht in die Antwort. Ohne diesen Zweig liefert ein
				// Reasoning-Modell tausende Tokens und eine leere Antwort.
				const thinking = delta.reasoning_content ?? delta.reasoning
				if (thinking) {
					yield { type: "reasoning", text: thinking }
				}
				for (const tc of delta.tool_calls ?? []) {
					const acc = pending.get(tc.index) ?? { id: `call_${tc.index}`, name: "", argsBuf: "" }
					if (tc.id) {
						acc.id = tc.id
					}
					if (tc.function?.name) {
						acc.name += tc.function.name
					}
					if (tc.function?.arguments) {
						acc.argsBuf += tc.function.arguments
					}
					pending.set(tc.index, acc)
				}
			}
		}
		for (const [, acc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			let args: Record<string, unknown> = {}
			try {
				args = JSON.parse(acc.argsBuf || "{}") as Record<string, unknown>
			} catch {
				args = { _raw: acc.argsBuf }
			}
			yield { type: "tool_call", call: { id: acc.id, name: acc.name, arguments: args } }
		}
		yield { type: "done" }
	}

	/** Abbruch läuft über das `AbortSignal` des Engines; hier kein Server-Zustand. */
	async cancel(): Promise<void> {
		// no-op
	}
}
