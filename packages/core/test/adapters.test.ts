/**
 * Adapter-Tests gegen einen lokalen Fake-HTTP-Server:
 * Ollama (NDJSON) und OpenAI-kompatibel (SSE) — Streaming, Usage, Discovery.
 */

import http from "node:http"
import type { AddressInfo } from "node:net"
import type { ChatChunk } from "@diriz/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProvider } from "../src/providers/factory.js"
import { LmStudioProvider } from "../src/providers/lmstudio.js"
import { OllamaProvider } from "../src/providers/ollama.js"
import { OpenAiCompatProvider } from "../src/providers/openai-compat.js"

let lastAuth: string | undefined
let server: http.Server
let baseUrl: string

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const url = req.url ?? ""
		if (req.method === "GET" && url === "/api/tags") {
			lastAuth = req.headers.authorization as string | undefined
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ models: [{ name: "llama3" }, { name: "mistral" }] }))
			return
		}
		if (req.method === "GET" && url === "/api/ps") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					models: [{ name: "llama3", size_vram: 4_000_000_000 }],
					size_vram_total: 16_000_000_000,
				}),
			)
			return
		}
		if (req.method === "POST" && url === "/api/chat") {
			res.writeHead(200, { "content-type": "application/x-ndjson" })
			res.write(`${JSON.stringify({ message: { content: "Hel" } })}\n`)
			res.write(`${JSON.stringify({ message: { content: "lo!" } })}\n`)
			res.end(`${JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 7 })}\n`)
			return
		}
		if (req.method === "GET" && url === "/v1/models") {
			lastAuth = req.headers.authorization as string | undefined
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					data: [
						{
							id: "gpt-x",
							name: "GPT X",
							context_length: 128_000,
							pricing: { prompt: "0.000003", completion: "0.000015" },
						},
					],
				}),
			)
			return
		}
		if (req.method === "GET" && url === "/api/v1/models") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ data: [{ id: "gpt-x", name: "GPT X" }] }))
			return
		}
		if (req.method === "GET" && url === "/models") {
			// So antwortet LM Studio auf unbekannte Endpunkte: HTTP 200 + Fehler-JSON.
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "Unexpected endpoint or method. (GET /models)" }))
			return
		}
		if (req.method === "POST" && url === "/v1/chat/completions") {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi " } }] })}\n\n`)
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "there" } }] })}\n\n`)
			res.write(
				`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`,
			)
			res.end("data: [DONE]\n\n")
			return
		}
		res.writeHead(404)
		res.end("not found")
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const addr = server.address() as AddressInfo
	baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
})

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
	const out: ChatChunk[] = []
	for await (const c of gen) {
		out.push(c)
	}
	return out
}

describe("adapter: Ollama", () => {
	const makeProvider = () => new OllamaProvider("ollama-test", baseUrl)

	it("meldt Health + Modelle + Load-Info", async () => {
		const provider = makeProvider()
		const health = await provider.healthCheck()
		expect(health.ok).toBe(true)
		const models = await provider.listModels()
		expect(models.map((m) => m.modelId)).toEqual(["llama3", "mistral"])
		const load = await (provider as OllamaProvider).loadInfo()
		expect(load?.loadedModels[0]?.modelId).toBe("llama3")
	})

	it("streamt NDJSON-Deltas + Usage", async () => {
		const provider = makeProvider()
		const chunks = await collect(
			provider.chat({ messages: [{ role: "user", content: "Hallo" }], model: "llama3" }),
		)
		const text = chunks
			.filter((c) => c.type === "delta")
			.map((c) => (c.type === "delta" ? c.text : ""))
			.join("")
		expect(text).toBe("Hello!")
		const usage = chunks.find((c) => c.type === "usage")
		expect(usage && usage.type === "usage" && usage.tokensIn).toBe(3)
		expect(chunks.at(-1)?.type).toBe("done")
	})

	it("sendet API-Key als Bearer-Token (Auth-Proxy)", async () => {
		const provider = new OllamaProvider("ollama-auth", baseUrl, "Ollama Auth", "sekret-123")
		await provider.listModels()
		expect(lastAuth).toBe("Bearer sekret-123")
	})

	it("sendet ohne Key keinen Authorization-Header", async () => {
		lastAuth = undefined
		const provider = new OllamaProvider("ollama-noauth", baseUrl)
		await provider.listModels()
		expect(lastAuth).toBeUndefined()
	})
})

describe("adapter: OpenAI-kompatibel (LM Studio)", () => {
	const makeProvider = () => new LmStudioProvider("lmstudio-test", `${baseUrl}/v1`)

	it("liest Modell-Metadaten inkl. Pricing", async () => {
		const provider = makeProvider()
		const models = await provider.listModels()
		expect(models[0]?.modelId).toBe("gpt-x")
		expect(models[0]?.contextWindow).toBe(128_000)
		expect(models[0]?.pricePerMTok?.out).toBeCloseTo(15)
	})

	it("streamt SSE-Deltas + Usage und stoppt bei [DONE]", async () => {
		const provider = makeProvider()
		const chunks = await collect(
			provider.chat({ messages: [{ role: "user", content: "Hi" }], model: "gpt-x" }),
		)
		const text = chunks
			.filter((c) => c.type === "delta")
			.map((c) => (c.type === "delta" ? c.text : ""))
			.join("")
		expect(text).toBe("Hi there")
		const usage = chunks.find((c) => c.type === "usage")
		expect(usage && usage.type === "usage" && usage.tokensOut).toBe(9)
	})

	it("sendet API-Key als Bearer-Token", async () => {
		const provider = new LmStudioProvider("lmstudio-auth", `${baseUrl}/v1`, "key-abc")
		await provider.listModels()
		expect(lastAuth).toBe("Bearer key-abc")
	})

	it("ergänzt fehlenden /v1-Pfad automatisch (LM-Studio-Konvention)", async () => {
		const provider = new LmStudioProvider("lmstudio-nov1", baseUrl) // bewusst ohne /v1
		const models = await provider.listModels()
		expect(models[0]?.modelId).toBe("gpt-x")
	})

	it("lässt vorhandene Versions-Pfade (/api/v1) unverändert", async () => {
		const provider = new LmStudioProvider("lmstudio-apiv1", `${baseUrl}/api/v1`)
		const models = await provider.listModels()
		expect(models[0]?.modelId).toBe("gpt-x")
	})

	it("meldet 200 + Fehler-JSON als Fehler statt „online, aber 0 Modelle“", async () => {
		const provider = new OpenAiCompatProvider({
			id: "compat-err",
			type: "openai-compat",
			label: "X",
			baseUrl,
		})
		await expect(provider.listModels()).rejects.toThrow("keine Modellliste")
		const health = await provider.healthCheck()
		expect(health.ok).toBe(false)
	})
})

describe("adapter: Fabrik", () => {
	it("erstellt die richtigen Typen", () => {
		expect(createProvider("a", "ollama", "http://x")).toBeInstanceOf(OllamaProvider)
		expect(createProvider("b", "lmstudio", "http://x")).toBeInstanceOf(LmStudioProvider)
		expect(() => createProvider("c", "unbekannt", "http://x")).toThrow()
		expect(() => createProvider("d", "openrouter", "http://x")).toThrow("API-Key")
	})
})
