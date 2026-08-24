/**
 * LLM-Modelle: pro Modell ein Datenblatt (`llm.md`).
 *
 * Eigene Ansicht, weil ein Modell etwas anderes ist als ein Spezialist. Der
 * Spezialist bekommt einen Auftrag; das Modell hat Eigenschaften — Fähigkeiten,
 * Kontext, Werkzeuge, Stärken, Schwächen, Voreinstellungen. Genau die braucht
 * die Orchestrierung, um das richtige Modell zu wählen, und genau die stehen
 * hier — in **einem** Dokument, nicht in dreien.
 *
 * Was gespeichert wird, wirkt sofort: Fähigkeiten und Kontext-Fenster sind
 * harte Routing-Gates, „Gut für"/„Nicht geeignet für" bewegen die
 * Eignungs-Achse, `## Werkzeuge` regelt den Agentik-Modus.
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	docKindsFor,
	type InstanceModel,
	parseLlmDoc,
	renderLlmDoc,
} from "@diriz/shared"
import { useEffect, useMemo, useState } from "react"
import {
	IconCheckCircle,
	IconDoc,
	IconEdit,
	IconEye,
	IconInfo,
	IconLayers,
	IconRefresh,
	IconSearch,
	IconSparkles,
} from "../components/icons.js"
import Markdown from "../components/Markdown.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

/** Ein Modell mit gemessenem Tempo, wie `GET /api/instances` es liefert. */
type InstanceWithSpeed = InstanceModel & { tokensPerSecond?: number }

/** Ein Modell aus `GET /api/docs` — inklusive seiner Dokumente. */
interface ModelOwner {
	kind: string
	id: string
	name: string
	basePath: string
	providerId?: string
	providerLabel?: string
	detail?: string
	enabled: boolean
	docs: Record<AgentDocKind, string>
}

type ViewMode = "edit" | "split" | "preview"

/** Ein Modell führt genau ein Dokument — sein Datenblatt. */
const KIND: AgentDocKind = docKindsFor("instance")[0] ?? "llm"

const HINT =
	"Alles hier ist wirksam: Fähigkeiten und Kontext-Fenster sind harte Routing-Gates, „Gut für“ und „Nicht geeignet für“ bewegen die Eignungs-Achse, „Werkzeuge“ regelt den Agentik-Modus, die Qualitätsklasse ist der Startwert der Qualitäts-Achse und „Voreinstellungen“ setzt Temperatur & Co."

export default function Models() {
	const setLastError = useStore((s) => s.setLastError)
	const lastError = useStore((s) => s.lastError)

	const [models, setModels] = useState<ModelOwner[] | null>(null)
	const [instances, setInstances] = useState<InstanceWithSpeed[]>([])
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [mode, setMode] = useState<ViewMode>("split")
	const [query, setQuery] = useState("")
	/** Entwürfe je `<modellId>:<kind>` — ungespeicherte Änderungen überleben den Wechsel. */
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [savedAt, setSavedAt] = useState<string | undefined>()

	const load = useMemo(
		() => async () => {
			const [docs, list] = await Promise.all([
				api.get<{ owners: ModelOwner[] }>("/api/docs"),
				api.get<InstanceWithSpeed[]>("/api/instances"),
			])
			const onlyModels = docs.owners.filter((o) => o.kind === "instance")
			setModels(onlyModels)
			setInstances(list)
			setSelectedId((prev) => prev ?? onlyModels[0]?.id ?? null)
		},
		[],
	)

	useEffect(() => {
		load().catch((e: unknown) => setLastError(e instanceof Error ? e.message : String(e)))
	}, [load, setLastError])

	const selected = models?.find((m) => m.id === selectedId)
	const instance = instances.find((i) => i.id === selectedId)
	const draftKey = `${selectedId}`
	const stored = selected?.docs[KIND] ?? ""
	const content = drafts[draftKey] ?? stored
	const dirty = selected !== undefined && content !== stored
	const spec = parseLlmDoc(content)
	const settings = Object.entries(spec.settings).filter(([, v]) => v !== undefined)

	/** Gruppiert nach Rechner — dort liegen die Modelle physisch. */
	const groups = useMemo(() => {
		const q = query.trim().toLowerCase()
		const hit = (m: ModelOwner) =>
			q.length === 0 ||
			m.name.toLowerCase().includes(q) ||
			(m.detail ?? "").toLowerCase().includes(q) ||
			(m.docs[KIND] ?? "").toLowerCase().includes(q)
		const byProvider = new Map<string, ModelOwner[]>()
		for (const m of models?.filter(hit) ?? []) {
			const key = m.providerLabel ?? "Ohne Rechner"
			byProvider.set(key, [...(byProvider.get(key) ?? []), m])
		}
		return [...byProvider.entries()]
	}, [models, query])

	const setContent = (value: string) => setDrafts((prev) => ({ ...prev, [draftKey]: value }))

	const reset = () =>
		setDrafts((prev) => {
			const next = { ...prev }
			delete next[draftKey]
			return next
		})

	const save = async () => {
		if (!selected) {
			return
		}
		setBusy(true)
		try {
			await api.put(`${selected.basePath}/docs/${KIND}`, { content })
			setModels(
				(prev) =>
					prev?.map((m) => (m.id === selected.id ? { ...m, docs: { ...m.docs, [KIND]: content } } : m)) ??
					prev,
			)
			reset()
			setSavedAt(new Date().toLocaleTimeString("de-DE"))
			// Fähigkeiten, Kontext und Voreinstellungen wirken sofort im Routing.
			await load()
			void useStore.getState().refreshProviders()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	/** Datenblatt neu aus dem Modell-Katalog erzeugen — verwirft eigene Notizen. */
	const regenerate = () => {
		if (!instance) {
			return
		}
		setContent(renderLlmDoc(instance, new Date().toISOString()))
	}

	return (
		<div className="models-view">
			<div className="page-head">
				<div>
					<h1>LLM-Modelle</h1>
					<p className="page-sub">
						Ein Datenblatt je Modell: Fähigkeiten, Kontext, Werkzeuge, Stärken und Schwächen. DiriZ rechnet es
						in die Orchestrierung ein — hier entscheidet sich, wofür ein Modell gerufen wird.
					</p>
				</div>
				<div className="page-actions">
					<span className="badge subtle">{models?.length ?? 0} Modelle</span>
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
							placeholder="Modell oder Datenblatt suchen …"
							aria-label="Modelle durchsuchen"
						/>
					</div>

					{models === null ? (
						<div style={{ padding: "var(--sp-3)" }}>
							<div className="skeleton" />
							<div className="skeleton" style={{ width: "70%" }} />
						</div>
					) : groups.length === 0 ? (
						<p className="faint" style={{ padding: "var(--sp-4)" }}>
							Nichts gefunden.
						</p>
					) : (
						groups.map(([provider, items]) => (
							<div key={provider}>
								<div className="docs-group" title="Rechner, auf dem diese Modelle liegen">
									{provider}
									<span className="faint"> · {items.length}</span>
								</div>
								{items.map((m) => (
									<button
										key={m.id}
										type="button"
										className={`docs-item ${selectedId === m.id ? "active" : ""} ${m.enabled ? "" : "off"}`}
										onClick={() => setSelectedId(m.id)}
									>
										<IconLayers size={15} />
										<span className="docs-item-text">
											<span className="docs-item-name">{m.name}</span>
											<span className="docs-item-meta">
												{m.detail}
												{(() => {
													const tps = instances.find((i) => i.id === m.id)?.tokensPerSecond
													return tps !== undefined ? ` · ${Math.round(tps)} Token/s` : ""
												})()}
											</span>
										</span>
									</button>
								))}
							</div>
						))
					)}
				</aside>

				{/* ------------------------------- Datenblatt -------------------------------- */}
				<section className="card flush docs-editor">
					{!selected ? (
						<div className="empty">
							<span className="icon-chip lg">
								<IconLayers size={20} />
							</span>
							<div className="empty-title">Kein Modell gewählt</div>
							<p>Wähle links ein Modell, um sein Datenblatt zu sehen.</p>
						</div>
					) : (
						<>
							<div className="docs-editor-head">
								<div>
									<div className="card-title">
										<IconLayers size={16} />
										{selected.name}
									</div>
									<p className="card-sub">
										{selected.providerLabel} · {selected.detail}
										{selected.enabled ? "" : " · im Routing deaktiviert"}
									</p>
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
										title="Bearbeiten und Vorschau"
									>
										<IconDoc size={14} />
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

							{/* Die harten Fakten, wie das Routing sie sieht. */}
							{instance && (
								<div className="model-facts">
									<span className="badge">Kontext: {instance.contextWindow.toLocaleString("de-CH")}</span>
									<span className={`badge ${instance.capabilities.length > 0 ? "accent" : "warn"}`}>
										Fähigkeiten:{" "}
										{instance.capabilities.length > 0 ? instance.capabilities.join(", ") : "keine"}
									</span>
									{/* Gemessen, nicht geschätzt: die ehrlichste Zahl über ein Modell. */}
									{instance.tokensPerSecond !== undefined && (
										<span
											className="badge accent"
											title="Durchschnitt der letzten erfolgreichen Läufe — zählt im Routing als Tempo-Achse"
										>
											{Math.round(instance.tokensPerSecond)} Token/s gemessen
										</span>
									)}
									{instance.quantization && <span className="badge">{instance.quantization}</span>}
									<span className="badge">
										{instance.pricePerMTok
											? `${instance.pricePerMTok.in}/${instance.pricePerMTok.out} $ je Mio.`
											: "lokal"}
									</span>
								</div>
							)}

							<div className="model-doc-title">
								<IconDoc size={15} />
								<strong>{AGENT_DOC_FILES[KIND]}</strong>
								<span className="faint">— das einzige Dokument dieses Modells</span>
								{dirty && <span className="dirty" title="ungespeicherte Änderungen" />}
							</div>

							<p className="hint" style={{ margin: "var(--sp-3) 0 0" }}>
								<IconInfo size={14} />
								<span>{HINT}</span>
							</p>

							<div className={`docs-panes ${mode}`}>
								{mode !== "preview" && (
									<textarea
										className="mono docs-textarea"
										value={content}
										onChange={(e) => setContent(e.target.value)}
										placeholder={`# ${AGENT_DOC_FILES[KIND]}`}
										aria-label={`${AGENT_DOC_FILES[KIND]} von ${selected.name}`}
										spellCheck={false}
									/>
								)}
								{mode !== "edit" && (
									<div className="docs-preview">
										<Markdown source={content} />
									</div>
								)}
							</div>

							<div className="model-readout">
								<span className="field-hint">Das Routing liest daraus:</span>
								<span className={`badge ${spec.capabilities.length > 0 ? "accent" : "warn"}`}>
									Fähigkeiten: {spec.capabilities.length > 0 ? spec.capabilities.join(", ") : "keine"}
								</span>
								<span className="badge">Kontext: {spec.contextWindow ?? "—"}</span>
								<span className="badge">Qualität: {spec.quality ?? "mittel"}</span>
								<span className="badge">Tempo: {spec.speed ?? "mittel"}</span>
								<span className="badge">
									Werkzeuge: {spec.tools.length > 0 ? spec.tools.join(", ") : "keine"}
								</span>
								<span className="badge">
									Eignung: {spec.goodFor.length} Stärken / {spec.notFor.length} Schwächen
								</span>
							</div>

							<div className="model-readout">
								<span className="field-hint">Voreinstellungen:</span>
								{settings.length === 0 ? (
									<span className="faint text-sm">keine — es gelten die Werte des Rechners</span>
								) : (
									settings.map(([k, v]) => (
										<span key={k} className="badge accent">
											{k}: {Array.isArray(v) ? v.join(" | ") : String(v).slice(0, 40)}
										</span>
									))
								)}
							</div>

							<div className="row model-actions">
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
								{instance && (
									<button
										type="button"
										className="btn"
										onClick={regenerate}
										title="Datenblatt aus dem Modell-Katalog neu erzeugen (überschreibt den Text)"
									>
										<IconSparkles size={15} />
										Aus Katalog erzeugen
									</button>
								)}
								<span style={{ marginLeft: "auto" }} className="faint text-sm">
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
