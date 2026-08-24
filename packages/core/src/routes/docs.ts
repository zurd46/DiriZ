/**
 * Dokument-Übersicht (M9): ein Aufruf liefert **alle** Deklarations-Dokumente
 * über alle drei Ebenen — Rechner (Provider), Modell (Instanz), Spezialist.
 * Welche Dokumente eine Ebene führt, sagt `DOC_KINDS`: Rechner und Spezialist
 * haben einen Auftrag (`plan.md`), ein Modell hat ein Datenblatt (`llm.md`).
 *
 * Die Dokumente-Ansicht im Web braucht das, um über den gesamten Bestand
 * suchen zu können, ohne pro Besitzer eine eigene Anfrage zu stellen.
 * Geschrieben wird weiterhin über die jeweilige Ebene
 * (`PUT /api/{providers|instances|agents}/:id/docs/:kind`).
 */

import type { AgentDocKind, DocOwnerKind } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	listAgentDocs,
	listAgents,
	listInstanceDocs,
	listInstances,
	listProviderDocs,
	listProviders,
} from "../db/repositories.js"

/** Ein Besitzer mit seinen drei Dokumenten. */
interface DocOwner {
	kind: DocOwnerKind
	id: string
	name: string
	/** Basis-Pfad zum Schreiben, z. B. `/api/agents/<id>`. */
	basePath: string
	/** Nur bei Modellen: auf welchem Rechner sie liegen. */
	providerId?: string
	providerLabel?: string
	/** Zusatzinfo für die Liste (Modell-ID, Provider-Typ, …). */
	detail?: string
	/** Ob der Besitzer aktiv ist — deaktivierte werden ausgegraut. */
	enabled: boolean
	docs: Record<AgentDocKind, string>
	updatedAt: string
}

function toMap(docs: { kind: AgentDocKind; content: string; updatedAt: string }[]): {
	content: Record<AgentDocKind, string>
	updatedAt: string
} {
	const content = { plan: "", llm: "", changelog: "", init: "" } as Record<AgentDocKind, string>
	let updatedAt = ""
	for (const doc of docs) {
		content[doc.kind] = doc.content
		if (doc.updatedAt > updatedAt) {
			updatedAt = doc.updatedAt
		}
	}
	return { content, updatedAt }
}

export function registerDocs(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/docs", () => {
		const owners: DocOwner[] = []

		for (const provider of listProviders(ctx.db)) {
			const { content, updatedAt } = toMap(listProviderDocs(ctx.db, provider.id))
			owners.push({
				kind: "provider",
				id: provider.id,
				name: provider.label,
				basePath: `/api/providers/${provider.id}`,
				detail: `${provider.type} · ${provider.baseUrl}`,
				enabled: provider.enabled,
				docs: content,
				updatedAt,
			})
			for (const instance of listInstances(ctx.db, provider.id)) {
				const inst = toMap(listInstanceDocs(ctx.db, instance.id))
				owners.push({
					kind: "instance",
					id: instance.id,
					name: instance.displayName,
					basePath: `/api/instances/${instance.id}`,
					providerId: provider.id,
					providerLabel: provider.label,
					detail: instance.modelId,
					enabled: instance.enabled,
					docs: inst.content,
					updatedAt: inst.updatedAt,
				})
			}
		}

		for (const agent of listAgents(ctx.db)) {
			const { content, updatedAt } = toMap(listAgentDocs(ctx.db, agent.id))
			owners.push({
				kind: "agent",
				id: agent.id,
				name: agent.name,
				basePath: `/api/agents/${agent.id}`,
				detail: agent.description || undefined,
				enabled: agent.enabled,
				docs: content,
				updatedAt,
			})
		}

		return { owners }
	})
}
