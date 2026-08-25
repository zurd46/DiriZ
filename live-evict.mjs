/**
 * Reproduktion: Was passiert, wenn während eines laufenden Streams ein
 * **anderes** Modell auf demselben LM Studio angefordert wird? Mit
 * „Auto-evict" wird das laufende Modell dabei aus dem Speicher geworfen.
 */
import { OpenAiCompatProvider } from "./packages/core/dist/providers/openai-compat.js"

const base = "http://127.0.0.1:1234/v1"
const a = new OpenAiCompatProvider({ id: "a", type: "lmstudio", label: "A", baseUrl: base })
const b = new OpenAiCompatProvider({ id: "b", type: "lmstudio", label: "B", baseUrl: base })

const lang = { role: "user", content: "Zähle langsam von 1 bis 300, eine Zahl je Zeile." }

console.log("→ Stream auf Modell A startet …")
let chunks = 0
let fehlerA = ""
const laufA = (async () => {
	try {
		for await (const c of a.chat({ messages: [lang], model: "nvidia-nemotron-3.5-lightning-30b-a3b" })) {
			if (c.type === "delta") chunks++
		}
	} catch (e) {
		fehlerA = e.message
	}
})()

await new Promise((r) => setTimeout(r, 4000))
console.log(`  A streamt (${chunks} Chunks). Jetzt Modell B auf demselben Server anfordern …`)
let fehlerB = ""
try {
	for await (const c of b.chat({
		messages: [{ role: "user", content: "Sag hallo." }],
		model: "qwen3-coder-30b-a3b-instruct",
	})) {
		if (c.type === "done") break
	}
	console.log("  B: geantwortet")
} catch (e) {
	fehlerB = e.message
	console.log(`  B: ✗ ${e.message.slice(0, 200)}`)
}

await laufA
console.log(`\n  A insgesamt: ${chunks} Chunks${fehlerA ? ` · ✗ ${fehlerA.slice(0, 220)}` : " · sauber beendet"}`)
