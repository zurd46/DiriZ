import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { isSafeRelPath, parseFileBlocks, writeWorkspaceFiles } from "../src/execution/files.js"

describe("files: parseFileBlocks", () => {
	const sample = [
		"Klar, hier sind die Dateien:",
		"",
		"```file:path=src/auth.py",
		"def check_user(user):",
		"    return user.is_active",
		"```",
		"",
		"Und noch eine:",
		"```file:path=config/settings.json",
		'{ "debug": true }',
		"```",
	].join("\n")

	it("extrahiert alle ```file:path=… Blöcke", () => {
		const blocks = parseFileBlocks(sample)
		expect(blocks).toHaveLength(2)
		expect(blocks[0]?.relPath).toBe("src/auth.py")
		expect(blocks[0]?.content).toContain("check_user")
		expect(blocks[1]?.relPath).toBe("config/settings.json")
	})

	it("ignoriert normale Codeblöcke", () => {
		const text = "```python\nprint('hi')\n```"
		expect(parseFileBlocks(text)).toHaveLength(0)
	})
})

describe("files: isSafeRelPath", () => {
	it("akzeptiert saubere Pfade", () => {
		expect(isSafeRelPath("src/a.py")).toBe(true)
		expect(isSafeRelPath("a/b/c.json")).toBe(true)
	})

	it("blockt Traversal, absolute Pfade und Backslashes", () => {
		expect(isSafeRelPath("../etc/passwd")).toBe(false)
		expect(isSafeRelPath("a/../../b")).toBe(false)
		expect(isSafeRelPath("/etc/passwd")).toBe(false)
		expect(isSafeRelPath("a\\b")).toBe(false)
		expect(isSafeRelPath("~/.ssh/id_rsa")).toBe(false)
		expect(isSafeRelPath("a/./b")).toBe(false)
	})
})

describe("files: writeWorkspaceFiles", () => {
	it("schreibt in die Sandbox und blockt Path-Traversal", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-ws-"))
		const written = writeWorkspaceFiles(dir, "task-x", [
			{ relPath: "src/app.py", content: "print(1)" },
			{ relPath: "../../evil.txt", content: "sollte nicht da sein" },
		])
		expect(written).toHaveLength(1)
		expect(fs.existsSync(path.join(dir, "task-x", "src", "app.py"))).toBe(true)
		expect(fs.existsSync(path.join(dir, "..", "evil.txt"))).toBe(false)
		expect(fs.existsSync(path.join(os.tmpdir(), "evil.txt"))).toBe(false)
	})
})
