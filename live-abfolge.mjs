/** Zwei Anfragen unmittelbar nacheinander — wie Stufe 1 → Stufe 2. */

import { TOOL_SPECS } from "./packages/core/dist/execution/tools.js"
import { OpenAiCompatProvider } from "./packages/core/dist/providers/openai-compat.js"

const a = new OpenAiCompatProvider({
	id: "a",
	type: "lmstudio",
	label: "A",
	baseUrl: "http://127.0.0.1:1234/v1",
})
const model = "qwen-agentworld-35b-a3b"

async function lauf(name, opts = {}) {
	const t0 = Date.now()
	try {
		let text = ""
		let calls = 0
		for await (const c of a.chat({
			messages: [{ role: "user", content: "Liste die Dateien im Workspace auf." }],
			model,
			tools: TOOL_SPECS,
			...opts,
		})) {
			if (c.type === "delta") text += c.text
			if (c.type === "tool_call") calls++
		}
		console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)} s, ${calls} Tool-Calls)`)
		return true
	} catch (e) {
		console.log(`  ✗ ${name} nach ${Math.round((Date.now() - t0) / 1000)} s: ${e.message.slice(0, 160)}`)
		return false
	}
}

console.log("Fünf Anfragen unmittelbar hintereinander (wie eine Kette):\n")
for (let i = 1; i <= 5; i++) {
	await lauf(`Anfrage ${i}`)
}

console.log("\nDasselbe mit 2 s Pause dazwischen:\n")
for (let i = 1; i <= 3; i++) {
	await lauf(`Anfrage ${i}`)
	await new Promise((r) => setTimeout(r, 2000))
}
