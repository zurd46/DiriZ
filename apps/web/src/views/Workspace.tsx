/**
 * Workspace (M6): Dateibaum der Sandbox + Vorschau + Diff-Ansicht.
 * Alle Pfade stammen aus der DB — kein Freiform-Nutzerinput.
 */

import { type CSSProperties, useCallback, useEffect, useState } from "react"
import { IconAlert, IconArrowRight, IconDiff, IconEye, IconFile, IconWorkspace } from "../components/icons.js"
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
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Workspace</h1>
					<p className="page-sub">
						Dateien aus Task-Executions — Vorschau und Zeilen-Diff zwischen zwei Versionen.
					</p>
				</div>
				{files.length > 0 && (
					<span className="pill no-dot">
						{files.length} {files.length === 1 ? "Datei" : "Dateien"}
					</span>
				)}
			</div>

			{error && (
				<div className="banner error" role="alert">
					<IconAlert size={17} />
					<span className="banner-text">{error}</span>
				</div>
			)}

			<div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)", gap: 16 }}>
				<div className="card" style={{ maxHeight: "72vh", overflow: "auto", marginBottom: 0 }}>
					<div className="card-title">
						<IconWorkspace size={16} />
						Dateien
					</div>
					{files.length === 0 ? (
						<div className="empty">
							<span className="icon-chip lg" style={{ "--mc": "var(--muted)" } as CSSProperties}>
								<IconFile size={20} />
							</span>
							<p>Noch keine Dateien — führe eine Task im Agentik-Modus aus.</p>
						</div>
					) : (
						<ul className="file-list">
							{files.map((f) => (
								<li key={f.relPath}>
									<button
										type="button"
										className={`file-btn ${selected === f.relPath ? "active" : ""}`}
										onClick={() => setSelected(f.relPath)}
										title={f.relPath}
									>
										<IconFile size={14} />
										<span className="file-name">{f.relPath}</span>
										<span className="faint text-xs">{formatBytes(f.size)}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="card" style={{ maxHeight: "72vh", overflow: "auto", marginBottom: 0 }}>
					{!selected && (
						<div className="empty">
							<span className="icon-chip lg" style={{ "--mc": "var(--accent)" } as CSSProperties}>
								<IconEye size={20} />
							</span>
							<span className="empty-title">Keine Datei gewählt</span>
							<p>Wähle links eine Datei, um Inhalt und Änderungsverlauf zu sehen.</p>
						</div>
					)}
					{selected && (
						<>
							<div className="card-head">
								<span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
									{selected}
								</span>
								<div className="seg">
									<button
										type="button"
										className={tab === "preview" ? "active" : ""}
										onClick={() => setTab("preview")}
									>
										<IconEye size={13} />
										Vorschau
									</button>
									<button
										type="button"
										className={tab === "diff" ? "active" : ""}
										disabled={versions.length < 2}
										title={versions.length < 2 ? "Mindestens zwei Versionen nötig" : undefined}
										onClick={() => setTab("diff")}
									>
										<IconDiff size={13} />
										Diff {versions.length > 1 ? `(${versions.length})` : ""}
									</button>
								</div>
							</div>

							{tab === "preview" && (
								<div style={{ marginTop: 14 }}>
									<label className="field" style={{ maxWidth: 320 }}>
										Version
										<select
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
									</label>
									<pre className="code" style={{ marginTop: 12, maxHeight: "52vh", overflow: "auto" }}>
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
								<div style={{ marginTop: 14 }}>
									<div className="row" style={{ alignItems: "flex-end" }}>
										<label className="field">
											Von
											<select value={diffA} onChange={(e) => setDiffA(e.target.value)} aria-label="Version A">
												{versions.map((v) => (
													<option key={v.executionId} value={v.executionId}>
														{versionLabel(v)}
													</option>
												))}
											</select>
										</label>
										<span className="faint" style={{ paddingBottom: 8 }}>
											<IconArrowRight size={16} />
										</span>
										<label className="field">
											Nach
											<select value={diffB} onChange={(e) => setDiffB(e.target.value)} aria-label="Version B">
												{versions.map((v) => (
													<option key={v.executionId} value={v.executionId}>
														{versionLabel(v)}
													</option>
												))}
											</select>
										</label>
										{diff !== null && (
											<span className="row tight text-sm" style={{ paddingBottom: 8 }}>
												<span className="text-ok">+{added}</span>
												<span className="text-err">−{removed}</span>
												<span className="faint">Zeilen</span>
											</span>
										)}
									</div>
									{diffA === diffB && (
										<p className="hint" style={{ marginTop: 12 }}>
											<IconAlert size={14} />
											Zwei verschiedene Versionen wählen, um den Diff zu sehen.
										</p>
									)}
									{diff !== null && (
										<div className="diff-box" style={{ marginTop: 12 }}>
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
