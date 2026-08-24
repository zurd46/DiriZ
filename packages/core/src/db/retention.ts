/**
 * Aufräumen: Was alt genug ist, verschwindet.
 *
 * Ohne Regel wächst die Datenbank unbegrenzt — in einem Bestand mit drei Tasks
 * lagen bereits 13 600 Logzeilen, 4 900 Antwort-Schnipsel und ein 5 MB grosses
 * Journal. Nichts davon ist nach Wochen noch von Wert, aber alles verlangsamt
 * jede Abfrage und jede Sicherung.
 *
 * Was **nicht** aufgeräumt wird: Tasks, Ausführungen, Dokumente, Feedback und
 * Bewertungen. Das ist die Geschichte des Systems — sie ist klein und sie
 * begründet Entscheidungen.
 */

import type { Db } from "./connection.js"

/** Aufbewahrungsfristen in Tagen (`settings.retention` überschreibt sie). */
export interface RetentionSettings {
	/** Logzeilen — die kurzlebigste Datenart. */
	logDays: number
	/** Antwort-Schnipsel des Live-Streams; die Volltext-Antwort bleibt. */
	chunkDays: number
	/** Stündliche Kennzahlen fürs Dashboard. */
	metricsDays: number
}

export const DEFAULT_RETENTION: RetentionSettings = { logDays: 14, chunkDays: 30, metricsDays: 180 }

export interface RetentionResult {
	logs: number
	chunks: number
	metrics: number
	sessions: number
}

function cutoff(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Räumt einmal auf und meldet, was verschwunden ist.
 *
 * Die Schnipsel einer Ausführung fallen nur, wenn die Ausführung selbst alt
 * ist — sonst risse man den Live-Verlauf eines gerade laufenden Auftrags weg.
 */
export function purgeOldData(db: Db, settings: RetentionSettings = DEFAULT_RETENTION): RetentionResult {
	const logs = db.prepare("DELETE FROM logs WHERE ts < ?").run(cutoff(settings.logDays)).changes
	const chunks = db
		.prepare(
			`DELETE FROM execution_chunks WHERE execution_id IN (
				SELECT id FROM executions WHERE started_at IS NOT NULL AND started_at < ?
			)`,
		)
		.run(cutoff(settings.chunkDays)).changes
	const metrics = db
		.prepare("DELETE FROM metrics_hourly WHERE bucket < ?")
		.run(cutoff(settings.metricsDays)).changes
	const sessions = db
		.prepare("DELETE FROM sessions WHERE expires_at <= ?")
		.run(new Date().toISOString()).changes

	// Das Journal wieder auf den Boden holen: Ohne Checkpoint bleibt die
	// WAL-Datei so gross, wie sie im Spitzenmoment war — hier waren das 5 MB
	// für 4 MB Nutzdaten.
	if (logs + chunks + metrics + sessions > 0) {
		db.pragma("wal_checkpoint(TRUNCATE)")
	}
	return { logs, chunks, metrics, sessions }
}
