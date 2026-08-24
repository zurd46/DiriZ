/**
 * Layout und Scroll-Verhalten der Chat-Ansicht — im echten Browser geprüft.
 *
 * Diese Regeln sind mehrfach gebrochen worden, ohne dass es jemand bemerkte:
 * Die Eingabe legte sich über die letzte Antwort, die ganze Seite sprang beim
 * Nachscrollen, und der Verlauf wuchs statt in sich zu scrollen. Genau das
 * prüft diese Datei — CSS-Regeln lassen sich nur im Browser verifizieren.
 */

import { expect, type Page, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("diriz_onboarded", "1"))
})

/** Legt eine Chat-Nachricht direkt über die API an — ohne Modell-Lauf. */
async function nachrichtAnlegen(page: Page, chatId: string, prompt: string): Promise<string> {
	const res = await page.request.post("/api/tasks", {
		data: { title: prompt.slice(0, 40), prompt, metadata: { chatId, privacy: "local-only" } },
	})
	expect(res.ok()).toBeTruthy()
	return ((await res.json()) as { id: string }).id
}

test("Eingabe überlappt den Verlauf nie", async ({ page }) => {
	await page.goto("/chat")
	const log = page.locator(".chat-log")
	const composer = page.locator(".chat-composer")
	await expect(log).toBeVisible()
	await expect(composer).toBeVisible()

	const logBox = await log.boundingBox()
	const composerBox = await composer.boundingBox()
	expect(logBox).not.toBeNull()
	expect(composerBox).not.toBeNull()
	if (!logBox || !composerBox) {
		return
	}
	// Der Verlauf endet **oberhalb** der Eingabe — und mit Abstand dazwischen.
	const abstand = composerBox.y - (logBox.y + logBox.height)
	expect(abstand).toBeGreaterThanOrEqual(0)
})

test("der Verlauf scrollt in sich, nicht die Seite", async ({ page }) => {
	await page.goto("/chat")
	const overflow = await page.locator(".chat-log").evaluate((el) => window.getComputedStyle(el).overflowY)
	expect(overflow).toBe("auto")

	// Die Seite selbst darf keinen nennenswerten Scroll-Bereich aufbauen.
	const seitenUeberhang = await page.evaluate(() => {
		const el = document.scrollingElement
		return el ? el.scrollHeight - el.clientHeight : 0
	})
	expect(seitenUeberhang).toBeLessThan(8)
})

test("viele Nachrichten: letzte Antwort bleibt sichtbar, Eingabe bleibt frei", async ({ page }) => {
	const chatId = `e2e-layout-${Date.now()}`
	for (let i = 1; i <= 12; i++) {
		await nachrichtAnlegen(page, chatId, `Nachricht Nummer ${i} für den Layout-Test`)
	}
	await page.goto("/chat")
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await page.locator(".chat-history-item").first().click()

	const letzte = page.locator(".chat-msg.user").last()
	await expect(letzte).toContainText("Nachricht Nummer 12")

	// Der Verlauf hat jetzt wirklich mehr Inhalt als Platz …
	const scrollbar = await page.locator(".chat-log").evaluate((el) => el.scrollHeight > el.clientHeight + 4)
	expect(scrollbar).toBe(true)

	// … und die letzte Nachricht liegt vollständig über der Eingabe.
	const letzteBox = await letzte.boundingBox()
	const composerBox = await page.locator(".chat-composer").boundingBox()
	expect(letzteBox && composerBox).toBeTruthy()
	if (letzteBox && composerBox) {
		expect(letzteBox.y + letzteBox.height).toBeLessThanOrEqual(composerBox.y + 1)
	}
})

test("kein Nachscrollen, wenn nichts mehr läuft", async ({ page }) => {
	const chatId = `e2e-scroll-${Date.now()}`
	for (let i = 1; i <= 12; i++) {
		await nachrichtAnlegen(page, chatId, `Ruhige Nachricht ${i} ohne laufenden Auftrag`)
	}
	await page.goto("/chat")
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await page.locator(".chat-history-item").first().click()
	await expect(page.locator(".chat-msg.user").last()).toBeVisible()

	// Nach oben scrollen — und dort bleiben dürfen.
	await page.locator(".chat-log").evaluate((el) => {
		el.scrollTop = 0
	})
	await page.waitForTimeout(2500)
	const position = await page.locator(".chat-log").evaluate((el) => el.scrollTop)
	expect(position).toBeLessThan(8)
})

test("laufender Auftrag reisst die Ansicht nicht nach unten", async ({ page }) => {
	// Ein **laufender** Chat, komplett aus der Stubbing-Ebene: nur so ist der
	// Sekundentakt der Ansicht deterministisch — echte Läufe brauchen ein Modell.
	const jetzt = new Date().toISOString()
	const turns = Array.from({ length: 15 }, (_, i) => ({
		taskId: `stub-${i}`,
		prompt: `Lange Nachricht Nummer ${i + 1}, damit der Verlauf sicher überläuft`,
		status: i === 14 ? "running" : "done",
		createdAt: jetzt,
		agentMode: false,
		repoId: null,
		agentName: null,
		agentReason: null,
		modelName: null,
		providerLabel: null,
		answer: i === 14 ? "" : `Antwort ${i + 1} mit genug Text, dass sie Platz braucht.`,
		error: null,
		files: [],
		toolCalls: [],
	}))
	await page.route("**/api/chats", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([
				{ chatId: "e2e-running", title: "Laufender Auftrag", createdAt: jetzt, updatedAt: jetzt, turns },
			]),
		}),
	)

	await page.goto("/chat")
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await page.locator(".chat-history-item").first().click()
	await expect(page.locator(".chat-msg.user").last()).toBeVisible()

	// Nach oben scrollen, **während** gearbeitet wird …
	await page.locator(".chat-log").evaluate((el) => {
		el.scrollTop = 0
	})
	// … und über mehrere Takte des Nachscroll-Intervalls dort bleiben.
	await page.waitForTimeout(3500)
	const position = await page.locator(".chat-log").evaluate((el) => el.scrollTop)
	expect(position).toBeLessThan(8)

	// Wieder ganz nach unten: ab da darf die Ansicht auch wieder mitlaufen.
	await page.locator(".chat-log").evaluate((el) => {
		el.scrollTop = el.scrollHeight
	})
	await page.waitForTimeout(1500)
	const unten = await page
		.locator(".chat-log")
		.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
	expect(unten).toBeLessThan(8)
})

test("Werkzeug-Badges stehen nebeneinander, nicht gestapelt", async ({ page }) => {
	await page.goto("/chat")
	// Die Leiste ist erst mit Operationen sichtbar; geprüft wird die Regel
	// selbst — sie war es, die die Badges in eine Spalte zwang.
	const richtung = await page.evaluate(() => {
		const probe = document.createElement("div")
		probe.className = "chat-tools"
		document.body.appendChild(probe)
		const value = window.getComputedStyle(probe).flexDirection
		probe.remove()
		return value
	})
	expect(richtung).toBe("row")
})
