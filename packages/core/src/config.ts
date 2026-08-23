/**
 * Laufzeit-Konfiguration. Alles über Environment überschreibbar —
 * Default bleibt lokal und single-user (`01-plan.md` §13).
 */

import os from "node:os"
import path from "node:path"
import { CORE_HOST, CORE_PORT, DEFAULT_DATA_DIR, DEFAULT_WORKSPACE_DIR } from "@diriz/shared"

export interface CoreConfig {
	host: string
	port: number
	/** SQLite-DB + Secret-Datei. */
	dataDir: string
	/** Sandbox für AI-generierte Dateien (§9). */
	workspaceDir: string
	/** Lokale Klone verbundener GitHub-Repositories (M10). */
	reposDir: string
}

function expandHome(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(1))
	}
	return path.resolve(p)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
	return {
		host: env.DIRIZ_HOST ?? CORE_HOST,
		port: Number(env.DIRIZ_PORT ?? CORE_PORT),
		dataDir: expandHome(env.DIRIZ_DATA_DIR ?? DEFAULT_DATA_DIR),
		workspaceDir: expandHome(env.DIRIZ_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_DIR),
		reposDir: expandHome(env.DIRIZ_REPOS_DIR ?? path.join(env.DIRIZ_DATA_DIR ?? DEFAULT_DATA_DIR, "repos")),
	}
}
