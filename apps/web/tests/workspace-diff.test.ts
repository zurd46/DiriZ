import { expect, test } from "@playwright/test"

/**
 * M6-Regression: Workspace-Vorschau + Diff zwischen zwei Dateiversionen.
 * Voraussetzung: mindestens eine Datei mit 2 Versionen in der DB
 * (entsteht normal durch zwei Executions derselben Task).
 */
test("E2E M6: Workspace-Diff zwischen zwei Versionen", async ({ page }) => {
	await page.goto("/")
	await page.waitForLoadState("networkidle")

	const onboarding = page.locator(".onboarding")
	if (await onboarding.isVisible()) {
		await page.click('button:has-text("Überspringen")')
	}

	await page.getByRole("button", { name: "Workspace" }).click()
	await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible()

	const fileBtn = page.locator('button:has-text("demo/hello.py")').first()
	try {
		await fileBtn.waitFor({ state: "visible", timeout: 5_000 })
	} catch {
		test.skip(true, "Demo-Datei mit 2 Versionen nicht vorhanden — Diff-Szenario übersprungen.")
	}
	await fileBtn.click()

	// Vorschau zeigt die neueste Version.
	await expect(page.getByText("formal").first()).toBeVisible({ timeout: 10_000 })

	// Diff-Tab (2 Versionen verfügbar) — Standard: älteste → neueste.
	await page.click('button:has-text("Diff")')
	await expect(page.locator(".diff-add").first()).toBeVisible()
	await expect(page.locator(".diff-del").first()).toBeVisible()
})
