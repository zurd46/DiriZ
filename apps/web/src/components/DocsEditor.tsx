/**
 * Editor für die Deklarations-Dokumente — identisch für Spezialisten
 * (`/api/agents/:id`) und Modelle (`/api/instances/:id`). Welche Dokumente eine
 * Ebene führt, sagt `docKindsFor`: Ein Spezialist hat einen Auftrag
 * (`plan.md`), ein Modell ein Datenblatt (`llm.md`).
 *
 * Jedes wirksame Dokument zeigt live, was der Core daraus liest — dieselben
 * Funktionen wie im Backend, keine Drift:
 * - `plan.md` → die verbindliche Arbeitsanweisung im System-Prompt
 *   (`extractDirective`).
 * - `llm.md`  → Fähigkeiten, Kontext-Fenster und Qualitätsklasse für das
 *   Routing (`parseLlmDoc`).
 * - `init.md` → die Model-Voreinstellungen (`parseInitDoc`).
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	type DocOwnerKind,
	docKindsFor,
	extractDirective,
	parseInitDoc,
	parseLlmDoc,
	renderInitDoc,
} from "@diriz/shared"
import { useEffect, useState } from "react"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"
import { IconCheckCircle, IconClose, IconDoc, IconInfo, IconRefresh, IconSparkles } from "./icons.js"

interface DocResponse {
	docs: { kind: AgentDocKind; content: string }[]
}

const HINTS: Record<AgentDocKind, string> = {
	plan: "Wirksam: Auftrag, Vorgehen und Leitplanken werden als verbindliche Arbeitsanweisung in den System-Prompt übernommen. Unausgefüllte Vorlagen-Zeilen ignoriert DiriZ.",
	llm: "Wirksam: Datenblatt des Modells. Fähigkeiten und Kontext-Fenster sind harte Routing-Gates, die Qualitätsklasse ist der Startwert der Qualitäts-Achse, „Gut für“/„Nicht geeignet für“ bewegen die Eignungs-Achse.",
	changelog: "Änderungsprotokoll — DiriZ hängt bei jeder Bearbeitung automatisch einen Eintrag an.",
	init: "Wirksam: Zeilen der Form „Temperature: 0.3“ setzen die Voreinstellungen des LLM-Modells.",
}

export default function DocsEditor(props: {
	/** Basis-Pfad ohne `/docs`, z. B. `/api/agents/<id>`. */
	basePath: string
	/** Welche Ebene — entscheidet, welche Dokumente es hier gibt. */
	ownerKind: DocOwnerKind
	/** Name für Überschriften und `init.md`-Aufräumen. */
	ownerName: string
	/** Wird nach dem Speichern von `init.md` gerufen (Settings neu laden). */
	onInitSaved?: () => Promise<void> | void
	onClose: () => void
}) {
	const onError = useStore((s) => s.setLastError)
	const kinds = docKindsFor(props.ownerKind)
	const [kind, setKind] = useState<AgentDocKind>(kinds[0] ?? "plan")
	const [docs, setDocs] = useState<Record<string, string> | null>(null)
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [savedAt, setSavedAt] = useState<string | undefined>()

	const { basePath } = props
	useEffect(() => {
		let cancelled = false
		api
			.get<DocResponse>(`${basePath}/docs`)
			.then((data) => {
				if (cancelled) return
				const map = Object.fromEntries(data.docs.map((d) => [d.kind, d.content]))
				setDocs(map)
				setDrafts(map)
			})
			.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
		return () => {
			cancelled = true
		}
	}, [basePath, onError])

	const content = drafts[kind] ?? ""
	const dirty = docs !== null && content !== (docs[kind] ?? "")

	const save = async () => {
		setBusy(true)
		try {
			await api.put(`${basePath}/docs/${kind}`, { content })
			setDocs((prev) => ({ ...(prev ?? {}), [kind]: content }))
			setSavedAt(new Date().toLocaleTimeString("de-DE"))
			if (kind === "init") {
				await props.onInitSaved?.()
			}
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	/** `init.md` aus den aktuell erkannten Werten neu formatieren. */
	const normalizeInit = () => {
		setDrafts((prev) => ({ ...prev, init: renderInitDoc(parseInitDoc(content), props.ownerName) }))
	}

	const parsed = kind === "init" ? parseInitDoc(content) : undefined
	const parsedEntries = parsed ? Object.entries(parsed).filter(([, v]) => v !== undefined) : []
	const directive = kind === "plan" ? extractDirective(content) : undefined
	const spec = kind === "llm" ? parseLlmDoc(content) : undefined

	return (
		<div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
			<div className="card-head">
				<div className="tabs" style={{ marginBottom: 0, border: "none" }}>
					{kinds.map((k) => (
						<button
							key={k}
							type="button"
							className={`tab ${kind === k ? "active" : ""}`}
							onClick={() => setKind(k)}
						>
							<IconDoc size={14} />
							{AGENT_DOC_FILES[k]}
							{docs && (drafts[k] ?? "") !== (docs[k] ?? "") ? (
								<span className="dirty" title="ungespeicherte Änderungen" />
							) : null}
						</button>
					))}
				</div>
				<button type="button" className="icon-btn" aria-label="Dokumente schließen" onClick={props.onClose}>
					<IconClose size={16} />
				</button>
			</div>

			<p className="hint" style={{ margin: "10px 0 0" }}>
				<IconInfo size={14} />
				<span>{HINTS[kind]}</span>
			</p>

			{docs === null ? (
				<div style={{ marginTop: 12 }}>
					<div className="skeleton" />
					<div className="skeleton" style={{ width: "80%" }} />
					<div className="skeleton" style={{ width: "55%" }} />
				</div>
			) : (
				<>
					<textarea
						className="mono"
						style={{ minHeight: 240, marginTop: 12 }}
						value={content}
						onChange={(e) => setDrafts((prev) => ({ ...prev, [kind]: e.target.value }))}
						placeholder={`# ${AGENT_DOC_FILES[kind]}`}
						aria-label={AGENT_DOC_FILES[kind]}
					/>

					{kind === "plan" && (
						<div style={{ marginTop: 10 }}>
							{directive ? (
								<>
									<div className="field-hint">Das Modell erhält daraus:</div>
									<pre className="output" style={{ maxHeight: 170 }}>
										{directive}
									</pre>
								</>
							) : (
								<p className="hint">
									<IconInfo size={14} />
									<span>
										Noch nichts deklariert — solange nur Vorlagen-Platzhalter dastehen, wird nichts an das
										Modell übergeben.
									</span>
								</p>
							)}
						</div>
					)}

					{spec && (
						<div className="row tight" style={{ marginTop: 10 }}>
							<span className="field-hint">Das Routing liest daraus:</span>
							<span className={`badge ${spec.capabilities.length > 0 ? "accent" : ""}`}>
								Fähigkeiten: {spec.capabilities.length > 0 ? spec.capabilities.join(", ") : "keine"}
							</span>
							<span className="badge">Kontext: {spec.contextWindow ?? "—"}</span>
							<span className="badge">Qualität: {spec.quality ?? "mittel"}</span>
							<span className="badge">
								Eignung: {spec.goodFor.length} gut / {spec.notFor.length} ungeeignet
							</span>
						</div>
					)}

					{kind === "init" && (
						<div className="row tight" style={{ marginTop: 10 }}>
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

					<div className="row" style={{ marginTop: 14 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void save()}
							disabled={busy || !dirty}
						>
							{busy ? "Speichere …" : "Speichern"}
						</button>
						<button
							type="button"
							className="btn ghost"
							onClick={() => setDrafts((prev) => ({ ...prev, [kind]: docs[kind] ?? "" }))}
							disabled={!dirty}
						>
							<IconRefresh size={15} />
							Zurücksetzen
						</button>
						{kind === "init" && (
							<button type="button" className="btn" onClick={normalizeInit} title="Format vereinheitlichen">
								<IconSparkles size={15} />
								Aufräumen
							</button>
						)}
						{savedAt && !dirty && (
							<span className="text-ok row tight text-sm">
								<IconCheckCircle size={15} />
								Gespeichert {savedAt}
							</span>
						)}
					</div>
				</>
			)}
		</div>
	)
}
