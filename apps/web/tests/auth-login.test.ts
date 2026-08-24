/**
 * Anmeldung im Browser: der Vorhang vor der Anwendung.
 *
 * Geprüft wird, was ohne Test still kaputt geht — dass ohne Sitzung wirklich
 * **nichts** zu sehen ist, dass ein falsches Passwort eine Meldung bringt statt
 * einer weissen Seite, und dass das Abmelden zurück auf den Vorhang führt.
 *
 * Läuft mit **eigenem** Kontext ohne Sitzungs-Cookie — die übrigen Tests
 * starten dank `globalSetup` angemeldet.
 */

import { expect, test } from "@playwright/test"
import { AUTH_FILE } from "./global-setup.js"

/** Die Einführung erscheint beim ersten Start und fängt sonst jeden Klick ab. */
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("diriz_onboarded", "1"))
})

/** Zugangsdaten des Testbenutzers aus `global-setup.ts`. */
const USER = { username: "e2e-tester", password: "e2e-passwort-123" }

test.describe("Anmeldung", () => {
	// Kein Cookie: Diese Tests sollen den Anmeldebildschirm sehen.
	test.use({ storageState: { cookies: [], origins: [] } })

	test("zeigt ohne Sitzung den Anmeldebildschirm statt der Anwendung", async ({ page }) => {
		await page.goto("/dashboard")
		await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible()
		// Nichts von der Anwendung darf durchscheinen.
		await expect(page.locator(".sidebar")).toHaveCount(0)
		await expect(page.locator("main")).toHaveCount(0)
	})

	test("weist ein falsches Passwort mit Meldung ab", async ({ page }) => {
		await page.goto("/")
		await page.getByLabel("Benutzername").fill(USER.username)
		await page.getByLabel("Passwort", { exact: true }).fill("völlig-falsch-123")
		await page.getByRole("button", { name: "Anmelden" }).click()

		await expect(page.locator(".error-banner")).toContainText("falsch")
		await expect(page.locator(".sidebar")).toHaveCount(0)
	})

	test("lässt mit richtigen Zugangsdaten hinein und wieder hinaus", async ({ page }) => {
		await page.goto("/")
		await page.getByLabel("Benutzername").fill(USER.username)
		await page.getByLabel("Passwort", { exact: true }).fill(USER.password)
		await page.getByRole("button", { name: "Anmelden" }).click()

		// Drin: Die Anwendung erscheint, der Benutzername steht in der Leiste.
		await expect(page.locator(".sidebar")).toBeVisible()
		await expect(page.getByRole("button", { name: new RegExp(USER.username) })).toBeVisible()

		// Und wieder hinaus.
		await page.getByRole("button", { name: new RegExp(USER.username) }).click()
		await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible()
	})
})

test.describe("Angemeldet", () => {
	test.use({ storageState: AUTH_FILE })

	test("zeigt den angemeldeten Benutzer und die Benutzerverwaltung", async ({ page }) => {
		await page.goto("/settings")
		await expect(page.getByRole("heading", { name: "Einstellungen" })).toBeVisible()
		// Die Verwaltung listet mindestens den eigenen Benutzer.
		await expect(page.getByText(USER.username, { exact: true }).first()).toBeVisible()
		await expect(page.getByRole("button", { name: "Benutzer anlegen" })).toBeVisible()
	})
})
