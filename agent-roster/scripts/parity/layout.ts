//! Turns a drawn pane into text the parity harness can diff: `frameText`
//! lays the tree out as a terminal would (an approximation of Ink's flexbox:
//! rows and columns, widths, borders, padding, gaps, margins, justify, wrap
//! and truncation), and `treeDump` writes the tree itself, element by element
//! with its style props, so a colour or a bold that the text cannot show
//! still diffs. Both run the same on either plugin's drawing, so where the
//! approximation differs from Ink it differs the same way for both.

/** A drawn element as the test kit hands it back. */
export type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const isDrawn = (n: unknown): n is Drawn => typeof n === 'object' && n !== null && typeof (n as Drawn).type === 'string'
const width = (s: string) => [...s].length
const chars = (s: string) => [...s]

/** A Client's drawing, looked up by its key (the harness fills this from `ui.drawn({ in: key })`). */
export type ClientTrees = Map<string, unknown>

/** Children with nothing to draw dropped, and runs of strings and numbers joined into one string. */
function kids(n: Drawn): unknown[] {
  const out: unknown[] = []
  for (const c of (n.children ?? []).flat(Infinity as 1)) {
    if (c === null || c === undefined || c === false || c === true || c === '') continue
    if (typeof c === 'string' || typeof c === 'number') {
      const last = out[out.length - 1]
      if (typeof last === 'string') out[out.length - 1] = last + String(c)
      else out.push(String(c))
    } else out.push(c)
  }
  return out
}

function textOf(n: unknown): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  return isDrawn(n) ? kids(n).map(textOf).join('') : ''
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** A Client replaced by what it drew; anything else as it is. */
function resolveClient(n: unknown, clients: ClientTrees): unknown {
  if (!isDrawn(n) || n.type !== 'Client') return n
  const key = String(n.props?.key ?? '')
  return clients.get(key) ?? { type: 'Text', props: {}, children: [`[client ${String(n.props?.module ?? '')}]`] }
}

// ---------------------------------------------------------------- text layout

function cutText(s: string, w: number, mode: unknown): string[] {
  if (w <= 0) return ['']
  const cs = chars(s)
  if (cs.length <= w) return [s]
  if (mode === 'truncate' || mode === 'truncate-end') return [cs.slice(0, w - 1).join('') + '…']
  if (mode === 'truncate-start') return ['…' + cs.slice(cs.length - (w - 1)).join('')]
  if (mode === 'truncate-middle') {
    const head = Math.ceil((w - 1) / 2)
    const tail = w - 1 - head
    return [cs.slice(0, head).join('') + '…' + (tail > 0 ? cs.slice(cs.length - tail).join('') : '')]
  }
  // Word wrap; a word longer than the line is broken.
  const lines: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word
    if (width(next) <= w) {
      cur = next
      continue
    }
    if (cur) lines.push(cur)
    let rest = word
    while (width(rest) > w) {
      lines.push(chars(rest).slice(0, w).join(''))
      rest = chars(rest).slice(w).join('')
    }
    cur = rest
  }
  lines.push(cur)
  return lines
}

/** Cells a node wants on one row. */
function natural(n: unknown, clients: ClientTrees): number {
  n = resolveClient(n, clients)
  if (typeof n === 'string') return width(n)
  if (!isDrawn(n)) return 0
  const p = n.props ?? {}
  const margin = num(p.marginLeft) + num(p.marginRight) + 2 * num(p.marginX)
  if (n.type === 'Text') return width(textOf(n))
  if (n.type === 'Button') return width(buttonText(n))
  if (n.type === 'Svg') return width(svgText(p))
  if (n.type !== 'Box') return width(textOf(n))
  if (typeof p.width === 'number') return p.width + margin
  const frame = (p.borderStyle ? 2 : 0) + 2 * num(p.paddingX ?? p.padding)
  const cs = kids(n)
  const ws = cs.map(c => natural(c, clients))
  const gap = num(p.columnGap ?? p.gap)
  const content = p.flexDirection === 'column' ? Math.max(0, ...ws) : ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1)
  return content + frame + margin
}

/** A Button as a terminal draws it: its hotkey, then its children's text where it has any (the label then only names it), else its label. */
const buttonText = (n: Drawn) => {
  const p = n.props ?? {}
  const kids = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
  return `${p.hotkey ? `${String(p.hotkey)}) ` : ''}${kids || String(p.label ?? '')}`
}
const svgText = (p: Record<string, unknown>) => `[svg: ${String(p.alt ?? '')}]`

const BORDERS: Record<string, [string, string, string, string, string, string]> = {
  round: ['╭', '╮', '╰', '╯', '─', '│'],
  single: ['┌', '┐', '└', '┘', '─', '│'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
}

const pad = (s: string, w: number) => {
  const cs = chars(s)
  return cs.length >= w ? cs.slice(0, w).join('') : s + ' '.repeat(w - cs.length)
}

/** Lays a node out in `avail` cells: its lines, each exactly its own width. */
function lay(n: unknown, avail: number, clients: ClientTrees, inRow: boolean): string[] {
  n = resolveClient(n, clients)
  if (typeof n === 'string') return cutText(n, avail, 'wrap').map(l => pad(l, Math.min(avail, Math.max(width(n), 0))))
  if (!isDrawn(n)) return []
  const p = n.props ?? {}
  if (n.type === 'Text') {
    const s = textOf(n)
    const lines = cutText(s, avail, p.wrap)
    const w = Math.min(avail, Math.max(...lines.map(width)))
    return lines.map(l => pad(l, w))
  }
  if (n.type === 'Button' || n.type === 'Svg') {
    const s = n.type === 'Button' ? buttonText(n) : svgText(p)
    return cutText(s, avail, 'truncate').map(l => pad(l, Math.min(avail, width(s))))
  }
  if (n.type !== 'Box') return cutText(textOf(n), avail, 'wrap')

  const marginL = num(p.marginLeft) + num(p.marginX)
  const marginR = num(p.marginRight) + num(p.marginX)
  // A column child stretches to its parent; a row child takes what it needs, or its width.
  let outer = typeof p.width === 'number' ? p.width : inRow ? Math.min(avail - marginL - marginR, natural({ ...n, props: { ...p, marginLeft: 0, marginRight: 0, marginX: 0 } }, clients)) : avail - marginL - marginR
  outer = Math.max(0, outer)
  const border = p.borderStyle ? BORDERS[String(p.borderStyle)] ?? BORDERS.round! : null
  const padX = num(p.paddingX ?? p.padding)
  const inner = Math.max(0, outer - (border ? 2 : 0) - 2 * padX)
  const cs = kids(n)
  const gap = num(p.columnGap ?? p.gap)
  let body: string[]
  if (p.flexDirection === 'column') {
    body = []
    for (const c of cs) {
      const cp = isDrawn(c) ? c.props ?? {} : {}
      for (let i = 0; i < num(cp.marginTop); i += 1) body.push('')
      const ls = lay(c, inner, clients, false)
      const ml = isDrawn(c) ? num(cp.marginLeft) : 0
      body.push(...ls.map(l => ' '.repeat(ml) + l))
      for (let i = 0; i < num(cp.marginBottom); i += 1) body.push('')
    }
  } else {
    body = layRow(cs, inner, gap, p, clients)
  }
  body = body.map(l => pad(l, inner))
  const lines: string[] = []
  if (border) lines.push(border[0] + border[4].repeat(Math.max(0, outer - 2)) + border[1])
  for (const l of body) {
    const padded = ' '.repeat(padX) + l + ' '.repeat(padX)
    lines.push(border ? border[5] + padded + border[5] : padded)
  }
  if (border) lines.push(border[2] + border[4].repeat(Math.max(0, outer - 2)) + border[3])
  return lines.map(l => pad(' '.repeat(marginL) + l, Math.min(avail, marginL + outer)))
}

function layRow(cs: unknown[], inner: number, gap: number, p: Record<string, unknown>, clients: ClientTrees): string[] {
  const items = cs.map(c => {
    const r = resolveClient(c, clients)
    const cp = isDrawn(r) ? r.props ?? {} : {}
    const fixed = isDrawn(r) && (typeof cp.width === 'number' || cp.flexShrink === 0)
    return { node: r, want: natural(r, clients), fixed, ml: isDrawn(r) ? num(cp.marginLeft) : 0 }
  })
  const rows: (typeof items)[] = []
  if (p.flexWrap === 'wrap') {
    let cur: typeof items = []
    let used = 0
    for (const it of items) {
      const need = it.want + (cur.length ? gap : 0)
      if (cur.length && used + need > inner) {
        rows.push(cur)
        cur = []
        used = 0
      }
      used += it.want + (cur.length ? gap : 0)
      cur.push(it)
    }
    if (cur.length) rows.push(cur)
  } else rows.push(items)
  const out: string[] = []
  for (const row of rows) {
    const widths = row.map(it => it.want)
    let total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, row.length - 1)
    // Too wide: shrinkable items give up cells, the last first.
    for (let i = row.length - 1; i >= 0 && total > inner; i -= 1) {
      if (row[i]!.fixed) continue
      const give = Math.min(widths[i]!, total - inner)
      widths[i]! -= give
      total -= give
    }
    const free = Math.max(0, inner - total)
    let lead = 0
    let between = gap
    if (p.justifyContent === 'center') lead = Math.floor(free / 2)
    else if (p.justifyContent === 'space-between' && row.length > 1) between = gap + Math.floor(free / (row.length - 1))
    else if (p.justifyContent === 'flex-end') lead = free
    const blocks = row.map((it, i) => lay(it.node, widths[i]!, clients, true).map(l => pad(l, widths[i]!)))
    const height = Math.max(1, ...blocks.map(b => b.length))
    for (let y = 0; y < height; y += 1) {
      let s = ' '.repeat(lead)
      blocks.forEach((b, i) => {
        if (i > 0) s += ' '.repeat(between)
        s += b[y] ?? ' '.repeat(widths[i]!)
      })
      out.push(s)
    }
  }
  return out
}

/** The drawing as the terminal would show it, `columns` wide, trailing spaces trimmed. */
export function frameText(tree: unknown, columns: number, clients: ClientTrees): string {
  return lay(tree, columns, clients, false)
    .map(l => chars(l).slice(0, columns).join('').trimEnd())
    .join('\n')
}

// ---------------------------------------------------------------- tree dump

/** Props that change what is drawn; handlers, keys and a Client's props (its drawing is dumped instead) are left out. */
function styleProps(n: Drawn): string {
  const p = n.props ?? {}
  return Object.keys(p)
    .filter(k => k !== 'children' && k !== 'key' && typeof p[k] !== 'function' && !(n.type === 'Client' && k === 'props'))
    .sort()
    .map(k => `${k}=${JSON.stringify(p[k])}`)
    .join(' ')
}

/** The tree, one element a line, indented by depth, its style props and text: what diffs where the frame text cannot show it. */
export function treeDump(tree: unknown, clients: ClientTrees, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (typeof tree === 'string') return `${indent}"${tree}"`
  if (!isDrawn(tree)) return ''
  const head = `${indent}<${tree.type}${styleProps(tree) ? ' ' + styleProps(tree) : ''}>`
  if (tree.type === 'Client') {
    const drawn = clients.get(String(tree.props?.key ?? ''))
    return [head, treeDump(drawn, clients, depth + 1)].join('\n')
  }
  return [head, ...kids(tree).map(c => treeDump(c, clients, depth + 1))].filter(Boolean).join('\n')
}

/** Every Client key in a drawing. */
export function clientKeys(tree: unknown, out: string[] = []): string[] {
  if (!isDrawn(tree)) return out
  if (tree.type === 'Client' && tree.props?.key !== undefined) out.push(String(tree.props.key))
  for (const c of tree.children ?? []) clientKeys(c, out)
  return out
}
