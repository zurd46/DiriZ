/**
 * Agenten- (Spezialisten) & Swarm-Routen (M1): CRUD + Validierung.
 * Die Zuordnungs-Entscheidung trifft die Engine (`task.agent_selected`);
 * hier wird nur verwaltet: Spezialist, Rollen, Pins, Swarm-Mitgliedschaft.
 */

import type { AgentPrivacy, Capability } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createAgent,
	createSwarm,
	deleteAgent,
	deleteSwarm,
	getAgent,
	listAgents,
	listSwarms,
	updateAgent,
	updateSwarm,
} from "../db/repositories.js"

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
	enabled?: boolean
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
		})
		ctx.bus.emit({ event: "agents.changed", data: { agentId: agent.id } })
		return reply.code(201).send(agent)
	})

	app.get<{ Params: { id: string } }>("/api/agents/:id", (req, reply) => {
		const agent = getAgent(ctx.db, req.params.id)
		if (!agent) {
			return reply.code(404).send({ error: "Agent nicht gefunden" })
		}
		const swarms = listSwarms(ctx.db).filter((sw) => sw.enabled && sw.agentIds.includes(agent.id))
		return { ...agent, swarms }
	})

	app.patch<{ Params: { id: string }; Body: AgentBody }>("/api/agents/:id", (req, reply) => {
		const body = req.body ?? {}
		const err = validateAgentBody(body)
		if (err) {
			return reply.code(400).send({ error: err })
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
		ctx.bus.emit({ event: "agents.changed", data: { agentId: agent.id } })
		return agent
	})

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
