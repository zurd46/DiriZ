/**
 * Host-Metriken (M8): RAM/CPU des Rechners, auf dem der Core läuft —
 * Basis für die Routing-Achse `hostLoad` und das System-Card im Dashboard.
 *
 * GPU: Linux mit NVIDIA liefert `nvidia-smi`; macOS (Metal) hat keine
 * CLI-API → dort bleibt `gpu` null (VRAM-Last kommt stattdessen aus
 * Ollama `/api/ps`, siehe Load-Karte).
 */

import { execFile } from "node:child_process"
import os from "node:os"
import type { GpuInfo, HostMetrics } from "@diriz/shared"

const round = (n: number) => Math.round(n * 100) / 100

function detectNvidiaGpu(): Promise<GpuInfo | null> {
	return new Promise((resolve) => {
		execFile(
			"nvidia-smi",
			["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
			{ timeout: 1500 },
			(err, stdout) => {
				if (err || !stdout.trim()) {
					resolve(null)
					return
				}
				const [name, totalMb, usedMb] = stdout
					.trim()
					.split("\n")[0]
					.split(",")
					.map((s) => s?.trim())
				resolve({
					name: name ?? "NVIDIA GPU",
					vramTotalBytes: Number(totalMb) * 1_048_576,
					vramUsedBytes: Number(usedMb) * 1_048_576,
				})
			},
		)
	})
}

/** Aktuelle Host-Metriken — nie werfend (Routing darf daran nicht scheitern). */
export async function getHostMetrics(): Promise<HostMetrics> {
	const total = os.totalmem()
	const free = os.freemem()
	const used = Math.max(0, total - free)
	const gpu = process.platform === "linux" ? await detectNvidiaGpu() : null
	return {
		platform: process.platform,
		arch: process.arch,
		cpuCores: os.cpus().length,
		loadAvg1m: round(os.loadavg()[0]),
		ramTotalBytes: total,
		ramUsedBytes: used,
		ramUsagePct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
		gpu,
		uptimeSec: Math.round(os.uptime()),
		timestamp: new Date().toISOString(),
	}
}
