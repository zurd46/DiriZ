import type { HostMetrics, LoadInfo } from "@diriz/shared"
import { type CSSProperties, type ReactNode, useEffect, useState } from "react"
import {
	IconAlert,
	IconBolt,
	IconChart,
	IconChevronRight,
	IconClose,
	IconCost,
	IconCpu,
	IconGpu,
	IconLayers,
	IconMemory,
	IconServer,
	IconTasks,
	IconTokens,
} from "../components/icons.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

type Range = 24 | 168

interface RechnerLast extends LoadInfo {
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

interface MetricCard {
	label: string
	value: string
	sub?: string
	icon: ReactNode
	color: string
}

export default function Dashboard() {
	const metrics = useStore((s) => s.metrics)
	const timeseries = useStore((s) => s.timeseries)
	const providers = useStore((s) => s.providers)
	const lastError = useStore((s) => s.lastError)
	const [range, setRange] = useState<Range>(24)
	const [series7d, setSeries7d] = useState<typeof timeseries | null>(null)
	const [lasten, setLasten] = useState<RechnerLast[]>([])
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

	// **Alle lokalen Rechner**, nicht nur Ollama.
	//
	// Die Kachel hiess „Ollama Load" und fragte auch nur Ollama-Provider ab —
	// wer LM Studio betreibt, sah dauerhaft „Kein Ollama-Provider verbunden",
	// obwohl LM Studio dieselben Auskünfte gibt. Ein Überbleibsel aus der Zeit,
	// als es nur Ollama gab.
	useEffect(() => {
		const lokale = providers.filter((p) => p.type === "ollama" || p.type === "lmstudio")
		if (lokale.length === 0) {
			setLasten([])
			return
		}
		let cancelled = false
		Promise.allSettled(
			lokale.map(
				async (p): Promise<RechnerLast> => ({
					...(await api.get<LoadInfo>(`/api/providers/${p.id}/load`)),
					providerId: p.id,
					label: p.label,
				}),
			),
		).then((results) => {
			if (!cancelled) {
				setLasten(
					results
						.filter((r): r is PromiseFulfilledResult<RechnerLast> => r.status === "fulfilled")
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
	const totalRequests = points.reduce((sum, p) => sum + p.requests, 0)
	const totalErrors = points.reduce((sum, p) => sum + p.errors, 0)

	const cards: MetricCard[] = [
		{
			label: "Provider (online)",
			value: `${metrics?.onlineProviders ?? 0} / ${metrics?.providers ?? 0}`,
			icon: <IconServer size={17} />,
			color: "#5b8cff",
		},
		{
			label: "Modelle",
			value: String(metrics?.instances ?? 0),
			icon: <IconLayers size={17} />,
			color: "#a78bfa",
		},
		{
			label: "Tasks",
			value: String(metrics?.tasks ?? 0),
			icon: <IconTasks size={17} />,
			color: "#3ecf8e",
		},
		{
			label: "Executions (aktiv)",
			value: `${metrics?.activeExecutions ?? 0} / ${metrics?.executions ?? 0}`,
			icon: <IconBolt size={17} />,
			color: "#f5a524",
		},
		{
			label: "Tokens (24 h)",
			value: formatCompact((metrics?.tokensIn24h ?? 0) + (metrics?.tokensOut24h ?? 0)),
			sub: `${formatCompact(metrics?.tokensIn24h ?? 0)} in · ${formatCompact(metrics?.tokensOut24h ?? 0)} out`,
			icon: <IconTokens size={17} />,
			color: "#38bdf8",
		},
		{
			// T3-13: Lokale Läufe sind hier schon verrechnet — die Engine addiert
			// die Stromkosten in dieselbe cost_usd-Spalte.
			label: "Kosten inkl. Strom (24 h)",
			value: `$${(metrics?.costUsd24h ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 4 })}`,
			icon: <IconCost size={17} />,
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
				<div className="banner error" role="alert">
					<IconAlert size={17} />
					<span className="banner-text">{lastError}</span>
					<button
						type="button"
						className="icon-btn sm"
						aria-label="Fehlermeldung schließen"
						onClick={() => setDismissedError(lastError)}
					>
						<IconClose size={15} />
					</button>
				</div>
			)}

			<div className="metrics-grid">
				{cards.map((c) => (
					<div key={c.label} className="card metric-card" style={{ "--mc": c.color } as CSSProperties}>
						<div className="icon-chip">{c.icon}</div>
						<div className="label">{c.label}</div>
						<div className="value">{c.value}</div>
						{c.sub ? <div className="metric-sub">{c.sub}</div> : null}
					</div>
				))}
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconChart size={16} />
							Token-Volumen &amp; Requests
						</div>
						<div className="card-sub">
							{range === 24 ? "Letzte 24 Stunden, stündlich" : "Letzte 7 Tage, täglich"}
							{points.length > 0 && (
								<>
									{" · "}
									{totalRequests.toLocaleString("de-DE")} Requests
									{totalErrors > 0 && ` · ${totalErrors} Fehler`}
								</>
							)}
						</div>
					</div>
					<div className="row">
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
						<span className="icon-chip lg" style={{ "--mc": "var(--accent)" } as CSSProperties}>
							<IconChart size={20} />
						</span>
						<span className="empty-title">Noch keine Messwerte</span>
						<p>Führe eine Task aus — danach erscheint hier das Token-Volumen pro Zeitfenster.</p>
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
							<div className="card-title">
								<IconLayers size={16} />
								Geladene Modelle
							</div>
							<div className="card-sub">Was gerade im Speicher liegt — je Rechner</div>
						</div>
						{lasten.length > 0 && (
							<span className="pill ok">
								{lasten.length} {lasten.length === 1 ? "Rechner" : "Rechner"}
							</span>
						)}
					</div>
					{lasten.length === 0 ? (
						<div className="empty">
							<span className="icon-chip lg" style={{ "--mc": "var(--muted)" } as CSSProperties}>
								<IconServer size={20} />
							</span>
							<span className="empty-title">Kein lokaler Rechner verbunden</span>
							<p>
								Verbinde ein lokales LM Studio oder Ollama, um live zu sehen, welche Modelle geladen sind.
							</p>
						</div>
					) : (
						lasten.map((l) => {
							const usedPct =
								l.usedMemoryBytes !== undefined && l.totalMemoryBytes
									? Math.round((l.usedMemoryBytes / l.totalMemoryBytes) * 100)
									: null
							return (
								<div key={l.providerId} style={{ marginTop: 14 }}>
									<div className="row between">
										<strong>{l.label ?? l.providerId}</strong>
										{usedPct !== null ? (
											<span className={`pill ${loadClass(usedPct)}`}>{usedPct}% VRAM</span>
										) : (
											<span className="faint text-sm">keine Modelle geladen</span>
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
													{m.modelId} {/* Ollama meldet Speicher, LM Studio die geladene Fenstergrösse. */}
													<b>
														{m.memoryBytes > 0
															? formatBytes(m.memoryBytes)
															: m.contextWindow
																? `${formatCompact(m.contextWindow)} Kontext`
																: "geladen"}
													</b>
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
							<div className="card-title">
								<IconCpu size={16} />
								System (Host)
							</div>
							<div className="card-sub">RAM, CPU &amp; GPU des Rechners</div>
						</div>
						{host && <span className="pill no-dot">{Math.round(host.uptimeSec / 3600)} h Uptime</span>}
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
								<div className="kv">
									<span title="RAM-Belegung dieses Rechners — Basis der Routing-Achse „Host-Last“">
										<IconMemory size={15} />
										RAM
									</span>
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
							<div className="kv">
								<span>
									<IconCpu size={15} />
									CPU
								</span>
								<span>
									{host.cpuCores} Kerne · Last (1 min) <strong>{host.loadAvg1m.toFixed(1)}</strong>
								</span>
							</div>
							<div className="kv">
								<span>
									<IconGpu size={15} />
									GPU
								</span>
								<span>
									{host.gpu
										? `${host.gpu.name}${host.gpu.vramTotalBytes ? ` · ${formatBytes(host.gpu.vramUsedBytes ?? 0)} / ${formatBytes(host.gpu.vramTotalBytes)} VRAM` : ""}`
										: "nicht detektierbar (Metal/Apple Silicon)"}
								</span>
							</div>
							<div className="faint text-xs">
								{host.platform}/{host.arch} · Uptime {Math.round(host.uptimeSec / 3600)} h
							</div>
						</div>
					)}
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Provider
						</div>
						<div className="card-sub">
							{providers.length} verbunden · {providers.filter((p) => p.status === "online").length} online
						</div>
					</div>
				</div>
				<div className="table-wrap" style={{ marginTop: 10 }}>
					<table className="table">
						<thead>
							<tr>
								<th>Name</th>
								<th>Typ</th>
								<th>Status</th>
								<th className="num">Modelle</th>
								<th className="num">Latenz p50</th>
							</tr>
						</thead>
						<tbody>
							{providers.map((p) => (
								<tr key={p.id}>
									<td>
										<strong>{p.label}</strong>
									</td>
									<td className="muted mono">{p.type}</td>
									<td>
										<span className={`pill ${p.status}`}>{p.status}</span>
									</td>
									<td className="num">{p.instanceCount ?? 0}</td>
									<td className="num">{p.latencyP50 !== undefined ? `${p.latencyP50} ms` : "–"}</td>
								</tr>
							))}
							{providers.length === 0 && (
								<tr>
									<td colSpan={5}>
										<div className="empty">
											<span className="icon-chip lg" style={{ "--mc": "var(--muted)" } as CSSProperties}>
												<IconServer size={20} />
											</span>
											<span className="empty-title">Noch keine Provider</span>
											<p className="row" style={{ justifyContent: "center", gap: 4 }}>
												Im Bereich „Provider“ hinzufügen <IconChevronRight size={14} />
											</p>
										</div>
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	)
}
