/**
 * Wo eine Task ihre Dateien ablegt.
 *
 * Ohne Repo-Bindung ist das ein einfaches Verzeichnis in der Workspace-Sandbox.
 * Mit gepinntem Repository ist **dasselbe Verzeichnis** ein Git-Worktree — die
 * Datei-Werkzeuge des Modells arbeiten dadurch unverändert, nur eben im echten
 * Projekt. Die Berechnung liegt hier, weil Engine und Git-Routen exakt
 * denselben Pfad meinen müssen.
 */

import path from "node:path"
import type { Task } from "@diriz/shared"

/** Verzeichnisname einer Task — stabil aus Titel bzw. Prompt gebildet. */
export function taskSlug(task: Task): string {
	const base = (task.title || task.prompt)
		.toLowerCase()
		.replace(/[^a-z0-9äöüß]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return (base.slice(0, 40) || "task").replace(/-+$/g, "")
}

/**
 * Arbeitsverzeichnis der Task — **stabil über die gesamte Lebensdauer**.
 *
 * Der Slug allein würde kollidieren (zwei Tasks mit gleichem Titel), deshalb
 * hängt die Kurz-ID mit dran. Sie darf nicht vom Pin-Zustand abhängen: Sonst
 * wanderte das Verzeichnis in dem Moment, in dem eine Task an ein Repository
 * gepinnt wird — und der frisch angelegte Worktree läge woanders als der
 * Arbeitsstand.
 */
export function taskWorktreePath(workspaceDir: string, task: Task): string {
	return path.join(workspaceDir, `${taskSlug(task)}-${task.id.slice(0, 8)}`)
}
