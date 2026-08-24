/**
 * SSE-Client (`/api/stream`) mit Auto-Reconnect + Backoff.
 * Events werden als `{ event, data }`-Objekte an den Listener übergeben.
 */

import { CORE_EVENT_NAMES } from "@diriz/shared"

const BASE: string = import.meta.env.VITE_DIRIZ_API ?? ""

export interface StreamEvent {
	event: string
	data: unknown
}

export interface SseHandle {
	close: () => void
}

export function connectStream(
	onEvent: (e: StreamEvent) => void,
	onState?: (connected: boolean) => void,
): SseHandle {
	let source: EventSource | undefined
	let closed = false
	let retry = 1000

	const open = () => {
		if (closed) {
			return
		}
		// `withCredentials`: Der Stream steht wie jede Route hinter der Anmeldung
		// — ohne Cookie käme nur ein 401 und eine endlose Wiederverbindung.
		source = new EventSource(`${BASE}/api/stream`, { withCredentials: true })
		source.onopen = () => {
			retry = 1000
			onState?.(true)
		}
		source.onerror = () => {
			onState?.(false)
			source?.close()
			if (!closed) {
				setTimeout(open, retry)
				retry = Math.min(retry * 2, 15_000)
			}
		}
		// Generic-Listener: Fastify sendet benannte Events (`event: <name>`).
		// Die Namen kommen aus dem Kontrakt — eine Kopie hier hatte bereits
		// `tool.call` und `task.pushed` verschluckt, weil sie niemand nachzog.
		for (const name of CORE_EVENT_NAMES) {
			source.addEventListener(name, ((e: MessageEvent) => {
				try {
					onEvent({ event: name, data: JSON.parse(e.data) })
				} catch {
					// Ungültiges JSON ignorieren.
				}
			}) as EventListener)
		}
	}

	open()

	return {
		close: () => {
			closed = true
			source?.close()
			onState?.(false)
		},
	}
}
