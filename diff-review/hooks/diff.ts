//! Line diffs for diff-review: a Myers diff of two texts into edit
//! operations, grouped into hunks with context, written as unified-diff
//! text, and undone one hunk at a time against the file as it is now.
//! No `$` here.
//!
//! Lines are split on '\n' only, so a '\r' stays at the end of its line and a
//! CRLF file round-trips byte for byte.

import type { Hunk, HunkLine } from '../types'

/** One step of an edit script. */
export type Op = { kind: ' ' | '-' | '+'; text: string }

/** Splits text into lines; '' is no lines. A trailing newline leaves a final ''. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** The inverse of `splitLines`. */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * How many lines in a row are equal, at most `limit`, walking `a` and `b`
 * by the index maps given (front to back for the head, back to front for the tail).
 */
function sameRun(a: readonly string[], b: readonly string[], limit: number, atA: (i: number) => number, atB: (i: number) => number): number {
  let count = 0
  for (; count < limit; count++) if (a[atA(count)] !== b[atB(count)]) break
  return count
}

/**
 * The shortest edit script from `a` to `b` (Myers, O((N+M)D)), after
 * trimming the common head and tail. Past `maxLines` changed lines it gives
 * up on minimality and replaces the middle whole, so a huge rewrite stays fast.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxLines = Infinity): Op[] {
  const head = sameRun(a, b, Math.min(a.length, b.length), i => i, i => i)
  // The tail may not reach back into the head: both files keep their own middle.
  const tail = sameRun(a, b, Math.min(a.length, b.length) - head, i => a.length - 1 - i, i => b.length - 1 - i)
  const ops: Op[] = a.slice(0, head).map(text => ({ kind: ' ', text }))
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length + midB.length > maxLines) {
    for (const text of midA) ops.push({ kind: '-', text })
    for (const text of midB) ops.push({ kind: '+', text })
  } else {
    ops.push(...myers(midA, midB))
  }
  for (const text of a.slice(a.length - tail)) ops.push({ kind: ' ', text })
  return ops
}

/** Myers' greedy algorithm with a saved trace, backtracked into ops. */
function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(text => ({ kind: '+', text }))
  if (m === 0) return a.map(text => ({ kind: '-', text }))
  const max = n + m
  const offset = max
  let v = new Array<number>(2 * max + 2).fill(0)
  const trace: number[][] = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) break outer
    }
  }
  // Backtrack from the end through the saved frontiers.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : v[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: a[x - 1]! })
      x--
      y--
    }
    if (d === 0) break
    if (down) ops.push({ kind: '+', text: b[y - 1]! })
    else ops.push({ kind: '-', text: a[x - 1]! })
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/**
 * Groups an edit script into hunks, each change with up to `context`
 * unchanged lines around it; changes closer than twice that share a hunk.
 */
export function hunksOf(ops: readonly Op[], context: number): Omit<Hunk, 'id' | 'status'>[] {
  const hunks: Omit<Hunk, 'id' | 'status'>[] = []
  const changed = ops.map((op, i) => (op.kind === ' ' ? -1 : i)).filter(i => i >= 0)
  if (changed.length === 0) return hunks
  // Where each op sits in the old and new files, 1-based.
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = 1
  let n = 1
  for (const op of ops) {
    oldAt.push(o)
    newAt.push(n)
    if (op.kind !== '+') o++
    if (op.kind !== '-') n++
  }
  let start = Math.max(0, changed[0]! - context)
  let end = Math.min(ops.length - 1, changed[0]! + context)
  const flush = () => {
    const slice = ops.slice(start, end + 1)
    hunks.push({ oldStart: oldAt[start]!, newStart: newAt[start]!, lines: slice.map(op => ({ kind: op.kind, text: op.text })) })
  }
  for (const i of changed.slice(1)) {
    if (i - context <= end + 1) end = Math.min(ops.length - 1, i + context)
    else {
      flush()
      start = Math.max(0, i - context)
      end = Math.min(ops.length - 1, i + context)
    }
  }
  flush()
  return hunks
}

/** The lines a hunk covers in the old file (context and removed). */
export function oldSide(lines: readonly HunkLine[]): string[] {
  return lines.filter(line => line.kind !== '+').map(line => line.text)
}

/** The lines a hunk covers in the new file (context and added). */
export function newSide(lines: readonly HunkLine[]): string[] {
  return lines.filter(line => line.kind !== '-').map(line => line.text)
}

/** A hunk as unified-diff text: its `@@` header, then each line with its mark. '\r' is dropped for display. */
export function unified(hunk: Pick<Hunk, 'oldStart' | 'newStart' | 'lines'>): string {
  const oldCount = oldSide(hunk.lines).length
  const newCount = newSide(hunk.lines).length
  const header = `@@ -${oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart},${oldCount} +${newCount === 0 ? hunk.newStart - 1 : hunk.newStart},${newCount} @@`
  return [header, ...hunk.lines.map(line => `${line.kind}${line.text.replace(/\r$/, '')}`)].join('\n')
}

/** Where `block` occurs in `lines`, every start index. An empty block occurs nowhere. */
function occurrences(lines: readonly string[], block: readonly string[]): number[] {
  const found: number[] = []
  if (block.length === 0) return found
  for (let i = 0; i + block.length <= lines.length; i++) {
    let j = 0
    while (j < block.length && lines[i + j] === block[j]) j++
    if (j === block.length) found.push(i)
  }
  return found
}

/**
 * Undoes one hunk in the file as it is now: finds the hunk's new-side lines
 * (nearest to where the edit put them, since later edits may have moved
 * them) and puts its old-side lines back. Null when the lines are no longer
 * there to undo, or appear in no unambiguous place.
 */
export function undoHunk(current: string, hunk: Pick<Hunk, 'newStart' | 'lines'>): string | null {
  const lines = splitLines(current)
  const next = newSide(hunk.lines)
  const prev = oldSide(hunk.lines)
  if (next.length === 0) {
    // The edit deleted everything there was and kept no context: only an empty file is that.
    return lines.length === 0 ? joinLines(prev) : null
  }
  const found = occurrences(lines, next)
  if (found.length === 0) return null
  const expected = hunk.newStart - 1
  const at = found.reduce((best, i) => (Math.abs(i - expected) < Math.abs(best - expected) ? i : best))
  return joinLines([...lines.slice(0, at), ...prev, ...lines.slice(at + next.length)])
}

/** The changed line range of a hunk in the old file, for messages: first and last old line touched. */
export function oldRange(hunk: Pick<Hunk, 'oldStart' | 'lines'>): { start: number; end: number } {
  let line = hunk.oldStart
  let start = -1
  let end = -1
  for (const l of hunk.lines) {
    if (l.kind === '-') {
      if (start < 0) start = line
      end = line
    }
    if (l.kind !== '+') line++
    else if (start < 0) {
      start = line
      end = line - 1
    }
  }
  return { start: Math.max(1, start), end: Math.max(start, end) }
}
