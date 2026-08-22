/**
 * Agenten-Ansicht (M1/M9): Spezialisten anlegen **und bearbeiten** (Rolle,
 * Fähigkeiten, Privacy, Rechner-/Modell-Pin, Model-Voreinstellungen) sowie
 * ihre Dokumente pflegen — `plan.md`, `changelog.md` und `init.md`.
 *
 * `init.md` ist dabei wirksam: Daraus liest der Core die Model-Voreinstellungen
 * (Provider ← Modell ← **Agent** ← Task). Die Zuordnung pro Prompt übernimmt
 * die Engine — hier wird nur verwaltet.
 */

import type {
	Agent,
	AgentPrivacy,
	Capability,
	InstanceModel,
	ModelSettings,
	Swarm,
} from "@diriz/shared"
import { useEffect, useState } from "react"
import DocsEditor from "../components/DocsEditor.js"
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

	return (
		<div>
			<div className="row between">
				<h1>Spezialisten</h1>
				<button type="button" className="btn primary" onClick={startCreate}>
					+ Spezialist anlegen
				</button>
			</div>
			<p className="muted" style={{ marginTop: -8 }}>
				Jeder Spezialist hat eine Rolle (System-Prompt), Fähigkeiten, Routing-Vorgaben und drei Dokumente:{" "}
				<code>plan.md</code>, <code>changelog.md</code> und <code>init.md</code> (setzt die Voreinstellungen
				des LLM-Modells). Alles ist jederzeit bearbeitbar.
			</p>

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
			/>

			<div className="row between" style={{ marginTop: 18 }}>
				<h1 style={{ margin: 0 }}>Swarms</h1>
				<button type="button" className="btn primary" onClick={startCreateSwarm}>
					+ Swarm anlegen
				</button>
			</div>
			<p className="muted" style={{ marginTop: -8 }}>
				Ein Swarm bündelt Spezialisten — pro Prompt wird das beste Mitglied automatisch gewählt.
			</p>

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
			<strong>{props.mode === "edit" ? "✏️ Spezialist bearbeiten" : "Neuer Spezialist"}</strong>
			<div className="row" style={{ marginTop: 8 }}>
				<label className="field" style={{ minWidth: 180 }}>
					Name *
					<input
						value={draft.name}
						onChange={(e) => patch({ name: e.target.value })}
						placeholder="z. B. Code-Dev"
					/>
				</label>
				<label className="field" style={{ flex: 1, minWidth: 220 }}>
					Beschreibung (Keywords für die Auto-Zuordnung)
					<input
						value={draft.description}
						onChange={(e) => patch({ description: e.target.value })}
						placeholder="z. B. React TypeScript Bug Refactoring"
					/>
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

			<label className="field" style={{ marginTop: 8 }}>
				System-Prompt (Rolle des Spezialisten)
				<textarea
					value={draft.systemPrompt}
					onChange={(e) => patch({ systemPrompt: e.target.value })}
					placeholder={"Du bist ein …"}
				/>
			</label>

			<div className="row" style={{ marginTop: 8, gap: 24 }}>
				<div>
					<div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
						Pflicht-Fähigkeiten (hartes Gate)
					</div>
					<div className="row">
						{CAPABILITIES.map((c) => (
							<label key={c} className="muted" style={{ fontSize: 13 }}>
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
					<div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
						Wunsch-Fähigkeiten (Bonus)
					</div>
					<div className="row">
						{CAPABILITIES.map((c) => (
							<label key={c} className="muted" style={{ fontSize: 13 }}>
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

			<div style={{ marginTop: 12 }}>
				<strong style={{ fontSize: 13 }}>Model-Voreinstellungen (→ init.md)</strong>
				<div className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
					Gilt für jede Ausführung dieses Spezialisten. Reihenfolge: Provider ← Modell ←{" "}
					<strong>Agent</strong> ← Task. Beim Speichern wird daraus sein <code>init.md</code> geschrieben.
				</div>
				<SettingsEditor value={draft.modelSettings} onChange={(modelSettings) => patch({ modelSettings })} />
			</div>

			<div className="row" style={{ marginTop: 10 }}>
				<button
					type="button"
					className="btn primary"
					onClick={() => void props.onSave()}
					disabled={props.busy || draft.name.trim().length === 0}
				>
					{props.busy ? "…" : "Speichern"}
				</button>
				<button type="button" className="btn" onClick={props.onCancel}>
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
}) {
	const [docsFor, setDocsFor] = useState<string | null>(null)

	return (
		<div>
			{props.agents.length === 0 && (
				<div className="card">
					<p className="muted" style={{ margin: 0 }}>
						Noch keine Spezialisten. Lege einen an — z. B. „Code-Dev“ mit den Keywords deines Fachgebiets.
					</p>
				</div>
			)}
			{props.agents.map((a) => {
				const memberSwarms = props.swarms.filter((sw) => sw.enabled && sw.agentIds.includes(a.id))
				const settingsCount = Object.keys(a.modelSettings ?? {}).length
				return (
					<div key={a.id} className="card">
						<div className="row between">
							<div>
								<div className="row" style={{ gap: 8 }}>
									<strong>{a.name}</strong>
									{!a.enabled && (
										<span className="badge" style={{ opacity: 0.7 }}>
											inaktiv
										</span>
									)}
									{a.privacy !== "any" && <span className="badge">{a.privacy}</span>}
									{a.pinnedProviderId && (
										<span className="badge">
											⚓ {props.providerLabel(a.pinnedProviderId)}
											{a.pinnedInstanceId ? ` / ${props.instanceLabel(a.pinnedInstanceId)}` : ""}
										</span>
									)}
									{settingsCount > 0 && (
										<span className="badge" title="Voreinstellungen aus init.md">
											init.md · {settingsCount}
										</span>
									)}
								</div>
								{a.description && (
									<div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
										{a.description}
									</div>
								)}
								<div className="row" style={{ marginTop: 6, gap: 4 }}>
									{a.requiredCapabilities.map((c) => (
										<span key={c} className="badge">
											{c}
										</span>
									))}
									{a.preferredCapabilities.map((c) => (
										<span key={c} className="badge" style={{ opacity: 0.65 }}>
											{c}+
										</span>
									))}
								</div>
								{a.systemPrompt && (
									<div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>
										„{a.systemPrompt.length > 100 ? `${a.systemPrompt.slice(0, 100)}…` : a.systemPrompt}"
									</div>
								)}
								{memberSwarms.length > 0 && (
									<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
										In Swarms: {memberSwarms.map((sw) => sw.name).join(", ")}
									</div>
								)}
							</div>
							<div className="row">
								<button
									type="button"
									className={`btn ${props.editing === a.id ? "primary" : ""}`}
									onClick={() => props.onEdit(a)}
								>
									✏️ Bearbeiten
								</button>
								<button
									type="button"
									className={`btn ${docsFor === a.id ? "primary" : ""}`}
									onClick={() => setDocsFor(docsFor === a.id ? null : a.id)}
								>
									📄 Dokumente
								</button>
								<button
									type="button"
									className="btn"
									onClick={() => void props.onAct(a.id, { enabled: !a.enabled })}
								>
									{a.enabled ? "Deaktivieren" : "Aktivieren"}
								</button>
								<button type="button" className="btn danger" onClick={() => void props.onDel(a.id)}>
									Löschen
								</button>
							</div>
						</div>

						{props.editing === a.id && <div style={{ marginTop: 10 }}>{props.editForm}</div>}

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
			<strong>{props.mode === "edit" ? "✏️ Swarm bearbeiten" : "Neuer Swarm"}</strong>
			<div className="row" style={{ marginTop: 8 }}>
				<label className="field" style={{ minWidth: 180 }}>
					Name *
					<input
						value={props.swarmName}
						onChange={(e) => props.setSwarmName(e.target.value)}
						placeholder="z. B. Frontend"
					/>
				</label>
				<label className="field" style={{ flex: 1, minWidth: 220 }}>
					Beschreibung
					<input
						value={props.swarmDesc}
						onChange={(e) => props.setSwarmDesc(e.target.value)}
						placeholder="optional"
					/>
				</label>
			</div>
			<div className="row" style={{ marginTop: 8 }}>
				{props.agents.length === 0 && (
					<span className="muted">Zuerst mindestens einen Spezialisten anlegen.</span>
				)}
				{props.agents.map((a) => (
					<label key={a.id} className="muted" style={{ fontSize: 13 }}>
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
			<div className="row" style={{ marginTop: 10 }}>
				<button
					type="button"
					className="btn primary"
					onClick={() => void props.onSave()}
					disabled={props.busy || props.swarmName.trim().length === 0}
				>
					{props.busy ? "…" : "Speichern"}
				</button>
				<button type="button" className="btn" onClick={props.onCancel}>
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
	return (
		<div>
			{props.swarms.length === 0 && (
				<div className="card">
					<p className="muted" style={{ margin: 0 }}>
						Noch keine Swarms.
					</p>
				</div>
			)}
			{props.swarms.map((sw) => (
				<div key={sw.id} className="card">
					<div className="row between">
						<div>
							<div className="row" style={{ gap: 8 }}>
								<strong>🐝 {sw.name}</strong>
								{!sw.enabled && (
									<span className="badge" style={{ opacity: 0.7 }}>
										inaktiv
									</span>
								)}
							</div>
							{sw.description && (
								<div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
									{sw.description}
								</div>
							)}
							<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
								Mitglieder:{" "}
								{sw.agentIds.length > 0 ? sw.agentIds.map((id) => props.agentName(id)).join(", ") : "—"}
							</div>
						</div>
						<div className="row">
							<button
								type="button"
								className={`btn ${props.editing === sw.id ? "primary" : ""}`}
								onClick={() => props.onEdit(sw)}
							>
								✏️ Bearbeiten
							</button>
							<button
								type="button"
								className="btn"
								onClick={() => void props.onAct(sw.id, { enabled: !sw.enabled })}
							>
								{sw.enabled ? "Deaktivieren" : "Aktivieren"}
							</button>
							<button type="button" className="btn danger" onClick={() => void props.onDel(sw.id)}>
								Löschen
							</button>
						</div>
					</div>
					{props.editing === sw.id && <div style={{ marginTop: 10 }}>{props.editForm}</div>}
				</div>
			))}
		</div>
	)
}
