import { useState } from "react"
import { useStore } from "../store.js"

const LEVELS = ["debug", "info", "warn", "error"] as const

export default function Logs() {
	const logs = useStore((s) => s.logs)
	const [level, setLevel] = useState<string>("")

	const filtered = level ? logs.filter((l) => l.level === level) : logs

	return (
		<div>
			<div className="row between">
				<h1>Logs</h1>
				<div className="row">
					<button
						type="button"
						className={`btn ${level === "" ? "primary" : ""}`}
						onClick={() => setLevel("")}
					>
						Alle
					</button>
					{LEVELS.map((l) => (
						<button
							type="button"
							key={l}
							className={`btn ${level === l ? "primary" : ""}`}
							onClick={() => setLevel(l)}
						>
							{l}
						</button>
					))}
				</div>
			</div>

			<div className="card" style={{ maxHeight: "70vh", overflow: "auto" }}>
				{filtered.length === 0 && <span className="muted">Keine Log-Einträge.</span>}
				{[...filtered].reverse().map((entry) => (
					<div className="log-line" key={`${entry.ts}|${entry.level}|${entry.scope}|${entry.msg}`}>
						<span className="muted">{entry.ts.slice(11, 19)}</span>
						<span className={`log-level ${entry.level}`}>{entry.level}</span>
						<span className="muted">{entry.scope}</span>
						<span>{entry.msg}</span>
					</div>
				))}
			</div>
		</div>
	)
}
