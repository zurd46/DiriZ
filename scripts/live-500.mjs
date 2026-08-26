/**
 * Was genau bringt LM Studio zum Absturz? Der Verdacht: nicht die Grösse,
 * sondern die Form der Anfrage. Also Stück für Stück nachbauen und die
 * **vollständige** Fehlerantwort zeigen.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../packages/core/dist/db/connection.js"
import { migrate } from "../packages/core/dist/db/migrate.js"
import { getAgent, getAgentDoc } from "../packages/core/dist/db/repositories.js"
import { seedTeamCatalog } from "../packages/core/dist/db/seed.js"
import { TOOL_SPECS } from "../packages/core/dist/execution/tools.js"
import { composeSystemPrompt } from "../packages/shared/dist/index.js"

const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-500-")))
migrate(db)
seedTeamCatalog(db)

const agent = getAgent(db, "agent-code-reviewer")
const plan = getAgentDoc(db, "agent-code-reviewer", "plan")
const system = composeSystemPrompt([
	{ label: `Spezialist ${agent.name}`, plan: plan?.content, systemPrompt: agent.systemPrompt },
]).trim()

const übergabe = [
	"## Ursprünglicher Auftrag",
	"",
	"SKU bereinigen.",
	"",
	"## Vorarbeit aus Stufe 1",
	"",
	"Ich habe die Datei gelesen.",
	"",
	"## Deine Aufgabe",
	"",
	"Bau darauf auf.",
].join("\n")

async function versuch(name, body) {
	const res = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "qwen-agentworld-35b-a3b", stream: true, ...body }),
	})
	if (res.ok) {
		await res.body?.cancel()
		console.log(`  ✓ ${name}`)
		return true
	}
	const text = await res.text()
	console.log(`  ✗ ${name} → HTTP ${res.status}`)
	console.log(`      ${text.replace(/\s+/g, " ").slice(0, 400)}`)
	return false
}

console.log("Bausteine einzeln prüfen:\n")
await versuch("nur user", { messages: [{ role: "user", content: "hi" }] })
await versuch("system + user", {
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: "hi" },
	],
})
await versuch("user + tools", {
	messages: [{ role: "user", content: "hi" }],
	tools: TOOL_SPECS.map((t) => ({ type: "function", function: t })),
})
await versuch("system + übergabe", {
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: übergabe },
	],
})
await versuch("system + übergabe + tools", {
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: übergabe },
	],
	tools: TOOL_SPECS.map((t) => ({ type: "function", function: t })),
})
db.close()
