/**
 * Meldungen unten rechts. Fehler bleiben stehen, bis man sie schließt;
 * Erfolgs- und Info-Meldungen verschwinden von selbst (siehe `notify` im Store).
 */

import { useStore } from "../store.js"
import { IconAlert, IconCheckCircle, IconClose, IconInfo } from "./icons.js"

export default function Toasts() {
	const toasts = useStore((s) => s.toasts)
	const dismiss = useStore((s) => s.dismissToast)

	if (toasts.length === 0) {
		return null
	}

	return (
		<div className="toasts" role="status" aria-live="polite">
			{toasts.map((toast) => (
				<div key={toast.id} className={`toast ${toast.kind}`}>
					{toast.kind === "error" ? (
						<IconAlert size={16} />
					) : toast.kind === "success" ? (
						<IconCheckCircle size={16} />
					) : (
						<IconInfo size={16} />
					)}
					<span className="toast-text">{toast.message}</span>
					<button
						type="button"
						className="icon-btn sm"
						aria-label="Meldung schließen"
						onClick={() => dismiss(toast.id)}
					>
						<IconClose size={14} />
					</button>
				</div>
			))}
		</div>
	)
}
