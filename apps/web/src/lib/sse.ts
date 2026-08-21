/**
 * SSE-Client (`/api/stream`) mit Auto-Reconnect + Backoff.
 * Events werden als `{ event, data }`-Objekte an den Listener übergeben.
 */

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
		source = new EventSource(`${BASE}/api/stream`)
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
		const names = [
			"task.created",
			"routing.decided",
			"execution.delta",
			"execution.usage",
			"execution.failover",
			"execution.done",
			"execution.failed",
			"provider.status",
			"log",
		]
		for (const name of names) {
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
