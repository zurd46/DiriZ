import { type CSSProperties, useMemo, useState } from "react"
import { IconClose, IconLogs, IconSearch } from "../components/icons.js"
import { useStore } from "../store.js"

const LEVELS = ["debug", "info", "warn", "error"] as const

export default function Logs() {
	const logs = useStore((s) => s.logs)
	const [level, setLevel] = useState<string>("")
	const [query, setQuery] = useState("")

	const counts = useMemo(() => {
		const acc: Record<string, number> = {}
		for (const l of logs) acc[l.level] = (acc[l.level] ?? 0) + 1
		return acc
	}, [logs])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		return logs.filter(
			(l) =>
				(level === "" || l.level === level) &&
				(q === "" || l.msg.toLowerCase().includes(q) || l.scope.toLowerCase().includes(q)),
		)
	}, [logs, level, query])

	return (
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Logs</h1>
					<p className="page-sub">
						Ereignisse des Cores — Routing, Provider-Health und Ausführungen. Aktualisiert sich alle 10
						Sekunden.
					</p>
				</div>
				<span className="live-chip">
					<span className="live-dot" />
					{logs.length} Einträge
				</span>
			</div>

			<div className="toolbar">
				<div className="seg">
					<button type="button" className={level === "" ? "active" : ""} onClick={() => setLevel("")}>
						Alle
					</button>
					{LEVELS.map((l) => (
						<button type="button" key={l} className={level === l ? "active" : ""} onClick={() => setLevel(l)}>
							{l}
							{counts[l] ? ` · ${counts[l]}` : ""}
						</button>
					))}
				</div>
				<div className="spacer" />
				<div className="row tight" style={{ position: "relative" }}>
					<span
						style={{
							position: "absolute",
							left: 9,
							top: "50%",
							transform: "translateY(-50%)",
							color: "var(--faint)",
							pointerEvents: "none",
							lineHeight: 0,
						}}
					>
						<IconSearch size={14} />
					</span>
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Nachricht oder Bereich filtern …"
						aria-label="Logs durchsuchen"
						style={{ paddingLeft: 30, minWidth: 260 }}
					/>
					{query && (
						<button
							type="button"
							className="icon-btn sm"
							aria-label="Filter zurücksetzen"
							onClick={() => setQuery("")}
						>
							<IconClose size={14} />
						</button>
					)}
				</div>
			</div>

			<div className="card flush">
				{filtered.length === 0 ? (
					<div className="empty">
						<span className="icon-chip lg" style={{ "--mc": "var(--muted)" } as CSSProperties}>
							<IconLogs size={20} />
						</span>
						<span className="empty-title">Keine Log-Einträge</span>
						<p>
							{logs.length === 0
								? "Sobald der Core arbeitet, erscheinen hier die Ereignisse."
								: "Kein Eintrag passt zum aktuellen Filter."}
						</p>
					</div>
				) : (
					<div className="log-list">
						{[...filtered].reverse().map((entry) => (
							<div className="log-line" key={`${entry.ts}|${entry.level}|${entry.scope}|${entry.msg}`}>
								<span className="faint">{entry.ts.slice(11, 19)}</span>
								<span className={`log-level ${entry.level}`}>{entry.level}</span>
								<span className="muted truncate" title={entry.scope}>
									{entry.scope}
								</span>
								<span>{entry.msg}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	)
}
