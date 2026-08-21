/**
 * Agenten-Ansicht (M1): Spezialisten anlegen (Rolle, Fähigkeiten, Privacy,
 * Rechner-/Modell-Pin) und in Swarms gruppieren. Die Zuordnung pro Prompt
 * übernimmt die Engine — hier wird nur verwaltet.
 */

import type { Agent, AgentPrivacy, Capability, InstanceModel, Swarm } from "@diriz/shared"
import { useEffect, useState } from "react"
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

	const [showAgentForm, setShowAgentForm] = useState(false)
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [systemPrompt, setSystemPrompt] = useState("")
	const [required, setRequired] = useState<Capability[]>([])
	const [preferred, setPreferred] = useState<Capability[]>([])
	const [privacy, setPrivacy] = useState<AgentPrivacy>("any")
	const [pinnedProvider, setPinnedProvider] = useState("")
	const [pinnedInstance, setPinnedInstance] = useState("")
	const [busy, setBusy] = useState(false)

	const providerLabel = (id?: string | null) => providers.find((p) => p.id === id)?.label ?? id ?? ""
	const instanceLabel = (id?: string | null) => instances.find((i) => i.id === id)?.displayName ?? id ?? ""

	const resetAgentForm = () => {
		setName("")
		setDescription("")
		setSystemPrompt("")
		setRequired([])
		setPreferred([])
		setPrivacy("any")
		setPinnedProvider("")
		setPinnedInstance("")
	}

	const saveAgent = async () => {
		setBusy(true)
		try {
			await api.post("/api/agents", {
				name,
				description,
				systemPrompt,
				requiredCapabilities: required,
				preferredCapabilities: preferred,
				privacy,
				pinnedProviderId: pinnedProvider || null,
				pinnedInstanceId: pinnedInstance || null,
			})
			resetAgentForm()
			setShowAgentForm(false)
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
			await refreshAgents()
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const [showSwarmForm, setShowSwarmForm] = useState(false)
	const [swarmName, setSwarmName] = useState("")
	const [swarmDesc, setSwarmDesc] = useState("")
	const [swarmMembers, setSwarmMembers] = useState<string[]>([])
	const [swarmBusy, setSwarmBusy] = useState(false)

	const saveSwarm = async () => {
		setSwarmBusy(true)
		try {
			await api.post("/api/swarms", { name: swarmName, description: swarmDesc, agentIds: swarmMembers })
			setSwarmName("")
			setSwarmDesc("")
			setSwarmMembers([])
			setShowSwarmForm(false)
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
			await refreshSwarms()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id
	return (
		<div>
			<AgentForm
				show={showAgentForm}
				onToggle={() => setShowAgentForm((v) => !v)}
				onSave={saveAgent}
				onCancel={() => setShowAgentForm(false)}
				name={name}
				setName={setName}
				description={description}
				setDescription={setDescription}
				systemPrompt={systemPrompt}
				setSystemPrompt={setSystemPrompt}
				required={required}
				setRequired={setRequired}
				preferred={preferred}
				setPreferred={setPreferred}
				privacy={privacy}
				setPrivacy={setPrivacy}
				pinnedProvider={pinnedProvider}
				setPinnedProvider={(v) => {
					setPinnedProvider(v)
					setPinnedInstance("")
				}}
				pinnedInstance={pinnedInstance}
				setPinnedInstance={setPinnedInstance}
				providers={providers}
				instances={instances.filter((i) => i.providerId === pinnedProvider)}
				busy={busy}
			/>
			<AgentList
				agents={agents}
				swarms={swarms}
				onAct={actAgent}
				onDel={delAgent}
				providerLabel={providerLabel}
				instanceLabel={instanceLabel}
			/>
			<SwarmForm
				show={showSwarmForm}
				onToggle={() => setShowSwarmForm((v) => !v)}
				onSave={saveSwarm}
				agents={agents}
				swarmName={swarmName}
				setSwarmName={setSwarmName}
				swarmDesc={swarmDesc}
				setSwarmDesc={setSwarmDesc}
				swarmMembers={swarmMembers}
				setSwarmMembers={setSwarmMembers}
				busy={swarmBusy}
			/>
			<SwarmList swarms={swarms} agentName={agentName} onAct={actSwarm} onDel={delSwarm} />
		</div>
	)
}

/* ---------------------------------- Sub-Views --------------------------------- */

function AgentForm(props: {
	show: boolean
	onToggle: () => void
	onSave: () => void
	onCancel: () => void
	name: string
	setName: (v: string) => void
	description: string
	setDescription: (v: string) => void
	systemPrompt: string
	setSystemPrompt: (v: string) => void
	required: Capability[]
	setRequired: (v: Capability[]) => void
	preferred: Capability[]
	setPreferred: (v: Capability[]) => void
	privacy: AgentPrivacy
	setPrivacy: (v: AgentPrivacy) => void
	pinnedProvider: string
	setPinnedProvider: (v: string) => void
	pinnedInstance: string
	setPinnedInstance: (v: string) => void
	providers: { id: string; label: string }[]
	instances: { id: string; displayName: string }[]
	busy: boolean
}) {
	return (
		<div>
			<div className="row between">
				<h1>Spezialisten</h1>
				<button type="button" className="btn primary" onClick={props.onToggle}>
					+ Spezialist anlegen
				</button>
			</div>
			<p className="muted" style={{ marginTop: -8 }}>
				Jeder Spezialist hat eine Rolle (System-Prompt), Fähigkeiten und Routing-Vorgaben. Pro Prompt wird
				automatisch der passende gewählt — oder manuell per Task festgelegt.
			</p>
			{props.show && (
				<div className="card">
					<div className="row">
						<label className="field" style={{ minWidth: 180 }}>
							Name *
							<input
								value={props.name}
								onChange={(e) => props.setName(e.target.value)}
								placeholder="z. B. Code-Dev"
							/>
						</label>
						<label className="field" style={{ flex: 1, minWidth: 220 }}>
							Beschreibung (Keywords für die Auto-Zuordnung)
							<input
								value={props.description}
								onChange={(e) => props.setDescription(e.target.value)}
								placeholder="z. B. React TypeScript Bug Refactoring"
							/>
						</label>
						<label className="field">
							Privacy
							<select
								value={props.privacy}
								onChange={(e) => props.setPrivacy(e.target.value as AgentPrivacy)}
							>
								{PRIVACIES.map((p) => (
									<option key={p.id} value={p.id}>
										{p.label}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							Pin: Rechner
							<select value={props.pinnedProvider} onChange={(e) => props.setPinnedProvider(e.target.value)}>
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
								value={props.pinnedInstance}
								onChange={(e) => props.setPinnedInstance(e.target.value)}
								disabled={!props.pinnedProvider}
							>
								<option value="">— automatisch —</option>
								{props.instances.map((i) => (
									<option key={i.id} value={i.id}>
										{i.displayName}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							className="btn primary"
							onClick={() => void props.onSave()}
							disabled={props.busy || props.name.trim().length === 0}
						>
							{props.busy ? "…" : "Speichern"}
						</button>
					</div>
					<label className="field" style={{ marginTop: 8 }}>
						System-Prompt (Rolle des Spezialisten)
						<textarea
							value={props.systemPrompt}
							onChange={(e) => props.setSystemPrompt(e.target.value)}
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
											checked={props.required.includes(c)}
											onChange={() => props.setRequired(toggleCap(props.required, c))}
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
											checked={props.preferred.includes(c)}
											onChange={() => props.setPreferred(toggleCap(props.preferred, c))}
										/>
										{c}
									</label>
								))}
							</div>
						</div>
					</div>
					<div className="row" style={{ marginTop: 10 }}>
						<button type="button" className="btn" onClick={props.onCancel}>
							Abbrechen
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

function AgentList(props: {
	agents: Agent[]
	swarms: Swarm[]
	onAct: (id: string, body: Record<string, unknown>) => Promise<void>
	onDel: (id: string) => Promise<void>
	providerLabel: (id?: string | null) => string
	instanceLabel: (id?: string | null) => string
}) {
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
					</div>
				)
			})}
		</div>
	)
}

function SwarmForm(props: {
	show: boolean
	onToggle: () => void
	onSave: () => void
	agents: Agent[]
	swarmName: string
	setSwarmName: (v: string) => void
	swarmDesc: string
	setSwarmDesc: (v: string) => void
	swarmMembers: string[]
	setSwarmMembers: (v: string[]) => void
	busy: boolean
}) {
	return (
		<div>
			<div className="row between" style={{ marginTop: 18 }}>
				<h1 style={{ margin: 0 }}>Swarms</h1>
				<button type="button" className="btn primary" onClick={props.onToggle}>
					+ Swarm anlegen
				</button>
			</div>
			<p className="muted" style={{ marginTop: -8 }}>
				Ein Swarm bündelt Spezialisten — pro Prompt wird das beste Mitglied automatisch gewählt.
			</p>
			{props.show && (
				<div className="card">
					<div className="row">
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
					</div>
				</div>
			)}
		</div>
	)
}

function SwarmList(props: {
	swarms: Swarm[]
	agentName: (id: string) => string
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
				</div>
			))}
		</div>
	)
}
