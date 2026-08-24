import { WEB_PORT } from "@diriz/shared"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Dev-Proxy: UI auf :5173, Core auf :8787 — CORS-freie Entwicklung.
export default defineConfig({
	plugins: [react()],
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
