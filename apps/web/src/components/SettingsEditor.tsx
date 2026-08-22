/**
 * Editor für Model-Settings — wird pro Rechner (Provider), pro Modell
 * (Instance) und pro Task (Overrides) verwendet.
 * Reihenfolge der Auflösung: Provider ← Modell ← Task (späterer Eintrag gewinnt).
 */

import type { ModelSettings } from "@diriz/shared"

type NumKey =
	| "temperature"
	| "topP"
	| "topK"
	| "minP"
	| "maxTokens"
	| "repeatPenalty"
	| "presencePenalty"
	| "frequencyPenalty"
	| "seed"

const NUM_FIELDS: { key: NumKey; label: string; step?: string; min?: number; max?: number }[] = [
	{ key: "temperature", label: "Temperatur", step: "0.1", min: 0, max: 2 },
	{ key: "topP", label: "Top-P", step: "0.05", min: 0, max: 1 },
	{ key: "topK", label: "Top-K", min: 1 },
	{ key: "minP", label: "Min-P", step: "0.05", min: 0, max: 1 },
	{ key: "maxTokens", label: "Max-Tokens", min: 1 },
	{ key: "repeatPenalty", label: "Repeat-Penalty", step: "0.01", min: 1, max: 2 },
	{ key: "presencePenalty", label: "Presence-Penalty", step: "0.1", min: -2, max: 2 },
	{ key: "frequencyPenalty", label: "Frequency-Penalty", step: "0.1", min: -2, max: 2 },
	{ key: "seed", label: "Seed" },
]

export default function SettingsEditor({
	value,
	onChange,
}: {
	value: ModelSettings
	onChange: (next: ModelSettings) => void
}) {
	const setNum = (key: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value
		const v = raw === "" ? undefined : Number(raw)
		onChange({ ...value, [key]: v === undefined || Number.isNaN(v) ? undefined : v })
	}

	return (
		<div className="stack">
			<div
				style={{
					display: "grid",
					gap: "12px",
					gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
				}}
			>
				{NUM_FIELDS.map((f) => (
					<label key={f.key} className="field">
						{f.label}
						<input
							type="number"
							step={f.step}
							min={f.min}
							max={f.max}
							value={value[f.key] ?? ""}
							onChange={setNum(f.key)}
							placeholder="—"
						/>
					</label>
				))}
			</div>

			<label className="field">
				Stop-Wörter (kommagetrennt)
				<input
					value={(value.stop ?? []).join(", ")}
					onChange={(e) =>
						onChange({
							...value,
							stop: e.target.value
								.split(",")
								.map((x) => x.trim())
								.filter(Boolean),
						})
					}
					placeholder="z. B. ```file:"
				/>
			</label>

			<label className="field">
				System-Prompt
				<textarea
					value={value.systemPrompt ?? ""}
					onChange={(e) => onChange({ ...value, systemPrompt: e.target.value || undefined })}
					placeholder="Rolle / Anweisungen für das Modell …"
				/>
			</label>
		</div>
	)
}
