//! Pure review rules for diff-review: turning an edit into a change record,
//! addressing hunks (landed changes only), moving the cursor, setting
//! statuses, counting, and the text the pane and the agent read. No `$` here.

import type { Change, Hunk, HunkStatus, Tuning } from '../types'
import { diffLines, hunksOf, oldRange, splitLines, unified } from './diff'

/** A hunk with the change it belongs to, in review order. */
export type Item = { change: Change; hunk: Hunk; key: string }

/** A hunk's address: `<change id>:<hunk id>`. */
export function keyOf(change: Pick<Change, 'id'>, hunk: Pick<Hunk, 'id'>): string {
  return `${change.id}:${hunk.id}`
}

/** Everything about a change but its hunks and whether the file is new: what the caller knows of the call. */
export type ChangeMeta = Omit<Change, 'hunks' | 'isNew'>

/**
 * The change record for one edit, or null when nothing changed. Hunk ids
 * count within the change; the change id is the caller's. A landed change's
 * hunks wait for review; a denied or failed one's are kept for the replay
 * only, so they are born 'kept' and never counted (`items` skips them).
 */
export function changeOf(meta: ChangeMeta, before: string | null, after: string, t: Tuning): Change | null {
  const old = before ?? ''
  if (old === after) return null
  const ops = diffLines(splitLines(old), splitLines(after), t.maxDiffLines)
  const status: HunkStatus = meta.outcome === 'landed' ? 'pending' : 'kept'
  const hunks = hunksOf(ops, t.contextLines).map((hunk, i) => ({ ...hunk, id: String(i + 1), status }))
  if (hunks.length === 0) return null
  return { ...meta, isNew: before === null, hunks }
}

/** The changes that landed: the only ones review, keep and undo act on. */
export function landed(changes: readonly Change[]): Change[] {
  return changes.filter(change => change.outcome === 'landed')
}

/** Every reviewable hunk in review order: landed changes oldest first, hunks top to bottom. */
export function items(changes: readonly Change[]): Item[] {
  return landed(changes).flatMap(change => change.hunks.map(hunk => ({ change, hunk, key: keyOf(change, hunk) })))
}

/** The item at `cursor`, else the first pending one, else the last one; null when there are none. */
export function current(changes: readonly Change[], cursor: string): Item | null {
  const all = items(changes)
  return all.find(item => item.key === cursor) ?? all.find(item => item.hunk.status === 'pending') ?? all[all.length - 1] ?? null
}

/** The key `step` places from `cursor` (wrapping), or '' when there are none. */
export function move(changes: readonly Change[], cursor: string, step: number): string {
  const all = items(changes)
  if (all.length === 0) return ''
  const at = Math.max(0, all.findIndex(item => item.key === (current(changes, cursor)?.key ?? '')))
  return all[(((at + step) % all.length) + all.length) % all.length]!.key
}

/** The next pending item after `cursor` (wrapping), or `cursor` itself when none is pending. */
export function nextPending(changes: readonly Change[], cursor: string): string {
  const all = items(changes)
  const at = all.findIndex(item => item.key === cursor)
  for (let step = 1; step <= all.length; step++) {
    const item = all[(at + step + all.length) % all.length]
    if (item !== undefined && item.hunk.status === 'pending') return item.key
  }
  return cursor
}

/** The changes with the hunks `keys` set to `status`. Other hunks and changes are untouched. */
export function withStatus(changes: readonly Change[], keys: readonly string[], status: HunkStatus): Change[] {
  const set = new Set(keys)
  return changes.map(change => ({
    ...change,
    hunks: change.hunks.map(hunk => (set.has(keyOf(change, hunk)) ? { ...hunk, status } : hunk)),
  }))
}

/** Keys of the pending hunks, optionally only in one file. */
export function pendingKeys(changes: readonly Change[], file?: string): string[] {
  return items(changes)
    .filter(item => item.hunk.status === 'pending' && (file === undefined || item.change.file === file))
    .map(item => item.key)
}

/** Counts for the summary and the status line. */
export function counts(changes: readonly Change[]): { files: number; hunks: number } & Record<HunkStatus, number> {
  const all = items(changes)
  const by = (status: HunkStatus) => all.filter(item => item.hunk.status === status).length
  return {
    files: new Set(landed(changes).map(change => change.file)).size,
    hunks: all.length,
    pending: by('pending'),
    kept: by('kept'),
    undone: by('undone'),
    conflict: by('conflict'),
  }
}

/** The changes with every fully reviewed change dropped, the denied and failed ones with them. */
export function withoutReviewed(changes: readonly Change[]): Change[] {
  return landed(changes).filter(change => change.hunks.some(hunk => hunk.status === 'pending'))
}

/** A path shown relative to `cwd` when it lies under it, with forward slashes. */
export function shortPath(file: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const f = norm(file)
  const c = norm(cwd).replace(/\/$/, '')
  return c !== '' && f.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? f.slice(c.length + 1) : f
}

/** "14:05", local time, for the position line. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Fills `{key}` placeholders in a template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** What the agent reads after the person undid a hunk. */
export function agentUndoText(file: string, hunk: Hunk, t: Tuning): string {
  const { start, end } = oldRange(hunk)
  return fill(t.text.agentUndo, { file, start, end, diff: unified(hunk) })
}
