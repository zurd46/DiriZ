/**
 * T3-13 Stromkosten: Die Formel muss nachvollziehbar sein und bei
 * Abschalt-Stellung (0 Ct/kWh oder 0 Watt) exakt null liefern — sonst
 * würde eine leere Eingabe in der UI plötzlich Kosten erfinden.
 */

import { describe, expect, it } from "vitest"
import { DEFAULT_POWER_COST, electricityCostUsd } from "../src/execution/powercost.js"

describe("electricityCostUsd", () => {
	it("rechnet die Standard-Einstellungen über eine Stunde durch", () => {
		// 60 W × 3600 s = (60/1000) × (3600/3600) = 0.06 kWh
		// 0.06 kWh × (25 Ct/kWh / 100) = 0.015 USD
		expect(electricityCostUsd(DEFAULT_POWER_COST, 3600)).toBeCloseTo(0.015, 9)
	})

	it("skaliert proportional mit der Laufzeit", () => {
		const s = { electricityCentsPerKwh: 30, systemWatts: 100 }
		const eineStunde = electricityCostUsd(s, 3600)
		const dreiStunden = electricityCostUsd(s, 10800)
		// Dreifache Zeit = dreifache Kosten (innerhalb des Roundings).
		expect(dreiStunden).toBeCloseTo(eineStunde * 3, 9)
	})

	it("skaliert proportional mit der Leistung", () => {
		const hundertWatt = electricityCostUsd({ electricityCentsPerKwh: 25, systemWatts: 100 }, 3600)
		const zweihundertWatt = electricityCostUsd({ electricityCentsPerKwh: 25, systemWatts: 200 }, 3600)
		expect(zweihundertWatt).toBeCloseTo(hundertWatt * 2, 9)
	})

	it("liefert exakt null, wenn der Strompreis auf 0 steht", () => {
		expect(electricityCostUsd({ electricityCentsPerKwh: 0, systemWatts: 60 }, 3600)).toBe(0)
	})

	it("liefert exakt null, wenn die Leistung auf 0 steht", () => {
		expect(electricityCostUsd({ electricityCentsPerKwh: 25, systemWatts: 0 }, 3600)).toBe(0)
	})

	it("liefert null bei fehlender Laufzeit", () => {
		expect(electricityCostUsd(DEFAULT_POWER_COST, 0)).toBe(0)
		expect(electricityCostUsd(DEFAULT_POWER_COST, -5)).toBe(0)
	})

	it("rundet auf sechs Nachkommastellen", () => {
		// 60 W, 25 Ct/kWh, 1 s = (0.06) × (1/3600) × 0.25 = 0.0000041666… USD
		const usd = electricityCostUsd(DEFAULT_POWER_COST, 1)
		expect(usd).toBe(0.000004)
	})

	it("verwirft negative Eingaben statt einer negativen Rechnung zu erzeugen", () => {
		expect(electricityCostUsd({ electricityCentsPerKwh: -25, systemWatts: 60 }, 3600)).toBe(0)
		expect(electricityCostUsd({ electricityCentsPerKwh: 25, systemWatts: -60 }, 3600)).toBe(0)
	})
})

describe("DEFAULT_POWER_COST", () => {
	it("trägt sinnvolle, nachvollziehbare Standardwerte", () => {
		// Ein typischer Notebook-Wert und ein mittlerer EU-Strompreis —
		// beide positiv, damit die Verrechnung aus der Box greift.
		expect(DEFAULT_POWER_COST.systemWatts).toBeGreaterThan(0)
		expect(DEFAULT_POWER_COST.electricityCentsPerKwh).toBeGreaterThan(0)
	})
})
