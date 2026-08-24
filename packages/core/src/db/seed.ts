/**
 * Katalog-Seeding: das eingebaute Software-Team anlegen.
 *
 * Der Katalog (`@diriz/shared` → `SOFTWARE_TEAM`) beschreibt Spezialisten
 * deklarativ; hier werden daraus einmalig echte Agenten samt ihren drei
 * Dokumenten (`plan.md`, `init.md`, `changelog.md`) und die Fachbereichs-
 * Swarms erzeugt.
 *
 * Drei Regeln, damit das Seeding nie im Weg steht:
 * 1. **Einmalig.** Was einmal geseedet wurde, steht in `settings.catalog_seed`
 *    und kommt nicht wieder — wer einen Spezialisten löscht, hat ihn gelöscht.
 * 2. **Nie überschreiben.** Bestehende Agenten (auch namensgleiche, selbst
 *    angelegte) bleiben unangetastet.
 * 3. **Nachrüstbar.** Neue Katalog-Einträge kommen beim nächsten Start dazu,
 *    ohne die vorhandenen anzufassen.
 */

import {
	type AgentBlueprint,
	blueprintAgentId,
	blueprintDocs,
	blueprintSwarmId,
	SOFTWARE_TEAM,
	type SwarmBlueprint,
	TEAM_SWARMS,
} from "@diriz/shared"
import type { Db } from "./connection.js"
import {
	createAgent,
	createSwarm,
	getAgent,
	getSetting,
	getSwarm,
	listAgents,
	listSwarms,
	setSetting,
	updateSwarm,
} from "./repositories.js"

/** Was bereits geseedet wurde — Slugs, nicht IDs (der Katalog ist die Quelle). */
interface SeedState {
	agents: string[]
	swarms: string[]
}

const SEED_KEY = "catalog_seed"

export interface SeedResult {
	/** Neu angelegte Spezialisten (Slugs). */
	agents: string[]
	/** Neu angelegte Swarms (Slugs). */
	swarms: string[]
}

function loadState(db: Db): SeedState {
	const raw = getSetting<Partial<SeedState>>(db, SEED_KEY)
	return { agents: raw?.agents ?? [], swarms: raw?.swarms ?? [] }
}

/** Ein Blueprint wird zum Agenten — mit fester ID und gefüllten Dokumenten. */
function seedAgent(db: Db, bp: AgentBlueprint, now: string): void {
	createAgent(db, {
		id: blueprintAgentId(bp.slug),
		name: bp.name,
		description: bp.description,
		systemPrompt: bp.systemPrompt,
		requiredCapabilities: bp.requiredCapabilities,
		preferredCapabilities: bp.preferredCapabilities,
		privacy: bp.privacy,
		enabled: true,
		docs: blueprintDocs(bp, now),
	})
}

/**
 * Legt fehlende Spezialisten und Swarms an. Idempotent: mehrfaches Aufrufen
 * ändert nichts mehr.
 */
export function seedTeamCatalog(db: Db): SeedResult {
	const state = loadState(db)
	const seededAgents = new Set(state.agents)
	const seededSwarms = new Set(state.swarms)
	const takenNames = new Set(listAgents(db).map((a) => a.name.trim().toLowerCase()))
	const now = new Date().toISOString()
	const result: SeedResult = { agents: [], swarms: [] }

	for (const bp of SOFTWARE_TEAM) {
		if (seededAgents.has(bp.slug) || getAgent(db, blueprintAgentId(bp.slug))) {
			continue
		}
		// Namensgleiche Eigenbauten haben Vorrang — sonst stünden zwei
		// „Code-Reviewer“ in der Liste und die Zuordnung würfelte zwischen ihnen.
		if (takenNames.has(bp.name.trim().toLowerCase())) {
			seededAgents.add(bp.slug)
			continue
		}
		seedAgent(db, bp, now)
		seededAgents.add(bp.slug)
		takenNames.add(bp.name.trim().toLowerCase())
		result.agents.push(bp.slug)
	}

	for (const sw of TEAM_SWARMS) {
		if (seededSwarms.has(sw.slug) || getSwarm(db, blueprintSwarmId(sw.slug))) {
			continue
		}
		const memberIds = memberIdsOf(db, sw)
		if (memberIds.length === 0) {
			continue
		}
		createSwarm(db, {
			id: blueprintSwarmId(sw.slug),
			name: sw.name,
			description: sw.description,
			agentIds: memberIds,
			enabled: true,
		})
		seededSwarms.add(sw.slug)
		result.swarms.push(sw.slug)
	}

	setSetting(db, SEED_KEY, { agents: [...seededAgents], swarms: [...seededSwarms] } satisfies SeedState)
	return result
}

/** Mitglieder eines Swarms — nur Spezialisten, die es wirklich gibt. */
function memberIdsOf(db: Db, sw: SwarmBlueprint): string[] {
	return sw.agentSlugs.map(blueprintAgentId).filter((id) => getAgent(db, id) !== undefined)
}

/**
 * Ergänzt bestehende Katalog-Swarms um Spezialisten, die später dazugekommen
 * sind. Selbst gebaute Swarms (ohne Katalog-ID) bleiben unberührt.
 */
export function refreshCatalogSwarms(db: Db): string[] {
	const changed: string[] = []
	const known = new Set(listSwarms(db).map((s) => s.id))
	for (const sw of TEAM_SWARMS) {
		const id = blueprintSwarmId(sw.slug)
		if (!known.has(id)) {
			continue
		}
		const swarm = getSwarm(db, id)
		if (!swarm) {
			continue
		}
		const missing = memberIdsOf(db, sw).filter((memberId) => !swarm.agentIds.includes(memberId))
		if (missing.length === 0) {
			continue
		}
		updateSwarm(db, id, { agentIds: [...swarm.agentIds, ...missing] })
		changed.push(sw.slug)
	}
	return changed
}
