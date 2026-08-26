/**
 * Provider-Routen (`01-plan.md` §7.2): CRUD + Health-Check + Discovery.
 * API-Keys werden beim Einlegen verschlüsselt (AES-256-GCM) und nirgendwo
 * im Klartext zurückgegeben (nur `hasApiKey`).
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	appendChangelogEntry,
	isAgentDocKind,
	type ModelSettings,
	normalizeBaseUrl,
	type ProviderType,
	parseInitDoc,
	renderInitDoc,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createProvider,
	deleteProvider,
	getProvider,
	getProviderDoc,
	listInstances,
	listProviderDocs,
	listProviders,
	sameServerProviders,
	saveProviderDoc,
	updateProvider,
} from "../db/repositories.js"
import { encryptString } from "../security/keys.js"

const PROVIDER_TYPES: ProviderType[] = ["ollama", "lmstudio", "openai-compat", "openrouter", "openai"]

/** Feld-Labels für den automatischen Changelog-Eintrag beim Bearbeiten. */
const FIELD_LABELS: Record<string, string> = {
	label: "Name",
	baseUrl: "Base-URL",
	enabled: "Status",
	config: "Konfiguration",
	modelSettings: "Model-Voreinstellungen",
}

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
	/**
	 * Der Rechner, auf dem dieser Zugang rechnet.
	 *
	 * Nötig, wo DiriZ es nicht messen kann: Über einen Tunnel lässt sich der
	 * `lms`-Befehl nicht befragen, also weiss DiriZ nicht, dass der Tunnel
	 * denselben Windows-Rechner meint wie die per LM Link durchgereichten
	 * Modelle des Macs. Wer es weiss, trägt es hier ein — geraten wäre hier
	 * schlimmer als gefragt.
	 */
	deviceName?: string | null
	enabled?: boolean
	config?: Record<string, unknown>
	/** "null" = zurücksetzen, weggelassen = unverändert. */
	modelSettings?: ModelSettings | null
	apiKey?: string
	clearApiKey?: boolean
}

export function registerProviders(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/providers", () => {
		const alle = listProviders(ctx.db)
		return alle.map((p) => {
			const insts = listInstances(ctx.db, p.id)
			// **Welche Einträge auf dieselbe Maschine zeigen.**
			//
			// Nachgewiesen und für den Nutzer sonst unsichtbar: `MacDani`
			// (127.0.0.1) und `lokalai` (Tunnel) sind derselbe Rechner — auf dem
			// Mac vermittelt LM Studio per LM Link an den anderen PC. Wer das
			// nicht weiss, wundert sich, warum zwei „Rechner" sich gegenseitig
			// die Modelle aus dem Speicher werfen.
			const gruppe = sameServerProviders(ctx.db, p.id)
				.filter((id) => id !== p.id)
				.map((id) => alle.find((q) => q.id === id)?.label ?? id)
			// **Auf welchen Rechnern die Modelle dieses Zugangs wirklich rechnen.**
			//
			// Bei LM Studio mit „LM Link" ist das nicht zwingend der Rechner des
			// Endpunkts: Der Mac reicht die Modelle eines Windows-Rechners durch.
			// Wer das nicht sieht, sucht Engpässe am falschen Ort.
			const erklaert = typeof p.config?.deviceName === "string" ? p.config.deviceName : undefined
			const devices = [...new Set([...insts.map((i) => i.deviceName), erklaert].filter(Boolean))] as string[]
			return {
				...p,
				instanceCount: insts.filter((i) => i.enabled).length,
				sameMachineAs: gruppe,
				devices,
			}
		})
	})

	app.post<{ Body: CreateBody }>("/api/providers", (req, reply) => {
		const { type, baseUrl, label, apiKey, config } = req.body ?? {}
		if (!type || !PROVIDER_TYPES.includes(type as ProviderType)) {
			return reply.code(400).send({ error: `type muss einer von ${PROVIDER_TYPES.join(", ")} sein` })
		}
		// **Was gespeichert wird, muss stimmen.**
		//
		// Wer einen Schlüssel hinterlegt, meint den Dienst — nicht den eigenen
		// Rechner. Genau das ging schief: Die Maske gab `http://localhost:11434`
		// vor, und der Wert wurde auch für einen OpenRouter-Zugang gespeichert.
		const adresse = normalizeBaseUrl(type, baseUrl)
		if (!adresse || !/^https?:\/\//.test(adresse)) {
			return reply.code(400).send({ error: "baseUrl muss eine http(s)-URL sein" })
		}
		const { modelSettings } = req.body ?? {}
		const provider = createProvider(ctx.db, {
			type: type as ProviderType,
			label: label || type,
			baseUrl: adresse,
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
		const before = getProvider(ctx.db, req.params.id)
		if (!before) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		// Model-Settings sind aus `init.md` abgeleitet — also dort hineinschreiben.
		const { modelSettings, deviceName, ...rest } = body
		if (rest.baseUrl !== undefined) {
			rest.baseUrl = normalizeBaseUrl(before.type, rest.baseUrl)
		}
		if (deviceName !== undefined) {
			const config = { ...(before.config ?? {}) }
			if (deviceName === null || deviceName.trim() === "") {
				delete config.deviceName
			} else {
				config.deviceName = deviceName.trim()
			}
			rest.config = { ...config, ...(rest.config ?? {}) }
		}
		if (modelSettings !== undefined) {
			saveProviderDoc(
				ctx.db,
				req.params.id,
				"init",
				renderInitDoc(modelSettings ?? {}, body.label?.trim() || before.label),
			)
		}
		const provider = updateProvider(ctx.db, req.params.id, {
			...rest,
			apiKeyEnc: body.apiKey ? encryptString(body.apiKey, ctx.secret) : undefined,
		})
		if (!provider) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		const changed = Object.entries(body)
			.filter(([key, value]) => value !== undefined && key in FIELD_LABELS)
			.filter(
				([key, value]) =>
					JSON.stringify(value ?? null) !==
					JSON.stringify((before as unknown as Record<string, unknown>)[key] ?? null),
			)
			.map(([key]) => FIELD_LABELS[key] ?? key)
		if (changed.length > 0) {
			saveProviderDoc(
				ctx.db,
				provider.id,
				"changelog",
				appendChangelogEntry(
					getProviderDoc(ctx.db, provider.id, "changelog")?.content ?? "",
					`Bearbeitet: ${changed.join(", ")}`,
					new Date().toISOString(),
				),
			)
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

	/* --------------------- Dokumente: plan/changelog/init.md -------------------- */

	app.get<{ Params: { id: string } }>("/api/providers/:id/docs", (req, reply) => {
		if (!getProvider(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Provider nicht gefunden" })
		}
		return { providerId: req.params.id, docs: listProviderDocs(ctx.db, req.params.id) }
	})

	app.put<{ Params: { id: string; kind: string }; Body: { content?: string } }>(
		"/api/providers/:id/docs/:kind",
		(req, reply) => {
			const { id, kind } = req.params
			if (!isAgentDocKind(kind)) {
				return reply
					.code(400)
					.send({ error: `kind muss einer von ${Object.values(AGENT_DOC_FILES).join(", ")} sein` })
			}
			const content = req.body?.content
			if (typeof content !== "string") {
				return reply.code(400).send({ error: "content ist erforderlich" })
			}
			const doc = saveProviderDoc(ctx.db, id, kind as AgentDocKind, content)
			if (!doc) {
				return reply.code(404).send({ error: "Provider nicht gefunden" })
			}
			// `init.md` wirkt: die abgeleiteten Settings gleich zurückgeben.
			return { ...doc, settings: kind === "init" ? parseInitDoc(content) : undefined }
		},
	)

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
