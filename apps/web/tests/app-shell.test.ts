/**
 * Rauchtest des Anwendungsrahmens gegen den **gebauten** Server.
 *
 * Geprüft wird, was eine Webanwendung ausmacht und was ohne Test still kaputt
 * geht: Startet sie ohne Konsolenfehler? Führt jeder Navigationspunkt zu einer
 * Ansicht? Ändert sich die URL, funktionieren Neuladen und Zurück-Button?
 */

import { expect, test } from "@playwright/test"

/** Die Einführung erscheint beim ersten Start — für die übrigen Tests weggeklickt. */
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("diriz_onboarded", "1"))
})

/** Navigationsziele mit ihrem erwarteten Pfad und ihrer Überschrift. */
const VIEWS = [
	{ label: "Dashboard", path: "/dashboard" },
	{ label: "Chat", path: "/chat" },
	{ label: "Provider", path: "/providers" },
	{ label: "LLM-Modelle", path: "/models" },
	{ label: "Agenten", path: "/agents" },
	{ label: "Tasks", path: "/tasks" },
	{ label: "Dokumente", path: "/docs" },
	{ label: "GitHub", path: "/github" },
	{ label: "Workspace", path: "/workspace" },
	{ label: "Logs", path: "/logs" },
	{ label: "Einstellungen", path: "/settings" },
]

test("startet ohne Konsolenfehler und zeigt die Navigation", async ({ page }) => {
	const errors: string[] = []
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(msg.text())
		}
	})
	page.on("pageerror", (e) => errors.push(e.message))

	await page.goto("/")
	await expect(page.locator(".sidebar")).toBeVisible()
	// Die Wurzel wird auf die kanonische Ansicht normalisiert.
	await expect(page).toHaveURL(/\/dashboard$/)
	await expect(page).toHaveTitle(/Dashboard · DiriZ/)

	// Die Statusleiste nennt die Version des laufenden Cores (nicht „…").
	await expect(page.locator(".statusbar")).toContainText(/DiriZ v\d+\.\d+\.\d+/)

	expect(errors, `Konsolenfehler: ${errors.join(" | ")}`).toHaveLength(0)
})

test("jede Ansicht ist erreichbar und setzt die URL", async ({ page }) => {
	await page.goto("/")
	for (const view of VIEWS) {
		await page.getByRole("button", { name: view.label, exact: true }).click()
		await expect(page).toHaveURL(new RegExp(`${view.path}$`))
		await expect(page.locator("main h1")).toBeVisible()
	}
})

test("Deep-Link lädt direkt die richtige Ansicht", async ({ page }) => {
	await page.goto("/docs")
	await expect(page.locator("main h1")).toHaveText("Dokumente")
	await expect(page).toHaveTitle(/Dokumente · DiriZ/)

	// Neuladen bleibt in derselben Ansicht — das war ohne Routing unmöglich.
	await page.reload()
	await expect(page.locator("main h1")).toHaveText("Dokumente")
})

test("Zurück-Button führt zur vorherigen Ansicht", async ({ page }) => {
	await page.goto("/dashboard")
	await page.getByRole("button", { name: "Tasks", exact: true }).click()
	await expect(page).toHaveURL(/\/tasks$/)

	await page.goBack()
	await expect(page).toHaveURL(/\/dashboard$/)
	await expect(page.locator("main h1")).toHaveText("Dashboard")
})

test("Dokumente-Ansicht listet die Ebenen und zeigt eine Vorschau", async ({ page }) => {
	await page.goto("/docs")
	// Ohne angebundenen Provider gibt es keine Rechner/Modelle — die Ansicht
	// muss trotzdem stehen und den leeren Zustand erklären.
	await expect(page.locator(".docs-layout")).toBeVisible()
	await expect(page.getByPlaceholder("Suchen in allen Dokumenten …")).toBeVisible()
})

test("LLM-Modelle-Ansicht steht auch ohne angebundenen Rechner", async ({ page }) => {
	await page.goto("/models")
	await expect(page.locator("main h1")).toHaveText("LLM-Modelle")
	await expect(page.getByPlaceholder("Modell oder Datenblatt suchen …")).toBeVisible()
	// Ohne Modelle erklärt die Ansicht den leeren Zustand, statt leer zu bleiben.
	await expect(page.getByText("Kein Modell gewählt")).toBeVisible()
})

test("unbekannter Pfad landet in der Anwendung statt im 404", async ({ page }) => {
	const res = await page.goto("/gibt-es-nicht")
	expect(res?.status()).toBe(200)
	await expect(page.locator(".sidebar")).toBeVisible()
})

test.describe("Einführung beim ersten Start", () => {
	// Dieser Block soll die Einführung sehen — die Vorbelegung wieder aufheben.
	test.use({ storageState: { cookies: [], origins: [] } })

	test("erscheint und lässt sich mit Escape schließen", async ({ browser }) => {
		const context = await browser.newContext()
		const page = await context.newPage()
		await page.goto("/")

		const dialog = page.getByRole("dialog", { name: "Einführung" })
		await expect(dialog).toBeVisible()

		// Escape schließt den Dialog — ohne das hängt man mit der Tastatur fest.
		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()

		// Und sie kommt nach dem Neuladen nicht zurück.
		await page.reload()
		await expect(page.getByRole("dialog", { name: "Einführung" })).toBeHidden()
		await context.close()
	})
})

test("GitHub-Ansicht zeigt Verbindung und Repo-Formular", async ({ page }) => {
	await page.goto("/github")
	await expect(page.locator("main h1")).toHaveText("GitHub")
	// Ohne Token: Eingabefeld für den Personal Access Token.
	await expect(page.getByPlaceholder("ghp_… oder github_pat_…")).toBeVisible()
	// Repositories lassen sich auch ohne Token-Auswahl von Hand hinzufügen.
	await expect(page.getByPlaceholder("zurd46/DiriZ")).toBeVisible()
})

/**
 * Die Chat-Ansicht ist der einfache Einstieg: ein Textfeld, eine Zielwahl und
 * ein Senden-Knopf. Ohne diesen Test bliebe unbemerkt, wenn die Ansicht zwar
 * in der Navigation steht, aber leer lädt.
 */
test("Chat zeigt Eingabefeld, Zielwahl und Senden-Knopf", async ({ page }) => {
	await page.goto("/chat")
	await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible()

	const eingabe = page.locator(".chat-composer textarea")
	await expect(eingabe).toBeVisible()

	// Die drei Ziele bestimmen, was der Spezialist anfassen darf.
	for (const label of ["Nur antworten", "Projekt anlegen", "Repository ändern"]) {
		await expect(page.getByRole("button", { name: label })).toBeVisible()
	}

	// Senden bleibt gesperrt, solange nichts drinsteht.
	const senden = page.getByRole("button", { name: "Senden" })
	await expect(senden).toBeDisabled()
	await eingabe.fill("Prüfe die Anmeldung auf SQL-Injection")
	await expect(senden).toBeEnabled()

	// Der Verlauf ist zugeklappt, damit die Unterhaltung die Breite bekommt.
	await expect(page.locator("#chat-history")).toHaveCount(0)
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await expect(page.locator("#chat-history")).toBeVisible()
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await expect(page.locator("#chat-history")).toHaveCount(0)

	// „Repository ändern“ blendet die Repo-Auswahl ein — solange keines
	// angebunden ist, stattdessen den Weg dorthin. Eine leere Auswahl ohne
	// Erklärung war der häufigste Stolperstein.
	await page.getByRole("button", { name: "Repository ändern" }).click()
	const auswahl = page.getByLabel("Repository")
	const hinweis = page.getByRole("link", { name: /Kein Repository angebunden/ })
	await expect(auswahl.or(hinweis).first()).toBeVisible()
})
