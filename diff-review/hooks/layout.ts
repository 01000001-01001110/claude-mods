//! Pure layout for the review pane: a hunk as numbered diff rows, laying
//! labels into rows, the pane's row budget so the action bar stays pinned at
//! the bottom, the diff window's slice and scroll clamp, and the scrollbar
//! thumb and track. No `$` here.

import type { Hunk } from '../types'

/** One drawn row of a hunk: its line numbers in the old and new file, its mark and text. */
export type DiffRow = { old: number | null; new: number | null; kind: ' ' | '-' | '+'; text: string }

/** A hunk as rows, numbered from its starts; '\r' dropped for display. */
export function diffRows(hunk: Pick<Hunk, 'oldStart' | 'newStart' | 'lines'>): DiffRow[] {
  let o = hunk.oldStart
  let n = hunk.newStart
  return hunk.lines.map(line => {
    const row: DiffRow = {
      old: line.kind === '+' ? null : o,
      new: line.kind === '-' ? null : n,
      kind: line.kind,
      text: line.text.replace(/\r$/, ''),
    }
    if (line.kind !== '+') o++
    if (line.kind !== '-') n++
    return row
  })
}

/** Width of the line-number gutter for these rows: the widest number, at least 3. */
export function gutterWidth(rows: readonly DiffRow[]): number {
  const widest = rows.reduce((max, row) => Math.max(max, row.old ?? 0, row.new ?? 0), 0)
  return Math.max(3, String(widest).length)
}

/** A number right-aligned in the gutter, or blanks. */
export function num(n: number | null, width: number): string {
  return n === null ? ' '.repeat(width) : String(n).padStart(width)
}

/** Tabs as spaces, so a row's width is its length. */
export function detab(text: string, size: number): string {
  return text.replace(/\t/g, ' '.repeat(size))
}

/**
 * Lays labels into rows `width` wide with `gap` cells between them: a label
 * that does not fit starts the next row. Returns each row's label indexes.
 */
export function rowsOf(widths: readonly number[], width: number, gap: number): number[][] {
  const rows: number[][] = []
  let used = 0
  widths.forEach((size, index) => {
    const current = rows[rows.length - 1]
    if (current === undefined || used + gap + size > width) {
      rows.push([index])
      used = size
    } else {
      current.push(index)
      used += gap + size
    }
  })
  return rows
}

/** Columns a Button takes on the terminal: its label in `[ ]`. Structural: the terminal's bracket chrome. */
export function buttonWidth(label: string): number {
  return label.length + 4
}

/** Rows a bordered box adds around its body. Structural: one border row each side. */
const BORDER_ROWS = 2
/** Columns the diff box takes from the width: border and padding each side, the scrollbar and its gap. Structural. */
const DIFF_CHROME_COLUMNS = 6

/** The pane's sizes. */
export type ReviewLayout = { diffRows: number; diffWidth: number }

/**
 * Sizes the pane so it fills its body exactly: every fixed row counted the
 * way it is drawn, and the diff window takes what is left.
 * `fixedRows` is the rows of everything outside the diff box.
 */
export function reviewLayout(columns: number, rows: number, fixedRows: number, minDiffRows: number, slack: number): ReviewLayout {
  return {
    diffRows: Math.max(minDiffRows, rows - fixedRows - BORDER_ROWS - slack),
    diffWidth: Math.max(10, columns - DIFF_CHROME_COLUMNS),
  }
}

/** The window over `total` rows `rows` tall at `top`, clamped. */
export function windowAt(total: number, rows: number, top: number): { top: number; maxTop: number } {
  const maxTop = Math.max(0, total - rows)
  return { top: Math.min(maxTop, Math.max(0, Math.round(top))), maxTop }
}

/** Where the thumb sits on a track `rows` tall for `total` rows seen from `top`. */
export function thumb(total: number, rows: number, top: number): { start: number; size: number } {
  if (total <= rows || rows <= 0) return { start: 0, size: Math.max(0, rows) }
  const size = Math.max(1, Math.round((rows / total) * rows))
  const maxStart = rows - size
  const start = Math.round((top / (total - rows)) * maxStart)
  return { start: Math.min(maxStart, Math.max(0, start)), size }
}

/** The top row a press or drag at track row `row` asks for. */
export function topFromTrack(row: number, rows: number, total: number): number {
  const maxTop = Math.max(0, total - rows)
  if (maxTop === 0 || rows <= 1) return 0
  return Math.round(Math.min(1, Math.max(0, row / (rows - 1))) * maxTop)
}

/** A progress bar of reviewed hunks. */
export function progress(done: number, total: number, cells: number, full: string, empty: string): string {
  const filled = total === 0 ? cells : Math.round((done / total) * cells)
  return full.repeat(filled) + empty.repeat(cells - filled)
}

/** A row of the replay's diff: a hunk row, or a gap between two hunks of one call. */
export type StepRow = DiffRow | { gap: true }

/**
 * Every hunk of one call as rows, top to bottom, with one gap row between
 * hunks so the skipped unchanged lines read as skipped.
 */
export function stepRows(hunks: readonly Pick<Hunk, 'oldStart' | 'newStart' | 'lines'>[]): StepRow[] {
  return hunks.flatMap((hunk, i): StepRow[] => (i === 0 ? diffRows(hunk) : [{ gap: true }, ...diffRows(hunk)]))
}
