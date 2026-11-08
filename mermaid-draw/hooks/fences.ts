//! Finds fenced code blocks in a reply's markdown, the way CommonMark does:
//! up to `maxIndent` spaces, a run of at least `minLength` backticks or
//! tildes, an info string, and a closing run of the same character at least
//! as long. A fence whose first info word is the diagram language becomes a
//! diagram block; every other fence, and everything inside it, stays prose,
//! so a ```mermaid example quoted inside a ````markdown fence is left alone.

import type { FenceTuning } from '../types'

/** A run of the reply: prose to hand to Markdown, or a diagram fence. */
export type Block =
  | { kind: 'prose'; lines: string[] }
  | {
      kind: 'diagram'
      /** The fence's body with the fence's indent taken off each line. */
      source: string
      /** The fence as written, opening and closing lines included. */
      lines: string[]
      /** False while the closing fence has not arrived (a streamed reply). */
      closed: boolean
    }

/** Escapes a character for use in a RegExp. */
function esc(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** An opening fence on `line`, or null. */
export function opening(line: string, f: FenceTuning): { indent: number; ch: string; len: number; info: string } | null {
  for (const ch of f.chars) {
    const m = new RegExp(`^( {0,${f.maxIndent}})(${esc(ch)}{${f.minLength},})(.*)$`).exec(line)
    if (!m) continue
    const info = m[3]!.trim()
    // CommonMark: a backtick fence's info string may not hold a backtick (it would be inline code).
    if (ch === '`' && info.includes('`')) return null
    return { indent: m[1]!.length, ch, len: m[2]!.length, info }
  }
  return null
}

/** True when `line` closes a fence of `ch` at least `len` long. */
export function closes(line: string, ch: string, len: number, f: FenceTuning): boolean {
  return new RegExp(`^ {0,${f.maxIndent}}${esc(ch)}{${len},}[ \\t]*$`).test(line)
}

/** Splits markdown into prose and diagram blocks. A CR before a line end is ignored when matching and kept in the text. */
export function blocks(text: string, f: FenceTuning): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  const prose = (more: string[]) => {
    const last = out[out.length - 1]
    if (last?.kind === 'prose') last.lines.push(...more)
    else out.push({ kind: 'prose', lines: [...more] })
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const open = opening(line.replace(/\r$/, ''), f)
    if (!open) {
      prose([line])
      i++
      continue
    }
    let end = i + 1
    while (end < lines.length && !closes(lines[end]!.replace(/\r$/, ''), open.ch, open.len, f)) end++
    const closed = end < lines.length
    const fence = lines.slice(i, closed ? end + 1 : end)
    const language = (open.info.split(/\s+/)[0] ?? '').toLowerCase()
    if (language !== f.language) {
      prose(fence)
    } else {
      const body = lines.slice(i + 1, end).map(l => l.replace(/\r$/, '').replace(new RegExp(`^ {0,${open.indent}}`), ''))
      out.push({ kind: 'diagram', source: body.join('\n'), lines: fence, closed })
    }
    i = closed ? end + 1 : end
  }
  return out
}
