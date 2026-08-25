/**
 * ECHTTEST DER GANZEN KETTE.
 *
 * Eigene Datenbank und eigener Workspace (die echten Daten bleiben unberührt),
 * aber **echter** Rechner, **echte** Modelle, **echte** Engine: Routing →
 * Agentik mit Werkzeugen → Übergabe → nächste Stufe.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "./packages/core/dist/db/connection.js"
import { migrate } from "./packages/core/dist/db/migrate.js"
import {
	createProvider,
	createTask,
	getTask,
	listExecutionsByTask,
	listTasks,
	listToolCallsByTask,
} from "./packages/core/dist/db/repositories.js"
import { seedTeamCatalog } from "./packages/core/dist/db/seed.js"
import { EventBus } from "./packages/core/dist/execution/bus.js"
import { ExecutionEngine } from "./packages/core/dist/execution/engine.js"
import { ProviderRegistry } from "./packages/core/dist/providers/registry.js"
import { Feedback } from "./packages/core/dist/routing/feedback.js"

// Mitschnitt: Bei jedem Fehlschlag die **ganze** Anfrage und Antwort zeigen.
const echterFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
	const res = await echterFetch(url, init)
	if (!res.ok && String(url).includes("chat/completions")) {
		const body = JSON.parse(String(init?.body ?? "{}"))
		const antwort = await res.clone().text()
		console.log(`\n  ‼️  HTTP ${res.status} bei ${url}`)
		console.log(`      Modell: ${body.model} · stream: ${body.stream} · tools: ${body.tools?.length ?? 0}`)
		console.log(
			`      Nachrichten: ${(body.messages ?? []).map((m) => `${m.role}(${(m.content ?? "").length}${m.tool_calls ? `,calls:${m.tool_calls.length}` : ""})`).join(" ")}`,
		)
		console.log(
			`      Settings: ${JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !["model", "messages", "tools", "stream"].includes(k))))}`,
		)
		console.log(`      Antwort: ${antwort.replace(/\s+/g, " ").slice(0, 500)}\n`)
	}
	return res
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-kette-db-"))
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-kette-ws-"))
const db = openDatabase(dataDir)
migrate(db)
seedTeamCatalog(db)

const bus = new EventBus()
const laut = process.env.LAUT === "1"
const log = (lvl, scope, msg) => {
	if (laut || ["routing", "agents", "failover"].includes(scope)) console.log(`    [${scope}] ${msg}`)
}
const registry = new ProviderRegistry(
	db,
	(e) => bus.emit(e),
	log,
	() => undefined,
)
createProvider(db, { type: "lmstudio", label: "MacDani", baseUrl: "http://127.0.0.1:1234/v1" })
await registry.bootstrap()
await new Promise((r) => setTimeout(r, 1500))
console.log(`Rechner bereit · ${registry.instances().length} Modelle entdeckt\n`)

const engine = new ExecutionEngine({
	db,
	registry,
	feedback: new Feedback(db),
	emit: (e) => bus.emit(e),
	log,
	workspaceDir,
})

// Ein kleines „Projekt“, an dem die Kette wirklich etwas tun muss.
// Vier Spezialisten, dritte Stufe **parallel** — wie im echten Auftrag.
const stufen = [
	["agent-requirements-analyst"],
	["agent-backend-entwickler"],
	["agent-code-reviewer", "agent-test-engineer"],
]
const kette = stufen.flat()
const task = createTask(db, {
	title: "SKU bereinigen",
	prompt:
		'Im Workspace liegt src/seo.js mit `export const sku = " ABC-123 "`. ' +
		"Entferne die Leerzeichen im SKU-Wert und prüfe die Änderung mit " +
		"`node -e \"import('./src/seo.js').then(m=>console.log(JSON.stringify(m.sku)))\"`.",
	assignmentMode: "agent",
	agentId: kette[0],
	metadata: {
		privacy: "local-only",
		mode: "auto",
		agentMode: true,
		chain: { id: "kette-live", agentIds: kette, index: 0, stages: stufen, stage: 0 },
	},
})

// Workspace der Wurzel-Task vorbereiten (alle Stufen teilen ihn sich).
const dir = path.join(workspaceDir, `sku-bereinigen-${task.id.slice(0, 8)}`)
fs.mkdirSync(path.join(dir, "src"), { recursive: true })
fs.writeFileSync(path.join(dir, "src", "seo.js"), 'export const sku = " ABC-123 "\n')
console.log(`Workspace: ${dir}\nStart …\n`)

const t0 = Date.now()
try {
	await engine.runTask(task)
} catch (e) {
	console.log(`  Stufe 1 warf: ${e.message}`)
}

// Auf die Folgestufen warten — sie startet die Engine selbst.
for (let i = 0; i < 180; i++) {
	const offen = listTasks(db).filter((t) => ["draft", "queued", "routing", "running"].includes(t.status))
	if (offen.length === 0 && listTasks(db).length >= kette.length) break
	await new Promise((r) => setTimeout(r, 2000))
}

console.log(`\n═══ Ergebnis nach ${Math.round((Date.now() - t0) / 1000)} s ═══`)
console.log(`  Stufen: ${stufen.length} · Spezialisten: ${kette.length} · Tasks angelegt: ${listTasks(db).length}`)
let allesGut = true
for (const t of listTasks(db).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
	const stufe = (t.metadata.chain?.stage ?? 0) + 1
	const ops = listToolCallsByTask(db, t.id)
	const exec = listExecutionsByTask(db, t.id).at(-1)
	const ok = t.status === "done"
	if (!ok) allesGut = false
	console.log(
		`  ${ok ? "✓" : "✗"} Stufe ${stufe} · ${t.agentId?.replace("agent-", "")} · ${t.status} · ` +
			`${ops.length} Ops (${ops.filter((o) => !o.ok).length} Fehler)` +
			`${exec?.error ? ` · ${exec.error.slice(0, 90)}` : ""}`,
	)
	if (stufe > 1) {
		const hatVorarbeit = t.prompt.includes("## Vorarbeit aus Stufe")
		const gleicherOrdner = t.metadata.chain?.rootTaskId === task.id
		console.log(
			`      Übergabe: ${hatVorarbeit ? "✓" : "✗"} · gemeinsames Arbeitsverzeichnis: ${gleicherOrdner ? "✓" : "✗"}`,
		)
		if (!hatVorarbeit || !gleicherOrdner) allesGut = false
	}
}
const inhalt = fs.readFileSync(path.join(dir, "src", "seo.js"), "utf8").trim()
const geändert = inhalt.includes('"ABC-123"')
console.log(`\n  Datei: ${inhalt}`)
console.log(`  SKU bereinigt: ${geändert ? "✓" : "✗"}`)
console.log(`\n═══ ${allesGut && geändert ? "KETTE LÄUFT" : "PROBLEM"} ═══`)
db.close()
process.exit(allesGut && geändert ? 0 : 1)
