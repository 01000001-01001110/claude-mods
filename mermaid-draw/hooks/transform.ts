//! Turns one reply block's markdown into what the hook draws: prose as
//! Markdown, each drawable ```mermaid fence as diagram rows (and, in `both`
//! display, the fence again under it), and a warning line under a closed
//! fence whose source had problems. Anything not drawn keeps its fence
//! exactly as written. Null means nothing changed: the engine draws as usual.

import type { Span, Tuning } from '../types'
import { fill } from './draw/common'
import { render } from './draw/index'
import { blocks } from './fences'

/** One piece of the drawn block. */
export type Segment = { kind: 'markdown'; text: string } | { kind: 'diagram'; rows: Span[][] } | { kind: 'warning'; text: string }

/** The warning line for a fence's warnings. */
export function warningLine(warnings: string[], t: Tuning): string {
  const more = warnings.length > 1 ? fill(t.text.more, { n: warnings.length - 1 }) : ''
  return fill(t.text.warning, { first: warnings[0] ?? '', more })
}

/**
 * The segments for `text` drawn into `width` columns, or null when no fence
 * was drawn and no warning raised.
 */
export function transform(text: string, width: number, t: Tuning): Segment[] | null {
  const out: Segment[] = []
  let changed = false
  const markdown = (lines: string[]) => {
    const last = out[out.length - 1]
    if (last?.kind === 'markdown') last.text += '\n' + lines.join('\n')
    else out.push({ kind: 'markdown', text: lines.join('\n') })
  }
  for (const block of blocks(text, t.fence)) {
    if (block.kind === 'prose') {
      markdown(block.lines)
      continue
    }
    if (!block.closed && !t.drawWhileStreaming) {
      markdown(block.lines)
      continue
    }
    const art = render(block.source, t)
    // Warnings shift at almost every half-typed state, so they only count once the fence is closed.
    if (art && block.closed && art.warnings.length > 0) {
      markdown(block.lines)
      out.push({ kind: 'warning', text: warningLine(art.warnings, t) })
      changed = true
      continue
    }
    if (!art || art.rows.length === 0 || art.width > width) {
      markdown(block.lines)
      continue
    }
    out.push({ kind: 'diagram', rows: art.rows })
    if (t.display === 'both') markdown(block.lines)
    changed = true
  }
  if (!changed) return null
  // Prose that is only blank lines draws nothing but a gap.
  return out.filter(s => s.kind !== 'markdown' || s.text.trim() !== '')
}

/** A first-in, first-out memo of transforms: a streamed reply redraws on every chunk. */
export class Memo {
  private readonly map = new Map<string, Segment[] | null>()
  /** Transforms computed, not found. */
  misses = 0

  /** A memo holding at most `size` entries. */
  constructor(private readonly size: number) {}

  /** The transform of `text` at `width`, computed once per pair while it stays held. */
  get(text: string, width: number, t: Tuning): Segment[] | null {
    const key = `${width}\0${text}`
    if (this.map.has(key)) return this.map.get(key)!
    this.misses++
    const value = transform(text, width, t)
    if (this.map.size >= this.size) this.map.delete(this.map.keys().next().value!)
    this.map.set(key, value)
    return value
  }
}
