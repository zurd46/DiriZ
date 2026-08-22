/**
 * Erststart-Einführung (M7): 4 kurze Schritte, überspringbar.
 * Zustand in `localStorage` — einmal gesehen, nie wieder.
 */

import type { ComponentType } from "react"
import { useState } from "react"
import type { IconProps } from "./icons.js"
import { IconArrowRight, IconBolt, IconPlug, IconStar, IconTasks } from "./icons.js"

const STORAGE_KEY = "diriz_onboarded"

interface Step {
	title: string
	body: string
	icon: ComponentType<IconProps>
}

const STEPS: Step[] = [
	{
		icon: IconBolt,
		title: "Willkommen bei DiriZ",
		body: "DiriZ ist dein lokaler LLM-Routing-Hub: Er wählt automatisch das beste Modell für jede Task — lokal oder Cloud, mit Failover, Budget-Gates und Explainability.",
	},
	{
		icon: IconPlug,
		title: "1 · Provider verbinden",
		body: "Füge im Tab „Provider“ deine Modelle hinzu: Ollama (lokal), LM Studio, OpenRouter oder OpenAI-kompatible Endpunkte. DiriZ erkennt die verfügbaren Modelle automatisch.",
	},
	{
		icon: IconTasks,
		title: "2 · Tasks starten",
		body: "Erstelle im Tab „Tasks“ eine Task mit Prompt und optionalen Einstellungen (Privatsphäre, Budget, Cost-Aware). DiriZ routet sie auf das passende Modell — du siehst jede Entscheidung nachvollziehbar.",
	},
	{
		icon: IconStar,
		title: "3 · Bewerten & optimieren",
		body: "Bewerte Ergebnisse mit 1–5 Sternen. DiriZ lernt daraus (Qualitäts-Prior) und wird mit der Zeit immer besser routen. Im Dashboard siehst du Tokens, Kosten und Ollama-Load.",
	},
]

export default function Onboarding({ onDone }: { onDone: () => void }) {
	const [step, setStep] = useState(0)
	const last = step === STEPS.length - 1
	const current = STEPS[step]
	const Icon = current.icon

	const finish = () => {
		localStorage.setItem(STORAGE_KEY, "1")
		onDone()
	}

	return (
		<div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Einführung">
			<div className="card onboarding">
				<span className="onboard-icon">
					<Icon size={26} />
				</span>
				<h2>{current.title}</h2>
				<p>{current.body}</p>

				<div className="onboard-dots" aria-hidden="true">
					{STEPS.map((s, i) => (
						<span key={s.title} className={`onboard-dot ${i === step ? "active" : ""}`} />
					))}
				</div>

				<div className="row between">
					<button type="button" className="btn ghost" onClick={finish}>
						Überspringen
					</button>
					<span className="faint text-sm">
						Schritt {step + 1} von {STEPS.length}
					</span>
					{last ? (
						<button type="button" className="btn primary" onClick={finish}>
							Loslegen
							<IconArrowRight size={15} />
						</button>
					) : (
						<button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
							Weiter
							<IconArrowRight size={15} />
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
