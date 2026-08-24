/**
 * Anmeldung — der Vorhang vor der Anwendung.
 *
 * Zwei Zustände in einem Bildschirm:
 *
 *  * **Erst-Einrichtung** (`configured: false`): Es gibt noch keinen Benutzer,
 *    also wird hier der erste angelegt. Bewusst kein voreingestelltes
 *    „admin/admin" — ein Standardpasswort, das jemand stehen lässt, ist
 *    schlimmer als gar keines.
 *  * **Anmeldung**: Benutzername und Passwort. Die Fehlermeldung unterscheidet
 *    nicht zwischen „gibt es nicht" und „falsches Passwort"; alles andere
 *    verriete, welche Namen existieren.
 */

import { type FormEvent, useState } from "react"
import { IconCheckCircle, IconInfo, LogoMark } from "../components/icons.js"
import { api } from "../lib/api.js"

export default function Login(props: { configured: boolean; onSignedIn: () => void | Promise<void> }) {
	const [username, setUsername] = useState("")
	const [password, setPassword] = useState("")
	const [repeat, setRepeat] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>()

	const setup = !props.configured

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setError(undefined)
		if (setup && password !== repeat) {
			setError("Die beiden Passwörter stimmen nicht überein")
			return
		}
		setBusy(true)
		try {
			await api.post(setup ? "/api/auth/setup" : "/api/auth/login", {
				username: username.trim(),
				password,
			})
			setPassword("")
			setRepeat("")
			await props.onSignedIn()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="login-screen">
			<form className="card login-card" onSubmit={(e) => void submit(e)}>
				<div className="login-brand">
					<LogoMark size={34} />
					<div>
						<div className="login-title">DiriZ</div>
						<div className="login-sub">Control Tower</div>
					</div>
				</div>

				<h1 className="login-head">{setup ? "Ersten Benutzer anlegen" : "Anmelden"}</h1>
				{setup && (
					<p className="hint">
						<IconInfo size={14} />
						<span>
							Dieser Rechner hat noch keinen Benutzer. Wer hier angelegt wird, darf DiriZ bedienen — weitere
							kommen später unter Einstellungen dazu.
						</span>
					</p>
				)}

				<label className="login-field">
					<span>Benutzername</span>
					{/* Ein Anmeldeformular ist der einzige Inhalt der Seite — hier ist
					    der Fokussprung erwartet und keine Falle für Screenreader. */}
					<input
						ref={(el) => el?.focus()}
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						autoComplete="username"
						required
					/>
				</label>

				<label className="login-field">
					<span>Passwort</span>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete={setup ? "new-password" : "current-password"}
						required
					/>
				</label>

				{setup && (
					<label className="login-field">
						<span>Passwort wiederholen</span>
						<input
							type="password"
							value={repeat}
							onChange={(e) => setRepeat(e.target.value)}
							autoComplete="new-password"
							required
						/>
					</label>
				)}

				{error && <div className="error-banner">{error}</div>}

				<button type="submit" className="btn primary login-submit" disabled={busy}>
					{busy ? "Einen Moment …" : setup ? "Benutzer anlegen und starten" : "Anmelden"}
				</button>

				{setup && (
					<p className="faint text-sm login-foot">
						<IconCheckCircle size={13} /> Das Passwort wird als scrypt-Hash gespeichert — im Klartext liegt es
						nirgends.
					</p>
				)}
			</form>
		</div>
	)
}
