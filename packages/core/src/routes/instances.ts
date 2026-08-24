/**
 * Instance-Routen: Modelle pro Provider — Übersicht, manuelle Korrektur
 * (Context-Fenster, Fähigkeiten, Sprachen, Preis), Entfernen.
 *
 * Jedes Modell führt drei Dokumente (`llm.md`, `changelog.md`, `init.md`).
 * Anders als ein Spezialist bekommt es **keinen** Auftrag (`plan.md`), sondern
 * ein Datenblatt: `llm.md` beschreibt Fähigkeiten, Kontext-Fenster, Stärken und
 * Schwächen — und ist damit die Quelle der Wahrheit für die Orchestrierung.
 * `init.md` setzt wie gehabt die Model-Voreinstellungen.
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	appendChangelogEntry,
	type Capability,
	docKindsFor,
	isAgentDocKind,
	type ModelSettings,
	parseInitDoc,
	parseLlmDoc,
	renderInitDoc,
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

/** Feld-Labels für den automatischen Changelog-Eintrag beim Bearbeiten. */
const FIELD_LABELS: Record<string, string> = {
	displayName: "Anzeigename",
	contextWindow: "Kontext-Fenster",
	capabilities: "Fähigkeiten",
	languages: "Sprachen",
	quantization: "Quantisierung",
	priceInPerMTok: "Preis (in)",
	priceOutPerMTok: "Preis (out)",
	modelSettings: "Model-Voreinstellungen",
	enabled: "Status",
}

export function registerInstances(app: FastifyInstance, ctx: AppContext): void {
	app.get<{ Querystring: { providerId?: string } }>("/api/instances", (req) => {
		return listInstances(ctx.db, req.query.providerId)
	})

	app.patch<{ Params: { id: string }; Body: InstancePatchBody }>("/api/instances/:id", (req, reply) => {
		const body = req.body ?? {}
		if (body.capabilities?.some((c) => !CAPABILITIES.includes(c as Capability))) {
			return reply.code(400).send({ error: `capabilities muss aus ${CAPABILITIES.join(", ")} kommen` })
		}
		const before = getInstance(ctx.db, req.params.id)
		if (!before) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		// Model-Settings sind aus `init.md` abgeleitet — also dort hineinschreiben.
		if (body.modelSettings !== undefined) {
			saveInstanceDoc(
				ctx.db,
				req.params.id,
				"init",
				renderInitDoc(body.modelSettings ?? {}, body.displayName?.trim() || before.displayName),
			)
		}
		// Fähigkeiten und Kontext-Fenster stehen im `llm.md` — dorthin zurück,
		// sonst überschreibt der nächste Speichervorgang im Dokument die Eingabe.
		if (body.capabilities !== undefined || body.contextWindow !== undefined) {
			const doc = getInstanceDoc(ctx.db, req.params.id, "llm")
			if (doc) {
				saveInstanceDoc(
					ctx.db,
					req.params.id,
					"llm",
					updateLlmDoc(doc.content, {
						capabilities: body.capabilities as Capability[] | undefined,
						contextWindow: body.contextWindow,
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
		const changed = Object.entries(body)
			.filter(([key, value]) => value !== undefined && key in FIELD_LABELS)
			.filter(
				([key, value]) =>
					JSON.stringify(value ?? null) !==
					JSON.stringify((before as unknown as Record<string, unknown>)[key] ?? null),
			)
			.map(([key]) => FIELD_LABELS[key] ?? key)
		if (changed.length > 0) {
			const doc = getInstanceDoc(ctx.db, instance.id, "changelog")
			saveInstanceDoc(
				ctx.db,
				instance.id,
				"changelog",
				appendChangelogEntry(
					doc?.content ?? "",
					`Bearbeitet: ${changed.join(", ")}`,
					new Date().toISOString(),
				),
			)
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
			// Beide wirksamen Dokumente geben zurück, was der Core daraus gelesen
			// hat — die UI zeigt damit ohne zweite Anfrage die Wirkung an.
			return {
				...doc,
				settings: kind === "init" ? parseInitDoc(content) : undefined,
				spec: kind === "llm" ? parseLlmDoc(content) : undefined,
			}
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
