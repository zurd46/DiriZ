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

	/** Kein Server erreichbar — anders zu behandeln als ein 4xx/5xx. */
	get offline(): boolean {
		return this.status === 0
	}
}

/** Adresse des Cores — für die Fehlermeldung, wenn er nicht antwortet. */
const CORE_URL = BASE || window.location.origin

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const hasBody = init?.body !== undefined && init.body !== null
	let res: Response
	try {
		res = await fetch(`${BASE}${path}`, {
			...init,
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
		try {
			const body = (await res.json()) as { error?: string }
			if (body.error) {
				message = body.error
			}
		} catch {
			// Antwort hatte kein JSON.
		}
		throw new ApiError(message, res.status)
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
