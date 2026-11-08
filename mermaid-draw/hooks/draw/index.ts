//! The renderer's front door: takes a fence's Mermaid source, drops comments
//! and front matter (keeping its title), picks the diagram type from the first
//! line and hands the rest to that type's drawer. A type with no drawer gives
//! null, which leaves the fence as it was.

import type { Art, Tuning } from '../../types'
import type { Line } from './common'
import { flowchart } from './flowchart'
import { sequence } from './sequence'
import { width } from './width'

/** Mermaid's comment and directive lines start with `%%`. Structural: the language's syntax. */
const COMMENT = /^\s*%%/
/** Front matter fence. Structural: YAML's. */
const FRONT = /^\s*---\s*$/
/** A front matter title. */
const TITLE = /^\s*title\s*:\s*(.*?)\s*$/

/** Draws Mermaid `source`; null when its diagram type is not one this mod draws. */
export function render(source: string, t: Tuning): Art | null {
  const all: Line[] = source.split('\n').map((text, i) => ({ n: i + 1, text: text.replace(/\r$/, '') }))
  let i = 0
  while (i < all.length && all[i]!.text.trim() === '') i++
  let title = ''
  if (i < all.length && FRONT.test(all[i]!.text)) {
    const close = all.findIndex((l, j) => j > i && FRONT.test(l.text))
    if (close < 0) return null
    for (const l of all.slice(i + 1, close)) {
      const m = TITLE.exec(l.text)
      if (m) title = m[1]!.replace(/^["']|["']$/g, '')
    }
    i = close + 1
  }
  const lines = all.slice(i).filter(l => l.text.trim() !== '' && !COMMENT.test(l.text))
  const first = lines[0]
  if (!first) return null
  // `graph TD; A-->B` puts statements on the header line after a `;`.
  const semi = first.text.indexOf(';')
  const header: Line = { n: first.n, text: semi < 0 ? first.text : first.text.slice(0, semi) }
  const body = semi < 0 ? lines.slice(1) : [{ n: first.n, text: first.text.slice(semi + 1) }, ...lines.slice(1)]
  const word = header.text.trim().split(/\s+/)[0]!
  let art: Art
  if (t.flowchart.headers.includes(word)) art = flowchart(header, body, t)
  else if (word === t.sequence.header) art = sequence(header, body, t)
  else return null
  if (title === '' || art.rows.length === 0) return art
  return { ...art, rows: [[{ text: title, role: 'title' }], [], ...art.rows], width: Math.max(art.width, width(title)) }
}
