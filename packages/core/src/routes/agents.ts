/**
 * Agenten- (Spezialisten) & Swarm-Routen (M1): CRUD + Validierung.
 * Die Zuordnungs-Entscheidung trifft die Engine (`task.agent_selected`);
 * hier wird nur verwaltet: Spezialist, Rollen, Pins, Swarm-Mitgliedschaft.
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	type AgentPrivacy,
	appendChangelogEntry,
	blueprintAgentId,
	type Capability,
	isAgentDocKind,
	type ModelSettings,
	parseInitDoc,
	renderInitDoc,
	SOFTWARE_TEAM,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createAgent,
	createSwarm,
	deleteAgent,
	deleteSwarm,
	getAgent,
	getAgentDoc,
	listAgentDocs,
	listAgents,
	listSwarms,
	saveAgentDoc,
	updateAgent,
	updateSwarm,
} from "../db/repositories.js"
import { refreshCatalogAgents, refreshCatalogSwarms, seedTeamCatalog } from "../db/seed.js"

const CAPABILITIES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]
const PRIVACIES: AgentPrivacy[] = ["any", "local-only", "allow-cloud"]

interface AgentBody {
	name?: string
	description?: string
	systemPrompt?: string
	requiredCapabilities?: string[]
	preferredCapabilities?: string[]
	privacy?: string
	pinnedProviderId?: string | null
	pinnedInstanceId?: string | null
	/** Model-Voreinstellungen — schreibt zugleich das `init.md` des Agenten. */
	modelSettings?: ModelSettings | null
	enabled?: boolean
}

/** Feld-Labels für den automatischen Changelog-Eintrag beim Bearbeiten. */
const FIELD_LABELS: Record<string, string> = {
	name: "Name",
	description: "Beschreibung",
	systemPrompt: "System-Prompt",
	requiredCapabilities: "Pflicht-Fähigkeiten",
	preferredCapabilities: "Wunsch-Fähigkeiten",
	privacy: "Privacy",
	pinnedProviderId: "Rechner-Pin",
	pinnedInstanceId: "Modell-Pin",
	modelSettings: "Model-Voreinstellungen",
	enabled: "Status",
}

function validateAgentBody(body: AgentBody): string | undefined {
	for (const cap of [...(body.requiredCapabilities ?? []), ...(body.preferredCapabilities ?? [])]) {
		if (!CAPABILITIES.includes(cap as Capability)) {
			return `Fähigkeiten müssen aus ${CAPABILITIES.join(", ")} kommen`
		}
	}
	if (body.privacy !== undefined && !PRIVACIES.includes(body.privacy as AgentPrivacy)) {
		return `privacy muss einer von ${PRIVACIES.join(", ")} sein`
	}
	return undefined
}

/** Was hat sich beim Bearbeiten wirklich geändert? (für `changelog.md`) */
function changedFields(before: Record<string, unknown>, body: AgentBody): string[] {
	const changed: string[] = []
	for (const [key, value] of Object.entries(body)) {
		if (value === undefined || !(key in FIELD_LABELS)) {
			continue
		}
		if (JSON.stringify(value ?? null) !== JSON.stringify(before[key] ?? null)) {
			changed.push(FIELD_LABELS[key] ?? key)
		}
	}
	return changed
}

export function registerAgents(app: FastifyInstance, ctx: AppContext): void {
	/* ------------------------------- Spezialisten ------------------------------ */

	app.get("/api/agents", () => {
		return listAgents(ctx.db)
	})

	app.post<{ Body: AgentBody }>("/api/agents", (req, reply) => {
		const body = req.body ?? {}
		if (!body.name?.trim()) {
			return reply.code(400).send({ error: "name ist erforderlich" })
		}
		const err = validateAgentBody(body)
		if (err) {
			return reply.code(400).send({ error: err })
		}
		const agent = createAgent(ctx.db, {
			name: body.name,
			description: body.description,
			systemPrompt: body.systemPrompt,
			requiredCapabilities: body.requiredCapabilities as Capability[] | undefined,
			preferredCapabilities: body.preferredCapabilities as Capability[] | undefined,
			privacy: body.privacy as AgentPrivacy | undefined,
			pinnedProviderId: body.pinnedProviderId ?? null,
			pinnedInstanceId: body.pinnedInstanceId ?? null,
			enabled: body.enabled,
			docs: body.modelSettings ? { init: renderInitDoc(body.modelSettings, body.name.trim()) } : undefined,
		})
		ctx.bus.emit({ event: "agents.changed", data: { agentId: agent.id } })
		return reply.code(201).send(agent)
	})

	/* ------------------------------ Team-Katalog ------------------------------ */

	/**
	 * Das eingebaute Software-Team: welcher Spezialist ist installiert, welcher
	 * fehlt. Gelöschte Katalog-Einträge kommen nicht von selbst zurück — über
	 * diese Route holt man sie bewusst zurück.
	 */
	app.get("/api/agents/catalog", () => {
		const installed = new Set(listAgents(ctx.db).map((a) => a.id))
		return {
			agents: SOFTWARE_TEAM.map((bp) => ({
				slug: bp.slug,
				name: bp.name,
				discipline: bp.discipline,
				description: bp.description,
				requiredCapabilities: bp.requiredCapabilities,
				preferredCapabilities: bp.preferredCapabilities,
				privacy: bp.privacy,
				installed: installed.has(blueprintAgentId(bp.slug)),
			})),
		}
	})

	/** Fehlende Katalog-Spezialisten und -Swarms anlegen (ohne Neustart). */
	app.post("/api/agents/catalog", (_req, reply) => {
		const seeded = seedTeamCatalog(ctx.db)
		const refreshedSwarms = refreshCatalogSwarms(ctx.db)
		const refreshedAgents = refreshCatalogAgents(ctx.db)
		if (
			seeded.agents.length > 0 ||
			seeded.swarms.length > 0 ||
			refreshedSwarms.length > 0 ||
			refreshedAgents.length > 0
		) {
			ctx.bus.emit({ event: "agents.changed", data: {} })
		}
		return reply.code(201).send({ ...seeded, refreshedSwarms, refreshedAgents })
	})

	app.get<{ Params: { id: string } }>("/api/agents/:id", (req, reply) => {
		const agent = getAgent(ctx.db, req.params.id)
		if (!agent) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		const swarms = listSwarms(ctx.db).filter((sw) => sw.enabled && sw.agentIds.includes(agent.id))
		return { ...agent, swarms, docs: listAgentDocs(ctx.db, agent.id) }
	})

	app.patch<{ Params: { id: string }; Body: AgentBody }>("/api/agents/:id", (req, reply) => {
		const body = req.body ?? {}
		const err = validateAgentBody(body)
		if (err) {
			return reply.code(400).send({ error: err })
		}
		const before = getAgent(ctx.db, req.params.id)
		if (!before) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		const changed = changedFields(before as unknown as Record<string, unknown>, body)
		// Model-Settings sind aus `init.md` abgeleitet — also dort hineinschreiben.
		if (body.modelSettings !== undefined) {
			saveAgentDoc(
				ctx.db,
				req.params.id,
				"init",
				renderInitDoc(body.modelSettings ?? {}, body.name?.trim() || before.name),
			)
		}
		const agent = updateAgent(ctx.db, req.params.id, {
			name: body.name,
			description: body.description,
			systemPrompt: body.systemPrompt,
			requiredCapabilities: body.requiredCapabilities as Capability[] | undefined,
			preferredCapabilities: body.preferredCapabilities as Capability[] | undefined,
			privacy: body.privacy as AgentPrivacy | undefined,
			pinnedProviderId: body.pinnedProviderId,
			pinnedInstanceId: body.pinnedInstanceId,
			enabled: body.enabled,
		})
		if (!agent) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		if (changed.length > 0) {
			const doc = getAgentDoc(ctx.db, agent.id, "changelog")
			saveAgentDoc(
				ctx.db,
				agent.id,
				"changelog",
				appendChangelogEntry(
					doc?.content ?? "",
					`Bearbeitet: ${changed.join(", ")}`,
					new Date().toISOString(),
				),
			)
		}
		ctx.bus.emit({ event: "agents.changed", data: { agentId: agent.id } })
		return agent
	})

	/* --------------------- Dokumente: plan/changelog/init.md -------------------- */

	app.get<{ Params: { id: string } }>("/api/agents/:id/docs", (req, reply) => {
		if (!getAgent(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		return { agentId: req.params.id, docs: listAgentDocs(ctx.db, req.params.id) }
	})

	app.put<{ Params: { id: string; kind: string }; Body: { content?: string } }>(
		"/api/agents/:id/docs/:kind",
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
			const doc = saveAgentDoc(ctx.db, id, kind as AgentDocKind, content)
			if (!doc) {
				return reply.code(404).send({ error: "Agent nicht gefunden" })
			}
			ctx.bus.emit({ event: "agents.changed", data: { agentId: id } })
			// `init.md` wirkt: die abgeleiteten Settings gleich zurückgeben.
			return { ...doc, settings: kind === "init" ? parseInitDoc(content) : undefined }
		},
	)

	app.delete<{ Params: { id: string } }>("/api/agents/:id", (req, reply) => {
		if (!deleteAgent(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		ctx.bus.emit({ event: "agents.changed", data: { agentId: req.params.id } })
		return reply.code(204).send()
	})

	/* ---------------------------------- Swarms --------------------------------- */

	interface SwarmBody {
		name?: string
		description?: string
		agentIds?: string[]
		enabled?: boolean
	}

	app.get("/api/swarms", () => {
		return listSwarms(ctx.db)
	})

	app.post<{ Body: SwarmBody }>("/api/swarms", (req, reply) => {
		const body = req.body ?? {}
		if (!body.name?.trim()) {
			return reply.code(400).send({ error: "name ist erforderlich" })
		}
		for (const id of body.agentIds ?? []) {
			if (!getAgent(ctx.db, id)) {
				return reply.code(400).send({ error: `Agent ${id} existiert nicht` })
			}
		}
		const swarm = createSwarm(ctx.db, {
			name: body.name,
			description: body.description,
			agentIds: body.agentIds,
			enabled: body.enabled,
		})
		ctx.bus.emit({ event: "swarms.changed", data: { swarmId: swarm.id } })
		return reply.code(201).send(swarm)
	})

	app.patch<{ Params: { id: string }; Body: SwarmBody }>("/api/swarms/:id", (req, reply) => {
		const body = req.body ?? {}
		for (const id of body.agentIds ?? []) {
			if (!getAgent(ctx.db, id)) {
				return reply.code(400).send({ error: `Agent ${id} existiert nicht` })
			}
		}
		const swarm = updateSwarm(ctx.db, req.params.id, {
			name: body.name,
			description: body.description,
			agentIds: body.agentIds,
			enabled: body.enabled,
		})
		if (!swarm) {
			return reply.code(404).send({ error: "Swarm nicht gefunden" })
		}
		ctx.bus.emit({ event: "swarms.changed", data: { swarmId: swarm.id } })
		return swarm
	})

	app.delete<{ Params: { id: string } }>("/api/swarms/:id", (req, reply) => {
		if (!deleteSwarm(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Swarm nicht gefunden" })
		}
		ctx.bus.emit({ event: "swarms.changed", data: { swarmId: req.params.id } })
		return reply.code(204).send()
	})
}
