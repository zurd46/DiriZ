import { expect, test } from "@playwright/test"

test("E2E M8: System-Karte (Host-Metriken) + Agentik-Checkbox + Host-Last-Gewicht", async ({ page }) => {
	await page.goto("/")
	await page.waitForLoadState("networkidle")

	// Onboarding überspringen (falls sichtbar).
	const onboarding = page.locator(".onboarding")
	if (await onboarding.isVisible()) {
		await page.click('button:has-text("Überspringen")')
	}

	// 1) Dashboard: System-Karte mit RAM-Auslastung (M8 Host-Monitoring).
	await page.getByRole("button", { name: "Dashboard" }).click()
	await expect(page.getByText("System (Host)")).toBeVisible({ timeout: 10_000 })
	await expect(page.getByText(/RAM/).first()).toBeVisible()
	// RAM-Prozentzahl erscheint erst, wenn die Metriken geladen sind.
	await expect(page.locator(".card", { hasText: "System (Host)" }).getByText(/%$/)).toBeVisible({
		timeout: 10_000,
	})

	// 2) Einstellungen: 7. Routing-Achse „Host-Last“ ist als Slider vorhanden.
	await page.getByRole("button", { name: "Einstellungen" }).click()
	await expect(page.getByText("Host-Last")).toBeVisible({ timeout: 5_000 })

	// 3) Tasks: Composer bietet den Agentik-Modus an (M8 Tool-Loop).
	await page.getByRole("button", { name: "Tasks" }).click()
	await page.click('button:has-text("Neue Task")')
	const agentCheckbox = page.locator('label[title*="Agentik"] input[type="checkbox"]')
	await expect(agentCheckbox).toBeVisible({ timeout: 5_000 })

	// API-Check: Host-Metriken-Endpoint liefert plausible Werte.
	const res = await page.request.get("/api/host/metrics")
	expect(res.status()).toBe(200)
	const body = (await res.json()) as { ramTotalBytes: number; cpuCores: number }
	expect(body.ramTotalBytes).toBeGreaterThan(0)
	expect(body.cpuCores).toBeGreaterThan(0)

	await page.screenshot({ path: "test-results/m8-test.png" })
})
