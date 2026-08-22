import type { HostMetrics, LoadInfo } from "@diriz/shared"
import { type CSSProperties, useEffect, useState } from "react"
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

function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} M`
	if (n >= 1_000) return `${(n / 1_000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} k`
	return n.toLocaleString("de-DE")
}

function loadClass(pct: number): "ok" | "warn" | "err" {
	if (pct > 85) return "err"
	if (pct > 60) return "warn"
	return "ok"
}

/* ---------------------------------- Icons ----------------------------------- */

const svgProps = {
	width: 17,
	height: 17,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
}

function IconServer() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<rect x="3" y="4" width="18" height="7" rx="2" />
			<rect x="3" y="13" width="18" height="7" rx="2" />
			<path d="M7 7.5h.01M7 16.5h.01" />
		</svg>
	)
}

function IconLayers() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<path d="m12 3 9 5-9 5-9-5 9-5Z" />
			<path d="m3 13.5 9 5 9-5" />
		</svg>
	)
}

function IconTasks() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<path d="M4 6h10M4 12h10M4 18h7" />
			<path d="m15 15.5 2 2 4-4.5" />
		</svg>
	)
}

function IconBolt() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
		</svg>
	)
}

function IconTokens() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
		</svg>
	)
}

function IconCost() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<path d="M15 9.3c-.7-1-1.8-1.6-3-1.6-1.9 0-3.2 1-3.2 2.4s1.3 2.4 3.2 2.4 3.2.9 3.2 2.4-1.3 2.4-3.2 2.4c-1.2 0-2.3-.6-3-1.6M12 5.8v1.9M12 16.3v1.9" />
		</svg>
	)
}

function IconChart() {
	return (
		<svg {...svgProps} aria-hidden="true">
			<path d="M4 20v-9M10 20V5M16 20v-6M3 20h18" />
		</svg>
	)
}

export default function Dashboard() {
	const metrics = useStore((s) => s.metrics)
	const timeseries = useStore((s) => s.timeseries)
	const providers = useStore((s) => s.providers)
	const lastError = useStore((s) => s.lastError)
	const [range, setRange] = useState<Range>(24)
	const [series7d, setSeries7d] = useState<typeof timeseries | null>(null)
	const [ollamaLoads, setOllamaLoads] = useState<OllamaLoad[]>([])
	const [host, setHost] = useState<HostMetrics | null>(null)
	const [dismissedError, setDismissedError] = useState<string | null>(null)

	// M8: Host-Metriken (RAM/CPU/GPU) — alle 5 s aktualisieren.
	useEffect(() => {
		let cancelled = false
		const load = () => {
			api
				.get<HostMetrics>("/api/host/metrics")
				.then((h) => {
					if (!cancelled) setHost(h)
				})
				.catch(() => {})
		}
		load()
		const timer = setInterval(load, 5000)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [])

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
	const labelStep = Math.max(1, Math.ceil(points.length / 8))
	const xLabel = (bucket: string) => (range === 24 ? `${bucket.slice(11, 13)}h` : bucket.slice(5))

	const cards = [
		{
			label: "Provider (online)",
			value: `${metrics?.onlineProviders ?? 0} / ${metrics?.providers ?? 0}`,
			icon: <IconServer />,
			color: "#4f8cff",
		},
		{ label: "Modelle", value: String(metrics?.instances ?? 0), icon: <IconLayers />, color: "#a78bfa" },
		{ label: "Tasks", value: String(metrics?.tasks ?? 0), icon: <IconTasks />, color: "#34d399" },
		{
			label: "Executions (aktiv)",
			value: `${metrics?.activeExecutions ?? 0} / ${metrics?.executions ?? 0}`,
			icon: <IconBolt />,
			color: "#f59e0b",
		},
		{
			label: "Tokens (24 h)",
			value: formatCompact((metrics?.tokensIn24h ?? 0) + (metrics?.tokensOut24h ?? 0)),
			sub: `${formatCompact(metrics?.tokensIn24h ?? 0)} in · ${formatCompact(metrics?.tokensOut24h ?? 0)} out`,
			icon: <IconTokens />,
			color: "#38bdf8",
		},
		{
			label: "Kosten (24 h)",
			value: `$${(metrics?.costUsd24h ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 4 })}`,
			icon: <IconCost />,
			color: "#f472b6",
		},
	]

	return (
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Dashboard</h1>
					<p className="page-sub">Überblick über Provider, Token-Volumen und System-Last</p>
				</div>
				{host && (
					<span className="live-chip" title="Host-Metriken werden alle 5 Sekunden aktualisiert">
						<span className="live-dot" />
						live · {new Date(host.timestamp).toLocaleTimeString("de-DE")}
					</span>
				)}
			</div>

			{lastError && lastError !== dismissedError && (
				<div className="error-banner" role="alert">
					<span>{lastError}</span>
					<button
						type="button"
						className="error-close"
						aria-label="Fehlermeldung schließen"
						onClick={() => setDismissedError(lastError)}
					>
						✕
					</button>
				</div>
			)}

			<div className="metrics-grid">
				{cards.map((c) => (
					<div key={c.label} className="card metric-card" style={{ "--mc": c.color } as CSSProperties}>
						<div className="icon-chip">{c.icon}</div>
						<div className="label">{c.label}</div>
						<div className="value">{c.value}</div>
						{"sub" in c && c.sub ? <div className="metric-sub">{c.sub}</div> : null}
					</div>
				))}
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">Token-Volumen &amp; Requests</div>
						<div className="card-sub">
							{range === 24 ? "Letzte 24 Stunden, stündlich" : "Letzte 7 Tage, täglich"}
						</div>
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
						<div className="legend">
							<span>
								<i style={{ background: "var(--accent)" }} />
								Tokens
							</span>
							<span>
								<i style={{ background: "var(--warn)" }} />
								Fehler
							</span>
						</div>
						<div className="seg">
							<button type="button" className={range === 24 ? "active" : ""} onClick={() => setRange(24)}>
								24 h
							</button>
							<button type="button" className={range === 168 ? "active" : ""} onClick={() => setRange(168)}>
								7 Tage
							</button>
						</div>
					</div>
				</div>
				{points.length === 0 ? (
					<div className="empty">
						<span className="icon-chip" style={{ "--mc": "var(--accent)" } as CSSProperties}>
							<IconChart />
						</span>
						Noch keine Daten — führe eine Task aus, um hier das Token-Volumen zu sehen.
					</div>
				) : (
					<>
						<div className="chart-wrap">
							{points.map((t) => (
								<div
									key={t.bucket}
									className="chart-col"
									title={`${t.bucket} — ${t.tokens.toLocaleString("de-DE")} Tokens · ${t.requests} Requests · $${t.costUsd.toFixed(3)}${t.errors ? ` · ${t.errors} Fehler` : ""}`}
								>
									<div
										className={`chart-bar${t.errors > 0 ? " error" : ""}`}
										style={{ height: `${Math.max(3, (t.tokens / maxTokens) * 100)}%` }}
									/>
								</div>
							))}
						</div>
						<div className="chart-x">
							{points.map((t, i) => (
								<span key={t.bucket}>{i % labelStep === 0 ? xLabel(t.bucket) : ""}</span>
							))}
						</div>
					</>
				)}
			</div>

			<div className="dash-cols">
				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">Ollama Load</div>
							<div className="card-sub">Geladene Modelle &amp; VRAM-Belegung</div>
						</div>
						{ollamaLoads.length > 0 && <span className="pill ok">{ollamaLoads.length} Provider</span>}
					</div>
					{ollamaLoads.length === 0 ? (
						<div className="empty">Kein Ollama-Provider verbunden.</div>
					) : (
						ollamaLoads.map((l) => {
							const usedPct =
								l.usedMemoryBytes !== undefined && l.totalMemoryBytes
									? Math.round((l.usedMemoryBytes / l.totalMemoryBytes) * 100)
									: null
							return (
								<div key={l.providerId} style={{ marginTop: 14 }}>
									<div className="row between">
										<span style={{ fontWeight: 600 }}>{l.label ?? l.providerId}</span>
										{usedPct !== null ? (
											<span className={`pill ${loadClass(usedPct)}`}>{usedPct}% VRAM</span>
										) : (
											<span className="muted" style={{ fontSize: 12 }}>
												keine Modelle geladen
											</span>
										)}
									</div>
									{usedPct !== null && (
										<div className="bar-track">
											<div
												className={`bar-fill ${loadClass(usedPct)}`}
												style={{ width: `${Math.min(100, usedPct)}%` }}
											/>
										</div>
									)}
									{l.loadedModels.length > 0 && (
										<div className="model-chips">
											{l.loadedModels.map((m) => (
												<span key={m.modelId} className="chip">
													{m.modelId} <b>{formatBytes(m.memoryBytes)}</b>
												</span>
											))}
										</div>
									)}
								</div>
							)
						})
					)}
				</div>

				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">System (Host)</div>
							<div className="card-sub">RAM, CPU &amp; GPU des Rechners</div>
						</div>
						{host && <span className="pill ok">{Math.round(host.uptimeSec / 3600)} h Uptime</span>}
					</div>
					{host === null ? (
						<div style={{ marginTop: 14 }}>
							<div className="skeleton" />
							<div className="skeleton" style={{ width: "85%" }} />
							<div className="skeleton" style={{ width: "60%" }} />
						</div>
					) : (
						<div style={{ marginTop: 14, display: "grid", gap: 12 }}>
							<div>
								<div className="row between" style={{ fontSize: 13 }}>
									<span title="RAM-Belegung dieses Rechners — Basis der Routing-Achse „Host-Last“">RAM</span>
									<span>
										{formatBytes(host.ramUsedBytes)} / {formatBytes(host.ramTotalBytes)} ·{" "}
										<strong>{host.ramUsagePct}%</strong>
									</span>
								</div>
								<div className="bar-track">
									<div
										className={`bar-fill ${loadClass(host.ramUsagePct)}`}
										style={{ width: `${Math.min(100, host.ramUsagePct)}%` }}
									/>
								</div>
							</div>
							<div className="row between" style={{ fontSize: 13 }}>
								<span>CPU</span>
								<span>
									{host.cpuCores} Kerne · Last (1 min) {host.loadAvg1m.toFixed(1)}
								</span>
							</div>
							<div className="row between" style={{ fontSize: 13 }}>
								<span>GPU</span>
								<span>
									{host.gpu
										? `${host.gpu.name}${host.gpu.vramTotalBytes ? ` · ${formatBytes(host.gpu.vramUsedBytes ?? 0)} / ${formatBytes(host.gpu.vramTotalBytes)} VRAM` : ""}`
										: "nicht detektierbar (Metal/Apple Silicon)"}
								</span>
							</div>
							<div className="muted" style={{ fontSize: 11 }}>
								{host.platform}/{host.arch} · Uptime {Math.round(host.uptimeSec / 3600)} h
							</div>
						</div>
					)}
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">Provider</div>
						<div className="card-sub">{providers.length} verbunden</div>
					</div>
				</div>
				<table className="table" style={{ marginTop: 10 }}>
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
									<span className={`pill ${p.status}`}>{p.status}</span>
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
