/**
 * Erzeugt die Quell-Ikone für den Tauri-Wrapper (1024×1024 PNG) —
 * ohne externe Abhängigkeiten (Node-zlib + handgerollte PNG-Chunks).
 * Design: dunkler Grundton, indigo „Radar“-Kreis mit Akzentpunkt.
 * Danach: `npx tauri icon src-tauri/icons/source.png` für alle Formate.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const SIZE = 1024
const BG = [15, 23, 42] // slate-900
const RING = [99, 102, 241] // indigo-500
const DOT = [226, 232, 240] // slate-200

// Pixel-Bitmap (RGBA) — geometrisches Design per Distanzprüfung.
const px = Buffer.alloc(SIZE * SIZE * 4)
const c = SIZE / 2
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		const dx = x - c + 0.5
		const dy = y - c + 0.5
		const d = Math.sqrt(dx * dx + dy * dy)
		let color = BG
		if (d > 300 && d < 420) {
			color = RING // äußerer Ring
		} else if (d > 180 && d < 260) {
			color = [79, 70, 229] // indigo-600, innerer Ring
		} else if (d < 90) {
			color = DOT // Zentrumspunkt
		}
		const i = (y * SIZE + x) * 4
		px[i] = color[0]
		px[i + 1] = color[1]
		px[i + 2] = color[2]
		px[i + 3] = 255
	}
}

// PNG-Chunks (IHDR/IDAT/IEND) mit CRC32.
const crcTable = new Int32Array(256).map((_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	}
	return c
})
function crc32(buf) {
	let c = -1
	for (const b of buf) {
		c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
	}
	return (c ^ -1) >>> 0
}
function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, "ascii"), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // Bit-Tiefe
ihdr[9] = 6 // RGBA
// Scanlines: pro Zeile Filter-Byte 0 + Pixel.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
	raw[y * (SIZE * 4 + 1)] = 0
	px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
])

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, "..", "src-tauri", "icons")
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, "source.png")
fs.writeFileSync(out, png)
process.stdout.write(`✓ Icon-Quelle geschrieben: ${out} (${png.length} Bytes)\n`)
