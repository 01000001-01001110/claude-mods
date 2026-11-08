//! Label clean-up shared by every diagram type: Mermaid's entity codes
//! (`#quot;`, `#9829;`) become the characters they stand for, a label wrapped
//! in double quotes loses them, and `<br>` splits a label into lines.

import type { CleanTuning } from '../../types'

/** Mermaid writes entities as `#name;` or `#NN;`. Structural: the language's syntax. */
const ENTITY = /#([a-zA-Z]+|\d+);/g

/** Highest Unicode code point; a larger `#NN;` is left as written. */
const MAX_CP = 0x10ffff

/** Replaces entity codes the tuning names, and every numeric one, with their characters. */
export function decode(text: string, t: CleanTuning): string {
  return text.replace(ENTITY, (whole, code: string) => {
    if (/^\d+$/.test(code)) {
      const cp = Number(code)
      return cp <= MAX_CP ? String.fromCodePoint(cp) : whole
    }
    return t.entities[code] ?? whole
  })
}

/** A label as the lines it draws: quotes dropped, entities decoded, split at line breaks, each line trimmed. */
export function labelLines(raw: string, t: CleanTuning): string[] {
  let text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
  const lines = text.split(new RegExp(t.lineBreak, 'i')).map(l => decode(l, t).trim())
  return lines.length > 0 ? lines : ['']
}
