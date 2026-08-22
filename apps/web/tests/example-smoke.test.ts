import { expect, test } from "@playwright/test"

test("E2E smoke: App lädt → Onboarding → Task anlegen → Start → Rating", async ({ page }) => {
	await page.goto("/")
	await page.waitForLoadState("networkidle")

	// Erststart-Overlay wie ein echter User überspringen.
	const onboarding = page.locator(".onboarding")
	if (await onboarding.isVisible()) {
		await expect(page.getByRole("heading", { name: "Willkommen bei DiriZ" })).toBeVisible()
		await page.click('button:has-text("Überspringen")')
	}

	// Alte Test-Tasks aufräumen, damit alle Selektoren eindeutig bleiben.
	const existing = (await (await page.request.get("/api/tasks")).json()) as { id: string }[]
	for (const t of existing) {
		await page.request.delete(`/api/tasks/${t.id}`)
	}

	// Navigation ist sichtbar (eindeutiger Selektor statt text=Tasks).
	const tasksNav = page.getByRole("button", { name: "Tasks" })
	await expect(tasksNav).toBeVisible()
	await tasksNav.click()

	// Task mit eindeutigem Titel anlegen.
	const title = `E2E Smoke ${Date.now()}`
	await page.click('button:has-text("Neue Task")')
	await page.fill('input[placeholder*="Auth-Fix"]', title)
	await page.fill('textarea[placeholder*="Ergebnis"]', "Nur ein E2E-Smoke-Test — bitte kurz bestätigen.")
	await page.click('button:has-text("Task anlegen")')

	const row = page.locator(`tr:has-text("${title}")`)
	await expect(row).toBeVisible({ timeout: 10_000 })

	// Starten → ohne Provider schlägt die Execution sofort fehl (sichtbar als Record).
	await row.locator('button:has-text("Start")').click()

	// M7: Detail-Karte lädt per SSE nach — Bewertungs-Sternen erscheinen.
	const star = page.locator(".star-btn").first()
	await expect(star).toBeVisible({ timeout: 10_000 })
	await star.click() // 1 Stern setzen (persistiert via Core → Qualitäts-Prior)
	// POST läuft asynchron — auf den sichtbaren Zustand warten.
	await expect(page.locator(".star-btn.filled").first()).toBeVisible({ timeout: 5_000 })

	// Statusleiste (M5) ist sichtbar.
	await expect(page.locator(".statusbar")).toBeVisible()

	// Neue Views (M6/M7) rendern ohne Fehler.
	await page.getByRole("button", { name: "Einstellungen" }).click()
	await expect(page.getByRole("heading", { name: "Einstellungen" })).toBeVisible()
	await expect(page.getByText("Routing-Gewichte")).toBeVisible()

	await page.getByRole("button", { name: "Workspace" }).click()
	await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible()

	await page.screenshot({ path: "test-results/smoke-test.png" })
})
