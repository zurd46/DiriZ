/**
 * Passwörter und Sitzungen.
 *
 * Passwort: **scrypt** mit zufälligem Salt je Benutzer, verglichen in
 * konstanter Zeit. Kein Klartext, kein wiederverwendetes Salt, keine schnelle
 * Hash-Funktion — ein gestohlener Datenbankauszug soll wertlos sein.
 *
 * Sitzung: ein zufälliges Token (32 Byte) im HttpOnly-Cookie; in der Datenbank
 * liegt nur sein SHA-256. Damit lässt sich aus der Datenbank keine fremde
 * Sitzung übernehmen, und das Token ist trotzdem in einem Schlag prüfbar.
 */

import crypto from "node:crypto"

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const

/** `scrypt$<salt-hex>$<hash-hex>` — Format und Parameter stehen im Wert selbst. */
export function hashPassword(password: string): string {
	const salt = crypto.randomBytes(16)
	const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`
}

/**
 * Prüft ein Passwort. Vergleich in konstanter Zeit — ein Vergleich, der beim
 * ersten falschen Zeichen abbricht, verrät über die Laufzeit das Passwort.
 */
export function verifyPassword(password: string, stored: string): boolean {
	const [scheme, saltHex, hashHex] = (stored ?? "").split("$")
	if (scheme !== "scrypt" || !saltHex || !hashHex) {
		return false
	}
	const expected = Buffer.from(hashHex, "hex")
	let actual: Buffer
	try {
		actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, SCRYPT)
	} catch {
		return false
	}
	return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/** Neues Sitzungs-Token — das Klartext-Token verlässt den Prozess nur als Cookie. */
export function createSessionToken(): { token: string; hash: string } {
	const token = crypto.randomBytes(32).toString("base64url")
	return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex")
}

/**
 * Mindestanforderung an ein Passwort. Bewusst niedrig gehalten und ohne
 * Zeichenklassen-Zwang: Für einen lokalen Dienst ist Länge der einzige Faktor,
 * der wirklich zählt — Sonderzeichen-Regeln erzeugen nur „Passwort1!".
 */
export const MIN_PASSWORD_LENGTH = 8

export function passwordProblem(password: string): string | undefined {
	if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
		return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben`
	}
	return undefined
}

/** Erlaubte Benutzernamen: 3–32 Zeichen, Buchstaben/Ziffern/._- */
export function usernameProblem(username: string): string | undefined {
	if (typeof username !== "string" || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
		return "Benutzername: 3–32 Zeichen, erlaubt sind Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich"
	}
	return undefined
}
