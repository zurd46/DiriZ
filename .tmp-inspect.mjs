// Temporäre Inspektion: Provider + (maskierter) API-Key aus ~/.diriz
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const dataDir = path.join(os.homedir(), ".diriz")
const db = new Database(path.join(dataDir, "diriz.sqlite"), { readonly: true })
const secret = fs.readFileSync(path.join(dataDir, "secret"))

function decrypt(payload) {
	const raw = Buffer.from(payload, "base64")
	const iv = raw.subarray(0, 12)
	const tag = raw.subarray(12, 28)
	const data = raw.subarray(28)
	const key = crypto.scryptSync(secret, "diriz.apikey.v1", 32)
	const d = crypto.createDecipheriv("aes-256-gcm", key, iv)
	d.setAuthTag(tag)
	return Buffer.concat([d.update(data), d.final()]).toString("utf8")
}

const providers = db.prepare("SELECT id,type,label,base_url,enabled,status,api_key_enc FROM providers").all()
for (const p of providers) {
	console.log(`\n=== Provider ${p.id}`)
	console.log(`  type=${p.type} label="${p.label}" base_url="${p.base_url}" enabled=${p.enabled} status=${p.status}`)
	if (!p.api_key_enc) {
		console.log("  api_key: <nicht hinterlegt>")
		continue
	}
	const t = decrypt(p.api_key_enc)
	const ws = (t.match(/\s/g) || []).map((c, i) => `pos ${i}: U+${c.charCodeAt(0).toString(16).toUpperCase()}`)
	console.log(`  api_key: len=${t.length} first="${t.slice(0, 5)}" last="…${t.slice(-4)}"`)
	console.log(`  startsWith lm-: ${t.startsWith("lm-")} | contains "Bearer": ${t.includes("Bearer")}`)
	console.log(`  whitespace: ${ws.length ? ws.join(", ") : "keine"} | non-printable: ${/[^\x20-\x7e]/.test(t)}`)
}

const inst = db.prepare("SELECT provider_id,model_id,display_name,status,last_seen_at FROM instances").all()
console.log(`\n=== Instances (${inst.length})`)
for (const i of inst) console.log(`  ${i.provider_id.slice(0, 8)} | ${i.model_id} | "${i.display_name}" | ${i.status} | ${i.last_seen_at}`)
