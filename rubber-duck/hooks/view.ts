//! Pure layout for the duck pane: wrapping chat text into rows, laying chips
//! into rows, counting the pane's fixed rows so the input stays pinned to the
//! bottom, the chat window's slice and scroll clamp, and the scrollbar thumb.
//! No `$` here. Widths are counted in characters, which is one cell each for
//! the text the duck draws (the title's emoji is outside every measured row).

import type { Choice, Line, Tuning, Turn } from '../types'
import { fill, seconds } from './chat'

/**
 * Wraps text to `width` columns: on spaces where it can, mid-word where a
 * word is wider than the row. Each input line wraps on its own; a blank line
 * stays a blank row.
 */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const rows: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      rows.push('')
      continue
    }
    let row = ''
    for (const word of line.split(' ')) {
      let rest = word
      while (rest.length > w) {
        if (row !== '') {
          rows.push(row)
          row = ''
        }
        rows.push(rest.slice(0, w))
        rest = rest.slice(w)
      }
      if (row === '') row = rest
      else if (row.length + 1 + rest.length <= w) row = `${row} ${rest}`
      else {
        rows.push(row)
        row = rest
      }
    }
    rows.push(row)
  }
  return rows
}

/** What the chat window draws besides the turns. */
export type ChatExtras = {
  /** The pending reply, if any: who and how long so far. */
  waiting: { persona: string; model: string; ms: number } | null
}

/**
 * Every row of the conversation, oldest first: each turn's label and text
 * wrapped to `width`, replies under a gutter with code-block rows colored,
 * a blank row between turns, and the waiting line last.
 */
export function chatLines(turns: readonly Turn[], width: number, extras: ChatExtras, t: Tuning): Line[] {
  const L = t.labels
  const C = t.colors
  const lines: Line[] = []
  const modelLabel = (value?: string) => t.models.find(one => one.value === value)?.label ?? value ?? ''

  turns.forEach((turn, index) => {
    if (index > 0) lines.push([])
    if (turn.role === 'you') {
      const rows = wrap(`${L.you} ${turn.text}`, width)
      rows.forEach((row, i) => {
        if (i === 0 && row.startsWith(L.you)) {
          lines.push([{ text: L.you, color: C.you, bold: true }, { text: row.slice(L.you.length) }])
        } else lines.push([{ text: row }])
      })
    } else if (turn.role === 'duck') {
      lines.push([
        { text: L.duck, color: C.duck, bold: true },
        { text: ` ${fill(L.replyMeta, { model: modelLabel(turn.model), seconds: seconds(turn.ms ?? 0) })}`, color: C.dim },
        // The clip that played with the reply; the meta row is drawn truncated, so a long label never adds a row.
        ...(turn.clip === undefined ? [] : [{ text: ` ${fill(L.clipMeta, { clip: turn.clip })}`, color: C.clip }]),
      ])
      const inner = width - t.layout.replyGutter.length
      let isCode = false
      for (const source of turn.text.split(/\r?\n/)) {
        const isFence = source.trimStart().startsWith(t.layout.codeFence)
        const color = isCode || isFence ? C.code : undefined
        for (const row of wrap(source, inner)) {
          lines.push([{ text: t.layout.replyGutter, color: C.replyGutter }, { text: row, ...(color ? { color } : {}) }])
        }
        if (isFence) isCode = !isCode
      }
    } else {
      for (const row of wrap(`${L.error} ${turn.text}`, width)) lines.push([{ text: row, color: C.error }])
    }
  })

  if (extras.waiting !== null) {
    if (lines.length > 0) lines.push([])
    const text = fill(L.waiting, { persona: extras.waiting.persona, model: extras.waiting.model, seconds: seconds(extras.waiting.ms) })
    for (const row of wrap(text, width)) lines.push([{ text: row, color: C.busy }])
  }
  if (lines.length === 0) {
    for (const row of wrap(L.empty, width)) lines.push([{ text: row, dim: true }])
  }
  return lines
}

/**
 * Lays labels into rows `width` wide with `gap` cells between them, the way
 * the pane draws a chip row: a label that does not fit starts the next row.
 * Returns the labels' indexes per row.
 */
export function chipRows(labels: readonly string[], width: number, gap: number): number[][] {
  const rows: number[][] = []
  let used = 0
  labels.forEach((label, index) => {
    const size = label.length
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

/** A chip's drawn text: the radio mark, a space, the label. */
export function chipText(picked: boolean, label: string, t: Tuning): string {
  return `${picked ? t.labels.radioOn : t.labels.radioOff} ${label}`
}

/** The chip texts of one settings group, heading first. */
export function groupTexts(heading: string, choices: readonly Choice[], picked: string, t: Tuning): string[] {
  return [heading, ...choices.map(one => chipText(one.value === picked, one.label, t))]
}

/** The pane's sizes for a body `columns` wide and `rows` tall. */
export type PaneLayout = {
  /** Width inside the settings card's border and padding. */
  cardWidth: number
  /** Width of a chat row, inside the chat border, padding and scrollbar. */
  chatWidth: number
  /** Rows the chat window shows. */
  chatRows: number
}

/** Rows a bordered box adds around its body. Structural: the terminal's border is one row each side. */
const BORDER_ROWS = 2
/** Columns a bordered, paddingX 1 box takes from its width. Structural: border plus padding, each side. */
const BOX_COLUMNS = 4
/** Columns the scrollbar takes beside the chat: its glyph and one gap. Structural. */
const SCROLLBAR_COLUMNS = 2

/**
 * Sizes the pane so it exactly fills its body: everything but the chat is a
 * fixed number of rows (counted the way it is drawn), and the chat window
 * takes what is left. `groups` are the settings rows' chip texts, heading
 * first; `extraCardRows` counts other card rows (persona-file problems).
 */
export function paneLayout(
  columns: number,
  rows: number,
  groups: readonly (readonly string[])[],
  extraCardRows: number,
  t: Tuning,
): PaneLayout {
  const cardWidth = Math.max(1, columns - BOX_COLUMNS)
  const chatWidth = Math.max(1, columns - BOX_COLUMNS - SCROLLBAR_COLUMNS)
  const cardRows = groups.reduce((sum, group) => sum + chipRows(group, cardWidth, t.layout.chipGap).length, 0) + extraCardRows
  const header = 1
  const settings = BORDER_ROWS + cardRows
  const chatChrome = BORDER_ROWS + 1
  const input = BORDER_ROWS + 1 + t.layout.inputRows
  const footer = 1
  const fixed = header + settings + chatChrome + input + footer + t.layout.rowSlack
  return { cardWidth, chatWidth, chatRows: Math.max(t.layout.minChatRows, rows - fixed) }
}

/** The rows the chat window shows, and how far back it really is once clamped. */
export type ChatWindow = { lines: Line[]; back: number; maxBack: number; top: number }

/**
 * The slice of `lines` a window of `rows` shows when scrolled `back` rows
 * from the newest. `back` is clamped to what exists.
 */
export function chatWindow(lines: readonly Line[], rows: number, back: number): ChatWindow {
  const maxBack = Math.max(0, lines.length - rows)
  const clamped = Math.min(maxBack, Math.max(0, Math.round(back)))
  const top = Math.max(0, lines.length - rows - clamped)
  return { lines: lines.slice(top, top + rows), back: clamped, maxBack, top }
}

/** A wheel move of `by` ticks (negative toward older) as a new scroll-back. */
export function scrolled(back: number, by: number, maxBack: number, t: Tuning): number {
  return Math.min(maxBack, Math.max(0, back - by * t.layout.wheelRows))
}

/** Where the thumb sits on a track `rows` tall for `total` lines seen `rows` at a time from `top`. */
export function thumb(total: number, rows: number, top: number): { start: number; size: number } {
  if (total <= rows || rows <= 0) return { start: 0, size: Math.max(0, rows) }
  const size = Math.max(1, Math.round((rows / total) * rows))
  const maxStart = rows - size
  const start = Math.round((top / (total - rows)) * maxStart)
  return { start: Math.min(maxStart, Math.max(0, start)), size }
}

/**
 * The scroll-back a press or drag at track row `row` asks for: the track's
 * top shows the oldest lines, its bottom the newest.
 */
export function backFromTrack(row: number, rows: number, total: number): number {
  const maxBack = Math.max(0, total - rows)
  if (maxBack === 0 || rows <= 1) return 0
  const ratio = Math.min(1, Math.max(0, row / (rows - 1)))
  return Math.round((1 - ratio) * maxBack)
}
