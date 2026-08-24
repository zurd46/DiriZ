/**
 * Kleiner Markdown-Renderer für die Dokument-Vorschau.
 *
 * Bewusst ohne Abhängigkeit und ohne `dangerouslySetInnerHTML`: Der Text wird
 * geparst und als React-Elemente ausgegeben — es kann also kein Markup aus
 * einem Dokument in die Seite gelangen. Unterstützt wird, was in `plan.md`,
 * `changelog.md` und `init.md` vorkommt: Überschriften, Listen (auch
 * nummeriert), Code-Blöcke, Zitate, Trennlinien, Absätze sowie inline
 * **fett**, *kursiv*, `Code` und Links.
 */

import type { ReactNode } from "react"

/* --------------------------------- Inline ----------------------------------- */

/** `**fett**`, `*kursiv*`, `` `code` `` und `[Text](url)` — in dieser Reihenfolge. */
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
	const out: ReactNode[] = []
	let last = 0
	let match: RegExpExecArray | null = null
	INLINE.lastIndex = 0
	// biome-ignore lint/suspicious/noAssignInExpressions: übliche exec-Schleife
	while ((match = INLINE.exec(text)) !== null) {
		if (match.index > last) {
			out.push(text.slice(last, match.index))
		}
		const token = match[0]
		const key = `${keyPrefix}-${match.index}`
		if (token.startsWith("**") || token.startsWith("__")) {
			out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
		} else if (token.startsWith("`")) {
			out.push(
				<code key={key} className="md-code">
					{token.slice(1, -1)}
				</code>,
			)
		} else if (token.startsWith("[")) {
			const split = token.indexOf("](")
			const label = token.slice(1, split)
			const href = token.slice(split + 2, -1)
			const safe = /^(https?:|mailto:)/i.test(href) ? href : undefined
			out.push(
				safe ? (
					<a key={key} href={safe} target="_blank" rel="noreferrer noopener">
						{label}
					</a>
				) : (
					label
				),
			)
		} else {
			out.push(<em key={key}>{token.slice(1, -1)}</em>)
		}
		last = match.index + token.length
	}
	if (last < text.length) {
		out.push(text.slice(last))
	}
	return out
}

/* ---------------------------------- Block ----------------------------------- */

export default function Markdown({ source }: { source: string }) {
	const lines = (source ?? "").split(/\r?\n/)
	const blocks: ReactNode[] = []

	let paragraph: string[] = []
	let list: { ordered: boolean; items: string[] } | null = null
	let quote: string[] = []
	let fence: { lang?: string; lines: string[] } | null = null

	const flushParagraph = () => {
		if (paragraph.length === 0) {
			return
		}
		const text = paragraph.join(" ")
		blocks.push(<p key={`p-${blocks.length}`}>{renderInline(text, `p${blocks.length}`)}</p>)
		paragraph = []
	}
	const flushList = () => {
		if (!list) {
			return
		}
		const items = list.items.map((item, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: Position ist hier die Identität
			<li key={i}>{renderInline(item, `li${blocks.length}-${i}`)}</li>
		))
		blocks.push(
			list.ordered ? (
				<ol key={`l-${blocks.length}`}>{items}</ol>
			) : (
				<ul key={`l-${blocks.length}`}>{items}</ul>
			),
		)
		list = null
	}
	const flushQuote = () => {
		if (quote.length === 0) {
			return
		}
		const text = quote.join(" ")
		blocks.push(<blockquote key={`q-${blocks.length}`}>{renderInline(text, `q${blocks.length}`)}</blockquote>)
		quote = []
	}
	const flushAll = () => {
		flushParagraph()
		flushList()
		flushQuote()
	}

	for (const raw of lines) {
		// Code-Fence hat Vorrang: darin wird nichts interpretiert.
		const fenceMatch = raw.match(/^\s*```(.*)$/)
		if (fenceMatch) {
			if (fence) {
				blocks.push(
					<pre key={`c-${blocks.length}`} className="md-pre">
						<code>{fence.lines.join("\n")}</code>
					</pre>,
				)
				fence = null
			} else {
				flushAll()
				fence = { lang: fenceMatch[1]?.trim() || undefined, lines: [] }
			}
			continue
		}
		if (fence) {
			fence.lines.push(raw)
			continue
		}

		if (raw.trim().length === 0) {
			flushAll()
			continue
		}

		const heading = raw.match(/^(#{1,6})\s+(.*)$/)
		if (heading) {
			flushAll()
			// Um eine Stufe tiefer als im Dokument: Die Seite hat bereits ihre
			// eigene `h1`. Ein zweites `h1` aus einer Vorschau würde die
			// Dokumentgliederung zerreissen — Screenreader melden dann zwei
			// gleichrangige Seitentitel.
			const level = heading[1]?.length ?? 1
			const text = heading[2] ?? ""
			const key = `h-${blocks.length}`
			const inner = renderInline(text, key)
			blocks.push(
				level === 1 ? (
					<h2 key={key} className="md-h1">
						{inner}
					</h2>
				) : level === 2 ? (
					<h3 key={key} className="md-h2">
						{inner}
					</h3>
				) : level === 3 ? (
					<h4 key={key}>{inner}</h4>
				) : (
					<h5 key={key}>{inner}</h5>
				),
			)
			continue
		}

		if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
			flushAll()
			blocks.push(<hr key={`hr-${blocks.length}`} />)
			continue
		}

		const bullet = raw.match(/^\s*[-*+]\s+(.*)$/)
		const numbered = raw.match(/^\s*\d+[.)]\s+(.*)$/)
		if (bullet || numbered) {
			flushParagraph()
			flushQuote()
			const ordered = numbered !== null
			const item = (bullet?.[1] ?? numbered?.[1] ?? "").trim()
			if (list && list.ordered !== ordered) {
				flushList()
			}
			list ??= { ordered, items: [] }
			list.items.push(item)
			continue
		}

		const quoted = raw.match(/^\s*>\s?(.*)$/)
		if (quoted) {
			flushParagraph()
			flushList()
			quote.push(quoted[1] ?? "")
			continue
		}

		flushList()
		flushQuote()
		paragraph.push(raw.trim())
	}

	if (fence) {
		blocks.push(
			<pre key={`c-${blocks.length}`} className="md-pre">
				<code>{fence.lines.join("\n")}</code>
			</pre>,
		)
	}
	flushAll()

	if (blocks.length === 0) {
		return <p className="faint">Dieses Dokument ist leer.</p>
	}
	return <div className="markdown">{blocks}</div>
}
