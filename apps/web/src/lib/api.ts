/**
 * API-Client für den DiriZ Core. In der Dev-Umgebung läuft Vite mit
 * Proxy auf `http://127.0.0.1:8787`; in Produktion dieselbe Herkunft.
 */

const BASE: string = import.meta.env.VITE_DIRIZ_API ?? ""

export class ApiError extends Error {
	constructor(
		message: string,
		/** HTTP-Status; **0** bedeutet: gar keine Antwort (Netzwerk/Server aus). */
		readonly status: number,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = "ApiError"
	}

	/** Der Server kennt den Pfad nicht — er fährt älteren Code als diese Oberfläche. */
	missingRoute = false

	/** Kein Server erreichbar — anders zu behandeln als ein 4xx/5xx. */
	get offline(): boolean {
		return this.status === 0
	}
}

/**
 * Rückruf für „Route existiert nicht“. Der API-Client kennt den Store nicht
 * (und soll ihn nicht kennen) — die App hängt sich hier einmal ein.
 */
let onMissingRoute: (() => void) | undefined

export function setMissingRouteHandler(handler: () => void): void {
	onMissingRoute = handler
}

/**
 * Rückruf für „nicht angemeldet“ (HTTP 401). Die Sitzung kann jederzeit
 * ablaufen — dann gehört der Anmeldebildschirm auf den Schirm, nicht eine
 * Fehlermeldung in einer Ecke.
 */
let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler: () => void): void {
	onUnauthorized = handler
}

/** Adresse des Cores — für die Fehlermeldung, wenn er nicht antwortet. */
const CORE_URL = BASE || window.location.origin

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const hasBody = init?.body !== undefined && init.body !== null
	let res: Response
	try {
		res = await fetch(`${BASE}${path}`, {
			...init,
			// Die Anmeldung läuft über ein HttpOnly-Cookie; ohne `include`
			// schickt der Browser es aus der Dev-UI (anderer Port) nicht mit.
			credentials: "include",
			headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
		})
	} catch (e) {
		// `fetch` wirft bei Netzwerkfehlern ein nacktes „Failed to fetch“ — das
		// nennt weder Ursache noch Adresse. Der mit Abstand häufigste Fall ist
		// ein nicht laufender Core, also sagen wir genau das.
		throw new ApiError(
			`DiriZ Core nicht erreichbar (${CORE_URL}) — läuft der Server? Start mit „npm run serve“.`,
			0,
			{ cause: e },
		)
	}
	if (!res.ok) {
		let message = `HTTP ${res.status}`
		let missingRoute = false
		try {
			const body = (await res.json()) as { error?: string; message?: string }
			if (body.error) {
				message = body.error
			}
			// Fastify meldet unbekannte Pfade als 404 mit genau diesem Wortlaut.
			// Das ist der einzige verlässliche Hinweis darauf, dass der Server
			// älteren Code fährt als diese Oberfläche — ein Zeitstempel-Vergleich
			// schlüge auch bei einem reinen Oberflächen-Build an.
			missingRoute = res.status === 404 && /Route .* existiert nicht/.test(body.message ?? body.error ?? "")
			if (missingRoute) {
				message = `Der Core kennt diese Funktion nicht (${path}) — er läuft mit älterem Code.`
			}
		} catch {
			// Antwort hatte kein JSON.
		}
		const error = new ApiError(message, res.status)
		error.missingRoute = missingRoute
		if (missingRoute) {
			onMissingRoute?.()
		}
		if (res.status === 401) {
			onUnauthorized?.()
		}
		throw error
	}
	if (res.status === 204) {
		return undefined as T
	}
	return (await res.json()) as T
}

export const api = {
	get: <T>(path: string) => request<T>(path),
	post: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
	patch: <T>(path: string, body?: unknown) =>
		request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
	put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
	del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
}
