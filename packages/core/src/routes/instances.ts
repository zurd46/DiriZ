/**
 * Instance-Routen: Modelle pro Provider — Übersicht, manuelle Korrektur
 * (Context-Fenster, Fähigkeiten, Sprachen, Preis), Entfernen.
 *
 * Jedes Modell führt **genau ein** Dokument: `llm.md`, sein Datenblatt. Es
 * beschreibt Fähigkeiten, Kontext-Fenster, Werkzeuge, Stärken, Schwächen und
 * die Voreinstellungen — und ist damit die Quelle der Wahrheit für die
 * Orchestrierung. Einen Auftrag (`plan.md`) und ein Änderungsprotokoll führt
 * ein Modell nicht; das gehört zur Arbeit, nicht zum Werkzeug.
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	type Capability,
	docKindsFor,
	isAgentDocKind,
	type ModelSettings,
	parseLlmDoc,
	updateLlmDoc,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	deleteInstance,
	getInstance,
	getInstanceDoc,
	listInstanceDocs,
	listInstances,
	saveInstanceDoc,
	throughputByInstance,
	updateInstance,
} from "../db/repositories.js"

const CAPABILITIES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]

interface InstancePatchBody {
	displayName?: string
	contextWindow?: number
	capabilities?: string[]
	languages?: string[]
	quantization?: string
	priceInPerMTok?: number
	priceOutPerMTok?: number
	/** "null" = Overrides zurücksetzen, weggelassen = unverändert. Schreibt `init.md`. */
	modelSettings?: ModelSettings | null
	/** Modell auf diesem Rechner aktivieren/deaktivieren (Routing-Gate). */
	enabled?: boolean
}

export function registerInstances(app: FastifyInstance, ctx: AppContext): void {
	app.get<{ Querystring: { providerId?: string } }>("/api/instances", (req) => {
		// Gemessenes Tempo mitliefern: Es entscheidet im Routing mit und ist die
		// Antwort auf „warum dauert das so lange?" — es gehört vor Augen, nicht
		// nur in die Formel.
		const tempo = throughputByInstance(ctx.db)
		return listInstances(ctx.db, req.query.providerId).map((i) => ({
			...i,
			tokensPerSecond: tempo.get(i.id),
		}))
	})

	/**
	 * Alle Modelle eines Rechners auf einmal an- oder abschalten.
	 *
	 * Ein OpenRouter-Zugang bringt 417 Modelle mit, ein OpenAI-Zugang 132.
	 * Die einzeln abzuwählen sind vierhundert Klicks und vierhundert Anfragen —
	 * beobachtet, und der Grund für diesen Endpunkt: eine Anfrage, eine
	 * Transaktion.
	 */
	app.post<{ Params: { id: string }; Body: { enabled?: boolean; ids?: string[] } }>(
		"/api/providers/:id/instances/enabled",
		(req, reply) => {
			const enabled = req.body?.enabled
			if (typeof enabled !== "boolean") {
				return reply.code(400).send({ error: "enabled muss true oder false sein" })
			}
			const alle = listInstances(ctx.db, req.params.id)
			if (alle.length === 0) {
				return reply.code(404).send({ error: "Rechner nicht gefunden oder ohne Modelle" })
			}
			const nur = req.body?.ids?.length ? new Set(req.body.ids) : undefined
			const betroffen = alle.filter((i) => (nur ? nur.has(i.id) : true) && i.enabled !== enabled)
			const stmt = ctx.db.prepare("UPDATE instances SET enabled = ? WHERE id = ?")
			const alsEines = ctx.db.transaction((liste: typeof betroffen) => {
				for (const i of liste) {
					stmt.run(enabled ? 1 : 0, i.id)
				}
			})
			alsEines(betroffen)
			return { changed: betroffen.length, enabled }
		},
	)

	app.patch<{ Params: { id: string }; Body: InstancePatchBody }>("/api/instances/:id", (req, reply) => {
		const body = req.body ?? {}
		if (body.capabilities?.some((c) => !CAPABILITIES.includes(c as Capability))) {
			return reply.code(400).send({ error: `capabilities muss aus ${CAPABILITIES.join(", ")} kommen` })
		}
		const before = getInstance(ctx.db, req.params.id)
		if (!before) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		// Alles, was das Formular ändert, steht im Datenblatt — dorthin zurück,
		// sonst überschreibt der nächste Speichervorgang im Dokument die Eingabe.
		if (
			body.capabilities !== undefined ||
			body.contextWindow !== undefined ||
			body.modelSettings !== undefined
		) {
			const doc = getInstanceDoc(ctx.db, req.params.id, "llm")
			if (doc) {
				saveInstanceDoc(
					ctx.db,
					req.params.id,
					"llm",
					updateLlmDoc(doc.content, {
						capabilities: body.capabilities as Capability[] | undefined,
						contextWindow: body.contextWindow,
						settings: body.modelSettings,
					}),
				)
			}
		}
		const instance = updateInstance(ctx.db, req.params.id, {
			displayName: body.displayName,
			contextWindow: body.contextWindow,
			capabilities: body.capabilities as Capability[] | undefined,
			languages: body.languages,
			quantization: body.quantization,
			priceInPerMTok: body.priceInPerMTok,
			priceOutPerMTok: body.priceOutPerMTok,
			enabled: body.enabled,
		})
		if (!instance) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		return instance
	})

	/* --------------------- Dokumente: plan/changelog/init.md -------------------- */

	app.get<{ Params: { id: string } }>("/api/instances/:id/docs", (req, reply) => {
		if (!getInstance(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		return { instanceId: req.params.id, docs: listInstanceDocs(ctx.db, req.params.id) }
	})

	app.put<{ Params: { id: string; kind: string }; Body: { content?: string } }>(
		"/api/instances/:id/docs/:kind",
		(req, reply) => {
			const { id, kind } = req.params
			const allowed = docKindsFor("instance")
			if (!isAgentDocKind(kind) || !allowed.includes(kind)) {
				return reply
					.code(400)
					.send({ error: `kind muss einer von ${allowed.map((k) => AGENT_DOC_FILES[k]).join(", ")} sein` })
			}
			const content = req.body?.content
			if (typeof content !== "string") {
				return reply.code(400).send({ error: "content ist erforderlich" })
			}
			const doc = saveInstanceDoc(ctx.db, id, kind as AgentDocKind, content)
			if (!doc) {
				return reply.code(404).send({ error: "Instance nicht gefunden" })
			}
			// Das Datenblatt wirkt: zurückgeben, was der Core daraus gelesen hat —
			// die UI zeigt die Wirkung ohne zweite Anfrage an.
			const spec = kind === "llm" ? parseLlmDoc(content) : undefined
			return { ...doc, spec, settings: spec?.settings }
		},
	)

	app.delete<{ Params: { id: string } }>("/api/instances/:id", (req, reply) => {
		const instance = getInstance(ctx.db, req.params.id)
		if (!instance) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		if (!deleteInstance(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		return reply.code(204).send()
	})
}
