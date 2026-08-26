/**
 * Minimaler Router über die History-API — ohne Abhängigkeit.
 *
 * Warum überhaupt: Ohne Routing ist jede Ansicht nur ein React-State. Ein
 * Neuladen wirft einen zurück aufs Dashboard, der Zurück-Button verlässt die
 * App, und man kann niemandem einen Link auf eine Ansicht schicken. Genau das
 * erwartet man von einer Webanwendung.
 *
 * Der Core liefert für unbekannte Pfade `index.html` aus (SPA-Fallback), und
 * der Vite-Dev-Server tut dasselbe — deshalb echte Pfade statt `#/hash`.
 */

import { useEffect, useState } from "react"

export const ROUTES = [
	"dashboard",
	"chat",
	"providers",
	"models",
	"agents",
	"tasks",
	"docs",
	"github",
	"workspace",
	"logs",
	"settings",
	"schedules",
] as const

export type Route = (typeof ROUTES)[number]

export const DEFAULT_ROUTE: Route = "dashboard"

/** Seitentitel je Ansicht — steht im Browser-Tab und in der History. */
export const ROUTE_TITLES: Record<Route, string> = {
	dashboard: "Dashboard",
	chat: "Chat",
	providers: "Provider",
	models: "LLM-Modelle",
	agents: "Agenten",
	tasks: "Tasks",
	docs: "Dokumente",
	github: "GitHub",
	workspace: "Workspace",
	logs: "Logs",
	settings: "Einstellungen",
	schedules: "Zeitplan",
}

function isRoute(value: string): value is Route {
	return (ROUTES as readonly string[]).includes(value)
}

/** Liest die Ansicht aus dem Pfad; unbekannte Pfade landen beim Dashboard. */
export function routeFromPath(pathname: string): Route {
	const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? ""
	return isRoute(segment) ? segment : DEFAULT_ROUTE
}

/**
 * Aktuelle Ansicht + Navigation. `navigate` schreibt in die History, damit
 * Zurück/Vorwärts funktionieren; `replace` für Korrekturen ohne History-Eintrag.
 */
export function useRoute(): {
	route: Route
	navigate: (to: Route, replace?: boolean) => void
} {
	const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname))

	useEffect(() => {
		const onPop = () => setRoute(routeFromPath(window.location.pathname))
		window.addEventListener("popstate", onPop)
		return () => window.removeEventListener("popstate", onPop)
	}, [])

	useEffect(() => {
		document.title = `${ROUTE_TITLES[route]} · DiriZ`
		// Unbekannten oder leeren Pfad einmalig auf die kanonische Form bringen.
		const canonical = `/${route}`
		if (window.location.pathname !== canonical) {
			window.history.replaceState({ route }, "", canonical + window.location.search)
		}
	}, [route])

	const navigate = (to: Route, replace = false) => {
		if (to === route) {
			return
		}
		const url = `/${to}`
		if (replace) {
			window.history.replaceState({ route: to }, "", url)
		} else {
			window.history.pushState({ route: to }, "", url)
		}
		setRoute(to)
	}

	return { route, navigate }
}
