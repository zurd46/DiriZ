/**
 * SSE-Event-Bus (`01-plan.md` §7.3): Der Engine-Kern emittiert,
 * die `/api/stream`-Route + Tests abonnieren. Listener-Fehler dürfen
 * den Core nie reissen.
 */

import type { CoreEvent } from "@diriz/shared"

export type EventListener = (event: CoreEvent) => void

export class EventBus {
	private listeners = new Set<EventListener>()

	/** Abonniert; gibt die Unsubscribe-Funktion zurück. */
	subscribe(fn: EventListener): () => void {
		this.listeners.add(fn)
		return () => {
			this.listeners.delete(fn)
		}
	}

	emit(event: CoreEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(event)
			} catch {
				// Ein kaputter Listener blockiert nicht den Rest.
			}
		}
	}

	get listenerCount(): number {
		return this.listeners.size
	}
}
