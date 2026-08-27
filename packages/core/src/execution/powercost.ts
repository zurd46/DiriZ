/**
 * Stromkosten für lokale Modelle (T3-13).
 *
 * Ein lokaler Lauf kostet nicht nur GPU-Zeit, sondern auch Strom. Die
 * Formel ist bewusst einfach und nachvollziehbar:
 *
 *   kWh  = (Watt / 1000) × (Sekunden / 3600)
 *   USD  = kWh × (Cents pro kWh / 100)
 *
 * Der Nutzer gibt seinen Strompreis (Cents/kWh) und die Systemleistung
 * (Watt) an. Default ist ein typischer Mac-Workstation-Wert (60 W).
 * Bei 0 Cents/kWh oder 0 Watt fallen die Stromkosten auf 0 — das erlaubt
 * ein sauberes Abschalten, ohne die anderen Kosten zu berühren.
 */

export interface PowerCostSettings {
	/** Strompreis in Cents pro kWh (z. B. 25 = 25 Ct/kWh). 0 = aus. */
	electricityCentsPerKwh: number
	/** Systemleistung in Watt während einer lokalen Ausführung. 0 = aus. */
	systemWatts: number
}

export const DEFAULT_POWER_COST: PowerCostSettings = {
	electricityCentsPerKwh: 25,
	systemWatts: 60,
}

/**
 * Stromkosten in USD für eine lokale Ausführung.
 *
 * @param settings Strompreis + Leistung (Defaults bei Fehlen).
 * @param durationSec Dauer der Ausführung in Sekunden.
 * @returns USD, gerundet auf 6 Nachkommastellen (0.000001 = 0.0001 Ct).
 */
export function electricityCostUsd(settings: PowerCostSettings, durationSec: number): number {
	if (settings.electricityCentsPerKwh <= 0 || settings.systemWatts <= 0 || durationSec <= 0) {
		return 0
	}
	const kwh = (settings.systemWatts / 1000) * (durationSec / 3600)
	const usd = kwh * (settings.electricityCentsPerKwh / 100)
	return Math.round(usd * 1_000_000) / 1_000_000
}
