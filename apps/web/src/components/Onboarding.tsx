/**
 * Erststart-Einführung (M7): 4 kurze Schritte, überspringbar.
 * Zustand in `localStorage` — einmal gesehen, nie wieder.
 */

import { useState } from "react"

const STORAGE_KEY = "diriz_onboarded"

interface Step {
	title: string
	body: string
	icon: string
}

const STEPS: Step[] = [
	{
		icon: "⚡",
		title: "Willkommen bei DiriZ",
		body: "DiriZ ist dein lokaler LLM-Routing-Hub: Er wählt automatisch das beste Modell für jede Task — lokal oder Cloud, mit Failover, Budget-Gates und Explainability.",
	},
	{
		icon: "🔌",
		title: "1 · Provider verbinden",
		body: "Füge im Tab „Provider“ deine Modelle hinzu: Ollama (lokal), LM Studio, OpenRouter oder OpenAI-kompatible Endpunkte. DiriZ erkennt die verfügbaren Modelle automatisch.",
	},
	{
		icon: "📝",
		title: "2 · Tasks starten",
		body: "Erstelle im Tab „Tasks“ eine Task mit Prompt und optionalen Einstellungen (Privatsphäre, Budget, Cost-Aware). DiriZ routet sie auf das passende Modell — du siehst jede Entscheidung nachvollziehbar.",
	},
	{
		icon: "⭐",
		title: "3 · Bewerten & optimieren",
		body: "Bewerte Ergebnisse mit 1–5 Sternen. DiriZ lernt daraus (Qualitäts-Prior) und wird mit der Zeit immer besser routen. Im Dashboard siehst du Tokens, Kosten und Ollama-Load.",
	},
]

export default function Onboarding({ onDone }: { onDone: () => void }) {
	const [step, setStep] = useState(0)
	const last = step === STEPS.length - 1

	const finish = () => {
		localStorage.setItem(STORAGE_KEY, "1")
		onDone()
	}

	return (
		<div className="onboarding-backdrop">
			<div className="card onboarding">
				<div style={{ fontSize: 40 }}>{STEPS[step].icon}</div>
				<h2>{STEPS[step].title}</h2>
				<p className="muted" style={{ lineHeight: 1.6 }}>
					{STEPS[step].body}
				</p>

				<div className="row" style={{ gap: 6, justifyContent: "center", margin: "18px 0" }}>
					{STEPS.map((s, i) => (
						<span key={s.title} className={`onboard-dot ${i === step ? "active" : ""}`} />
					))}
				</div>

				<div className="row between">
					<button type="button" className="btn" onClick={finish}>
						Überspringen
					</button>
					{last ? (
						<button type="button" className="btn primary" onClick={finish}>
							Loslegen →
						</button>
					) : (
						<button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
							Weiter →
						</button>
					)}
				</div>
			</div>
		</div>
	)
}

export function shouldShowOnboarding(): boolean {
	return localStorage.getItem(STORAGE_KEY) !== "1"
}
