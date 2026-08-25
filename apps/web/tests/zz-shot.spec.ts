import { expect, test } from "@playwright/test"

test("screenshot", async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("diriz_onboarded", "1"))
	const jetzt = new Date().toISOString()
	const turn = (i: number, extra: Record<string, unknown> = {}) => ({
		taskId: `s-${i}`,
		prompt: `Prüfe die Anmeldung auf SQL-Injection und behebe gefundene Stellen im Projekt`,
		status: "done",
		createdAt: jetzt,
		agentMode: true,
		chain: null,
		repoId: null,
		agentName: "Security-Analystin",
		agentReason:
			"Gewählt, weil der Auftrag eine Sicherheitsprüfung am echten Code verlangt und diese Spezialistin auf Injection-Muster, Eingabevalidierung und Authentifizierung trainiert ist.",
		modelName: "qwen2.5-coder:32b-instruct-q4_K_M",
		providerLabel: "Ollama · macstudio.local",
		answer:
			"## Befund\n\nIn `login.ts` wird der Benutzername direkt in die Abfrage interpoliert.\n\n- **Zeile 42** — String-Konkatenation statt Parameter\n- **Zeile 88** — gleiche Stelle im Passwort-Reset\n\nBeide Stellen sind jetzt auf vorbereitete Anweisungen umgestellt.",
		error: null,
		files: [{ relPath: "src/auth/login.ts", size: 2100 }],
		toolCalls: [
			{ id: "t1", name: "list_files", argsSummary: "src/auth", ok: true },
			{ id: "t2", name: "read_file", argsSummary: "src/auth/login.ts", ok: true },
			{ id: "t3", name: "read_file", argsSummary: "src/auth/reset.ts", ok: true },
			{ id: "t4", name: "write_file", argsSummary: "src/auth/login.ts", ok: true },
			{ id: "t5", name: "write_file", argsSummary: "src/auth/reset.ts", ok: false },
			{ id: "t6", name: "read_file", argsSummary: "src/db/query.ts", ok: true },
		],
		...extra,
	})
	await page.route("**/api/chats", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([
				{
					chatId: "shot",
					title: "SQL-Injection",
					createdAt: jetzt,
					updatedAt: jetzt,
					turns: [
						turn(1),
						turn(2, { status: "failed", error: "Verbindung zum Anbieter abgebrochen", answer: "" }),
						turn(3, {
							status: "running",
							answer: "Ich sehe mir zuerst die Abfragen in `src/db` an …",
							files: [],
							error: null,
						}),
					],
				},
			]),
		}),
	)
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.goto("/chat")
	await page.getByRole("button", { name: /^Verlauf/ }).click()
	await page.locator(".chat-history-item").first().click()
	await expect(page.locator(".chat-msg.agent").first()).toBeVisible()
	await page.waitForTimeout(600)
	await page.screenshot({
		path: "/private/tmp/claude-501/-Users-danielzurmuhle-Desktop-LokalCodeProjekte-DiriZ/93dbf6c5-bfd3-4558-9eb9-d5bec8bcbab0/scratchpad/chat.png",
		fullPage: false,
	})
})
