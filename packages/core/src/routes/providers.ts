/**
 * Provider-Routen (`01-plan.md` §7.2): CRUD + Health-Check + Discovery.
 * API-Keys werden beim Einlegen verschlüsselt (AES-256-GCM) und nirgendwo
 * im Klartext zurückgegeben (nur `hasApiKey`).
 */

import type { ModelSettings, ProviderType } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createProvider,
	deleteProvider,
	getProvider,
	listInstances,
	listProviders,
	updateProvider,
} from "../db/repositories.js"
import { encryptString } from "../security/keys.js"

const PROVIDER_TYPES: ProviderType[] = ["ollama", "lmstudio", "openai-compat", "openrouter", "openai"]

interface CreateBody {
	type: string
	label?: string
	baseUrl: string
	apiKey?: string
	config?: Record<string, unknown>
	modelSettings?: ModelSettings
}

interface PatchBody {
	label?: string
	baseUrl?: string
	enabled?: boolean
	config?: Record<string, unknown>
	/** "null" = zurücksetzen, weggelassen = unverändert. */
	modelSettings?: ModelSettings | null
	apiKey?: string
	clearApiKey?: boolean
}

export function registerProviders(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/providers", () => {
		return listProviders(ctx.db).map((p) => {
			const insts = listInstances(ctx.db, p.id)
			return { ...p, instanceCount: insts.filter((i) => i.enabled).length }
		})
	})

	app.post<{ Body: CreateBody }>("/api/providers", (req, reply) => {
		const { type, baseUrl, label, apiKey, config } = req.body ?? {}
		if (!type || !PROVIDER_TYPES.includes(type as ProviderType)) {
			return reply.code(400).send({ error: `type muss einer von ${PROVIDER_TYPES.join(", ")} sein` })
		}
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
			return reply.code(400).send({ error: "baseUrl muss eine http(s)-URL sein" })
		}
		const { modelSettings } = req.body ?? {}
		const provider = createProvider(ctx.db, {
			type: type as ProviderType,
			label: label || type,
			baseUrl,
			config,
			modelSettings: modelSettings ?? null,
			apiKeyEnc: apiKey ? encryptString(apiKey, ctx.secret) : undefined,
		})
		try {
			ctx.registry.register(provider.id, provider.type, provider.baseUrl, provider.label)
		} catch (e) {
			return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
		}
		ctx.registry
			.checkHealth(provider.id)
			.then(() => ctx.registry.refreshDiscovery(provider.id))
			.catch(() => {
				/* Health-Status wird per SSE gemeldet */
			})
		return reply.code(201).send(provider)
	})

	app.get<{ Params: { id: string } }>("/api/providers/:id", (req, reply) => {
		const provider = getProvider(ctx.db, req.params.id)
		if (!provider) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		const instances = listInstances(ctx.db, provider.id)
		return { ...provider, instanceCount: instances.filter((i) => i.enabled).length, instances }
	})

	app.get<{ Params: { id: string } }>("/api/providers/:id/load", (req, reply) => {
		const adapter = ctx.registry.adapter(req.params.id)
		if (!adapter?.loadInfo) {
			return reply.code(404).send({ error: "Provider unterstützt keine Load-Info" })
		}
		return adapter
			.loadInfo()
			.then((info) => ({ providerId: req.params.id, ...info }))
			.catch(() => reply.code(502).send({ error: "Load-Info nicht verfügbar" }))
	})

	app.patch<{ Params: { id: string }; Body: PatchBody }>("/api/providers/:id", (req, reply) => {
		const body = req.body ?? {}
		if (body.baseUrl !== undefined && !/^https?:\/\//.test(body.baseUrl)) {
			return reply.code(400).send({ error: "baseUrl muss eine http(s)-URL sein" })
		}
		if (body.label !== undefined && body.label.trim().length === 0) {
			return reply.code(400).send({ error: "label darf nicht leer sein" })
		}
		const provider = updateProvider(ctx.db, req.params.id, {
			...body,
			apiKeyEnc: body.apiKey ? encryptString(body.apiKey, ctx.secret) : undefined,
		})
		if (!provider) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		// Adapter neu anlegen (BaseUrl/Key können sich geändert haben).
		ctx.registry.unregister(provider.id)
		if (provider.enabled) {
			ctx.registry.register(provider.id, provider.type, provider.baseUrl, provider.label)
			ctx.registry
				.checkHealth(provider.id)
				.then(() => ctx.registry.refreshDiscovery(provider.id))
				.catch(() => {
					/* SSE meldet Status */
				})
		}
		return provider
	})

	app.delete<{ Params: { id: string } }>("/api/providers/:id", (req, reply) => {
		ctx.registry.unregister(req.params.id)
		if (!deleteProvider(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		return reply.code(204).send()
	})

	app.post<{ Params: { id: string } }>("/api/providers/:id/health", async (req, reply) => {
		const provider = getProvider(ctx.db, req.params.id)
		if (!provider) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		if (!ctx.registry.providerIds.includes(req.params.id)) {
			ctx.registry.register(provider.id, provider.type, provider.baseUrl, provider.label)
		}
		const ok = await ctx.registry.checkHealth(req.params.id)
		const updated = getProvider(ctx.db, req.params.id)
		return { ok, provider: updated }
	})

	app.post<{ Params: { id: string } }>("/api/providers/:id/discover", async (req, reply) => {
		const provider = getProvider(ctx.db, req.params.id)
		if (!provider) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		if (!ctx.registry.providerIds.includes(req.params.id)) {
			ctx.registry.register(provider.id, provider.type, provider.baseUrl, provider.label)
		}
		try {
			await ctx.registry.refreshDiscovery(req.params.id)
		} catch (e) {
			return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
		}
		return { instances: listInstances(ctx.db, req.params.id) }
	})
}
