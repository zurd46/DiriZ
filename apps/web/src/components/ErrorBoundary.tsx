/**
 * Fehlergrenze — fängt Render-Fehler ab, bevor sie die ganze Oberfläche
 * abräumen. Ohne sie führt ein einziger Fehler in einer Ansicht zur weißen
 * Seite und die App ist ohne Neuladen nicht mehr bedienbar.
 *
 * Bewusst als Klasse: `componentDidCatch` gibt es in React nur so.
 */

import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
	children: ReactNode
	/** Wechselt dieser Wert, wird ein Fehler automatisch zurückgesetzt (z. B. Ansichtswechsel). */
	resetKey?: string
}

interface State {
	error?: Error
	stack?: string
}

export default class ErrorBoundary extends Component<Props, State> {
	state: State = {}

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		this.setState({ stack: info.componentStack ?? undefined })
		console.error("Unbehandelter Fehler in der Oberfläche:", error, info.componentStack)
	}

	componentDidUpdate(prev: Props): void {
		if (this.state.error && prev.resetKey !== this.props.resetKey) {
			this.setState({ error: undefined, stack: undefined })
		}
	}

	render(): ReactNode {
		const { error, stack } = this.state
		if (!error) {
			return this.props.children
		}
		return (
			<div className="card" style={{ maxWidth: 720, margin: "var(--sp-8) auto" }}>
				<div className="card-head">
					<div className="card-title">Diese Ansicht ist abgestürzt</div>
				</div>
				<p className="card-sub">
					Der Rest von DiriZ läuft weiter — der Core ist davon nicht betroffen. Unten steht, was passiert ist.
				</p>
				<pre className="output" style={{ marginTop: "var(--sp-3)", maxHeight: 240 }}>
					{error.message}
					{stack ? `\n${stack}` : ""}
				</pre>
				<div className="row" style={{ marginTop: "var(--sp-4)" }}>
					<button
						type="button"
						className="btn primary"
						onClick={() => this.setState({ error: undefined, stack: undefined })}
					>
						Erneut versuchen
					</button>
					<button type="button" className="btn ghost" onClick={() => window.location.reload()}>
						Seite neu laden
					</button>
				</div>
			</div>
		)
	}
}
