//! DiriZ Desktop (M8): minimale Tauri-2-Hülle um die Web-UI.
//!
//! Dev: `devUrl` zeigt auf den Vite-Server (http://localhost:5173).
//! Prod: `frontendDist` liefert das gebaute Web-Bundle — der lokale Core
//! läuft weiterhin separat (`npm run start`) und wird über localhost erreicht.

/// Version des Desktop-Pakets (für spätere Update-/Diagnostics-Zwecke).
#[tauri::command]
fn version() -> String {
	env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
	tauri::Builder::default()
		.invoke_handler(tauri::generate_handler![version])
		.run(tauri::generate_context!())
		.expect("error while running DiriZ desktop");
}