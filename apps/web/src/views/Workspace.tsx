/**
 * Workspace (M6): Dateibaum der Sandbox + Vorschau + Diff-Ansicht.
 * Alle Pfade stammen aus der DB — kein Freiform-Nutzerinput.
 */

import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api.js"

interface WsFile {
	relPath: string
	size: number
	executionId: string
	taskId: string
}

interface FileVersion {
	executionId: string
	taskId: string
	size: number
	createdAt: string
}

type DiffLine = { type: "add" | "del" | "ctx"; text: string; lnA?: number; lnB?: number }

/** LCS-basierter Zeilen-Diff (lokal, ohne Abhängigkeiten). */
function diffLines(a: string[], b: string[]): DiffLine[] {
	const n = a.length
	const m = b.length
	if (n * m > 4_000_000) {
		return [
			...a.map((text, i) => ({ type: "del" as const, text, lnA: i + 1 })),
			...b.map((text, j) => ({ type: "add" as const, text, lnB: j + 1 })),
		]
	}
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
		}
	}
	const out: DiffLine[] = []
	let i = 0
	let j = 0
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: "ctx", text: a[i], lnA: i + 1, lnB: j + 1 })
			i++
			j++
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ type: "del", text: a[i], lnA: i + 1 })
			i++
		} else {
			out.push({ type: "add", text: b[j], lnB: j + 1 })
			j++
		}
	}
	while (i < n) {
		out.push({ type: "del", text: a[i], lnA: i + 1 })
		i++
	}
	while (j < m) {
		out.push({ type: "add", text: b[j], lnB: j + 1 })
		j++
	}
	return out
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
	return `${bytes} B`
}

function formatTime(iso: string): string {
	const d = new Date(iso)
	return d.toLocaleString("de-DE", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

export default function Workspace() {
	const [files, setFiles] = useState<WsFile[]>([])
	const [selected, setSelected] = useState<string | null>(null)
	const [versions, setVersions] = useState<FileVersion[]>([])
	const [previewId, setPreviewId] = useState<string>("")
	const [diffA, setDiffA] = useState<string>("")
	const [diffB, setDiffB] = useState<string>("")
	const [contentA, setContentA] = useState<string | null>(null)
	const [contentB, setContentB] = useState<string | null>(null)
	const [previewContent, setPreviewContent] = useState<string | null>(null)
	const [tab, setTab] = useState<"preview" | "diff">("preview")
	const [error, setError] = useState<string | undefined>()

	useEffect(() => {
		api
			.get<{ dir: string; files: WsFile[] }>("/api/workspace")
			.then((r) => setFiles(r.files))
			.catch((e) => setError(e.message))
	}, [])

	const loadVersion = useCallback(async (relPath: string, executionId: string): Promise<string> => {
		const r = await api.get<{ relPath: string; content: string }>(
			`/api/workspace/file?executionId=${encodeURIComponent(executionId)}&path=${encodeURIComponent(relPath)}`,
		)
		return r.content
	}, [])

	useEffect(() => {
		if (!selected) return
		setVersions([])
		setPreviewContent(null)
		api
			.get<FileVersion[]>(`/api/workspace/file-history?path=${encodeURIComponent(selected)}`)
			.then(async (history) => {
				setVersions(history)
				const latest = history[0]
				if (latest) {
					setPreviewId(latest.executionId)
					setDiffA(history.length > 1 ? history[history.length - 1].executionId : latest.executionId)
					setDiffB(latest.executionId)
					try {
						setPreviewContent(await loadVersion(selected, latest.executionId))
					} catch {
						/* Inhalt fehlt — History bleibt sichtbar */
					}
				}
			})
			.catch((e) => setError(e.message))
	}, [selected, loadVersion])

	useEffect(() => {
		if (!selected || !diffA || !diffB) return
		setContentA(null)
		setContentB(null)
		Promise.all([loadVersion(selected, diffA), loadVersion(selected, diffB)])
			.then(([a, b]) => {
				setContentA(a)
				setContentB(b)
			})
			.catch((e) => setError(e.message))
	}, [selected, diffA, diffB, loadVersion])

	const versionLabel = (v: FileVersion) => `${formatTime(v.createdAt)} · ${formatBytes(v.size)}`

	let diff: DiffLine[] | null = null
	if (tab === "diff" && contentA !== null && contentB !== null && diffA !== diffB) {
		diff = diffLines(contentA.split("\n"), contentB.split("\n"))
	}
	const added = diff?.filter((d) => d.type === "add").length ?? 0
	const removed = diff?.filter((d) => d.type === "del").length ?? 0

	return (
		<div>
			<h1>Workspace</h1>
			{error && <div className="error-banner">{error}</div>}
			<p className="muted">Dateien aus Task-Executions — Vorschau und Diff zwischen Versionen.</p>

			<div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 16 }}>
				<div className="card" style={{ maxHeight: "72vh", overflow: "auto" }}>
					<strong>Dateien</strong>
					{files.length === 0 && (
						<p className="muted" style={{ margin: "8px 0 0" }}>
							Noch keine Dateien — führe eine Task aus.
						</p>
					)}
					<ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
						{files.map((f) => (
							<li key={f.relPath}>
								<button
									type="button"
									className={`nav-btn ${selected === f.relPath ? "active" : ""}`}
									style={{ width: "100%", textAlign: "left", marginBottom: 2 }}
									onClick={() => setSelected(f.relPath)}
								>
									<span className="mono">{f.relPath}</span>{" "}
									<span className="muted">({formatBytes(f.size)})</span>
								</button>
							</li>
						))}
					</ul>
				</div>

				<div className="card" style={{ maxHeight: "72vh", overflow: "auto" }}>
					{!selected && <p className="muted">Datei links auswählen.</p>}
					{selected && (
						<>
							<div className="row between" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
								<span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
									{selected}
								</span>
								<div className="row" style={{ gap: 4 }}>
									<button
										type="button"
										className={`btn ${tab === "preview" ? "primary" : ""}`}
										onClick={() => setTab("preview")}
									>
										Vorschau
									</button>
									<button
										type="button"
										className={`btn ${tab === "diff" ? "primary" : ""}`}
										disabled={versions.length < 2}
										onClick={() => setTab("diff")}
									>
										Diff {versions.length > 1 && `(${versions.length})`}
									</button>
								</div>
							</div>

							{tab === "preview" && (
								<div style={{ marginTop: 12 }}>
									<select
										className="input"
										value={previewId}
										onChange={(e) => setPreviewId(e.target.value)}
										aria-label="Version"
									>
										{versions.map((v) => (
											<option key={v.executionId} value={v.executionId}>
												{versionLabel(v)}
											</option>
										))}
									</select>
									<pre className="code" style={{ marginTop: 10, maxHeight: "52vh", overflow: "auto" }}>
										{(previewContent ?? "").split("\n").map((line, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: statische Zeilenliste ohne Reorder — Index ist stabil.
											<div key={i} className="diff-line diff-ctx">
												<span className="ln">{i + 1}</span>
												<span>{line || " "}</span>
											</div>
										))}
									</pre>
								</div>
							)}

							{tab === "diff" && (
								<div style={{ marginTop: 12 }}>
									<div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
										<span className="muted">Von:</span>
										<select
											className="input"
											value={diffA}
											onChange={(e) => setDiffA(e.target.value)}
											aria-label="Version A"
										>
											{versions.map((v) => (
												<option key={v.executionId} value={v.executionId}>
													{versionLabel(v)}
												</option>
											))}
										</select>
										<span className="muted">→ Nach:</span>
										<select
											className="input"
											value={diffB}
											onChange={(e) => setDiffB(e.target.value)}
											aria-label="Version B"
										>
											{versions.map((v) => (
												<option key={v.executionId} value={v.executionId}>
													{versionLabel(v)}
												</option>
											))}
										</select>
									</div>
									{diffA === diffB && (
										<p className="muted" style={{ marginTop: 10 }}>
											Zwei verschiedene Versionen wählen, um den Diff zu sehen.
										</p>
									)}
									{diff !== null && (
										<>
											<p style={{ margin: "10px 0 6px", fontSize: 12 }}>
												<span style={{ color: "var(--ok)" }}>+{added} Zeilen</span> ·{" "}
												<span style={{ color: "var(--err)" }}>−{removed} Zeilen</span>
											</p>
											<div
												style={{
													maxHeight: "52vh",
													overflow: "auto",
													border: "1px solid var(--border)",
													borderRadius: 8,
												}}
											>
												{diff.map((d) => (
													<div
														key={`${d.type}-${d.lnA ?? d.lnB}`}
														className={`diff-line diff-${d.type === "add" ? "add" : d.type === "del" ? "del" : "ctx"}`}
													>
														<span className="ln">{d.lnA ?? ""}</span>
														<span>
															{(d.type === "add" ? "+" : d.type === "del" ? "-" : " ") + d.text || " "}
														</span>
													</div>
												))}
											</div>
										</>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	)
}
