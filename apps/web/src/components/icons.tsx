/**
 * Zentrale Icon-Bibliothek — **ausschließlich SVG**, keine Emoji/Unicode-Glyphen.
 *
 * Alle Icons teilen dasselbe 24×24-Raster, zeichnen mit `currentColor` und
 * erben die Größe über die Prop `size` (Default 16 px). Dadurch passen sie
 * sich Buttons, Badges und Karten automatisch an.
 *
 * Konvention: Icons sind rein dekorativ (`aria-hidden`), die zugängliche
 * Beschriftung liefert immer der umgebende Button/Link. Nur wenn ein Icon
 * alleine steht, bekommt der Button ein `aria-label`.
 */

import type { SVGProps } from "react"

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
	/** Kantenlänge in Pixeln (quadratisch). Default: 16. */
	size?: number
}

function Svg({
	size = 16,
	children,
	strokeWidth = 1.75,
	...rest
}: IconProps & { children: React.ReactNode }) {
	return (
		<svg
			className="icon"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			{children}
		</svg>
	)
}

/* ------------------------------- Marke / Logo ------------------------------- */

/** DiriZ-Signet: gerichteter Knoten-Hub — ein Eingang, drei geroutete Ziele. */
export function LogoMark({ size = 28, ...rest }: IconProps) {
	return (
		<svg
			className="icon"
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			<title>DiriZ</title>
			<rect x="1" y="1" width="30" height="30" rx="9" fill="url(#dz-g)" />
			<path
				d="M9 16h4m0 0 5-5m-5 5 5 5"
				stroke="#fff"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.95"
			/>
			<circle cx="22" cy="9" r="2.6" fill="#fff" />
			<circle cx="22" cy="23" r="2.6" fill="#fff" opacity="0.75" />
			<circle cx="8.5" cy="16" r="2.2" fill="#fff" opacity="0.55" />
			<defs>
				<linearGradient id="dz-g" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
					<stop stopColor="#5b8cff" />
					<stop offset="1" stopColor="#8b5cf6" />
				</linearGradient>
			</defs>
		</svg>
	)
}

/* ------------------------------- Navigation --------------------------------- */

export function IconDashboard(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="3" y="3" width="7.5" height="8.5" rx="2" />
			<rect x="13.5" y="3" width="7.5" height="5" rx="2" />
			<rect x="3" y="14.5" width="7.5" height="6.5" rx="2" />
			<rect x="13.5" y="11" width="7.5" height="10" rx="2" />
		</Svg>
	)
}

export function IconServer(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="3" y="4" width="18" height="7" rx="2" />
			<rect x="3" y="13" width="18" height="7" rx="2" />
			<path d="M7 7.5h.01M7 16.5h.01" />
		</Svg>
	)
}

export function IconAgents(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="4" y="8" width="16" height="11" rx="3" />
			<path d="M12 4.5V8M8.5 13v1.5M15.5 13v1.5" />
			<circle cx="12" cy="3.5" r="1.2" />
			<path d="M2.5 12.5v3M21.5 12.5v3" />
		</Svg>
	)
}

export function IconTasks(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 6h9M4 12h9M4 18h6" />
			<path d="m15.5 16.5 2 2 4-4.5" />
		</Svg>
	)
}

export function IconWorkspace(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8h5.6A2.5 2.5 0 0 1 21 10.5v6A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
		</Svg>
	)
}

export function IconLogs(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="m7 9.5 2.5 2.5L7 14.5M12.5 15h4.5" />
		</Svg>
	)
}

export function IconSettings(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
			<circle cx="16" cy="7" r="2.2" />
			<circle cx="8" cy="17" r="2.2" />
		</Svg>
	)
}

/* -------------------------------- Aktionen ---------------------------------- */

export function IconPlus(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M12 5v14M5 12h14" />
		</Svg>
	)
}

export function IconEdit(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
			<path d="m14.5 6.5 3 3" />
		</Svg>
	)
}

export function IconTrash(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 7h16M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7" />
			<path d="M6.5 7 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" />
			<path d="M10.5 11v6M13.5 11v6" />
		</Svg>
	)
}

export function IconClose(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M6 6 18 18M18 6 6 18" />
		</Svg>
	)
}

export function IconCheck(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="m4.5 12.5 5 5 10-11" />
		</Svg>
	)
}

export function IconCheckCircle(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="m8 12.3 2.7 2.7L16.2 9" />
		</Svg>
	)
}

export function IconXCircle(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="m9 9 6 6M15 9l-6 6" />
		</Svg>
	)
}

export function IconAlert(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
			<path d="M12 9.5v4M12 17h.01" />
		</Svg>
	)
}

export function IconInfo(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5.5M12 7.8h.01" />
		</Svg>
	)
}

export function IconPlay(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
		</Svg>
	)
}

export function IconStop(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="6.5" y="6.5" width="11" height="11" rx="2" />
		</Svg>
	)
}

export function IconRefresh(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" />
			<path d="M4 12.5a8 8 0 0 0 13.7 5.2L20 15.5" />
			<path d="M4 4v4.5h4.5M20 20v-4.5h-4.5" />
		</Svg>
	)
}

export function IconSearch(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="11" cy="11" r="6.5" />
			<path d="m16 16 4.5 4.5" />
		</Svg>
	)
}

export function IconDownload(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
			<path d="M4.5 19h15" />
		</Svg>
	)
}

export function IconUpload(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
			<path d="M4.5 19h15" />
		</Svg>
	)
}

export function IconSliders(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M5 20V13M5 9V4M12 20v-9M12 7V4M19 20v-4M19 12V4" />
			<path d="M2.5 13h5M9.5 11h5M16.5 16h5" />
		</Svg>
	)
}

export function IconDoc(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
			<path d="M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4" />
			<path d="M8.5 13h7M8.5 16.5h4.5" />
		</Svg>
	)
}

export function IconFile(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
			<path d="M13.5 3v4a1.5 1.5 0 0 0 1.5 1.5h4" />
		</Svg>
	)
}

export function IconPin(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="5.5" r="2.5" />
			<path d="M12 8v12M6 13.5a6 6 0 0 0 12 0" />
			<path d="M4 13.5h4M16 13.5h4" />
		</Svg>
	)
}

export function IconSwarm(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="5" r="2.4" />
			<circle cx="5.5" cy="17" r="2.4" />
			<circle cx="18.5" cy="17" r="2.4" />
			<path d="M10.4 6.7 7 14.9M13.6 6.7 17 14.9M8 17.5h8" />
		</Svg>
	)
}

export function IconStar({ filled, ...p }: IconProps & { filled?: boolean }) {
	return (
		<Svg {...p} fill={filled ? "currentColor" : "none"}>
			<path d="m12 3.6 2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85L12 3.6Z" />
		</Svg>
	)
}

export function IconArrowRight(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M5 12h14M13 6l6 6-6 6" />
		</Svg>
	)
}

export function IconChevronRight(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="m9 5 7 7-7 7" />
		</Svg>
	)
}

export function IconChevronDown(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="m5 9 7 7 7-7" />
		</Svg>
	)
}

export function IconRoute(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="6" cy="18.5" r="2.5" />
			<circle cx="18" cy="5.5" r="2.5" />
			<path d="M15.5 5.5H10a3.5 3.5 0 0 0 0 7h4a3.5 3.5 0 0 1 0 7H8.5" />
		</Svg>
	)
}

export function IconFailover(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M3.5 8.5h12a4 4 0 0 1 0 8H9" />
			<path d="m6.5 5.5-3 3 3 3M11.5 13.5l-3 3 3 3" />
		</Svg>
	)
}

export function IconTool(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M15.5 3.5a5 5 0 0 0-5.9 6.6L3.8 15.9a2.2 2.2 0 0 0 3.1 3.1l5.8-5.8a5 5 0 0 0 6.6-5.9l-3 3-2.7-2.7 3-3Z" />
		</Svg>
	)
}

export function IconBolt(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
		</Svg>
	)
}

export function IconPlug(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M9 2.5V7M15 2.5V7" />
			<path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0V7Z" />
			<path d="M12 16v5.5" />
		</Svg>
	)
}

export function IconLayers(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="m12 3 9 5-9 5-9-5 9-5Z" />
			<path d="m3 13.5 9 5 9-5" />
		</Svg>
	)
}

export function IconTokens(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
		</Svg>
	)
}

export function IconCost(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="M15 9.3c-.7-1-1.8-1.6-3-1.6-1.9 0-3.2 1-3.2 2.4s1.3 2.4 3.2 2.4 3.2.9 3.2 2.4-1.3 2.4-3.2 2.4c-1.2 0-2.3-.6-3-1.6M12 5.8v1.9M12 16.3v1.9" />
		</Svg>
	)
}

export function IconChart(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 20v-9M10 20V5M16 20v-6M3 20h18" />
		</Svg>
	)
}

export function IconCpu(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
			<path d="M10 10h4v4h-4z" />
			<path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" />
		</Svg>
	)
}

export function IconMemory(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="2.5" y="7" width="19" height="10" rx="2" />
			<path d="M6 11v2M10 11v2M14 11v2M18 11v2" />
		</Svg>
	)
}

export function IconGpu(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="2.5" y="6" width="19" height="12" rx="2.5" />
			<circle cx="9" cy="12" r="3" />
			<path d="M15 10h4M15 14h4" />
		</Svg>
	)
}

export function IconClock(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5.3l3.2 2" />
		</Svg>
	)
}

export function IconQueue(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="3" y="4" width="18" height="4.5" rx="1.5" />
			<rect x="3" y="11" width="18" height="4.5" rx="1.5" />
			<path d="M6 19.5h12" />
		</Svg>
	)
}

export function IconDiff(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M7 3.5v7M3.5 7h7" />
			<path d="M13.5 17h7" />
			<path d="M7 14.5v6M17 3.5v6" />
		</Svg>
	)
}

export function IconEye(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
			<circle cx="12" cy="12" r="3" />
		</Svg>
	)
}

export function IconKey(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="8" cy="16" r="4" />
			<path d="m10.9 13.1 8.1-8.1M17 7l2.2 2.2M14.6 9.4l2.2 2.2" />
		</Svg>
	)
}

export function IconHeart(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M3 11h3.5l2-4 3 8 2.5-5 1.5 3H21" />
		</Svg>
	)
}

export function IconRadar(p: IconProps) {
	return (
		<Svg {...p}>
			<circle cx="12" cy="12" r="9" />
			<circle cx="12" cy="12" r="4.5" />
			<path d="M12 12 18.5 7" />
		</Svg>
	)
}

export function IconPower(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M12 3.5v7.5" />
			<path d="M7 6.4a7.5 7.5 0 1 0 10 0" />
		</Svg>
	)
}

export function IconMenu(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M4 7h16M4 12h16M4 17h16" />
		</Svg>
	)
}

export function IconTemplate(p: IconProps) {
	return (
		<Svg {...p}>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M3 9h18M9 9v11" />
		</Svg>
	)
}

export function IconShield(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="M12 3 5 5.8v5.4c0 4.3 2.9 8.2 7 9.3 4.1-1.1 7-5 7-9.3V5.8L12 3Z" />
		</Svg>
	)
}

export function IconSparkles(p: IconProps) {
	return (
		<Svg {...p}>
			<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
			<path d="m18.5 15.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
		</Svg>
	)
}
