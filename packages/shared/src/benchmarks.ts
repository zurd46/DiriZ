/**
 * T1-5 Modell-Benchmarks: die Standard-Suite.
 *
 * Zehn kurze Aufgaben über die Kategorien Code, Reasoning und Sprache.
 * Jede Aufgabe trägt `erwartet` — Begriffe, die in einer vernünftigen
 * Antwort vorkommen sollten. Der Core zählt die Treffer als grobe
 * Qualitätsschätzung (Keyword-Match): kein Qualitätsurteil, aber ein
 * Signal, das sich zwischen Modellen vergleichen lässt.
 *
 * Bewusst kurz gehalten: Die Suite soll in Sekunden laufen und ein Modell
 * nicht mit einer halben Stunde Output belasten.
 */

export type BenchmarkCategory = "code" | "reasoning" | "sprache"

export interface BenchmarkTask {
	/** Stabile Kennung (z. B. „code-prim"). */
	id: string
	category: BenchmarkCategory
	/** Der Prompt — exakt so an das Modell, ohne Zusätze. */
	prompt: string
	/**
	 * Begriffe, die eine korrekte Antwort enthalten sollte.
	 * Gross-/Kleinschreibung egal; Teilstrings zählen (z. B. „is_prime"
	 * trifft auch „def is_prime").
	 */
	erwartet: string[]
	/** Kurze Beschreibung für die Oberfläche. */
	beschreibung: string
}

export const BENCHMARK_SUITE: readonly BenchmarkTask[] = [
	{
		id: "code-prime",
		category: "code",
		prompt:
			"Schreibe eine Python-Funktion is_prime(n), die prüft, ob n eine Primzahl ist. Kurz, nur die Funktion.",
		erwartet: ["is_prime"],
		beschreibung: "Python: Primzahl-Prüfung",
	},
	{
		id: "code-regex",
		category: "code",
		prompt:
			"Regulärer Ausdruck in JavaScript, der E-Mail-Adressen in einem Text findet. Nur der Ausdruck, kurz erklärt.",
		erwartet: ["@", "\\."],
		beschreibung: "JavaScript: E-Mail-Regex",
	},
	{
		id: "code-sql",
		category: "code",
		prompt: "SQL: Alle Bestellungen eines Kunden mit der Nummer 42, absteigend nach Datum. Nur das SELECT.",
		erwartet: ["order", "customer_id", "desc"],
		beschreibung: "SQL: gefiltertes SELECT",
	},
	{
		id: "code-fib",
		category: "code",
		prompt: "Python-Funktion fibonacci(n) mit Memoisierung (lru_cache oder Manuell). Kurz, nur die Funktion.",
		erwartet: ["fib", "cache"],
		beschreibung: "Python: Fibonacci mit Memo",
	},
	{
		id: "reasoning-anagram",
		category: "reasoning",
		prompt:
			"Welche dieser Wörter ist ein Anagramm von «listen»: silbern, sinlos, lints? Begründe in einem Satz.",
		erwartet: ["sinlos"],
		beschreibung: "Anagramm-Erkennung",
	},
	{
		id: "reasoning-datum",
		category: "reasoning",
		prompt:
			"Am 1. Januar 2025 ist ein Montag. An welchem Wochentag liegt der 1. Januar 2026? Nenne den Wochentag, Begründung in einem Satz.",
		erwartet: ["dienstag"],
		beschreibung: "Kalender-Arithmetik",
	},
	{
		id: "reasoning-waage",
		category: "reasoning",
		prompt:
			"Zehn Münzen, genau eine ist schwerer. Wie viele Waagen-Wiegungen genügen im schlechtesten Fall, um sie zu finden? Nenne die Zahl und die Strategie in zwei Sätzen.",
		erwartet: ["2"],
		beschreibung: "Logik: Münzen wiegen",
	},
	{
		id: "sprache-kurz",
		category: "sprache",
		prompt:
			"Fasse diesen Satz auf maximal fünf Wörter zusammen: «Die neue Regelung gilt ab dem ersten Juli in allen Bundesländern ohne Übergangsfrist.»",
		erwartet: ["juli", "alle"],
		beschreibung: "Zusammenfassung",
	},
	{
		id: "sprache-ton",
		category: "sprache",
		prompt:
			"Formuliere höflich, aber bestimmt: «Ihre Antwort ist zu spät und unvollständig.» Ein einziger Satz.",
		erwartet: ["bitte"],
		beschreibung: "Ton umformen",
	},
	{
		id: "sprache-reim",
		category: "sprache",
		prompt: "Zwei Zeilen, die sich reimen und das Wort «Server» enthalten. Nicht mehr, nicht weniger.",
		erwartet: ["server"],
		beschreibung: "Reim",
	},
] as const
