/**
 * Datenzugriff — alle SQL an einem Ort (`01-plan.md` §11).
 * Routen & Engine sprechen nur diese Funktionen; keine SQL-Strings sonstwo.
 */

import { randomUUID } from "node:crypto"
import type {
	Capability,
	DiscoveredModel,
	Execution,
	ExecutionStatus,
	InstanceModel,
	ModelSource,
	Provider,
	ProviderStatus,
	ProviderType,
	RoutingDecision,
	Task,
	TaskMetadata,
	TaskStatus,
} from "@diriz/shared"
import type { LogEntry } from "../logger.js"
import type { Db } from "./connection.js"

/* ---------------------------------- Provider --------------------------------- */

interface ProviderRow {
	id: string
	type: string
	label: string
	base_url: string
	enabled: number
	status: string
	latency_p50: number | null
	latency_p95: number | null
	last_checked_at: string | null
	config_json: string
	api_key_enc: string | null
	created_at: string
}

function mapProvider(row: ProviderRow): Provider {
	return {
		id: row.id,
		type: row.type as ProviderType,
		label: row.label,
		baseUrl: row.base_url,
		enabled: row.enabled === 1,
		status: row.status as ProviderStatus,
		latencyP50: row.latency_p50 ?? undefined,
		latencyP95: row.latency_p95 ?? undefined,
		lastCheckedAt: row.last_checked_at ?? undefined,
		config: JSON.parse(row.config_json) as Record<string, unknown>,
		hasApiKey: row.api_key_enc !== null,
	}
}

export interface ProviderInput {
	type: ProviderType
	label: string
	baseUrl: string
	config?: Record<string, unknown>
	/** Bereits verschlüsselter API-Key (AES-256-GCM) — nie im Klartext. */
	apiKeyEnc?: string
}

export function createProvider(db: Db, input: ProviderInput): Provider {
	const id = randomUUID()
	db.prepare(
		"INSERT INTO providers (id, type, label, base_url, config_json, api_key_enc) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		id,
		input.type,
		input.label,
		input.baseUrl,
		JSON.stringify(input.config ?? {}),
		input.apiKeyEnc ?? null,
	)
	const created = getProvider(db, id)
	if (!created) {
		throw new Error("provider create failed")
	}
	return created
}

export function listProviders(db: Db): Provider[] {
	const rows = db.prepare("SELECT * FROM providers ORDER BY created_at").all() as unknown as ProviderRow[]
	return rows.map(mapProvider)
}

export function getProvider(db: Db, id: string): Provider | undefined {
	const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as unknown as ProviderRow | undefined
	return row ? mapProvider(row) : undefined
}

/** Der verschlüsselte API-Key — nur für die Adapter-Fabrik, nie in API-Antworten. */
export function providerApiKeyEnc(db: Db, id: string): string | undefined {
	const row = db.prepare("SELECT api_key_enc FROM providers WHERE id = ?").get(id) as
		| { api_key_enc: string | null }
		| undefined
	return row?.api_key_enc ?? undefined
}

export interface ProviderPatch {
	label?: string
	baseUrl?: string
	enabled?: boolean
	config?: Record<string, unknown>
	apiKeyEnc?: string
	clearApiKey?: boolean
}

export function updateProvider(db: Db, id: string, patch: ProviderPatch): Provider | undefined {
	const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as unknown as ProviderRow | undefined
	if (!row) {
		return undefined
	}
	const label = patch.label ?? row.label
	const baseUrl = patch.baseUrl ?? row.base_url
	const enabled = patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0
	const config = patch.config === undefined ? row.config_json : JSON.stringify(patch.config)
	let apiKeyEnc = row.api_key_enc
	if (patch.clearApiKey) {
		apiKeyEnc = null
	}
	if (patch.apiKeyEnc !== undefined) {
		apiKeyEnc = patch.apiKeyEnc
	}
	db.prepare(
		"UPDATE providers SET label = ?, base_url = ?, enabled = ?, config_json = ?, api_key_enc = ? WHERE id = ?",
	).run(label, baseUrl, enabled, config, apiKeyEnc, id)
	return getProvider(db, id)
}

export function deleteProvider(db: Db, id: string): boolean {
	return db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0
}

export function setProviderStatus(
	db: Db,
	id: string,
	status: ProviderStatus,
	p50?: number,
	p95?: number,
): void {
	db.prepare(
		"UPDATE providers SET status = ?, latency_p50 = ?, latency_p95 = ?, last_checked_at = ? WHERE id = ?",
	).run(status, p50 ?? null, p95 ?? null, new Date().toISOString(), id)
}

/* ---------------------------------- Instances -------------------------------- */

interface InstanceRow {
	id: string
	provider_id: string
	model_id: string
	display_name: string
	context_window: number
	capabilities_json: string
	languages_json: string
	quantization: string | null
	price_in_per_mtok: number | null
	price_out_per_mtok: number | null
	source: string
	status: string
	last_seen_at: string
}

function mapInstance(row: InstanceRow): InstanceModel {
	return {
		id: row.id,
		providerId: row.provider_id,
		modelId: row.model_id,
		displayName: row.display_name,
		contextWindow: row.context_window,
		capabilities: JSON.parse(row.capabilities_json) as Capability[],
		languages: JSON.parse(row.languages_json) as string[],
		quantization: row.quantization ?? undefined,
		pricePerMTok:
			row.price_in_per_mtok !== null || row.price_out_per_mtok !== null
				? { in: row.price_in_per_mtok ?? 0, out: row.price_out_per_mtok ?? 0 }
				: undefined,
		source: row.source as ModelSource,
		status: row.status as ProviderStatus,
		lastSeenAt: row.last_seen_at,
	}
}

export function upsertInstance(
	db: Db,
	providerId: string,
	model: DiscoveredModel,
	source: ModelSource,
): InstanceModel {
	const now = new Date().toISOString()
	const existing = db
		.prepare("SELECT id FROM instances WHERE provider_id = ? AND model_id = ?")
		.get(providerId, model.modelId) as { id: string } | undefined

	if (!existing) {
		const id = randomUUID()
		db.prepare(
			`INSERT INTO instances (id, provider_id, model_id, display_name, context_window,
				capabilities_json, languages_json, quantization, price_in_per_mtok, price_out_per_mtok,
				source, status, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
		).run(
			id,
			providerId,
			model.modelId,
			model.displayName,
			model.contextWindow ?? 8192,
			JSON.stringify(model.capabilities ?? []),
			JSON.stringify(model.languages ?? []),
			model.quantization ?? null,
			model.pricePerMTok?.in ?? null,
			model.pricePerMTok?.out ?? null,
			source,
			now,
		)
		const created = getInstance(db, id)
		if (!created) {
			throw new Error("instance create failed")
		}
		return created
	}

	db.prepare(
		`UPDATE instances SET display_name = ?,
			context_window = COALESCE(?, context_window),
			languages_json = ?,
			quantization = COALESCE(?, quantization),
			price_in_per_mtok = ?, price_out_per_mtok = ?,
			last_seen_at = ?
		 WHERE id = ?`,
	).run(
		model.displayName,
		model.contextWindow ?? null,
		JSON.stringify(model.languages ?? []),
		model.quantization ?? null,
		model.pricePerMTok?.in ?? null,
		model.pricePerMTok?.out ?? null,
		now,
		existing.id,
	)
	const updated = getInstance(db, existing.id)
	if (!updated) {
		throw new Error("instance update failed")
	}
	return updated
}

export function listInstances(db: Db, providerId?: string): InstanceModel[] {
	const rows = providerId
		? (db
				.prepare("SELECT * FROM instances WHERE provider_id = ? ORDER BY display_name")
				.all(providerId) as unknown as InstanceRow[])
		: (db
				.prepare("SELECT * FROM instances ORDER BY provider_id, display_name")
				.all() as unknown as InstanceRow[])
	return rows.map(mapInstance)
}

export function getInstance(db: Db, id: string): InstanceModel | undefined {
	const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as unknown as InstanceRow | undefined
	return row ? mapInstance(row) : undefined
}

export interface InstancePatch {
	displayName?: string
	contextWindow?: number
	capabilities?: Capability[]
	languages?: string[]
	quantization?: string
	priceInPerMTok?: number
	priceOutPerMTok?: number
}

export function updateInstance(db: Db, id: string, patch: InstancePatch): InstanceModel | undefined {
	const current = getInstance(db, id)
	if (!current) {
		return undefined
	}
	const next: InstanceModel = {
		...current,
		displayName: patch.displayName ?? current.displayName,
		contextWindow: patch.contextWindow ?? current.contextWindow,
		capabilities: patch.capabilities ?? current.capabilities,
		languages: patch.languages ?? current.languages,
		quantization: patch.quantization !== undefined ? patch.quantization : current.quantization,
		pricePerMTok:
			patch.priceInPerMTok !== undefined || patch.priceOutPerMTok !== undefined
				? {
						in: patch.priceInPerMTok ?? current.pricePerMTok?.in ?? 0,
						out: patch.priceOutPerMTok ?? current.pricePerMTok?.out ?? 0,
					}
				: current.pricePerMTok,
	}
	db.prepare(
		`UPDATE instances SET display_name = ?, context_window = ?, capabilities_json = ?, languages_json = ?,
			quantization = ?, price_in_per_mtok = ?, price_out_per_mtok = ? WHERE id = ?`,
	).run(
		next.displayName,
		next.contextWindow,
		JSON.stringify(next.capabilities),
		JSON.stringify(next.languages),
		next.quantization ?? null,
		next.pricePerMTok?.in ?? null,
		next.pricePerMTok?.out ?? null,
		id,
	)
	return getInstance(db, id)
}

export function deleteInstance(db: Db, id: string): boolean {
	return db.prepare("DELETE FROM instances WHERE id = ?").run(id).changes > 0
}

export function setInstanceStatus(db: Db, id: string, status: ProviderStatus): void {
	db.prepare("UPDATE instances SET status = ? WHERE id = ?").run(status, id)
}

/* ------------------------------------ Tasks ---------------------------------- */

interface TaskRow {
	id: string
	title: string
	prompt: string
	metadata_json: string
	privacy: string
	mode: string
	status: string
	created_at: string
	finished_at: string | null
}

function mapTask(row: TaskRow): Task {
	return {
		id: row.id,
		title: row.title,
		prompt: row.prompt,
		metadata: JSON.parse(row.metadata_json) as TaskMetadata,
		status: row.status as TaskStatus,
		createdAt: row.created_at,
		finishedAt: row.finished_at ?? undefined,
	}
}

export interface TaskInput {
	title?: string
	prompt: string
	metadata?: Partial<TaskMetadata>
}

export function createTask(db: Db, input: TaskInput): Task {
	const id = randomUUID()
	const now = new Date().toISOString()
	const meta: TaskMetadata = {
		privacy: input.metadata?.privacy ?? "local-only",
		mode: input.metadata?.mode ?? "auto",
		goal: input.metadata?.goal,
		language: input.metadata?.language,
		constraints: input.metadata?.constraints,
		budgetUsd: input.metadata?.budgetUsd,
		preferredProviderId: input.metadata?.preferredProviderId,
		preferredModelId: input.metadata?.preferredModelId,
	}
	const title = (input.title ?? "").trim() || input.prompt.slice(0, 60)
	db.prepare(
		"INSERT INTO tasks (id, title, prompt, metadata_json, privacy, mode, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)",
	).run(id, title, input.prompt, JSON.stringify(meta), meta.privacy, meta.mode, now)
	const created = getTask(db, id)
	if (!created) {
		throw new Error("task create failed")
	}
	return created
}

export function listTasks(db: Db, opts?: { status?: TaskStatus; limit?: number }): Task[] {
	const limit = Math.min(opts?.limit ?? 50, 200)
	const rows = opts?.status
		? (db
				.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?")
				.all(opts.status, limit) as unknown as TaskRow[])
		: (db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as TaskRow[])
	return rows.map(mapTask)
}

export function getTask(db: Db, id: string): Task | undefined {
	const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined
	return row ? mapTask(row) : undefined
}

export function setTaskStatus(db: Db, id: string, status: TaskStatus, finishedAt?: string): void {
	if (status === "done" || status === "failed" || status === "cancelled") {
		db.prepare("UPDATE tasks SET status = ?, finished_at = ? WHERE id = ?").run(
			status,
			finishedAt ?? new Date().toISOString(),
			id,
		)
		return
	}
	db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id)
}

/* ---------------------------------- Executions ------------------------------- */

interface ExecutionRow {
	id: string
	task_id: string
	instance_id: string | null
	provider_id: string | null
	status: string
	started_at: string | null
	finished_at: string | null
	tokens_in: number | null
	tokens_out: number | null
	tps_avg: number | null
	cost_usd: number | null
	error: string | null
	failover_count: number
	rating: number | null
	rating_comment: string | null
	output: string | null
}

function mapExecution(row: ExecutionRow): Execution {
	return {
		id: row.id,
		taskId: row.task_id,
		instanceId: row.instance_id ?? undefined,
		providerId: row.provider_id ?? undefined,
		status: row.status as ExecutionStatus,
		startedAt: row.started_at ?? undefined,
		finishedAt: row.finished_at ?? undefined,
		tokensIn: row.tokens_in ?? undefined,
		tokensOut: row.tokens_out ?? undefined,
		tpsAvg: row.tps_avg ?? undefined,
		costUsd: row.cost_usd ?? undefined,
		error: row.error ?? undefined,
		failoverCount: row.failover_count,
		rating: row.rating ?? undefined,
		ratingComment: row.rating_comment ?? undefined,
		output: row.output ?? undefined,
	}
}

export interface ExecutionInput {
	taskId: string
	instanceId?: string
	providerId?: string
	failoverCount?: number
}

export function createExecution(db: Db, input: ExecutionInput): Execution {
	const id = randomUUID()
	db.prepare(
		"INSERT INTO executions (id, task_id, instance_id, provider_id, status, failover_count) VALUES (?, ?, ?, ?, 'pending', ?)",
	).run(id, input.taskId, input.instanceId ?? null, input.providerId ?? null, input.failoverCount ?? 0)
	const created = getExecution(db, id)
	if (!created) {
		throw new Error("execution create failed")
	}
	return created
}

export function getExecution(db: Db, id: string): Execution | undefined {
	const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as unknown as
		| ExecutionRow
		| undefined
	if (!row) {
		return undefined
	}
	return attachFiles(db, [mapExecution(row)])[0]
}

export function listExecutionsByTask(db: Db, taskId: string): Execution[] {
	const rows = db
		.prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY started_at, id")
		.all(taskId) as unknown as ExecutionRow[]
	return attachFiles(db, rows.map(mapExecution))
}

function attachFiles(db: Db, execs: Execution[]): Execution[] {
	if (execs.length === 0) {
		return execs
	}
	const placeholders = execs.map(() => "?").join(",")
	const rows = db
		.prepare(
			`SELECT execution_id, rel_path, size FROM files WHERE execution_id IN (${placeholders}) ORDER BY id`,
		)
		.all(...execs.map((e) => e.id)) as { execution_id: string; rel_path: string; size: number }[]
	const byExec = new Map<string, { relPath: string; size: number }[]>()
	for (const r of rows) {
		const arr = byExec.get(r.execution_id) ?? []
		arr.push({ relPath: r.rel_path, size: r.size })
		byExec.set(r.execution_id, arr)
	}
	return execs.map((e) => ({ ...e, files: byExec.get(e.id) ?? [] }))
}

export interface ExecutionPatch {
	status?: ExecutionStatus
	startedAt?: string
	finishedAt?: string
	tokensIn?: number
	tokensOut?: number
	tpsAvg?: number
	costUsd?: number
	error?: string
	output?: string
	rating?: number
	ratingComment?: string
}

const EXECUTION_COLUMNS: Record<keyof ExecutionPatch, string> = {
	status: "status",
	startedAt: "started_at",
	finishedAt: "finished_at",
	tokensIn: "tokens_in",
	tokensOut: "tokens_out",
	tpsAvg: "tps_avg",
	costUsd: "cost_usd",
	error: "error",
	output: "output",
	rating: "rating",
	ratingComment: "rating_comment",
}

export function updateExecution(db: Db, id: string, patch: ExecutionPatch): void {
	const cols: string[] = []
	const vals: (string | number | null)[] = []
	for (const key of Object.keys(EXECUTION_COLUMNS) as (keyof ExecutionPatch)[]) {
		const value = patch[key]
		if (value !== undefined) {
			cols.push(`${EXECUTION_COLUMNS[key]} = ?`)
			vals.push(value)
		}
	}
	if (cols.length === 0) {
		return
	}
	vals.push(id)
	db.prepare(`UPDATE executions SET ${cols.join(", ")} WHERE id = ?`).run(...vals)
}

/* ----------------------------------- Chunks ---------------------------------- */

export function appendChunk(db: Db, executionId: string, seq: number, delta: string): void {
	db.prepare("INSERT INTO execution_chunks (execution_id, seq, delta, created_at) VALUES (?, ?, ?, ?)").run(
		executionId,
		seq,
		delta,
		new Date().toISOString(),
	)
}

/** Stream-Replay: alle Deltas in Reihenfolge concatenated. */
export function replayOutput(db: Db, executionId: string): string {
	const rows = db
		.prepare("SELECT delta FROM execution_chunks WHERE execution_id = ? ORDER BY seq")
		.all(executionId) as { delta: string }[]
	return rows.map((r) => r.delta).join("")
}

/* ------------------------------ Routing-Entscheidungen ------------------------ */

export function saveDecision(db: Db, decision: RoutingDecision): void {
	db.prepare(
		`INSERT INTO routing_decisions (execution_id, task_profile_json, scores_json, excluded_json, weights_json, chosen_instance_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		decision.executionId,
		JSON.stringify(decision.profile),
		JSON.stringify(decision.candidates),
		JSON.stringify(decision.excluded),
		JSON.stringify(decision.weights),
		decision.chosenInstanceId ?? null,
		decision.createdAt,
	)
}

export function latestDecision(db: Db, executionId: string): RoutingDecision | undefined {
	const row = db
		.prepare("SELECT * FROM routing_decisions WHERE execution_id = ? ORDER BY id DESC LIMIT 1")
		.get(executionId) as
		| {
				execution_id: string
				task_profile_json: string
				scores_json: string
				excluded_json: string
				weights_json: string
				chosen_instance_id: string | null
				created_at: string
		  }
		| undefined
	if (!row) {
		return undefined
	}
	return {
		executionId: row.execution_id,
		chosenInstanceId: row.chosen_instance_id ?? undefined,
		profile: JSON.parse(row.task_profile_json) as RoutingDecision["profile"],
		candidates: JSON.parse(row.scores_json) as RoutingDecision["candidates"],
		excluded: JSON.parse(row.excluded_json) as RoutingDecision["excluded"],
		weights: JSON.parse(row.weights_json) as Record<string, number>,
		createdAt: row.created_at,
	}
}

/* ------------------------------------ Files ---------------------------------- */

export interface FileInput {
	executionId: string
	taskId: string
	relPath: string
	size: number
	content: string
}

export function saveFile(db: Db, input: FileInput): void {
	db.prepare(
		"INSERT INTO files (execution_id, task_id, rel_path, size, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(input.executionId, input.taskId, input.relPath, input.size, input.content, new Date().toISOString())
}

/** Alle Dateien einer Task (neuster Stand pro Pfad). */
export function listFilesByTask(db: Db, taskId: string): { relPath: string; size: number }[] {
	const rows = db
		.prepare(
			`SELECT f.rel_path, f.size FROM files f
			 JOIN (SELECT rel_path, MAX(id) AS max_id FROM files WHERE task_id = ? GROUP BY rel_path) latest ON f.id = latest.max_id
			 ORDER BY f.rel_path`,
		)
		.all(taskId) as { rel_path: string; size: number }[]
	return rows.map((r) => ({ relPath: r.rel_path, size: r.size }))
}

export function getFileContent(db: Db, executionId: string, relPath: string): string | undefined {
	const row = db
		.prepare("SELECT content FROM files WHERE execution_id = ? AND rel_path = ? ORDER BY id DESC LIMIT 1")
		.get(executionId, relPath) as { content: string } | undefined
	return row?.content
}

/** Workspace-Baum: jede Datei einmal, mit dem neusten Stand. */
export function workspaceFiles(db: Db): { relPath: string; size: number }[] {
	const rows = db
		.prepare(
			`SELECT f.rel_path, f.size FROM files f
			 JOIN (SELECT rel_path, MAX(id) AS max_id FROM files GROUP BY rel_path) latest ON f.id = latest.max_id
			 ORDER BY f.rel_path`,
		)
		.all() as { rel_path: string; size: number }[]
	return rows.map((r) => ({ relPath: r.rel_path, size: r.size }))
}

/* ------------------------------------- Logs ---------------------------------- */

export function persistLog(db: Db, entry: LogEntry): void {
	db.prepare("INSERT INTO logs (ts, level, scope, message) VALUES (?, ?, ?, ?)").run(
		entry.ts,
		entry.level,
		entry.scope,
		entry.msg,
	)
}

export function listLogRows(db: Db, filter: { level?: string; scope?: string; limit?: number }): LogEntry[] {
	const limit = Math.min(filter.limit ?? 200, 1000)
	let rows: { ts: string; level: string; scope: string; message: string }[]
	if (filter.level && filter.scope) {
		rows = db
			.prepare("SELECT * FROM logs WHERE level = ? AND scope = ? ORDER BY id DESC LIMIT ?")
			.all(filter.level, filter.scope, limit) as unknown as {
			ts: string
			level: string
			scope: string
			message: string
		}[]
	} else if (filter.level) {
		rows = db
			.prepare("SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?")
			.all(filter.level, limit) as unknown as { ts: string; level: string; scope: string; message: string }[]
	} else if (filter.scope) {
		rows = db
			.prepare("SELECT * FROM logs WHERE scope = ? ORDER BY id DESC LIMIT ?")
			.all(filter.scope, limit) as unknown as { ts: string; level: string; scope: string; message: string }[]
	} else {
		rows = db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
			ts: string
			level: string
			scope: string
			message: string
		}[]
	}
	return rows.map((r) => ({ ts: r.ts, level: r.level as LogEntry["level"], scope: r.scope, msg: r.message }))
}

/* ----------------------------------- Settings -------------------------------- */

export function getSetting<T>(db: Db, key: string): T | undefined {
	const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
		| { value_json: string }
		| undefined
	if (!row) {
		return undefined
	}
	try {
		return JSON.parse(row.value_json) as T
	} catch {
		return undefined
	}
}

export function setSetting(db: Db, key: string, value: unknown): void {
	db.prepare(
		"INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
	).run(key, JSON.stringify(value))
}

/* ------------------------------------ Metriken ------------------------------- */

export interface MetricsSummary {
	providers: number
	onlineProviders: number
	instances: number
	tasks: number
	executions: number
	activeExecutions: number
	tokensIn24h: number
	tokensOut24h: number
	costUsd24h: number
	schemaVersion: number
}

export function metricsSummary(db: Db, activeExecutions: number): MetricsSummary {
	const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
	const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
	const t24 = db
		.prepare(
			`SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout, COALESCE(SUM(cost_usd), 0) AS cost
			 FROM executions WHERE finished_at IS NOT NULL AND finished_at >= ?`,
		)
		.get(cutoff) as { tin: number; tout: number; cost: number }
	return {
		providers: count("SELECT COUNT(*) AS n FROM providers"),
		onlineProviders: count("SELECT COUNT(*) AS n FROM providers WHERE status = 'online'"),
		instances: count("SELECT COUNT(*) AS n FROM instances"),
		tasks: count("SELECT COUNT(*) AS n FROM tasks"),
		executions: count("SELECT COUNT(*) AS n FROM executions"),
		activeExecutions,
		tokensIn24h: t24.tin,
		tokensOut24h: t24.tout,
		costUsd24h: Math.round(t24.cost * 1_000_000) / 1_000_000,
		schemaVersion: getSetting<{ schemaVersion: number }>(db, "schemaVersion")?.schemaVersion ?? 0,
	}
}

export interface TimeseriesPoint {
	bucket: string
	requests: number
	tokens: number
	costUsd: number
	errors: number
}

export function timeseries(db: Db, hours: number): TimeseriesPoint[] {
	const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
	const rows = db
		.prepare(
			`SELECT strftime('%Y-%m-%d %H:00', finished_at) AS bucket,
				COUNT(*) AS requests,
				COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
				COALESCE(SUM(cost_usd), 0) AS cost,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors
			 FROM executions
			 WHERE finished_at IS NOT NULL AND finished_at >= ?
			 GROUP BY bucket ORDER BY bucket`,
		)
		.all(cutoff) as {
		bucket: string
		requests: number
		tokens: number
		cost: number
		errors: number | null
	}[]
	return rows.map((r) => ({
		bucket: r.bucket,
		requests: r.requests,
		tokens: r.tokens,
		costUsd: Math.round(r.cost * 1_000_000) / 1_000_000,
		errors: r.errors ?? 0,
	}))
}
