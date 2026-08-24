import { WEB_PORT } from "@diriz/shared"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Dev-Proxy: UI auf :5173, Core auf :8787 — CORS-freie Entwicklung.
export default defineConfig({
	plugins: [react()],
	// Baustand der Oberfläche. Zusammen mit `builtAt` des Cores deckt er einen
	// weiterlaufenden alten Server auf, statt ihn als „Route existiert nicht“
	// erscheinen zu lassen.
	define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
	server: {
		host: "localhost",
		port: WEB_PORT,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8787",
				changeOrigin: false,
			},
		},
	},
})
