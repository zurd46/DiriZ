/**
 * API-Client für den DiriZ Core. In der Dev-Umgebung läuft Vite mit
 * Proxy auf `http://127.0.0.1:8787`; in Produktion dieselbe Herkunft.
 */

const BASE: string = import.meta.env.VITE_DIRIZ_API ?? ""

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = "ApiError"
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const hasBody = init?.body !== undefined && init.body !== null
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
	})
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
