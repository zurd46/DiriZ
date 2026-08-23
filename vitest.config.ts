/**
 * Wurzel-Konfiguration für Vitest.
 *
 * Ohne sie sammelt ein `vitest run` an der Wurzel auch die Playwright-Dateien
 * unter `apps/web/tests/` ein und bricht ab („Playwright Test did not expect
 * test() to be called here"). Die End-to-End-Tests laufen über
 * `npm run test:e2e`, die Unit-Tests hier.
 */

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "apps/web/tests/**"],
		reporters: ["default"],
	},
})
