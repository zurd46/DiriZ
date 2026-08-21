/**
 * Dünner HTTP-Client für die Adapter (`01-plan.md` §4): nativer `fetch`,
 * JSON + zwei Stream-Formate (SSE `data:`-Zeilen für OpenAI-kompatible
 * Server, NDJSON für Ollama). Kein SDK.
 */

export class ProviderHttpError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = "ProviderHttpError"
	}
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) {
		return e.message
	}
	return String(e)
}

export interface JsonOptions {
	method?: string
	headers?: Record<string, string>
	body?: unknown
	signal?: AbortSignal
	timeoutMs?: number
}

export async function fetchJson<T>(url: string, opts: JsonOptions = {}): Promise<T> {
	const controller = new AbortController()
	const timeoutMs = opts.timeoutMs ?? 8000
	const timer = setTimeout(() => controller.abort(new Error(`timeout nach ${timeoutMs} ms`)), timeoutMs)
	const onAbort = () => controller.abort(opts.signal?.reason)
	if (opts.signal) {
		if (opts.signal.aborted) {
			onAbort()
		} else {
			opts.signal.addEventListener("abort", onAbort, { once: true })
		}
	}
	try {
		const res = await fetch(url, {
			method: opts.method ?? "GET",
			headers:
				opts.body !== undefined ? { "content-type": "application/json", ...opts.headers } : opts.headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal,
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw new ProviderHttpError(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`, res.status)
		}
		return (await res.json()) as T
	} finally {
		clearTimeout(timer)
		if (opts.signal) {
			opts.signal.removeEventListener("abort", onAbort)
		}
	}
}

/** Zeilen eines Streams — die gemeinsame Basis für SSE & NDJSON. */
async function* streamLines(res: Response): AsyncGenerator<string> {
	if (!res.body) {
		throw new ProviderHttpError("Antwort ohne Body")
	}
	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buf = ""
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			buf += decoder.decode(value, { stream: true })
			let idx = buf.indexOf("\n")
			while (idx >= 0) {
				yield buf.slice(0, idx).replace(/\r$/, "")
				buf = buf.slice(idx + 1)
				idx = buf.indexOf("\n")
			}
		}
	} finally {
		reader.releaseLock()
	}
}

/** `data:`-Payloads eines SSE-Streams (OpenAI-kompatible Endpunkte). */
export async function* sseData(res: Response): AsyncGenerator<string> {
	for await (const line of streamLines(res)) {
		if (line.startsWith("data:")) {
			const data = line.slice(5).trim()
			if (data.length > 0) {
				yield data
			}
		}
	}
}

/** NDJSON-Zeilen (Ollama `/api/chat`). */
export async function* jsonLines(res: Response): AsyncGenerator<string> {
	for await (const line of streamLines(res)) {
		if (line.trim().length > 0) {
			yield line
		}
	}
}
