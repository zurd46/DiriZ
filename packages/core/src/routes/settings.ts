/**
 * Settings-, Export- & Import-Routen (`01-plan.md` §6.2, M7):
 * - Routing-Gewichte (ScoringWeights) lesen/speichern — der Engine liest sie pro Entscheidung.
 * - Export: Tasks, Agenten, Swarms, Templates + Settings als JSON-Dokument.
 * - Import: Upsert derselben Entitäten (keine Provider/Keys — bewusst ausgeschlossen).
 */

import {
	type AgentDocKind,
	type AgentSettings,
	type ConcurrencySettings,
	DEFAULT_WEIGHTS,
	type DocTemplateSettings,
	docKindsFor,
	type GitSettings,
	isAgentDocKind,
	normalizeWeights,
	type ScoringWeights,
	type TimeoutSettings,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createAgent,
	createSwarm,
	createTemplate,
	getDocTemplates,
	getSetting,
	listAgentDocs,
	listAgents,
	listSwarms,
	listTasks,
	listTemplates,
	saveAgentDoc,
	setSetting,
	updateAgent,
	updateSwarm,
	updateTemplate,
} from "../db/repositories.js"
import { DEFAULT_RETENTION, type RetentionSettings } from "../db/retention.js"
import { DEFAULT_POWER_COST, type PowerCostSettings } from "../execution/powercost.js"
import type { CommandPolicy } from "../execution/tools.js"
import { DEFAULT_WARMUP, type WarmupSettings } from "../execution/warmup.js"
import { DEFAULT_ROUTER_MODEL, type RouterModelSettings } from "../routing/llmRouter.js"

const WEIGHT_KEYS: (keyof ScoringWeights)[] = [
	"contextFit",
	"capabilityMatch",
	"qualityPrior",
	"loadScore",
	"costScore",
	"latencyScore",
]

/**
 * Parallelitäts- und GPU-Grenzen. Nur ganze Zahlen ≥ 1 — eine 0 würde jedes
 * Routing blockieren, ein Bruch wäre sinnlos. Fehlende Felder behalten ihren
 * bisherigen Wert, damit ein Teil-Update nichts stillschweigend zurücksetzt.
 */
function parseConcurrency(
	body: Partial<ConcurrencySettings>,
	current: ConcurrencySettings,
): ConcurrencySettings | undefined {
	const keys: (keyof ConcurrencySettings)[] = ["global", "perProvider", "maxModelsPerProvider"]
	const next = { ...current }
	for (const key of keys) {
		const v = body[key]
		if (v === undefined) {
			continue
		}
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
			return undefined
		}
		next[key] = v
	}
	return next
}

/** M8: optionale 7. Achse — darf beim PUT fehlen (Backward-Kompatibilität). */
// Später hinzugekommene Achsen sind optional: Ein Client, der sie nicht
// kennt, soll die Einstellungen weiterhin speichern können (er schaltet die
// Achse damit auf 0 — sichtbar in der Oberfläche, nicht stillschweigend).
const OPTIONAL_WEIGHT_KEYS: (keyof ScoringWeights)[] = ["hostLoad", "specFit", "providerSpread", "throughput"]

function parseWeights(body: unknown): ScoringWeights | undefined {
	if (!body || typeof body !== "object") {
		return undefined
	}
	const raw = body as Record<string, unknown>
	for (const key of WEIGHT_KEYS) {
		const v = raw[key]
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return undefined
		}
	}
	for (const key of OPTIONAL_WEIGHT_KEYS) {
		const v = raw[key]
		if (v === undefined) {
			continue
		}
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return undefined
		}
	}
	return normalizeWeights(raw as unknown as ScoringWeights)
}

/**
 * Vorlagen für die Dokumente — je Besitzer-Art
 * (`provider`, `instance`, `agent`). Leere Strings bedeuten „eingebaute
 * Vorlage nutzen“ und werden verworfen. `undefined` bei ungültiger Struktur.
 */
function parseDocTemplates(body: unknown): DocTemplateSettings | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return undefined
	}
	const result: DocTemplateSettings = {}
	for (const owner of ["provider", "instance", "agent"] as const) {
		const group = (body as Record<string, unknown>)[owner]
		if (group === undefined || group === null) {
			continue
		}
		if (typeof group !== "object" || Array.isArray(group)) {
			return undefined
		}
		const entries: Record<string, string> = {}
		// Je Ebene nur ihre eigenen Arten — eine Vorlage für ein `plan.md` am
		// Modell hätte nichts, worauf sie wirken könnte.
		for (const kind of docKindsFor(owner)) {
			const value = (group as Record<string, unknown>)[kind]
			if (value === undefined || value === null) {
				continue
			}
			if (typeof value !== "string") {
				return undefined
			}
			if (value.trim().length > 0) {
				entries[kind] = value
			}
		}
		if (Object.keys(entries).length > 0) {
			result[owner] = entries
		}
	}
	return result
}

export function registerSettings(app: FastifyInstance, ctx: AppContext): void {
	/**
	 * Zeitgrenzen: nur ganze Millisekunden ≥ 5000. Kürzere Fristen wären keine
	 * Einstellung, sondern eine Garantie fürs Scheitern.
	 */
	const parseTimeouts = (
		body: Partial<TimeoutSettings>,
		current: TimeoutSettings,
	): TimeoutSettings | undefined => {
		const keys: (keyof TimeoutSettings)[] = ["firstChunkMs", "chunkMs", "totalMs"]
		const next = { ...current }
		for (const key of keys) {
			const v = body[key]
			if (v === undefined) {
				continue
			}
			if (typeof v !== "number" || !Number.isInteger(v) || v < 5000) {
				return undefined
			}
			next[key] = v
		}
		return next
	}

	const currentSettings = () => ({
		routingWeights: normalizeWeights(
			getSetting<ScoringWeights>(ctx.db, "routing_weights") ?? DEFAULT_WEIGHTS,
		),
		docTemplates: getDocTemplates(ctx.db) ?? {},
		concurrency: ctx.engine.limits(),
		timeouts: ctx.engine.timeouts(),
		git: ctx.engine.gitSettings(),
		agent: ctx.engine.agentSettings(),
		warmup: { ...DEFAULT_WARMUP, ...getSetting<Partial<WarmupSettings>>(ctx.db, "warmup") },
		retention: { ...DEFAULT_RETENTION, ...getSetting<Partial<RetentionSettings>>(ctx.db, "retention") },
		commands: ctx.engine.commandPolicy(),
		// T1-3: Router-Modell — Default aus, die Heuristik bleibt der Weg.
		routerModel: {
			...DEFAULT_ROUTER_MODEL,
			...getSetting<Partial<RouterModelSettings>>(ctx.db, "routerModel"),
		},
		// T2-7: UI-Theme — Dark ist der Default, Light ist opt-in.
		theme: (getSetting<string>(ctx.db, "uiTheme") ?? "dark") as "dark" | "light",
		// T3-13: Stromkosten für lokale Läufe — Defaults, wenn nichts gesetzt.
		powerCost: {
			...DEFAULT_POWER_COST,
			...getSetting<Partial<PowerCostSettings>>(ctx.db, "powerCost"),
		},
	})

	app.get("/api/settings", () => currentSettings())

	app.put<{
		Body: {
			routingWeights?: ScoringWeights
			docTemplates?: DocTemplateSettings
			concurrency?: Partial<ConcurrencySettings>
			timeouts?: Partial<TimeoutSettings>
			git?: Partial<GitSettings>
			agent?: Partial<AgentSettings>
			warmup?: Partial<WarmupSettings>
			retention?: Partial<RetentionSettings>
			commands?: Partial<CommandPolicy>
			routerModel?: Partial<RouterModelSettings>
			theme?: "dark" | "light"
			powerCost?: Partial<PowerCostSettings>
		}
	}>("/api/settings", (req, reply) => {
		const body = req.body ?? {}
		if (
			body.routingWeights === undefined &&
			body.docTemplates === undefined &&
			body.concurrency === undefined &&
			body.timeouts === undefined &&
			body.git === undefined &&
			body.agent === undefined &&
			body.warmup === undefined &&
			body.retention === undefined &&
			body.commands === undefined &&
			body.routerModel === undefined &&
			body.theme === undefined &&
			body.powerCost === undefined
		) {
			return reply.code(400).send({
				error: "routingWeights, docTemplates, concurrency, timeouts, git, agent oder warmup erforderlich",
			})
		}
		// T2-7: Theme ist eine einfache Zweierwahl — alles andere ist 400.
		if (body.theme !== undefined) {
			if (body.theme !== "dark" && body.theme !== "light") {
				return reply.code(400).send({ error: "theme muss 'dark' oder 'light' sein" })
			}
			setSetting(ctx.db, "uiTheme", body.theme)
		}
		// T3-13: Strompreis (Cents/kWh) und Systemleistung (Watt) — beide
		// nicht-negativ; 0 schaltet die Stromkosten-Achse ab.
		if (body.powerCost !== undefined) {
			const current = {
				...DEFAULT_POWER_COST,
				...getSetting<Partial<PowerCostSettings>>(ctx.db, "powerCost"),
			}
			const next: PowerCostSettings = {
				electricityCentsPerKwh: body.powerCost.electricityCentsPerKwh ?? current.electricityCentsPerKwh,
				systemWatts: body.powerCost.systemWatts ?? current.systemWatts,
			}
			if (
				!Number.isFinite(next.electricityCentsPerKwh) ||
				next.electricityCentsPerKwh < 0 ||
				next.electricityCentsPerKwh > 10_000 ||
				!Number.isFinite(next.systemWatts) ||
				next.systemWatts < 0 ||
				next.systemWatts > 100_000
			) {
				return reply.code(400).send({
					error: "powerCost braucht electricityCentsPerKwh (0–10000) und systemWatts (0–100000)",
				})
			}
			setSetting(ctx.db, "powerCost", next)
		}
		if (body.routerModel !== undefined) {
			const current = {
				...DEFAULT_ROUTER_MODEL,
				...getSetting<Partial<RouterModelSettings>>(ctx.db, "routerModel"),
			}
			const next: RouterModelSettings = {
				enabled: body.routerModel.enabled ?? current.enabled,
				providerId:
					body.routerModel.providerId === null
						? undefined
						: (body.routerModel.providerId ?? current.providerId),
				modelId:
					body.routerModel.modelId === null ? undefined : (body.routerModel.modelId ?? current.modelId),
				timeoutMs: body.routerModel.timeoutMs ?? current.timeoutMs,
				minConfidence: body.routerModel.minConfidence ?? current.minConfidence,
			}
			if (
				typeof next.enabled !== "boolean" ||
				(typeof next.providerId !== "undefined" && typeof next.providerId !== "string") ||
				(typeof next.modelId !== "undefined" && typeof next.modelId !== "string") ||
				!Number.isInteger(next.timeoutMs) ||
				next.timeoutMs < 5_000 ||
				next.timeoutMs > 300_000 ||
				typeof next.minConfidence !== "number" ||
				next.minConfidence < 0 ||
				next.minConfidence > 1
			) {
				return reply.code(400).send({
					error: "routerModel braucht enabled (bool), timeoutMs (5000–300000) und minConfidence (0–1)",
				})
			}
			setSetting(ctx.db, "routerModel", next)
		}
		if (body.commands !== undefined) {
			const current = ctx.engine.commandPolicy()
			const next: CommandPolicy = {
				enabled: body.commands.enabled ?? current.enabled,
				allowed: body.commands.allowed ?? current.allowed,
				timeoutMs: body.commands.timeoutMs ?? current.timeoutMs,
			}
			// Ein Programmname ist ein Name, kein Pfad und kein Befehl: Sonst
			// liesse sich die Erlaubnisliste über `sh -c` selbst aushebeln.
			const sauber =
				Array.isArray(next.allowed) &&
				next.allowed.every((c) => typeof c === "string" && /^[a-zA-Z0-9._-]{1,40}$/.test(c))
			if (typeof next.enabled !== "boolean" || !sauber) {
				return reply.code(400).send({
					error: "commands braucht enabled (bool) und allowed als Liste einfacher Programmnamen",
				})
			}
			if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1000 || next.timeoutMs > 3_600_000) {
				return reply.code(400).send({ error: "commands.timeoutMs muss zwischen 1000 und 3600000 liegen" })
			}
			setSetting(ctx.db, "commands", next)
		}
		if (body.retention !== undefined) {
			const current = { ...DEFAULT_RETENTION, ...getSetting<Partial<RetentionSettings>>(ctx.db, "retention") }
			const next: RetentionSettings = {
				logDays: body.retention.logDays ?? current.logDays,
				chunkDays: body.retention.chunkDays ?? current.chunkDays,
				metricsDays: body.retention.metricsDays ?? current.metricsDays,
			}
			// Mindestens ein Tag: Eine 0 hiesse „sofort löschen" und nähme der
			// Fehlersuche die Grundlage, noch während der Fehler passiert.
			const gültig = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3650
			if (!gültig(next.logDays) || !gültig(next.chunkDays) || !gültig(next.metricsDays)) {
				return reply.code(400).send({ error: "retention braucht ganze Tage zwischen 1 und 3650" })
			}
			setSetting(ctx.db, "retention", next)
		}
		if (body.warmup !== undefined) {
			const current = { ...DEFAULT_WARMUP, ...getSetting<Partial<WarmupSettings>>(ctx.db, "warmup") }
			const next: WarmupSettings = {
				enabled: body.warmup.enabled ?? current.enabled,
				intervalMinutes: body.warmup.intervalMinutes ?? current.intervalMinutes,
				perProvider: body.warmup.perProvider ?? current.perProvider,
			}
			if (
				typeof next.enabled !== "boolean" ||
				!Number.isInteger(next.intervalMinutes) ||
				next.intervalMinutes < 1 ||
				!Number.isInteger(next.perProvider) ||
				next.perProvider < 1
			) {
				return reply
					.code(400)
					.send({ error: "warmup braucht enabled (bool), intervalMinutes ≥ 1 und perProvider ≥ 1" })
			}
			setSetting(ctx.db, "warmup", next)
		}
		if (body.agent !== undefined) {
			const maxSteps = body.agent.maxSteps
			// 0 ist ausdrücklich erlaubt und heisst „unbegrenzt“.
			if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || (maxSteps as number) < 0)) {
				return reply
					.code(400)
					.send({ error: "agent.maxSteps muss eine ganze Zahl ≥ 0 sein (0 = unbegrenzt)" })
			}
			setSetting(ctx.db, "agent", { maxSteps: maxSteps ?? ctx.engine.agentSettings().maxSteps })
		}
		if (body.git !== undefined) {
			const current = ctx.engine.gitSettings()
			const next = {
				autoCommit: body.git.autoCommit ?? current.autoCommit,
				autoPush: body.git.autoPush ?? current.autoPush,
			}
			if (typeof next.autoCommit !== "boolean" || typeof next.autoPush !== "boolean") {
				return reply.code(400).send({ error: "git braucht autoCommit und autoPush als Wahrheitswerte" })
			}
			setSetting(ctx.db, "git", next)
		}
		if (body.timeouts !== undefined) {
			const parsed = parseTimeouts(body.timeouts, ctx.engine.timeouts())
			if (!parsed) {
				return reply
					.code(400)
					.send({ error: "timeouts brauchen ganze Millisekunden ≥ 5000 (firstChunkMs, chunkMs, totalMs)" })
			}
			setSetting(ctx.db, "timeouts", parsed)
		}
		if (body.concurrency !== undefined) {
			const parsed = parseConcurrency(body.concurrency, ctx.engine.limits())
			if (!parsed) {
				return reply
					.code(400)
					.send({ error: "concurrency braucht ganze Zahlen ≥ 1 (global, perProvider, maxModelsPerProvider)" })
			}
			setSetting(ctx.db, "concurrency", parsed)
		}
		if (body.routingWeights !== undefined) {
			const parsed = parseWeights(body.routingWeights)
			if (!parsed) {
				return reply.code(400).send({ error: "routingWeights muss Zahlen zwischen 0 und 1 sein" })
			}
			setSetting(ctx.db, "routing_weights", parsed)
		}
		if (body.docTemplates !== undefined) {
			const templates = parseDocTemplates(body.docTemplates)
			if (!templates) {
				return reply
					.code(400)
					.send({ error: "docTemplates muss { agent?, instance? } mit Text-Vorlagen sein" })
			}
			setSetting(ctx.db, "doc_templates", templates)
		}
		return currentSettings()
	})

	app.get("/api/export", () => {
		const weights = getSetting<ScoringWeights>(ctx.db, "routing_weights") ?? DEFAULT_WEIGHTS
		return {
			format: "diriz-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			tasks: listTasks(ctx.db),
			// Agenten inklusive ihrer Dokumente (plan/changelog/init.md).
			agents: listAgents(ctx.db).map((a) => ({
				...a,
				docs: Object.fromEntries(listAgentDocs(ctx.db, a.id).map((d) => [d.kind, d.content])),
			})),
			swarms: listSwarms(ctx.db),
			templates: listTemplates(ctx.db),
			settings: { routingWeights: normalizeWeights(weights), docTemplates: getDocTemplates(ctx.db) ?? {} },
		}
	})

	app.post<{ Body: Record<string, unknown> }>("/api/import", (req, reply) => {
		const body = req.body ?? {}
		if (body.format !== "diriz-export") {
			return reply.code(400).send({ error: "Ungültiges Export-Format (format muss 'diriz-export' sein)" })
		}

		let imported = 0

		const agents = Array.isArray(body.agents) ? body.agents : []
		for (const a of agents as { name?: string; docs?: Record<string, string> }[]) {
			if (!a.name) continue
			const existing = listAgents(ctx.db).find((x) => x.name === a.name)
			const agentId = existing
				? (updateAgent(ctx.db, existing.id, a as never)?.id ?? existing.id)
				: createAgent(ctx.db, a as never).id
			for (const [kind, content] of Object.entries(a.docs ?? {})) {
				if (isAgentDocKind(kind) && typeof content === "string") {
					saveAgentDoc(ctx.db, agentId, kind as AgentDocKind, content)
				}
			}
			imported++
		}

		const swarms = Array.isArray(body.swarms) ? body.swarms : []
		for (const s of swarms as { name?: string }[]) {
			if (!s.name) continue
			const existing = listSwarms(ctx.db).find((x) => x.name === s.name)
			if (existing) {
				updateSwarm(ctx.db, existing.id, s as never)
			} else {
				createSwarm(ctx.db, s as never)
			}
			imported++
		}

		const templates = Array.isArray(body.templates) ? body.templates : []
		for (const t of templates as { name?: string; prompt?: string }[]) {
			if (!t.name || !t.prompt) continue
			const existing = listTemplates(ctx.db).find((x) => x.name === t.name)
			if (existing) {
				updateTemplate(ctx.db, existing.id, { name: t.name, prompt: t.prompt })
			} else {
				createTemplate(ctx.db, { name: t.name, prompt: t.prompt })
			}
			imported++
		}

		const importedSettings = body.settings as
			| { routingWeights?: ScoringWeights; docTemplates?: DocTemplateSettings }
			| undefined
		const weights = parseWeights(importedSettings?.routingWeights)
		if (weights) {
			setSetting(ctx.db, "routing_weights", weights)
			imported++
		}
		if (importedSettings?.docTemplates !== undefined) {
			const templates = parseDocTemplates(importedSettings.docTemplates)
			if (templates) {
				setSetting(ctx.db, "doc_templates", templates)
				imported++
			}
		}

		return { imported, tasks: Array.isArray(body.tasks) ? body.tasks.length : 0 }
	})
}
