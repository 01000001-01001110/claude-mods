//! Layout arithmetic the deck draws by: gauge cells, how many pieces of a line fit, marks per row on each surface,
//! the log's share of the rows, the legend that fits, card titles over two rows, and the two checks on the
//! surface itself (which module faulted where, whether Text takes the monospaced face). No `$`, no elements.

import { tuning as T } from '../data/agent-roster'
import type { Card } from '../types'
import { clip } from './words'

/** A gauge of `width` cells for `pct` percent: the lit cells and the rest. A reading that is not a number lights none. */
export function meter(pct: number, width: number): { on: string; off: string } {
  const raw = Math.round(width * (pct / 100))
  const lit = Number.isFinite(raw) ? Math.min(width, Math.max(0, raw)) : 0
  return { on: T.glyphs.gaugeOn.repeat(lit), off: T.glyphs.gaugeOff.repeat(width - lit) }
}

/** Cells a string takes in a terminal: one per character. */
export function cells(s: string): number {
  return Array.from(s).length
}

/**
 * How many pieces of a line fit in `room` cells, from the start. Each piece takes its `indent` and then its
 * `width`, and pieces sit `gap` cells apart. The pieces past the first that does not fit are left out.
 */
export function piecesInRoom(pieces: readonly { width: number; indent?: number }[], room: number, gap: number): number {
  let used = 0
  let fitted = 0
  for (const p of pieces) {
    used += (fitted === 0 ? 0 : gap) + (p.indent ?? 0) + p.width
    if (used > room) break
    fitted += 1
  }
  return fitted
}

/** The legend items that fit on one row of `width` cells, in order, each with the data's padding. */
export function legendThatFits<I extends { label: string }>(items: I[], width: number): I[] {
  let left = width
  let count = 0
  for (const item of items) {
    left -= item.label.length + T.sizes.legendItemPad
    if (left < 0) break
    count += 1
  }
  return items.slice(0, count)
}

/** The marks a row of `cellCount` columns holds: one a cell in a terminal, fewer where a surface draws them wider. */
export function marksFor(cellCount: number, isTerminal: boolean): number {
  if (isTerminal) return cellCount
  return Math.floor(cellCount / T.sizes.graphicalMarkCells)
}

/** The log's rows: what the rest of the deck leaves, held between the data's minimum and maximum. */
export function logBudget(bodyRows: number, used: number): number {
  const Z = T.sizes
  const left = bodyRows - used - Z.logRowsSpare
  return Math.min(Z.logRowsMax, Math.max(Z.logRowsMin, left))
}

/** A card's title: the task in the agent's words, its type when it gave none. */
export function cardLabel(c: Card): string {
  return c.description ? c.description : c.type
}

/** A title over two rows, broken at a word: up to `first` cells, then the rest cut to `rest`. */
export function twoRowTitle(title: string, first: number, rest: number): [string, string] {
  const flat = title.replace(/\s+/g, ' ').trim()
  if (flat.length <= first) return [flat, '']
  const space = flat.lastIndexOf(' ', first)
  const breakAt = space > 0 ? space : first
  return [flat.slice(0, breakAt).trim(), clip(flat.slice(breakAt), rest)]
}

/** A surface module's fault key, `desktop:rail.tsx`, whichever separator the module path uses. */
export function faultId(surface: string, module: string): string {
  const parts = module.split(/[\\/]/)
  return `${surface}:${parts[parts.length - 1]}`
}

/**
 * Whether the engine draws Text's `mono`: its release (`base`, else `version`) is the data's `monoSince` or
 * later. False when there is no version or it is not spelled as a release.
 */
export function hasMonoFace(v: { version?: string; base?: string } | null | undefined): boolean {
  const release = (v?.base ?? v?.version ?? '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!release) return false
  const have = release.slice(1, 4).map(Number)
  for (let i = 0; i < 3; i += 1) {
    const mine = have[i] as number
    const floor = T.monoSince[i] as number
    if (mine > floor) return true
    if (mine < floor) return false
  }
  return true
}

/** An agent's accent from `accents`, the same for an id every time; `fallback` when the list is empty. */
export function accentFor(id: string, accents: readonly string[], fallback: string): string {
  if (accents.length === 0) return fallback
  let hash = 0
  for (const ch of id) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003
  return accents[hash % accents.length] as string
}
