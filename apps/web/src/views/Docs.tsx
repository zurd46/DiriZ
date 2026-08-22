/**
 * Dokumente (M9): eine Ansicht für **alle** Deklarations-Dokumente des Systems
 * — `plan.md`, `changelog.md` und `init.md` je Rechner (Provider), je Modell
 * (LLM-Instanz) und je Spezialist.
 *
 * Bearbeiten, Markdown-Vorschau und Volltextsuche über den gesamten Bestand.
 * Gelesen wird gesammelt über `GET /api/docs`, geschrieben weiterhin über die
 * jeweilige Ebene (`PUT /api/<ebene>/:id/docs/:kind`).
 */

import {
	AGENT_DOC_FILES,
	AGENT_DOC_KINDS,
	type AgentDocKind,
	type DocOwnerKind,
	extractDirective,
	parseInitDoc,
	renderInitDoc,
} from "@diriz/shared"
import { useEffect, useMemo, useState } from "react"
import {
	IconAgents,
	IconCheckCircle,
	IconDoc,
	IconEdit,
	IconEye,
	IconInfo,
	IconLayers,
	IconRefresh,
	IconSearch,
	IconServer,
	IconSparkles,
} from "../components/icons.js"
import Markdown from "../components/Markdown.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

interface DocOwner {
	kind: DocOwnerKind
	id: string
	name: string
	basePath: string
	providerId?: string
	providerLabel?: string
	detail?: string
	enabled: boolean
	docs: Record<AgentDocKind, string>
	updatedAt: string
}

type ViewMode = "edit" | "split" | "preview"

const OWNER_META: Record<DocOwnerKind, { label: string; icon: typeof IconServer }> = {
	provider: { label: "Rechner", icon: IconServer },
	instance: { label: "Modell", icon: IconLayers },
	agent: { label: "Spezialist", icon: IconAgents },
}

const HINTS: Record<AgentDocKind, string> = {
	plan: "Wirksam: Auftrag, Vorgehen und Leitplanken gehen als verbindliche Arbeitsanweisung in den System-Prompt. Unausgefüllte Vorlagen-Zeilen ignoriert DiriZ.",
	changelog: "Änderungsprotokoll — DiriZ hängt bei jeder Bearbeitung automatisch einen Eintrag an.",
	init: "Wirksam: Zeilen der Form „Temperature: 0.3“ setzen die Voreinstellungen des LLM-Modells.",
}

/** Reihenfolge der Deklaration: Rechner ← Modell ← Spezialist. */
const GROUPS: { kind: DocOwnerKind; title: string; hint: string }[] = [
	{ kind: "provider", title: "Rechner", hint: "Gilt für alle Modelle darauf" },
	{ kind: "instance", title: "Modelle", hint: "Gilt für dieses eine LLM" },
	{ kind: "agent", title: "Spezialisten", hint: "Gilt für diesen Spezialisten" },
]

export default function Docs() {
	const setLastError = useStore((s) => s.setLastError)
	const lastError = useStore((s) => s.lastError)

	const [owners, setOwners] = useState<DocOwner[] | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [kind, setKind] = useState<AgentDocKind>("plan")
	const [mode, setMode] = useState<ViewMode>("split")
	const [query, setQuery] = useState("")
	/** Entwürfe je `<ownerId>:<kind>` — ungespeicherte Änderungen bleiben beim Wechseln erhalten. */
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [savedAt, setSavedAt] = useState<string | undefined>()

	useEffect(() => {
		let cancelled = false
		api
			.get<{ owners: DocOwner[] }>("/api/docs")
			.then((data) => {
				if (cancelled) return
				setOwners(data.owners)
				setSelectedId((prev) => prev ?? data.owners[0]?.id ?? null)
			})
			.catch((e: unknown) => setLastError(e instanceof Error ? e.message : String(e)))
		return () => {
			cancelled = true
		}
	}, [setLastError])

	const selected = owners?.find((o) => o.id === selectedId)
	const draftKey = `${selectedId}:${kind}`
	const stored = selected?.docs[kind] ?? ""
	const content = drafts[draftKey] ?? stored
	const dirty = selected !== undefined && content !== stored

	/** Trefferliste: Name, Detail und Dokument-Inhalte werden durchsucht. */
	const matches = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!owners) {
			return []
		}
		if (q.length === 0) {
			return owners.map((o) => ({ owner: o, hits: [] as AgentDocKind[] }))
		}
		const result: { owner: DocOwner; hits: AgentDocKind[] }[] = []
		for (const owner of owners) {
			const hits = AGENT_DOC_KINDS.filter((k) => owner.docs[k]?.toLowerCase().includes(q))
			const inName = owner.name.toLowerCase().includes(q) || (owner.detail ?? "").toLowerCase().includes(q)
			if (hits.length > 0 || inName) {
				result.push({ owner, hits })
			}
		}
		return result
	}, [owners, query])

	const dirtyCount = Object.entries(drafts).filter(([key, value]) => {
		const [ownerId, docKind] = key.split(":")
		const owner = owners?.find((o) => o.id === ownerId)
		return owner !== undefined && value !== owner.docs[docKind as AgentDocKind]
	}).length

	const save = async () => {
		if (!selected) {
			return
		}
		setBusy(true)
		try {
			await api.put(`${selected.basePath}/docs/${kind}`, { content })
			setOwners(
				(prev) =>
					prev?.map((o) => (o.id === selected.id ? { ...o, docs: { ...o.docs, [kind]: content } } : o)) ??
					prev,
			)
			setDrafts((prev) => {
				const next = { ...prev }
				delete next[draftKey]
				return next
			})
			setSavedAt(new Date().toLocaleTimeString("de-DE"))
			// `init.md` verändert die Model-Voreinstellungen — abhängige Ansichten neu laden.
			if (kind === "init") {
				const state = useStore.getState()
				void state.refreshProviders()
				void state.refreshAgents()
			}
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const setContent = (value: string) => setDrafts((prev) => ({ ...prev, [draftKey]: value }))

	const reset = () =>
		setDrafts((prev) => {
			const next = { ...prev }
			delete next[draftKey]
			return next
		})

	const directive = kind === "plan" ? extractDirective(content) : undefined
	const parsedEntries =
		kind === "init" ? Object.entries(parseInitDoc(content)).filter(([, v]) => v !== undefined) : []

	return (
		<div>
			<div className="page-head">
				<div>
					<h1>Dokumente</h1>
					<p className="page-sub">
						`plan.md`, `changelog.md` und `init.md` für jeden Rechner, jedes LLM-Modell und jeden Spezialisten
						— die Deklaration, nach der die Modelle arbeiten.
					</p>
				</div>
				<div className="page-actions">
					{dirtyCount > 0 && (
						<span className="badge warn">
							{dirtyCount} ungespeicherte {dirtyCount === 1 ? "Änderung" : "Änderungen"}
						</span>
					)}
				</div>
			</div>

			{lastError && <div className="error-banner">{lastError}</div>}

			<div className="docs-layout">
				{/* ------------------------------ Liste + Suche ------------------------------ */}
				<aside className="card flush docs-list">
					<div className="docs-search">
						<IconSearch size={15} />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Suchen in allen Dokumenten …"
							aria-label="Dokumente durchsuchen"
						/>
					</div>

					{owners === null ? (
						<div style={{ padding: "var(--sp-3)" }}>
							<div className="skeleton" />
							<div className="skeleton" style={{ width: "70%" }} />
							<div className="skeleton" style={{ width: "85%" }} />
						</div>
					) : matches.length === 0 ? (
						<p className="faint" style={{ padding: "var(--sp-4)" }}>
							Nichts gefunden.
						</p>
					) : (
						GROUPS.map((group) => {
							const items = matches.filter((m) => m.owner.kind === group.kind)
							if (items.length === 0) {
								return null
							}
							return (
								<div key={group.kind}>
									<div className="docs-group" title={group.hint}>
										{group.title}
										<span className="faint"> · {items.length}</span>
									</div>
									{items.map(({ owner, hits }) => {
										const Icon = OWNER_META[owner.kind].icon
										const ownerDirty = AGENT_DOC_KINDS.some(
											(k) =>
												drafts[`${owner.id}:${k}`] !== undefined &&
												drafts[`${owner.id}:${k}`] !== owner.docs[k],
										)
										return (
											<button
												key={owner.id}
												type="button"
												className={`docs-item ${selectedId === owner.id ? "active" : ""} ${
													owner.enabled ? "" : "off"
												}`}
												onClick={() => setSelectedId(owner.id)}
											>
												<Icon size={15} />
												<span className="docs-item-text">
													<span className="docs-item-name">
														{owner.name}
														{ownerDirty && <span className="dirty" title="ungespeichert" />}
													</span>
													<span className="docs-item-meta">
														{owner.providerLabel ? `${owner.providerLabel} · ` : ""}
														{owner.detail ?? OWNER_META[owner.kind].label}
													</span>
												</span>
												{hits.length > 0 && (
													<span className="badge subtle" title="Treffer in diesen Dokumenten">
														{hits.map((h) => AGENT_DOC_FILES[h].replace(".md", "")).join(", ")}
													</span>
												)}
											</button>
										)
									})}
								</div>
							)
						})
					)}
				</aside>

				{/* -------------------------------- Editor ---------------------------------- */}
				<section className="card flush docs-editor">
					{!selected ? (
						<div className="empty">
							<span className="icon-chip lg">
								<IconDoc size={20} />
							</span>
							<div className="empty-title">Kein Dokument gewählt</div>
							<p>Wähle links einen Rechner, ein Modell oder einen Spezialisten.</p>
						</div>
					) : (
						<>
							<div className="docs-editor-head">
								<div>
									<div className="card-title">
										{(() => {
											const Icon = OWNER_META[selected.kind].icon
											return <Icon size={16} />
										})()}
										{selected.name}
									</div>
									<div className="card-sub">
										{OWNER_META[selected.kind].label}
										{selected.providerLabel ? ` auf ${selected.providerLabel}` : ""}
										{selected.detail ? ` · ${selected.detail}` : ""}
									</div>
								</div>
								<div className="seg">
									<button
										type="button"
										className={mode === "edit" ? "active" : ""}
										onClick={() => setMode("edit")}
										title="Nur bearbeiten"
									>
										<IconEdit size={14} />
										Bearbeiten
									</button>
									<button
										type="button"
										className={mode === "split" ? "active" : ""}
										onClick={() => setMode("split")}
										title="Bearbeiten und Vorschau nebeneinander"
									>
										Geteilt
									</button>
									<button
										type="button"
										className={mode === "preview" ? "active" : ""}
										onClick={() => setMode("preview")}
										title="Nur Vorschau"
									>
										<IconEye size={14} />
										Vorschau
									</button>
								</div>
							</div>

							<div className="tabs">
								{AGENT_DOC_KINDS.map((k) => {
									const kDirty =
										drafts[`${selected.id}:${k}`] !== undefined &&
										drafts[`${selected.id}:${k}`] !== selected.docs[k]
									return (
										<button
											key={k}
											type="button"
											className={`tab ${kind === k ? "active" : ""}`}
											onClick={() => setKind(k)}
										>
											<IconDoc size={14} />
											{AGENT_DOC_FILES[k]}
											{kDirty && <span className="dirty" title="ungespeicherte Änderungen" />}
										</button>
									)
								})}
							</div>

							<p className="hint" style={{ margin: "var(--sp-3) 0 0" }}>
								<IconInfo size={14} />
								<span>{HINTS[kind]}</span>
							</p>

							<div className={`docs-panes ${mode}`}>
								{mode !== "preview" && (
									<textarea
										className="mono docs-textarea"
										value={content}
										onChange={(e) => setContent(e.target.value)}
										placeholder={`# ${AGENT_DOC_FILES[kind]}`}
										aria-label={`${AGENT_DOC_FILES[kind]} von ${selected.name}`}
										spellCheck={false}
									/>
								)}
								{mode !== "edit" && (
									<div className="docs-preview">
										<Markdown source={content} />
									</div>
								)}
							</div>

							{kind === "plan" && (
								<div style={{ marginTop: "var(--sp-3)" }}>
									{directive ? (
										<>
											<div className="field-hint">Das Modell erhält daraus:</div>
											<pre className="output" style={{ maxHeight: 150 }}>
												{directive}
											</pre>
										</>
									) : (
										<p className="hint">
											<IconInfo size={14} />
											<span>
												Noch nichts deklariert — solange nur Vorlagen-Platzhalter dastehen, geht nichts an das
												Modell.
											</span>
										</p>
									)}
								</div>
							)}

							{kind === "init" && (
								<div className="row tight" style={{ marginTop: "var(--sp-3)" }}>
									<span className="field-hint">Erkannte Voreinstellungen:</span>
									{parsedEntries.length === 0 ? (
										<span className="faint text-sm">keine</span>
									) : (
										parsedEntries.map(([k, v]) => (
											<span key={k} className="badge accent">
												{k}: {Array.isArray(v) ? v.join(" | ") : String(v).slice(0, 40)}
											</span>
										))
									)}
								</div>
							)}

							<div className="row" style={{ marginTop: "var(--sp-4)" }}>
								<button
									type="button"
									className="btn primary"
									onClick={() => void save()}
									disabled={busy || !dirty}
								>
									{busy ? "Speichere …" : "Speichern"}
								</button>
								<button type="button" className="btn ghost" onClick={reset} disabled={!dirty}>
									<IconRefresh size={15} />
									Zurücksetzen
								</button>
								{kind === "init" && (
									<button
										type="button"
										className="btn"
										title="Format vereinheitlichen"
										onClick={() => setContent(renderInitDoc(parseInitDoc(content), selected.name))}
									>
										<IconSparkles size={15} />
										Aufräumen
									</button>
								)}
								<span className="spacer" style={{ marginLeft: "auto" }} />
								<span className="faint text-sm">
									{content.split(/\r?\n/).length} Zeilen · {content.length} Zeichen
								</span>
								{savedAt && !dirty && (
									<span className="text-ok row tight text-sm">
										<IconCheckCircle size={15} />
										Gespeichert {savedAt}
									</span>
								)}
							</div>
						</>
					)}
				</section>
			</div>
		</div>
	)
}
