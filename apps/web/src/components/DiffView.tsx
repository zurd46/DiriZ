/**
 * Diff-Darstellung (M10) — zeigt die Änderungen einer Task Datei für Datei,
 * mit alter und neuer Zeilennummer, wie man es von GitHub kennt.
 *
 * Der Patch wird bereits im Core geparst (`git/diff.ts`); hier wird nur noch
 * gezeichnet. Dateien lassen sich einzeln ein- und ausklappen — bei einem
 * großen Umbau will niemand tausende Zeilen auf einmal sehen.
 */

import type { ChangeKind, FileDiff } from "@diriz/shared"
import { useState } from "react"
import { IconChevronDown, IconChevronRight, IconFile } from "./icons.js"

const KIND_LABEL: Record<ChangeKind, string> = {
	added: "neu",
	modified: "geändert",
	deleted: "gelöscht",
	renamed: "umbenannt",
	untracked: "neu",
}

const KIND_CLASS: Record<ChangeKind, string> = {
	added: "ok",
	modified: "warn",
	deleted: "err",
	renamed: "info",
	untracked: "ok",
}

/** Zahl mit Vorzeichen — „+12" / „−3" für die Zeilenbilanz. */
function signed(value: number, sign: "+" | "−"): string | null {
	return value > 0 ? `${sign}${value}` : null
}

export default function DiffView({
	files,
	defaultOpen = 3,
}: {
	files: FileDiff[]
	/** So viele Dateien sind anfangs aufgeklappt. */
	defaultOpen?: number
}) {
	const [closed, setClosed] = useState<Set<string>>(new Set())
	const [openedExtra, setOpenedExtra] = useState<Set<string>>(new Set())

	if (files.length === 0) {
		return <p className="faint">Keine Änderungen gegenüber dem Basis-Branch.</p>
	}

	const isOpen = (file: FileDiff, index: number) =>
		openedExtra.has(file.path) || (index < defaultOpen && !closed.has(file.path))

	const toggle = (file: FileDiff, index: number) => {
		if (isOpen(file, index)) {
			setOpenedExtra((prev) => {
				const next = new Set(prev)
				next.delete(file.path)
				return next
			})
			setClosed((prev) => new Set(prev).add(file.path))
		} else {
			setClosed((prev) => {
				const next = new Set(prev)
				next.delete(file.path)
				return next
			})
			setOpenedExtra((prev) => new Set(prev).add(file.path))
		}
	}

	return (
		<div className="diff-list">
			{files.map((file, index) => {
				const open = isOpen(file, index)
				return (
					<div key={file.path} className="diff-file">
						<button type="button" className="diff-file-head" onClick={() => toggle(file, index)}>
							{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
							<IconFile size={14} />
							<span className="diff-path mono">
								{file.previousPath && file.previousPath !== file.path && (
									<span className="faint">{file.previousPath} → </span>
								)}
								{file.path}
							</span>
							<span className={`badge ${KIND_CLASS[file.kind]}`}>{KIND_LABEL[file.kind]}</span>
							<span className="diff-stat">
								{signed(file.additions, "+") && <span className="add">{signed(file.additions, "+")}</span>}
								{signed(file.deletions, "−") && <span className="del">{signed(file.deletions, "−")}</span>}
							</span>
						</button>

						{open && (
							<div className="diff-body">
								{file.binary ? (
									<p className="faint" style={{ padding: "var(--sp-3)" }}>
										Binärdatei — kein Zeilenvergleich möglich.
									</p>
								) : (
									file.hunks.map((hunk) => (
										<table key={hunk.header} className="diff-table">
											<tbody>
												<tr className="diff-hunk">
													<td colSpan={3}>{hunk.header}</td>
												</tr>
												{hunk.lines.map((line, i) => (
													<tr
														// biome-ignore lint/suspicious/noArrayIndexKey: Zeilenposition ist die Identität
														key={`${hunk.header}-${i}`}
														className={`diff-line ${line.kind}`}
													>
														<td className="diff-num">{line.oldLine ?? ""}</td>
														<td className="diff-num">{line.newLine ?? ""}</td>
														<td className="diff-text">
															<span className="diff-marker">
																{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
															</span>
															{line.text}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									))
								)}
								{file.truncated && (
									<p className="faint" style={{ padding: "var(--sp-2) var(--sp-3)" }}>
										Diff gekürzt — die Datei ist sehr groß.
									</p>
								)}
							</div>
						)}
					</div>
				)
			})}
		</div>
	)
}
