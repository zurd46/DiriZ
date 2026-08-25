/**
 * Echttest: Verträgt das Modell einen grossen Prompt — lokal, ohne Tunnel?
 * Genau die Grösse, die in der Kette entsteht (Auftrag + Vorarbeit).
 */
import { OpenAiCompatProvider } from "./packages/core/dist/providers/openai-compat.js"

const [baseUrl, model, kb] = process.argv.slice(2)
const füller = "Die Search Console meldet einen ungültigen Wert im Feld sku. ".repeat(Number(kb) * 17)
const adapter = new OpenAiCompatProvider({ id: "t", type: "lmstudio", label: "T", baseUrl })

console.log(`→ ${model} auf ${baseUrl}\n  Prompt: ${füller.length.toLocaleString("de-CH")} Zeichen (~${Math.round(füller.length / 3.5).toLocaleString("de-CH")} Token)`)
const t0 = Date.now()
let text = ""
try {
	for await (const c of adapter.chat({
		messages: [{ role: "user", content: `${füller}\n\nAntworte mit genau einem Satz: Worum geht es?` }],
		model,
	})) {
		if (c.type === "delta") text += c.text
	}
	console.log(`  ✓ ${Math.round((Date.now() - t0) / 1000)} s · Antwort: ${text.trim().slice(0, 120)}`)
} catch (e) {
	console.log(`  ✗ nach ${Math.round((Date.now() - t0) / 1000)} s: ${e.message.slice(0, 220)}`)
}
