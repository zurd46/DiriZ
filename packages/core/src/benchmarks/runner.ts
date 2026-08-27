/**
 * T1-5 Modell-Benchmarks: läuft die Standard-Suite (`BENCHMARK_SUITE`)
 * direkt über den Adapter — ohne Task, ohne Routing, ohne Failover.
 *
 * Das ist absichtlich der kürzeste Weg: Ein Benchmark misst **ein** Modell,
 * und ein Routing-Fehler wäre hier kein Failover-Signal, sondern ein
 * Messfehler. Deshalb:
 *   • sequenziell — ein lokales GPU-Modell darf nicht von zehn parallelen
 *     Calls gleichzeitig beansprucht werden (Ladevorgänge, VRAM),
 *   • begrenzter Output — `maxTokens` pro Aufgabe, damit die Suite in
 *     Sekunden statt Minuten läuft,
 *   • harte Frist pro Aufgabe — ein hängender Call verunreinigt nicht die
 *     übrigen neun Messungen.
 *
 * Gemessen wird: Dauer, Zeit zum ersten Token, TPS (Tokens pro Sekunde)
 * und eine grobe Qualität — wie viele der erwarteten Begriffe die Antwort
 * enthält. Keyword-Match ist kein Qualitätsurteil, aber ein stabiles
 * Vergleichssignal zwischen Modellen.
 */
import type { BenchmarkTask, LLMProvider, ModelSettings } from "@diriz/shared"

/** Harte Frist pro Aufgabe (Default 60 s) — überschreibbar. */
export const DEFAULT_TASK_TIMEOUT_MS = 60_000
/** Begrenzter Output pro Aufgabe — die Suite muss schnell bleiben. */
export const DEFAULT_MAX_TOKENS = 256
/** Temperatur 0: Reproduzierbarkeit schlägt Kreativität im Benchmark. */
export const BENCHMARK_TEMPERATURE = 0

/** Ergebnis einer einzelnen Aufgabe. */
export interface BenchmarkTaskResult {
	taskId: string
	category: BenchmarkTask["category"]
	/** true, wenn der Call durchgelaufen ist (auch bei leerer Antwort). */
	ok: boolean
	error?: string
	durationMs: number
	/** Zeit bis zum ersten Antwort-Chunk (ms); null bei Fehler vor dem ersten. */
	firstTokenMs: number | null
	/** Antworttokens laut Provider-Usage (null, wenn der Adapter nichts meldet). */
	tokensOut: number | null
	/** Tokens/Sekunde über den Generierungs-Teil (null ohne genug Daten). */
	tps: number | null
	/** Anteil der erwarteten Begriffe, die in der Antwort vorkamen (0–1). */
	quality: number
	/** Welche Begriffe fehlen — für die Oberfläche. */
	fehlende: string[]
	/** Die Antwort, gekürzt auf `outputMaxChars`. */
	output: string
}

/** Gesamtüberblick über einen Benchmark-Lauf. */
export interface BenchmarkSummary {
	laufend: number
	fehler: number
	/** Durchschnittlicher TPS über alle erfolgreichen Messungen. */
	tpsDurchschnitt: number | null
	/** Durchschnittliche Keyword-Qualität (0–1). */
	qualitaet: number
	gesamtMs: number
}

export interface BenchmarkResult {
	providerId: string
	modelId: string
	startedAt: string
	erg: BenchmarkTaskResult[]
	zusammenfassung: BenchmarkSummary
}

/**
 * Keyword-Treffer: wie viele der erwarteten Begriffe sind in der Antwort
 * enthalten? Gross-/Kleinschreibung egal, Teilstrings zählen.
 *
 * Reine Funktion — der wichtigste Qualitäts-Baustein, deshalb isoliert
 * und testbar.
 */
export function keywordTreffers(
	output: string,
	erwartet: readonly string[],
): {
	treffer: string[]
	fehlende: string[]
	anteil: number
} {
	if (erwartet.length === 0) {
		return { treffer: [], fehlende: [], anteil: 1 }
	}
	const text = output.toLowerCase()
	const treffer: string[] = []
	const fehlende: string[] = []
	for (const begriff of erwartet) {
		// Ein leeres/Whitespace-Begriff wäre ein automatischer Treffer —
		// das wäre ein Fehler in der Suite, kein Signal. Zählen wir es nicht.
		if (begriff.trim().length === 0) {
			continue
		}
		if (text.includes(begriff.toLowerCase())) {
			treffer.push(begriff)
		} else {
			fehlende.push(begriff)
		}
	}
	return { treffer, fehlende, anteil: erwartet.length === 0 ? 1 : treffer.length / erwartet.length }
}

export interface RunBenchmarkOptions {
	/** Harte Frist pro Aufgabe (ms). Default `DEFAULT_TASK_TIMEOUT_MS`. */
	timeoutMs?: number
	/** Maximal-Output-Tokens pro Aufgabe. Default `DEFAULT_MAX_TOKENS`. */
	maxTokens?: number
	/** Wie viel Antworttext im Ergebnis mitgeführt wird. Default 1200. */
	outputMaxChars?: number
	/** Nur diese Aufgaben laufen (sonst die ganze Suite). */
	tasks?: readonly BenchmarkTask[]
	/** Abbruchsignal (z. B. vom Request). */
	signal?: AbortSignal
}

/**
 * Führt **eine** Aufgabe aus und misst sie. Wirft nicht: Ein Fehler wird
 * als `ok: false` + `error` im Ergebnis getragen, damit der restliche Lauf
 * fortgesetzt werden kann.
 */
export async function runBenchmarkTask(
	provider: LLMProvider,
	modelId: string,
	task: BenchmarkTask,
	options: RunBenchmarkOptions,
): Promise<BenchmarkTaskResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
	const outputMaxChars = options.outputMaxChars ?? 1200
	const controller = new AbortController()
	const stop = setTimeout(() => controller.abort(), timeoutMs)
	// Externes Abbruchsignal mitliefern — aber nicht den Timer verhängen.
	const onOuterAbort = () => controller.abort()
	options.signal?.addEventListener("abort", onOuterAbort, { once: true })

	const start = performance.now()
	let firstTokenMs: number | null = null
	let text = ""
	let tokensOut: number | null = null
	let error: string | undefined

	try {
		const settings: ModelSettings = { maxTokens, temperature: BENCHMARK_TEMPERATURE }
		const stream = provider.chat({
			messages: [{ role: "user", content: task.prompt }],
			model: modelId,
			settings,
			signal: controller.signal,
		})
		for await (const chunk of stream) {
			if (chunk.type === "delta") {
				if (firstTokenMs === null) {
					firstTokenMs = performance.now() - start
				}
				text += chunk.text
			} else if (chunk.type === "usage") {
				tokensOut = chunk.tokensOut
			} else if (chunk.type === "done") {
				break
			}
			// `reasoning`- und `tool_call`-Chunks sind für den Benchmark
			// irrelevant — bewusst ignoriert.
		}
	} catch (e) {
		error = controller.signal.aborted
			? `Timeout nach ${timeoutMs} ms`
			: e instanceof Error
				? e.message
				: String(e)
	} finally {
		clearTimeout(stop)
		options.signal?.removeEventListener("abort", onOuterAbort)
	}

	const durationMs = Math.round(performance.now() - start)
	// Generierungs-Teil: von der ersten Antwort bis zum Ende. Ein Wert < 1 ms
	// ist ein Messartefakt (Mock-Provider, schneller als der Timer) — der
	// TPS-Wert wäre dann unrealistisch hoch, daher der 1-ms-Boden.
	const generierungMs = firstTokenMs !== null ? Math.max(1, durationMs - firstTokenMs) : 0
	let tps: number | null = null
	if (tokensOut !== null && generierungMs > 0) {
		tps = Math.round((tokensOut / generierungMs) * 1000 * 10) / 10
	}
	const { fehlende, anteil } = keywordTreffers(text, task.erwartet)

	return {
		taskId: task.id,
		category: task.category,
		ok: error === undefined,
		error,
		durationMs,
		firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
		tokensOut,
		tps,
		quality: Math.round(anteil * 100) / 100,
		fehlende,
		output: text.length > outputMaxChars ? `${text.slice(0, outputMaxChars)}…` : text,
	}
}

/**
 * Der komplette Lauf: alle Aufgaben sequenziell, dann die Zusammenfassung.
 * `suite` ist die Aufgabenliste (Default `BENCHMARK_SUITE`).
 */
export async function runBenchmark(
	provider: LLMProvider,
	modelId: string,
	suite: readonly BenchmarkTask[],
	options: RunBenchmarkOptions = {},
): Promise<BenchmarkResult> {
	const start = performance.now()
	const aufgaben = options.tasks && options.tasks.length > 0 ? options.tasks : suite
	const erg: BenchmarkTaskResult[] = []
	for (const task of aufgaben) {
		if (options.signal?.aborted) {
			break
		}
		erg.push(await runBenchmarkTask(provider, modelId, task, options))
	}
	const erfolgreich = erg.filter((r) => r.ok)
	const tpsWerte = erfolgreich.map((r) => r.tps).filter((v): v is number => v !== null)
	return {
		providerId: provider.id,
		modelId,
		startedAt: new Date().toISOString(),
		erg,
		zusammenfassung: {
			laufend: erfolgreich.length,
			fehler: erg.length - erfolgreich.length,
			tpsDurchschnitt:
				tpsWerte.length === 0
					? null
					: Math.round((tpsWerte.reduce((a, b) => a + b, 0) / tpsWerte.length) * 10) / 10,
			qualitaet:
				erg.length === 0
					? 0
					: Math.round((erg.reduce((a, r) => a + (r.ok ? r.quality : 0), 0) / erg.length) * 100) / 100,
			gesamtMs: Math.round(performance.now() - start),
		},
	}
}
