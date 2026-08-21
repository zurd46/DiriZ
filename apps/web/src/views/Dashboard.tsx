import { useStore } from "../store.js"

export default function Dashboard() {
	const metrics = useStore((s) => s.metrics)
	const timeseries = useStore((s) => s.timeseries)
	const providers = useStore((s) => s.providers)
	const lastError = useStore((s) => s.lastError)

	const maxTokens = Math.max(1, ...timeseries.map((t) => t.tokens))

	return (
		<div>
			<h1>Dashboard</h1>
			{lastError && <div className="error-banner">{lastError}</div>}
			<div className="grid">
				<div className="card metric">
					<div className="label">Provider (online)</div>
					<div className="value">
						{metrics?.onlineProviders ?? 0} / {metrics?.providers ?? 0}
					</div>
				</div>
				<div className="card metric">
					<div className="label">Modelle</div>
					<div className="value">{metrics?.instances ?? 0}</div>
				</div>
				<div className="card metric">
					<div className="label">Tasks</div>
					<div className="value">{metrics?.tasks ?? 0}</div>
				</div>
				<div className="card metric">
					<div className="label">Executions</div>
					<div className="value">
						{metrics?.activeExecutions ?? 0} / {metrics?.executions ?? 0}
					</div>
				</div>
				<div className="card metric">
					<div className="label">Tokens (24 h)</div>
					<div className="value">
						{(metrics?.tokensIn24h ?? 0).toLocaleString("de-DE")} in ·{" "}
						{(metrics?.tokensOut24h ?? 0).toLocaleString("de-DE")} out
					</div>
				</div>
				<div className="card metric">
					<div className="label">Kosten (24 h)</div>
					<div className="value">{(metrics?.costUsd24h ?? 0).toFixed(4)} $</div>
				</div>
			</div>

			<div className="card">
				<div className="row between">
					<strong>Provider</strong>
					<span className="muted">{providers.length} verbunden</span>
				</div>
				<table className="table" style={{ marginTop: 8 }}>
					<thead>
						<tr>
							<th>Name</th>
							<th>Typ</th>
							<th>Status</th>
							<th>Modelle</th>
							<th>Latenz p50</th>
						</tr>
					</thead>
					<tbody>
						{providers.map((p) => (
							<tr key={p.id}>
								<td>{p.label}</td>
								<td className="muted">{p.type}</td>
								<td>
									<span className={`dot ${p.status}`} /> {p.status}
								</td>
								<td>{p.instanceCount ?? 0}</td>
								<td>{p.latencyP50 !== undefined ? `${p.latencyP50} ms` : "–"}</td>
							</tr>
						))}
						{providers.length === 0 && (
							<tr>
								<td colSpan={5} className="muted">
									Noch keine Provider — im Tab „Provider“ hinzufügen.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			<div className="card">
				<strong>Token-Volumen (letzte 24 h, stündlich)</strong>
				<div className="row" style={{ gap: 3, height: 64, alignItems: "flex-end", marginTop: 10 }}>
					{timeseries.length === 0 && <span className="muted">Noch keine Daten.</span>}
					{timeseries.map((t) => (
						<div
							key={t.bucket}
							title={`${t.bucket} — ${t.tokens} Tokens, ${t.requests} Requests, ${t.costUsd} $`}
							style={{
								flex: 1,
								maxWidth: 28,
								background: t.errors > 0 ? "var(--warn)" : "var(--accent)",
								height: `${Math.max(4, (t.tokens / maxTokens) * 100)}%`,
								borderRadius: 3,
							}}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
