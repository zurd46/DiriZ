/**
 * Zentrales Loggen (`01-plan.md` §8.1, §13 Audit-Log).
 *
 * Ringbuffer in Memory (für die Live-Logs in der UI) + Persistenz in
 * `logs` (sobald eine DB vorhanden ist). Fehlerszenarien gehen zusätzlich
 * auf stderr — `console.log` ist im Core verboten (Biome-Regel).
 */

import type { LogLevel } from "@diriz/shared"

export interface LogEntry {
	ts: string
	level: LogLevel
	scope: string
	msg: string
}

const MAX_BUFFER = 2000
const buffer: LogEntry[] = []

/** Optional: Persistenz-Funktion (setzt die App), wenn die DB da ist. */
let persist: ((entry: LogEntry) => void) | undefined

export function setLogPersist(fn: ((entry: LogEntry) => void) | undefined): void {
	persist = fn
}

export function log(level: LogLevel, scope: string, msg: string): LogEntry {
	const entry: LogEntry = { ts: new Date().toISOString(), level, scope, msg }
	buffer.push(entry)
	if (buffer.length > MAX_BUFFER) {
		buffer.splice(0, buffer.length - MAX_BUFFER)
	}
	try {
		persist?.(entry)
	} catch {
		// Logging darf nie den Core reissen.
	}
	if (level === "error") {
		console.error(`[diriz:${scope}] ${msg}`)
	} else if (level === "warn") {
		console.warn(`[diriz:${scope}] ${msg}`)
	}
	return entry
}

export interface LogFilter {
	level?: LogLevel
	scope?: string
	limit?: number
}

export function listLogs(filter: LogFilter = {}): LogEntry[] {
	let entries = buffer
	if (filter.level) {
		entries = entries.filter((e) => e.level === filter.level)
	}
	if (filter.scope) {
		entries = entries.filter((e) => e.scope === filter.scope)
	}
	const limit = filter.limit ?? 200
	return entries.slice(-limit).reverse()
}
