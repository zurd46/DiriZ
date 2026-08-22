import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "./apps/web/tests",
	timeout: 30000,
	expect: {
		timeout: 5000,
	},
	retries: 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: [["list"], ["html"]],
	use: {
		baseURL: "http://localhost:5173",
		trace: "retry-on-failure",
		screenshot: "only-on-failure",
	},
})
