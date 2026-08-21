/**
 * Zentrale Konstanten & Defaults (`01-plan.md` §7.4, §13, §15).
 */

export const CORE_HOST = "127.0.0.1"
export const CORE_PORT = 8787
export const WEB_PORT = 5173
/** CORS wird nur für die lokale Vite-UI erlaubt (§13). */
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`

export const DEFAULT_CONCURRENCY = {
	perProvider: 2,
	global: 4,
} as const

export const DEFAULT_TIMEOUTS = {
	/** Kein Chunk in 60 s → Stream-Fehler → Failover. */
	chunkMs: 60_000,
	/** Gesamtdauer-Timeout (Default 15 min). */
	totalMs: 15 * 60_000,
} as const

export const MAX_FAILOVER_HOPS = 2

export const CIRCUIT_BREAKER = {
	/** 3 aufeinanderfolgende Fehlschläge → offen. */
	failureThreshold: 3,
	/** Offen-Dauer, danach ein Probe-Request (half-open). */
	openMs: 30_000,
} as const

export const HEALTH_POLL_MS = 10_000

export const DEFAULT_WORKSPACE_DIR = "~/DiriZ/workspace"
export const DEFAULT_DATA_DIR = "~/.diriz"

/** Konservativer Context-Faktor: 1.3× die geschätzten Tokens müssen passen. */
export const SAFETY_CONTEXT_FACTOR = 1.3
/** Harte Gate: 1.2× die geschätzten Tokens (darunter Ausschluss). */
export const GATE_CONTEXT_FACTOR = 1.2
