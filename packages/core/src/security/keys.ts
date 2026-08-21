/**
 * API-Key-Verschlüsselung (`01-plan.md` §13).
 *
 * macOS-Keychain wäre die Ziellösung; bis dahin (und in Tests) der im Plan
 * definierte Fallback: lokale Datei `secret` mit chmod 600, daraus ein
 * Schlüssel, mit dem die Keys symmetrisch verschlüsselt werden (AES-256-GCM).
 * Der Klartext existiert nur im Speicher des Core-Prozesses.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export function loadOrCreateSecret(dataDir: string): Buffer {
	const file = path.join(dataDir, "secret")
	if (fs.existsSync(file)) {
		return fs.readFileSync(file)
	}
	fs.mkdirSync(dataDir, { recursive: true })
	const secret = crypto.randomBytes(32)
	fs.writeFileSync(file, secret, { mode: 0o600 })
	return secret
}

function deriveKey(secret: Buffer): Buffer {
	return crypto.scryptSync(secret, "diriz.apikey.v1", 32)
}

export function encryptString(plaintext: string, secret: Buffer): string {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv)
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	const tag = cipher.getAuthTag()
	return Buffer.concat([iv, tag, enc]).toString("base64")
}

export function decryptString(payload: string, secret: Buffer): string {
	const raw = Buffer.from(payload, "base64")
	const iv = raw.subarray(0, 12)
	const tag = raw.subarray(12, 28)
	const data = raw.subarray(28)
	const base = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), iv)
	const decipher = base as unknown as {
		setAuthTag(t: Buffer): void
		update(d: Buffer): Buffer
		final(): Buffer
	}
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}
