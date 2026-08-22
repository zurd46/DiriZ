// Temporär: gespeicherten Token gegen den Live-Server testen (Token wird nicht ausgegeben)
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const dataDir = path.join(os.homedir(), ".diriz")
const db = new Database(path.join(dataDir, "diriz.sqlite"), { readonly: true })
const secret = fs.readFileSync(path.join(dataDir, "secret"))
const row = db.prepare("SELECT api_key_enc FROM providers WHERE type='lmstudio'").get()

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

const token = decrypt(row.api_key_enc)
for (const url of ["https://lokalai.ngrok.dev/v1/models", "https://lokalai.ngrok.dev/api/v0/models"]) {
	try {
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) })
		const body = (await res.text()).slice(0, 500)
		console.log(`\n${url}\n  HTTP ${res.status} ${res.statusText}\n  ${body.replace(/\s+/g, " ")}`)
	} catch (e) {
		console.log(`\n${url}\n  FEHLER: ${e.message}`)
	}
}
