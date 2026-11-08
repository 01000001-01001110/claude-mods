//! Pure replay rules for diff-review: which calls a replay plays (all, one
//! turn, one file), the turns there were, where the step strip's window sits,
//! how a play tick moves, what an edit call would have written (so a denied
//! or failed call still shows its diff), and the band's counts. No `$` here.
//!
//! The replay is a second cursor over the same change list review uses: it
//! walks calls in the order they ended, one call (all its hunks) per step,
//! while review walks the hunks still waiting. Keeping them apart is what
//! lets Play run through a turn without touching where review stands.

import type { Change, Tuning } from '../types'
import { fill } from './review'

/** What a replay plays, parsed from the `scope` state string. */
export type Scope = { kind: 'all' } | { kind: 'turn'; turnId: string } | { kind: 'file'; file: string }

/** Prefixes of the scope string. Structural: they address state, a person never reads them. */
const TURN_PREFIX = 'turn:'
const FILE_PREFIX = 'file:'

/** The scope string for a scope; the inverse of `parseScope`. */
export function scopeKey(scope: Scope): string {
  if (scope.kind === 'turn') return TURN_PREFIX + scope.turnId
  if (scope.kind === 'file') return FILE_PREFIX + scope.file
  return 'all'
}

/** The scope a state string names; anything unknown plays everything. */
export function parseScope(key: string): Scope {
  if (key.startsWith(TURN_PREFIX)) return { kind: 'turn', turnId: key.slice(TURN_PREFIX.length) }
  if (key.startsWith(FILE_PREFIX)) return { kind: 'file', file: key.slice(FILE_PREFIX.length) }
  return { kind: 'all' }
}

/** The calls a scope plays, in the order they ended (the list is kept in that order). */
export function stepsIn(changes: readonly Change[], scope: Scope): Change[] {
  if (scope.kind === 'turn') return changes.filter(change => change.turnId === scope.turnId)
  if (scope.kind === 'file') return changes.filter(change => change.file === scope.file)
  return [...changes]
}

/** One turn that has calls: its id, its number, and how many calls. */
export type TurnInfo = { turnId: string; turn: number; steps: number }

/** The turns with calls, oldest first. */
export function turnsOf(changes: readonly Change[]): TurnInfo[] {
  const seen = new Map<string, TurnInfo>()
  for (const change of changes) {
    const known = seen.get(change.turnId)
    if (known) known.steps += 1
    else seen.set(change.turnId, { turnId: change.turnId, turn: change.turn, steps: 1 })
  }
  return [...seen.values()]
}

/** A step index kept inside `[0, total)`; 0 when there are none. */
export function clampStep(step: number, total: number): number {
  return total <= 0 ? 0 : Math.min(total - 1, Math.max(0, Math.round(step)))
}

/**
 * Where one play tick leaves the replay: the next step, still playing while
 * more follow; reaching the last step stops it there, so Play shows again
 * the moment there is nothing left to play.
 */
export function playTick(step: number, total: number): { step: number; isPlaying: boolean } {
  const here = clampStep(step, total)
  const next = Math.min(here + 1, Math.max(0, total - 1))
  return { step: next, isPlaying: next < total - 1 }
}

/** Where pressing Play starts: from the top when the replay already sits on its last step. */
export function playFrom(step: number, total: number): number {
  const here = clampStep(step, total)
  return here >= total - 1 ? 0 : here
}

/**
 * The slice of step cells drawn, at most `max` wide, keeping `at` inside it
 * and as near the middle as the ends allow.
 */
export function stripWindow(total: number, at: number, max: number): { from: number; to: number } {
  const width = Math.max(1, Math.min(total, max))
  const from = Math.min(Math.max(0, total - width), Math.max(0, at - Math.floor(width / 2)))
  return { from, to: from + width }
}

/** Lines added and removed across a change's hunks. */
export function lineCounts(change: Pick<Change, 'hunks'>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === '+') added += 1
      else if (line.kind === '-') removed += 1
    }
  }
  return { added, removed }
}

/** The input fields an edit call may carry; only the ones read here. */
export type EditInput = {
  content?: unknown
  old_string?: unknown
  new_string?: unknown
  replace_all?: unknown
  edits?: unknown
}

/** One replacement of an Edit or a MultiEdit, or null when the fields are not strings. */
function replacement(raw: unknown): { from: string; to: string; isAll: boolean } | null {
  const one = raw as EditInput | null
  if (typeof one?.old_string !== 'string' || typeof one.new_string !== 'string') return null
  return { from: one.old_string, to: one.new_string, isAll: one.replace_all === true }
}

/** The replacements an Edit or MultiEdit asks for, in order; null for any other tool or a malformed input. */
function replacements(tool: string, input: EditInput): { from: string; to: string; isAll: boolean }[] | null {
  if (tool === 'Edit') {
    const one = replacement(input)
    return one ? [one] : null
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const all = input.edits.map(replacement)
    return all.every(one => one !== null) ? (all as { from: string; to: string; isAll: boolean }[]) : null
  }
  return null
}

/**
 * The text the call would have left in the file, worked out from the file
 * before it and the call's own input: a Write's content, or each Edit or
 * MultiEdit replacement applied in turn. Null when it cannot be known: an
 * old text not in the file, an empty old text on a file that has one, a
 * tool whose effect is not plain text (NotebookEdit).
 */
export function intendedText(tool: string, input: EditInput, before: string | null): string | null {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : null
  const steps = replacements(tool, input)
  if (steps === null) return null
  let text = before ?? ''
  for (const { from, to, isAll } of steps) {
    // An empty old text only means "create" on an empty or missing file, as the Edit tool reads it.
    if (from === '') {
      if (text !== '') return null
      text = to
      continue
    }
    if (!text.includes(from)) return null
    text = isAll ? text.split(from).join(to) : text.replace(from, () => to)
  }
  return text
}

/**
 * The call's own before and after text, for a failed Edit or MultiEdit
 * whose effect on the file cannot be worked out: the old strings against
 * the new ones, joined. Null for any other tool.
 */
export function snippetOf(tool: string, input: EditInput): { before: string; after: string } | null {
  const steps = replacements(tool, input)
  if (steps === null || steps.length === 0) return null
  return { before: steps.map(one => one.from).join('\n'), after: steps.map(one => one.to).join('\n') }
}

/** The edited path of a call: the first of `keys` that holds a string. */
export function pathOf(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** A reason cut to `max` characters on one line, with an ellipsis when cut. */
export function cutReason(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`
}

/** The newest file whose path holds `query` (any case, either slash), or null. */
export function findFile(changes: readonly Change[], query: string): string | null {
  const want = query.trim().toLowerCase().replace(/\\/g, '/')
  for (let i = changes.length - 1; i >= 0; i--) {
    const file = changes[i]!.file
    if (file.toLowerCase().replace(/\\/g, '/').includes(want)) return file
  }
  return null
}

/** The band's numbers for one turn: its calls, the hunks still waiting, the calls that did not land. */
export function turnCounts(changes: readonly Change[], turnId: string): { steps: number; pending: number; blocked: number } {
  const own = changes.filter(change => change.turnId === turnId)
  return {
    steps: own.length,
    pending: own.reduce((sum, change) => sum + (change.outcome === 'landed' ? change.hunks.filter(hunk => hunk.status === 'pending').length : 0), 0),
    blocked: own.filter(change => change.outcome !== 'landed').length,
  }
}

/** The label of a scope, as the header and the command reply show it. */
export function scopeLabel(scope: Scope, changes: readonly Change[], t: Tuning, short: (file: string) => string): string {
  const Y = t.replayText
  if (scope.kind === 'file') return fill(Y.scopeFile, { file: short(scope.file) })
  if (scope.kind === 'turn') {
    const turn = changes.find(change => change.turnId === scope.turnId)?.turn ?? 0
    return turn === 0 ? Y.scopeNoTurn : fill(Y.scopeTurn, { n: turn })
  }
  return Y.scopeAll
}
