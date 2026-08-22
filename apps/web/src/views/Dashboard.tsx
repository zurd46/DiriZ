import type { LoadInfo } from "@diriz/shared"
import { useEffect, useState } from "react"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

type Range = 24 | 168

interface OllamaLoad extends LoadInfo {
	providerId: string
	label?: string
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
	return `${Math.round(bytes / 1_048_576)} MB`
}

export default function Dashboard() {
	const metrics = useStore((s) => s.metrics)
	const timeseries = useStore((s) => s.timeseries)
	const providers = useStore((s) => s.providers)
	const lastError = useStore((s) => s.lastError)
	const [range, setRange] = useState<Range>(24)
	const [series7d, setSeries7d] = useState<typeof timeseries | null>(null)
	const [ollamaLoads, setOllamaLoads] = useState<OllamaLoad[]>([])

	useEffect(() => {
		if (range === 168 && series7d === null) {
			api
				.get<typeof timeseries>("/api/metrics/timeseries?hours=168")
				.then(setSeries7d)
				.catch(() => {})
		}
	}, [range, series7d])

	useEffect(() => {
		const ollama = providers.filter((p) => p.type === "ollama")
		if (ollama.length === 0) {
			setOllamaLoads([])
			return
		}
		let cancelled = false
		Promise.allSettled(
			ollama.map(
				async (p): Promise<OllamaLoad> => ({
					...(await api.get<LoadInfo>(`/api/providers/${p.id}/load`)),
					providerId: p.id,
					label: p.label,
				}),
			),
		).then((results) => {
			if (!cancelled) {
				setOllamaLoads(
					results
						.filter((r): r is PromiseFulfilledResult<OllamaLoad> => r.status === "fulfilled")
						.map((r) => r.value),
				)
			}
		})
		return () => {
			cancelled = true
		}
	}, [providers])

	const raw = range === 24 ? timeseries : (series7d ?? [])
	// 7-Tage-Ansicht: stündliche Buckets auf Tage aggregieren.
	const points =
		range === 168
			? Object.values(
					raw.reduce<
						Record<
							string,
							{ bucket: string; requests: number; tokens: number; costUsd: number; errors: number }
						>
					>((acc, p) => {
						const day = p.bucket.slice(0, 10)
						const cur = acc[day] ?? { bucket: day, requests: 0, tokens: 0, costUsd: 0, errors: 0 }
						cur.requests += p.requests
						cur.tokens += p.tokens
						cur.costUsd += p.costUsd
						cur.errors += p.errors
						acc[day] = cur
						return acc
					}, {}),
				)
			: raw

	const maxTokens = Math.max(1, ...points.map((t) => t.tokens))

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
					<div className="label">Executions (aktiv)</div>
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
				<div className="row between" style={{ alignItems: "center" }}>
					<strong>Token-Volumen &amp; Requests</strong>
					<div className="row" style={{ gap: 4 }}>
						<button
							type="button"
							className={`btn ${range === 24 ? "primary" : ""}`}
							onClick={() => setRange(24)}
						>
							24 h
						</button>
						<button
							type="button"
							className={`btn ${range === 168 ? "primary" : ""}`}
							onClick={() => setRange(168)}
						>
							7 Tage
						</button>
					</div>
				</div>
				<div className="row" style={{ gap: 3, height: 96, alignItems: "flex-end", marginTop: 12 }}>
					{points.length === 0 && <span className="muted">Noch keine Daten — führe eine Task aus.</span>}
					{points.map((t) => (
						<div
							key={t.bucket}
							style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
						>
							<div
								title={`${t.bucket} — ${t.tokens.toLocaleString("de-DE")} Tokens · ${t.requests} Requests · $${t.costUsd.toFixed(3)}${t.errors ? ` · ${t.errors} Fehler` : ""}`}
								style={{
									width: "100%",
									maxWidth: 28,
									background: t.errors > 0 ? "var(--warn)" : "var(--accent)",
									height: `${Math.max(4, (t.tokens / maxTokens) * 76)}px`,
									borderRadius: 3,
								}}
							/>
							<span className="muted" style={{ fontSize: 10 }}>
								{range === 24 ? `${t.bucket.slice(11, 13)}h` : t.bucket.slice(5)}
							</span>
						</div>
					))}
				</div>
			</div>

			<div className="card">
				<strong>Ollama Load</strong>
				{ollamaLoads.length === 0 && (
					<p className="muted" style={{ margin: "8px 0 0" }}>
						Kein Ollama-Provider verbunden.
					</p>
				)}
				{ollamaLoads.map((l) => {
					const usedPct =
						l.usedMemoryBytes !== undefined && l.totalMemoryBytes
							? Math.round((l.usedMemoryBytes / l.totalMemoryBytes) * 100)
							: null
					return (
						<div key={l.providerId} style={{ marginTop: 12 }}>
							<div className="row between">
								<span>{l.label ?? l.providerId}</span>
								<span className="muted">
									{l.loadedModels.length === 0
										? "keine Modelle geladen"
										: `${l.loadedModels.length} Modell(e)`}
									{usedPct !== null && ` · ${usedPct}% VRAM`}
								</span>
							</div>
							{usedPct !== null && (
								<div style={{ height: 6, background: "var(--panel-2)", borderRadius: 3, marginTop: 6 }}>
									<div
										style={{
											width: `${Math.min(100, usedPct)}%`,
											height: "100%",
											borderRadius: 3,
											background: usedPct > 85 ? "var(--err)" : usedPct > 60 ? "var(--warn)" : "var(--ok)",
										}}
									/>
								</div>
							)}
							{l.loadedModels.map((m) => (
								<div key={m.modelId} className="row between" style={{ fontSize: 12, marginTop: 4 }}>
									<span className="mono">{m.modelId}</span>
									<span className="muted">{formatBytes(m.memoryBytes)}</span>
								</div>
							))}
						</div>
					)
				})}
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
		</div>
	)
}
