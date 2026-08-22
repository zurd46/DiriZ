/**
 * Agenten-Ansicht (M1/M9): Spezialisten anlegen **und bearbeiten** (Rolle,
 * Fähigkeiten, Privacy, Rechner-/Modell-Pin, Model-Voreinstellungen) sowie
 * ihre Dokumente pflegen — `plan.md`, `changelog.md` und `init.md`.
 *
 * Beide Dokumente wirken: aus `init.md` liest der Core die Model-Voreinstellungen
 * (Provider ← Modell ← **Agent** ← Task), `plan.md` wird zur verbindlichen
 * Arbeitsanweisung im System-Prompt. Die Zuordnung pro Prompt übernimmt die
 * Engine — hier wird nur verwaltet.
 */

import type { Agent, AgentPrivacy, Capability, InstanceModel, ModelSettings, Swarm } from "@diriz/shared"
import { type CSSProperties, useEffect, useState } from "react"
import DocsEditor from "../components/DocsEditor.js"
import {
	IconAgents,
	IconClose,
	IconDoc,
	IconEdit,
	IconPin,
	IconPlus,
	IconPower,
	IconSettings,
	IconSwarm,
	IconTrash,
} from "../components/icons.js"
import SettingsEditor from "../components/SettingsEditor.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

const CAPABILITIES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]
const PRIVACIES: { id: AgentPrivacy; label: string }[] = [
	{ id: "any", label: "beliebig" },
	{ id: "local-only", label: "local-only" },
	{ id: "allow-cloud", label: "allow-cloud" },
]

function toggleCap(list: Capability[], cap: Capability): Capability[] {
	return list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]
}

/** Leerer Entwurf — Basis für „anlegen“ und für „Abbrechen“. */
interface AgentDraft {
	name: string
	description: string
	systemPrompt: string
	required: Capability[]
	preferred: Capability[]
	privacy: AgentPrivacy
	pinnedProvider: string
	pinnedInstance: string
	modelSettings: ModelSettings
}

const EMPTY_DRAFT: AgentDraft = {
	name: "",
	description: "",
	systemPrompt: "",
	required: [],
	preferred: [],
	privacy: "any",
	pinnedProvider: "",
	pinnedInstance: "",
	modelSettings: {},
}

function draftFrom(agent: Agent): AgentDraft {
	return {
		name: agent.name,
		description: agent.description,
		systemPrompt: agent.systemPrompt,
		required: [...agent.requiredCapabilities],
		preferred: [...agent.preferredCapabilities],
		privacy: agent.privacy,
		pinnedProvider: agent.pinnedProviderId ?? "",
		pinnedInstance: agent.pinnedInstanceId ?? "",
		modelSettings: { ...agent.modelSettings },
	}
}

export default function Agents() {
	const agents = useStore((s) => s.agents)
	const swarms = useStore((s) => s.swarms)
	const providers = useStore((s) => s.providers)
	const refreshAgents = useStore((s) => s.refreshAgents)
	const refreshSwarms = useStore((s) => s.refreshSwarms)
	const setLastError = useStore((s) => s.setLastError)

	const [instances, setInstances] = useState<InstanceModel[]>([])
	useEffect(() => {
		api
			.get<InstanceModel[]>("/api/instances")
			.then(setInstances)
			.catch(() => {
				/* Provider-Liste reicht für Pins */
			})
	}, [])

	/** `null` = Formular zu, `""` = neu anlegen, sonst die bearbeitete Agent-ID. */
	const [editing, setEditing] = useState<string | null>(null)
	const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT)
	const [busy, setBusy] = useState(false)

	const providerLabel = (id?: string | null) => providers.find((p) => p.id === id)?.label ?? id ?? ""
	const instanceLabel = (id?: string | null) => instances.find((i) => i.id === id)?.displayName ?? id ?? ""

	const startCreate = () => {
		setEditing(editing === "" ? null : "")
		setDraft(EMPTY_DRAFT)
	}

	const startEdit = (agent: Agent) => {
		if (editing === agent.id) {
			setEditing(null)
			return
		}
		setEditing(agent.id)
		setDraft(draftFrom(agent))
	}

	const saveAgent = async () => {
		setBusy(true)
		try {
			const body = {
				name: draft.name,
				description: draft.description,
				systemPrompt: draft.systemPrompt,
				requiredCapabilities: draft.required,
				preferredCapabilities: draft.preferred,
				privacy: draft.privacy,
				pinnedProviderId: draft.pinnedProvider || null,
				pinnedInstanceId: draft.pinnedInstance || null,
				modelSettings: Object.keys(draft.modelSettings).length > 0 ? draft.modelSettings : null,
			}
			if (editing) {
				await api.patch(`/api/agents/${editing}`, body)
			} else {
				await api.post("/api/agents", body)
			}
			setEditing(null)
			setDraft(EMPTY_DRAFT)
			await refreshAgents()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const actAgent = async (id: string, body: Record<string, unknown>) => {
		try {
			await api.patch(`/api/agents/${id}`, body)
			await refreshAgents()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const delAgent = async (id: string) => {
		try {
			await api.del(`/api/agents/${id}`)
			if (editing === id) setEditing(null)
			await refreshAgents()
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	/* ---------------------------------- Swarms --------------------------------- */

	const [swarmEditing, setSwarmEditing] = useState<string | null>(null)
	const [swarmName, setSwarmName] = useState("")
	const [swarmDesc, setSwarmDesc] = useState("")
	const [swarmMembers, setSwarmMembers] = useState<string[]>([])
	const [swarmBusy, setSwarmBusy] = useState(false)

	const startCreateSwarm = () => {
		setSwarmEditing(swarmEditing === "" ? null : "")
		setSwarmName("")
		setSwarmDesc("")
		setSwarmMembers([])
	}

	const startEditSwarm = (sw: Swarm) => {
		if (swarmEditing === sw.id) {
			setSwarmEditing(null)
			return
		}
		setSwarmEditing(sw.id)
		setSwarmName(sw.name)
		setSwarmDesc(sw.description)
		setSwarmMembers([...sw.agentIds])
	}

	const saveSwarm = async () => {
		setSwarmBusy(true)
		try {
			const body = { name: swarmName, description: swarmDesc, agentIds: swarmMembers }
			if (swarmEditing) {
				await api.patch(`/api/swarms/${swarmEditing}`, body)
			} else {
				await api.post("/api/swarms", body)
			}
			setSwarmEditing(null)
			setSwarmName("")
			setSwarmDesc("")
			setSwarmMembers([])
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setSwarmBusy(false)
		}
	}

	const actSwarm = async (id: string, body: Record<string, unknown>) => {
		try {
			await api.patch(`/api/swarms/${id}`, body)
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const delSwarm = async (id: string) => {
		try {
			await api.del(`/api/swarms/${id}`)
			if (swarmEditing === id) setSwarmEditing(null)
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id

	const form = (
		<AgentForm
			mode={editing ? "edit" : "create"}
			draft={draft}
			setDraft={setDraft}
			onSave={saveAgent}
			onCancel={() => setEditing(null)}
			providers={providers}
			instances={instances.filter((i) => i.providerId === draft.pinnedProvider && i.enabled !== false)}
			busy={busy}
		/>
	)

	const activeAgents = agents.filter((a) => a.enabled).length

	return (
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Spezialisten</h1>
					<p className="page-sub">
						Jeder Spezialist hat eine Rolle (System-Prompt), Fähigkeiten, Routing-Vorgaben und drei Dokumente:{" "}
						<code>plan.md</code>, <code>changelog.md</code> und <code>init.md</code>. Alles ist jederzeit
						bearbeitbar.
					</p>
				</div>
				<div className="page-actions">
					{agents.length > 0 && (
						<span className="pill ok no-dot">
							{activeAgents}/{agents.length} aktiv
						</span>
					)}
					<button type="button" className="btn primary" onClick={startCreate} aria-expanded={editing === ""}>
						{editing === "" ? <IconClose size={15} /> : <IconPlus size={15} />}
						{editing === "" ? "Abbrechen" : "Spezialist anlegen"}
					</button>
				</div>
			</div>

			{editing === "" && form}

			<AgentList
				agents={agents}
				swarms={swarms}
				editing={editing}
				editForm={form}
				onEdit={startEdit}
				onAct={actAgent}
				onDel={delAgent}
				providerLabel={providerLabel}
				instanceLabel={instanceLabel}
				onSettingsChanged={refreshAgents}
				onCreate={startCreate}
			/>

			<div className="section-head">
				<div>
					<h2>Swarms</h2>
					<p className="page-sub">
						Ein Swarm bündelt Spezialisten — pro Prompt wird das beste Mitglied automatisch gewählt.
					</p>
				</div>
				<button
					type="button"
					className="btn primary"
					onClick={startCreateSwarm}
					aria-expanded={swarmEditing === ""}
				>
					{swarmEditing === "" ? <IconClose size={15} /> : <IconPlus size={15} />}
					{swarmEditing === "" ? "Abbrechen" : "Swarm anlegen"}
				</button>
			</div>

			{swarmEditing === "" && (
				<SwarmForm
					mode="create"
					agents={agents}
					swarmName={swarmName}
					setSwarmName={setSwarmName}
					swarmDesc={swarmDesc}
					setSwarmDesc={setSwarmDesc}
					swarmMembers={swarmMembers}
					setSwarmMembers={setSwarmMembers}
					onSave={saveSwarm}
					onCancel={() => setSwarmEditing(null)}
					busy={swarmBusy}
				/>
			)}

			<SwarmList
				swarms={swarms}
				agentName={agentName}
				editing={swarmEditing}
				onEdit={startEditSwarm}
				onAct={actSwarm}
				onDel={delSwarm}
				editForm={
					<SwarmForm
						mode="edit"
						agents={agents}
						swarmName={swarmName}
						setSwarmName={setSwarmName}
						swarmDesc={swarmDesc}
						setSwarmDesc={setSwarmDesc}
						swarmMembers={swarmMembers}
						setSwarmMembers={setSwarmMembers}
						onSave={saveSwarm}
						onCancel={() => setSwarmEditing(null)}
						busy={swarmBusy}
					/>
				}
			/>
		</div>
	)
}

/* ---------------------------------- Sub-Views --------------------------------- */

function AgentForm(props: {
	mode: "create" | "edit"
	draft: AgentDraft
	setDraft: (next: AgentDraft) => void
	onSave: () => Promise<void>
	onCancel: () => void
	providers: { id: string; label: string }[]
	instances: { id: string; displayName: string }[]
	busy: boolean
}) {
	const { draft, setDraft } = props
	const patch = (next: Partial<AgentDraft>) => setDraft({ ...draft, ...next })

	return (
		<div className="card">
			<div className="card-head">
				<div className="card-title">
					{props.mode === "edit" ? <IconEdit size={16} /> : <IconPlus size={16} />}
					{props.mode === "edit" ? "Spezialist bearbeiten" : "Neuer Spezialist"}
				</div>
				<button type="button" className="icon-btn" aria-label="Formular schließen" onClick={props.onCancel}>
					<IconClose size={16} />
				</button>
			</div>

			<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
				<label className="field" style={{ minWidth: 180 }}>
					Name *
					<input
						value={draft.name}
						onChange={(e) => patch({ name: e.target.value })}
						placeholder="z. B. Code-Dev"
					/>
				</label>
				<label className="field grow">
					Beschreibung
					<input
						value={draft.description}
						onChange={(e) => patch({ description: e.target.value })}
						placeholder="z. B. React TypeScript Bug Refactoring"
					/>
					<span className="field-hint">Keywords für die automatische Zuordnung</span>
				</label>
				<label className="field">
					Privacy
					<select value={draft.privacy} onChange={(e) => patch({ privacy: e.target.value as AgentPrivacy })}>
						{PRIVACIES.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					Pin: Rechner
					<select
						value={draft.pinnedProvider}
						onChange={(e) => patch({ pinnedProvider: e.target.value, pinnedInstance: "" })}
					>
						<option value="">— automatisch —</option>
						{props.providers.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					Pin: Modell
					<select
						value={draft.pinnedInstance}
						onChange={(e) => patch({ pinnedInstance: e.target.value })}
						disabled={!draft.pinnedProvider}
					>
						<option value="">— automatisch —</option>
						{props.instances.map((i) => (
							<option key={i.id} value={i.id}>
								{i.displayName}
							</option>
						))}
					</select>
				</label>
			</div>

			<label className="field" style={{ marginTop: 14 }}>
				System-Prompt (Rolle des Spezialisten)
				<textarea
					value={draft.systemPrompt}
					onChange={(e) => patch({ systemPrompt: e.target.value })}
					placeholder={"Du bist ein …"}
				/>
			</label>

			<div className="row top" style={{ marginTop: 14, gap: 28 }}>
				<div>
					<div className="field-hint" style={{ marginBottom: 6 }}>
						Pflicht-Fähigkeiten (hartes Gate)
					</div>
					<div className="chip-group">
						{CAPABILITIES.map((c) => (
							<label key={c} className="check-chip">
								<input
									type="checkbox"
									checked={draft.required.includes(c)}
									onChange={() => patch({ required: toggleCap(draft.required, c) })}
								/>
								{c}
							</label>
						))}
					</div>
				</div>
				<div>
					<div className="field-hint" style={{ marginBottom: 6 }}>
						Wunsch-Fähigkeiten (Bonus)
					</div>
					<div className="chip-group">
						{CAPABILITIES.map((c) => (
							<label key={c} className="check-chip">
								<input
									type="checkbox"
									checked={draft.preferred.includes(c)}
									onChange={() => patch({ preferred: toggleCap(draft.preferred, c) })}
								/>
								{c}
							</label>
						))}
					</div>
				</div>
			</div>

			<div className="divider" />

			<div className="card-title">
				<IconSettings size={16} />
				Model-Voreinstellungen
			</div>
			<div className="card-sub">
				Gilt für jede Ausführung dieses Spezialisten. Reihenfolge: Provider → Modell → <strong>Agent</strong>{" "}
				→ Task. Beim Speichern wird daraus sein <code>init.md</code> geschrieben.
			</div>
			<div style={{ marginTop: 12 }}>
				<SettingsEditor value={draft.modelSettings} onChange={(modelSettings) => patch({ modelSettings })} />
			</div>

			<div className="row" style={{ marginTop: 16 }}>
				<button
					type="button"
					className="btn primary"
					onClick={() => void props.onSave()}
					disabled={props.busy || draft.name.trim().length === 0}
				>
					{props.busy ? "Speichere …" : "Speichern"}
				</button>
				<button type="button" className="btn ghost" onClick={props.onCancel}>
					Abbrechen
				</button>
			</div>
		</div>
	)
}

function AgentList(props: {
	agents: Agent[]
	swarms: Swarm[]
	editing: string | null
	editForm: React.ReactNode
	onEdit: (agent: Agent) => void
	onAct: (id: string, body: Record<string, unknown>) => Promise<void>
	onDel: (id: string) => Promise<void>
	providerLabel: (id?: string | null) => string
	instanceLabel: (id?: string | null) => string
	onSettingsChanged: () => Promise<void>
	onCreate: () => void
}) {
	const [docsFor, setDocsFor] = useState<string | null>(null)

	if (props.agents.length === 0) {
		return (
			<div className="card">
				<div className="empty">
					<span className="icon-chip lg" style={{ "--mc": "var(--accent)" } as CSSProperties}>
						<IconAgents size={20} />
					</span>
					<span className="empty-title">Noch keine Spezialisten</span>
					<p>
						Lege einen an — z. B. „Code-Dev“ mit den Keywords deines Fachgebiets. DiriZ ordnet Tasks dann
						automatisch dem passenden Spezialisten zu.
					</p>
					<button type="button" className="btn primary" onClick={props.onCreate}>
						<IconPlus size={15} />
						Spezialist anlegen
					</button>
				</div>
			</div>
		)
	}

	return (
		<div>
			{props.agents.map((a) => {
				const memberSwarms = props.swarms.filter((sw) => sw.enabled && sw.agentIds.includes(a.id))
				const settingsCount = Object.keys(a.modelSettings ?? {}).length
				return (
					<div key={a.id} className="card" style={{ opacity: a.enabled ? 1 : 0.62 }}>
						<div className="row between top">
							<div className="grow">
								<div className="row tight">
									<strong style={{ fontSize: 15 }}>{a.name}</strong>
									{!a.enabled && <span className="badge subtle">inaktiv</span>}
									{a.privacy !== "any" && <span className="badge">{a.privacy}</span>}
									{a.pinnedProviderId && (
										<span className="badge accent" title="Fest an Rechner/Modell gebunden">
											<IconPin size={11} />
											{props.providerLabel(a.pinnedProviderId)}
											{a.pinnedInstanceId ? ` / ${props.instanceLabel(a.pinnedInstanceId)}` : ""}
										</span>
									)}
									{settingsCount > 0 && (
										<span className="badge" title="Voreinstellungen aus init.md">
											<IconSettings size={11} />
											init.md · {settingsCount}
										</span>
									)}
								</div>

								{a.description && (
									<div className="muted text-sm" style={{ marginTop: 4 }}>
										{a.description}
									</div>
								)}

								{(a.requiredCapabilities.length > 0 || a.preferredCapabilities.length > 0) && (
									<div className="chip-group" style={{ marginTop: 8 }}>
										{a.requiredCapabilities.map((c) => (
											<span key={c} className="badge accent" title="Pflicht-Fähigkeit">
												{c}
											</span>
										))}
										{a.preferredCapabilities.map((c) => (
											<span key={c} className="badge" title="Wunsch-Fähigkeit">
												{c} +
											</span>
										))}
									</div>
								)}

								{a.systemPrompt && (
									<div className="faint mono text-xs" style={{ marginTop: 8 }}>
										„{a.systemPrompt.length > 120 ? `${a.systemPrompt.slice(0, 120)}…` : a.systemPrompt}“
									</div>
								)}

								{memberSwarms.length > 0 && (
									<div className="faint text-sm row tight" style={{ marginTop: 6 }}>
										<IconSwarm size={13} />
										In Swarms: {memberSwarms.map((sw) => sw.name).join(", ")}
									</div>
								)}
							</div>

							<div className="actions">
								<button
									type="button"
									className={`icon-btn ${props.editing === a.id ? "active" : ""}`}
									aria-label={`${a.name} bearbeiten`}
									title="Bearbeiten"
									onClick={() => props.onEdit(a)}
								>
									<IconEdit size={16} />
								</button>
								<button
									type="button"
									className={`icon-btn ${docsFor === a.id ? "active" : ""}`}
									aria-label={`Dokumente von ${a.name}`}
									title="plan.md, changelog.md und init.md"
									onClick={() => setDocsFor(docsFor === a.id ? null : a.id)}
								>
									<IconDoc size={16} />
								</button>
								<button
									type="button"
									className="icon-btn"
									aria-label={a.enabled ? `${a.name} deaktivieren` : `${a.name} aktivieren`}
									title={a.enabled ? "Deaktivieren" : "Aktivieren"}
									onClick={() => void props.onAct(a.id, { enabled: !a.enabled })}
								>
									<IconPower size={16} />
								</button>
								<button
									type="button"
									className="icon-btn danger"
									aria-label={`${a.name} löschen`}
									title="Löschen"
									onClick={() => void props.onDel(a.id)}
								>
									<IconTrash size={16} />
								</button>
							</div>
						</div>

						{props.editing === a.id && <div style={{ marginTop: 12 }}>{props.editForm}</div>}

						{docsFor === a.id && (
							<DocsEditor
								basePath={`/api/agents/${a.id}`}
								ownerName={a.name}
								onInitSaved={props.onSettingsChanged}
								onClose={() => setDocsFor(null)}
							/>
						)}
					</div>
				)
			})}
		</div>
	)
}

function SwarmForm(props: {
	mode: "create" | "edit"
	agents: Agent[]
	swarmName: string
	setSwarmName: (v: string) => void
	swarmDesc: string
	setSwarmDesc: (v: string) => void
	swarmMembers: string[]
	setSwarmMembers: (v: string[]) => void
	onSave: () => Promise<void>
	onCancel: () => void
	busy: boolean
}) {
	return (
		<div className="card">
			<div className="card-head">
				<div className="card-title">
					{props.mode === "edit" ? <IconEdit size={16} /> : <IconPlus size={16} />}
					{props.mode === "edit" ? "Swarm bearbeiten" : "Neuer Swarm"}
				</div>
				<button type="button" className="icon-btn" aria-label="Formular schließen" onClick={props.onCancel}>
					<IconClose size={16} />
				</button>
			</div>
			<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
				<label className="field" style={{ minWidth: 180 }}>
					Name *
					<input
						value={props.swarmName}
						onChange={(e) => props.setSwarmName(e.target.value)}
						placeholder="z. B. Frontend"
					/>
				</label>
				<label className="field grow">
					Beschreibung
					<input
						value={props.swarmDesc}
						onChange={(e) => props.setSwarmDesc(e.target.value)}
						placeholder="optional"
					/>
				</label>
			</div>
			<div style={{ marginTop: 14 }}>
				<div className="field-hint" style={{ marginBottom: 6 }}>
					Mitglieder
				</div>
				{props.agents.length === 0 ? (
					<span className="muted text-sm">Zuerst mindestens einen Spezialisten anlegen.</span>
				) : (
					<div className="chip-group">
						{props.agents.map((a) => (
							<label key={a.id} className="check-chip">
								<input
									type="checkbox"
									checked={props.swarmMembers.includes(a.id)}
									onChange={() =>
										props.setSwarmMembers(
											props.swarmMembers.includes(a.id)
												? props.swarmMembers.filter((x) => x !== a.id)
												: [...props.swarmMembers, a.id],
										)
									}
								/>
								{a.name}
							</label>
						))}
					</div>
				)}
			</div>
			<div className="row" style={{ marginTop: 16 }}>
				<button
					type="button"
					className="btn primary"
					onClick={() => void props.onSave()}
					disabled={props.busy || props.swarmName.trim().length === 0}
				>
					{props.busy ? "Speichere …" : "Speichern"}
				</button>
				<button type="button" className="btn ghost" onClick={props.onCancel}>
					Abbrechen
				</button>
			</div>
		</div>
	)
}

function SwarmList(props: {
	swarms: Swarm[]
	agentName: (id: string) => string
	editing: string | null
	editForm: React.ReactNode
	onEdit: (swarm: Swarm) => void
	onAct: (id: string, body: Record<string, unknown>) => Promise<void>
	onDel: (id: string) => Promise<void>
}) {
	if (props.swarms.length === 0) {
		return (
			<div className="card">
				<div className="empty">
					<span className="icon-chip lg" style={{ "--mc": "var(--accent-2)" } as CSSProperties}>
						<IconSwarm size={20} />
					</span>
					<span className="empty-title">Noch keine Swarms</span>
					<p>Bündle mehrere Spezialisten zu einem Team — DiriZ wählt pro Prompt das beste Mitglied.</p>
				</div>
			</div>
		)
	}

	return (
		<div>
			{props.swarms.map((sw) => (
				<div key={sw.id} className="card" style={{ opacity: sw.enabled ? 1 : 0.62 }}>
					<div className="row between top">
						<div className="grow">
							<div className="row tight">
								<span className="icon-chip" style={{ "--mc": "var(--accent-2)" } as CSSProperties}>
									<IconSwarm size={16} />
								</span>
								<strong style={{ fontSize: 15 }}>{sw.name}</strong>
								{!sw.enabled && <span className="badge subtle">inaktiv</span>}
								<span className="badge">
									{sw.agentIds.length} {sw.agentIds.length === 1 ? "Mitglied" : "Mitglieder"}
								</span>
							</div>
							{sw.description && (
								<div className="muted text-sm" style={{ marginTop: 4 }}>
									{sw.description}
								</div>
							)}
							<div className="chip-group" style={{ marginTop: 8 }}>
								{sw.agentIds.length > 0 ? (
									sw.agentIds.map((id) => (
										<span key={id} className="badge">
											{props.agentName(id)}
										</span>
									))
								) : (
									<span className="faint text-sm">keine Mitglieder</span>
								)}
							</div>
						</div>
						<div className="actions">
							<button
								type="button"
								className={`icon-btn ${props.editing === sw.id ? "active" : ""}`}
								aria-label={`${sw.name} bearbeiten`}
								title="Bearbeiten"
								onClick={() => props.onEdit(sw)}
							>
								<IconEdit size={16} />
							</button>
							<button
								type="button"
								className="icon-btn"
								aria-label={sw.enabled ? `${sw.name} deaktivieren` : `${sw.name} aktivieren`}
								title={sw.enabled ? "Deaktivieren" : "Aktivieren"}
								onClick={() => void props.onAct(sw.id, { enabled: !sw.enabled })}
							>
								<IconPower size={16} />
							</button>
							<button
								type="button"
								className="icon-btn danger"
								aria-label={`${sw.name} löschen`}
								title="Löschen"
								onClick={() => void props.onDel(sw.id)}
							>
								<IconTrash size={16} />
							</button>
						</div>
					</div>
					{props.editing === sw.id && <div style={{ marginTop: 12 }}>{props.editForm}</div>}
				</div>
			))}
		</div>
	)
}
