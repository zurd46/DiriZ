/**
 * T1-5 Modell-Benchmarks: `POST /api/benchmarks/:instanceId` läuft die
 * Standard-Suite direkt über den Adapter des Instanz-Providers — ohne
 * Task, ohne Routing. `GET /api/benchmarks/suite` liefert die Aufgaben
 * für die Oberfläche.
 *
 * Der Lauf ist asynchron: Der POST akzeptiert sofort (`202`), der Client
 * fragt `GET /api/benchmarks/:instanceId/last` ab, bis `completed: true`.
 * So übersteht ein Lauf auch einen abgebrochenen Client, und die Suite
 * kann ein lokales Modell Minuten lang beschäftigen, ohne eine
 * Verbindung offen zu halten. Ein zweiter Start derselben Instanz wird
 * mit `409` abgewiesen — zwei Messungen auf derselben GPU würden sich
 * gegenseitig verunreinigen.
 */
import { BENCHMARK_SUITE, type BenchmarkTask } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { type BenchmarkResult, type RunBenchmarkOptions, runBenchmark } from "../benchmarks/runner.js"
import { getInstance } from "../db/repositories.js"
import { log } from "../logger.js"

/** Körper des Start-Requests — alles optional, sensible Defaults. */
interface BenchmarkStartBody {
	/** Harte Frist pro Aufgabe (ms). */
	timeoutMs?: number
	/** Maximal-Output-Tokens pro Aufgabe. */
	maxTokens?: number
	/** Nur diese Aufgaben-IDs laufen (sonst die ganze Suite). */
	tasks?: string[]
}

function optionen(body: BenchmarkStartBody | undefined): RunBenchmarkOptions {
	const aus: RunBenchmarkOptions = {}
	const timeout = body?.timeoutMs
	if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 1000) {
		aus.timeoutMs = Math.min(timeout, 10 * 60_000)
	}
	const maxTokens = body?.maxTokens
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens >= 16) {
		aus.maxTokens = Math.min(maxTokens, 4096)
	}
	const ids = body?.tasks
	if (Array.isArray(ids)) {
		const subset = BENCHMARK_SUITE.filter((t) => ids.includes(t.id))
		if (subset.length > 0) {
			aus.tasks = subset
		}
	}
	return aus
}

export function registerBenchmarks(app: FastifyInstance, ctx: AppContext): void {
	// Pro App-Instanz: laufende & letzte Ergebnisse im Speicher.
	// Kein DB-Schema — Benchmarks sind Momentaufnahmen, kein Zustand.
	const inFlight = new Map<string, Promise<BenchmarkResult>>()
	const lastResults = new Map<string, BenchmarkResult>()

	/** Die Aufgaben-Liste — für die Oberfläche. */
	app.get("/api/benchmarks/suite", (): { suite: BenchmarkTask[] } => ({
		suite: [...BENCHMARK_SUITE],
	}))

	/**
	 * Startet einen Lauf. `202` + `accepted` — der Client pollt den
	 * Last-Endpunkt, bis `completed: true`.
	 */
	app.post<{ Params: { instanceId: string }; Body: BenchmarkStartBody }>(
		"/api/benchmarks/:instanceId",
		(req, reply) => {
			const inst = getInstance(ctx.db, req.params.instanceId)
			if (!inst) {
				return reply.code(404).send({ error: "Instanz nicht gefunden" })
			}
			const adapter = ctx.registry.adapter(inst.providerId)
			if (!adapter) {
				return reply.code(400).send({ error: `Provider ${inst.providerId} ist nicht registriert` })
			}
			if (inFlight.has(inst.id)) {
				return reply.code(409).send({ error: "Benchmark läuft bereits für diese Instanz" })
			}
			const lauf = runBenchmark(adapter, inst.modelId, BENCHMARK_SUITE, optionen(req.body))
			inFlight.set(inst.id, lauf)
			lauf
				.then((result) => {
					lastResults.set(inst.id, result)
				})
				.catch((e: unknown) => {
					// Der Runner fängt Adapter-Fehler pro Aufgabe ab — dieser
					// Pfad ist nur für interne Fehler. Den InFlight-Eintrag
					// räumt `finally` ab, damit kein toter Eintrag bleibt.
					log("error", "benchmark", `${inst.displayName}: ${e instanceof Error ? e.message : String(e)}`)
				})
				.finally(() => {
					inFlight.delete(inst.id)
				})
			return reply.code(202).send({ accepted: true, instanceId: inst.id })
		},
	)

	/**
	 * Status + letztes Ergebnis einer Instanz. `running: true`, solange der
	 * Lauf geht; `result` ist das letzte abgeschlossene Ergebnis.
	 */
	app.get<{ Params: { instanceId: string } }>("/api/benchmarks/:instanceId/last", (req) => {
		const inst = getInstance(ctx.db, req.params.instanceId)
		if (!inst) {
			return { completed: false, running: false, result: null }
		}
		return {
			completed: lastResults.has(inst.id),
			running: inFlight.has(inst.id),
			result: lastResults.get(inst.id) ?? null,
		}
	})
}
