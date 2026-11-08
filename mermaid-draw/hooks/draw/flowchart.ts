//! Flowcharts (`flowchart TD`, `graph LR`): reads nodes, shapes and edges,
//! lays them out in ranks, and draws boxes and routed lines on a canvas.
//!
//! Layout is a small layered drawing: back edges of cycles are turned round,
//! nodes get the longest-path rank, an edge longer than one rank passes
//! through a one-cell placeholder in each rank it crosses, and a few barycenter
//! sweeps order each rank to cut crossings. Ranks run down (TD) or right (LR);
//! the geometry is computed on a main axis (along ranks) and a cross axis and
//! turned into x and y only when drawn, so both directions share one code path.

import type { Art, BoxGlyphs, HeadKind, LineStyle, Tuning } from '../../types'
import { Canvas, type Point } from './canvas'
import { labelLines } from './clean'
import { fill, type Line } from './common'
import { width } from './width'

/** A node as read from the source. */
interface Node {
  id: string
  lines: string[]
  box: string
  /** Order of first mention: the starting order inside a rank. */
  seen: number
}

/** An edge as read from the source. */
interface Edge {
  from: string
  to: string
  style: LineStyle
  headStart: HeadKind
  headEnd: HeadKind
  label: string[]
  /** Fewest ranks between the ends (`--->` is two). */
  span: number
}

/** What the reader got out of the source. */
interface Chart {
  dir: 'down' | 'right'
  nodes: Map<string, Node>
  edges: Edge[]
  warnings: string[]
}

/**
 * Mermaid's link syntax. Structural: this is the language's grammar, not a
 * tunable. Group 1 the start head, 2 the stroke, 3 the end head.
 */
const LINK = /^(<|o(?=[-=.])|x(?=[-=.]))?(-{2,}|={2,}|-\.+-)(>|x|o)?/
/** A link with its text in the middle: `-- yes -->`, `-. maybe .->`, `== sure ==>`. */
const TEXT_LINK = /^(<)?(--|==|-\.)\s+([^|]+?)\s+(-{2,}|={2,}|\.+-)(>|x|o)?(?=\s|[^-=.>xo]|$)/
/** A node id: anything up to a shape delimiter, a link, a separator or a space. */
const ID = /^[^\s[\](){}<>|&;:"'=\-.~]+/
/** A class suffix on a node (`A:::warm`): styling only. */
const CLASS_SUFFIX = /^:::[\w-]+/

/** Head kind for a link's head character. */
function head(ch: string | undefined): HeadKind {
  return ch === '>' || ch === '<' ? 'arrow' : ch === 'x' ? 'cross' : ch === 'o' ? 'circle' : 'none'
}

/** Line style for a link's stroke. */
function stroke(s: string): LineStyle {
  return s.includes('=') ? 'thick' : s.includes('.') ? 'dotted' : 'solid'
}

/** Ranks a link spans from its length: `-->` and `---` one, each extra stroke one more. */
function span(strokeText: string, hasHead: boolean): number {
  const n = strokeText.includes('.') ? (strokeText.match(/\./g) ?? []).length : strokeText.length - (hasHead ? 1 : 2)
  return Math.max(1, n)
}

/** Splits a source line at `;` outside quotes and brackets. */
function statements(line: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') quoted = !quoted
    else if (!quoted && '[({'.includes(ch)) depth++
    else if (!quoted && '])}'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (!quoted && depth === 0 && ch === ';') {
      out.push(line.slice(start, i))
      start = i + 1
    }
  }
  out.push(line.slice(start))
  return out.map(s => s.trim()).filter(s => s !== '')
}

/** Reads one node reference at the head of `s`: its id, label and shape, and how much was read. */
function readNode(s: string, t: Tuning): { id: string; lines?: string[]; box?: string; used: number } | null {
  const id = ID.exec(s)?.[0]
  if (!id) return null
  let at = id.length
  let lines: string[] | undefined
  let box: string | undefined
  for (const shape of t.flowchart.shapes) {
    if (!s.startsWith(shape.open, at)) continue
    const from = at + shape.open.length
    let close: number
    if (s[from] === '"') {
      // A quoted label may hold the closing delimiter; read to the closing quote first.
      const q = s.indexOf('"', from + 1)
      if (q < 0) return null
      close = s.indexOf(shape.close, q + 1)
      if (close < 0 || s.slice(q + 1, close).trim() !== '') continue
    } else {
      close = s.indexOf(shape.close, from)
      if (close < 0) continue
    }
    lines = labelLines(s.slice(from, close), t.clean)
    box = shape.box
    at = close + shape.close.length
    break
  }
  const cls = CLASS_SUFFIX.exec(s.slice(at))
  if (cls) at += cls[0].length
  return { id, ...(lines ? { lines } : {}), ...(box ? { box } : {}), used: at }
}

/** Reads one link at the head of `s`, with its `|label|` if any. */
function readLink(s: string, t: Tuning): { style: LineStyle; headStart: HeadKind; headEnd: HeadKind; label: string[]; span: number; used: number } | null {
  const text = TEXT_LINK.exec(s)
  if (text) {
    const strokeText = text[2]! + text[4]!
    return {
      style: stroke(strokeText),
      headStart: head(text[1]),
      headEnd: head(text[5]),
      label: labelLines(text[3]!, t.clean),
      span: span(text[4]!, text[5] !== undefined),
      used: text[0].length,
    }
  }
  const m = LINK.exec(s)
  if (!m) return null
  let used = m[0].length
  let label: string[] = []
  const rest = s.slice(used)
  const pipe = /^\s*\|([^|]*)\|/.exec(rest)
  if (pipe) {
    label = labelLines(pipe[1]!, t.clean)
    used += pipe[0].length
  }
  return { style: stroke(m[2]!), headStart: head(m[1]), headEnd: head(m[3]), label, span: span(m[2]!, m[3] !== undefined), used }
}

/** Reads a flowchart's statements (after its header line). */
function read(dir: 'down' | 'right', body: Line[], t: Tuning): Chart {
  const chart: Chart = { dir, nodes: new Map(), edges: [], warnings: [] }
  const ft = t.flowchart
  const mention = (id: string, lines?: string[], box?: string) => {
    const known = chart.nodes.get(id)
    if (!known) chart.nodes.set(id, { id, lines: lines ?? [id], box: box ?? ft.plainBox, seen: chart.nodes.size })
    else if (lines) {
      known.lines = lines
      known.box = box ?? known.box
    }
  }
  for (const { n, text: raw } of body) {
    for (const stmt of statements(raw)) {
      const word = stmt.split(/\s+/)[0]!
      if (ft.ignored.includes(word)) continue
      if (ft.unsupported.includes(word)) {
        chart.warnings.push(fill(t.text.unsupported, { line: n, text: word }))
        continue
      }
      // A statement is groups of nodes (`A & B`) joined by links.
      const groups: string[][] = []
      const links: NonNullable<ReturnType<typeof readLink>>[] = []
      let s = stmt
      // Nodes are only recorded once the whole statement reads, so a bad line leaves no trace.
      const seen: NonNullable<ReturnType<typeof readNode>>[] = []
      let ok = true
      for (;;) {
        const group: string[] = []
        for (;;) {
          s = s.trimStart()
          const node = readNode(s, t)
          if (!node) {
            ok = false
            break
          }
          seen.push(node)
          group.push(node.id)
          s = s.slice(node.used).trimStart()
          if (!s.startsWith('&')) break
          s = s.slice(1)
        }
        if (!ok) break
        groups.push(group)
        if (s === '') break
        const link = readLink(s, t)
        if (!link) {
          ok = false
          break
        }
        links.push(link)
        s = s.slice(link.used)
      }
      if (!ok || groups.length !== links.length + 1) {
        chart.warnings.push(fill(t.text.badLine, { line: n, text: stmt }))
        continue
      }
      for (const node of seen) mention(node.id, node.lines, node.box)
      links.forEach((link, i) => {
        for (const from of groups[i]!) {
          for (const to of groups[i + 1]!) {
            if (from === to) {
              chart.warnings.push(fill(t.text.selfLoop, { line: n, text: from }))
              continue
            }
            chart.edges.push({ from, to, style: link.style, headStart: link.headStart, headEnd: link.headEnd, label: link.label, span: link.span })
          }
        }
      })
    }
  }
  return chart
}

/** A node of the layered layout: a real node, or a placeholder an edge passes through. */
interface Item {
  key: string
  rank: number
  /** Size along the cross axis and the main axis, in cells. */
  cross: number
  main: number
  /** Starting order inside its rank: first mention for a node, just after its edge's upper end for a placeholder. */
  seen: number
  node?: Node
}

/** One edge as laid out: the items it passes, top rank first, and whether it runs against its arrow. */
interface Route {
  edge: Edge
  items: string[]
  reversed: boolean
}

/** Ranks the nodes: cycles broken by turning back edges round, then the longest path from the sources. */
export function rank(ids: string[], edges: { from: string; to: string; span: number }[]): { ranks: Map<string, number>; reversed: Set<number> } {
  const out = new Map<string, string[]>(ids.map(id => [id, []]))
  edges.forEach((e, i) => out.get(e.from)!.push(String(i)))
  const reversed = new Set<number>()
  const state = new Map<string, 'open' | 'done'>()
  // Depth-first in first-mention order; an edge into a node still open closes a cycle.
  const visit = (id: string) => {
    state.set(id, 'open')
    for (const k of out.get(id)!) {
      const e = edges[Number(k)]!
      const s = state.get(e.to)
      if (s === 'open') reversed.add(Number(k))
      else if (s === undefined) visit(e.to)
    }
    state.set(id, 'done')
  }
  for (const id of ids) if (!state.has(id)) visit(id)
  const indeg = new Map<string, number>(ids.map(id => [id, 0]))
  const succ = new Map<string, { to: string; span: number }[]>(ids.map(id => [id, []]))
  edges.forEach((e, i) => {
    const [a, b] = reversed.has(i) ? [e.to, e.from] : [e.from, e.to]
    succ.get(a)!.push({ to: b, span: e.span })
    indeg.set(b, indeg.get(b)! + 1)
  })
  const ranks = new Map<string, number>(ids.map(id => [id, 0]))
  const queue = ids.filter(id => indeg.get(id) === 0)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const { to, span: len } of succ.get(id)!) {
      ranks.set(to, Math.max(ranks.get(to)!, ranks.get(id)! + len))
      indeg.set(to, indeg.get(to)! - 1)
      if (indeg.get(to) === 0) queue.push(to)
    }
  }
  return { ranks, reversed }
}

/** Orders each rank by barycenter sweeps: down by the rank above, then up by the rank below. */
export function order(layers: string[][], up: Map<string, string[]>, down: Map<string, string[]>, sweeps: number): string[][] {
  const result = layers.map(l => [...l])
  const pos = new Map<string, number>()
  const index = () => result.forEach(l => l.forEach((k, i) => pos.set(k, i)))
  index()
  const sweep = (r: number, nb: Map<string, string[]>) => {
    const layer = result[r]!
    const keyed = layer.map((k, i) => {
      const ns = nb.get(k) ?? []
      // A node with no neighbours on that side keeps its place.
      const bary = ns.length === 0 ? i : ns.reduce((a, n) => a + pos.get(n)!, 0) / ns.length
      return { k, bary, i }
    })
    keyed.sort((a, b) => a.bary - b.bary || a.i - b.i)
    result[r] = keyed.map(x => x.k)
    result[r]!.forEach((k, i) => pos.set(k, i))
  }
  for (let s = 0; s < sweeps; s++) {
    for (let r = 1; r < result.length; r++) sweep(r, up)
    for (let r = result.length - 2; r >= 0; r--) sweep(r, down)
  }
  return result
}

/** Lays out and draws a read chart. */
function draw(chart: Chart, t: Tuning): Art {
  const ft = t.flowchart
  const dir = chart.dir
  const ids = [...chart.nodes.keys()]
  const { ranks, reversed } = rank(ids, chart.edges)

  // What each edge draws at each end. A turned-round edge's arrow points back up the
  // ranks, at the end it starts from.
  const tips = chart.edges.map((edge, i) => (reversed.has(i) ? { atStart: edge.headEnd, atEnd: edge.headStart } : { atStart: edge.headStart, atEnd: edge.headEnd }))
  // The distinct kinds of end on each node's sides (`high`: where edges leave, `low`: where they arrive).
  const kinds = new Map<string, HeadKind[]>()
  const note = (k: string, side: 'low' | 'high', kind: HeadKind) => {
    const list = kinds.get(`${k}\0${side}`) ?? []
    if (!list.includes(kind)) list.push(kind)
    kinds.set(`${k}\0${side}`, list)
  }
  chart.edges.forEach((edge, i) => {
    const [a, b] = reversed.has(i) ? [edge.to, edge.from] : [edge.from, edge.to]
    note(a, 'high', tips[i]!.atStart)
    note(b, 'low', tips[i]!.atEnd)
  })

  // Items: real nodes sized from their labels, then placeholders for long edges.
  const items = new Map<string, Item>()
  for (const node of chart.nodes.values()) {
    const labelW = Math.max(...node.lines.map(width))
    const w = labelW + 2 * ft.padding + 2
    const h = node.lines.length + 2
    let cross = dir === 'down' ? w : h
    // A side with several kinds of end needs a port 2n from its middle for the n-th, off the corners.
    const extra = Math.max(0, (kinds.get(`${node.id}\0high`)?.length ?? 1) - 1, (kinds.get(`${node.id}\0low`)?.length ?? 1) - 1)
    while (extra > 0 && Math.floor(cross / 2) + 2 * extra > cross - 2) cross++
    items.set(node.id, { key: node.id, rank: ranks.get(node.id)!, seen: node.seen, cross, main: dir === 'down' ? h : w, node })
  }
  const routes: Route[] = chart.edges.map((edge, i) => {
    const rev = reversed.has(i)
    const [a, b] = rev ? [edge.to, edge.from] : [edge.from, edge.to]
    const keys = [a]
    for (let r = ranks.get(a)! + 1; r < ranks.get(b)!; r++) {
      const key = `\0${i}:${r}`
      items.set(key, { key, rank: r, seen: chart.nodes.get(a)!.seen + 0.5, cross: 1, main: 0 })
      keys.push(key)
    }
    keys.push(b)
    return { edge, items: keys, reversed: rev }
  })

  const top = Math.max(0, ...[...items.values()].map(i => i.rank))
  let layers: string[][] = Array.from({ length: top + 1 }, () => [])
  for (const item of [...items.values()].sort((a, b) => a.seen - b.seen)) layers[item.rank]!.push(item.key)
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  for (const route of routes) {
    for (let i = 0; i + 1 < route.items.length; i++) {
      const a = route.items[i]!
      const b = route.items[i + 1]!
      down.set(a, [...(down.get(a) ?? []), b])
      up.set(b, [...(up.get(b) ?? []), a])
    }
  }
  layers = order(layers, up, down, ft.orderSweeps)

  // Cross axis: each rank packed and centred on the widest rank's middle.
  const gap = ft.nodeGap[dir]
  const totals = layers.map(l => l.reduce((a, k) => a + items.get(k)!.cross, 0) + gap * Math.max(0, l.length - 1))
  const crossSize = Math.max(1, ...totals)
  const mid = Math.floor(crossSize / 2)
  const crossAt = new Map<string, number>()
  layers.forEach((layer, r) => {
    let c = mid - Math.floor(totals[r]! / 2)
    for (const k of layer) {
      crossAt.set(k, c)
      c += items.get(k)!.cross + gap
    }
  })

  // Ports: edges meet a node's side at its middle, grouped by what they draw there. Plain
  // tails share the middle of the outgoing side, arrows the middle of the incoming side; any
  // other kind (a head on the outgoing side, a bare end among arrows) gets its own point
  // beside the middle, so one glyph never stands for two different ends.
  const center = (k: string) => crossAt.get(k)! + Math.floor(items.get(k)!.cross / 2)
  const port = (k: string, side: 'low' | 'high', kind: HeadKind): number => {
    const c = center(k)
    if (!items.get(k)!.node) return c
    const preferred: HeadKind = side === 'high' ? 'none' : 'arrow'
    const list = kinds.get(`${k}\0${side}`)!
    const ranked = list.includes(preferred) ? [preferred, ...list.filter(x => x !== preferred)] : list
    const n = ranked.indexOf(kind)
    if (n <= 0) return c
    const lo = crossAt.get(k)! + 1
    const hi = crossAt.get(k)! + items.get(k)!.cross - 2
    for (const p of [c + 2 * n, c - 2 * n]) if (p >= lo && p <= hi) return p
    return c
  }
  const ends = routes.map((route, ri) => ({
    start: port(route.items[0]!, 'high', tips[ri]!.atStart),
    end: port(route.items[route.items.length - 1]!, 'low', tips[ri]!.atEnd),
  }))
  /** The cross coordinate where a route passes item `i` of its chain. */
  const crossOf = (ri: number, i: number) => {
    const route = routes[ri]!
    if (i === 0) return ends[ri]!.start
    if (i === route.items.length - 1) return ends[ri]!.end
    return crossAt.get(route.items[i]!)!
  }

  // Gaps: lanes for every bend (one per upper end), then room for labels, then the head.
  const lanes: Map<string, number>[] = layers.map(() => new Map())
  const labelExt = layers.map(() => 0)
  /** The gap whose segment carries route `ri`'s label: next to the arrow's end. */
  const labelGap = (ri: number) => (routes[ri]!.reversed ? 0 : routes[ri]!.items.length - 2)
  routes.forEach((route, ri) => {
    for (let i = 0; i + 1 < route.items.length; i++) {
      const r = items.get(route.items[i]!)!.rank
      const a = crossOf(ri, i)
      const b = crossOf(ri, i + 1)
      if (a !== b) {
        const key = `${route.items[i]}\0${a}`
        if (!lanes[r]!.has(key)) lanes[r]!.set(key, a)
      }
      if (i === labelGap(ri) && route.edge.label.some(l => l !== '')) {
        const need = dir === 'down' ? route.edge.label.length : width(route.edge.label.join(' ')) + 2
        labelExt[r] = Math.max(labelExt[r]!, need)
      }
    }
  })
  const laneIndex = lanes.map(m => {
    const sorted = [...m.entries()].sort((x, y) => x[1] - y[1])
    return new Map(sorted.map(([k], i) => [k, i]))
  })
  const ext = layers.map(l => Math.max(1, ...l.map(k => items.get(k)!.main)))
  const gaps = layers.map((_, r) => (r === layers.length - 1 ? 0 : Math.max(ft.minRankGap[dir], 2 + laneIndex[r]!.size + labelExt[r]!)))
  const bandAt: number[] = []
  let m = 0
  layers.forEach((_, r) => {
    bandAt.push(m)
    m += ext[r]! + gaps[r]!
  })
  const mainSize = m
  const mainStart = (k: string) => {
    const it = items.get(k)!
    return bandAt[it.rank]! + Math.floor((ext[it.rank]! - it.main) / 2)
  }

  const toXY = (main: number, cross: number): Point => (dir === 'down' ? { x: cross, y: main } : { x: main, y: cross })

  // Every route's corner points, head positions and label place, before anything is drawn.
  const heads: { at: Point; kind: HeadKind; forward: boolean }[] = []
  const labels: { main: number; cross: number; lines: string[]; x: number; w: number }[] = []
  const paths = routes.map((route, ri) => {
    const first = route.items[0]!
    const last = route.items[route.items.length - 1]!
    const startMain = mainStart(first) + items.get(first)!.main
    const endMain = mainStart(last) - 1
    const pts: Point[] = [toXY(startMain, crossOf(ri, 0))]
    for (let i = 0; i + 1 < route.items.length; i++) {
      const r = items.get(route.items[i]!)!.rank
      const a = crossOf(ri, i)
      const b = crossOf(ri, i + 1)
      const gapStart = bandAt[r]! + ext[r]!
      if (a !== b) {
        const lane = gapStart + 1 + laneIndex[r]!.get(`${route.items[i]}\0${a}`)!
        pts.push(toXY(lane, a), toXY(lane, b))
      }
      if (i === labelGap(ri) && route.edge.label.some(l => l !== '')) {
        const w = Math.max(...route.edge.label.map(width))
        labels.push({ main: gapStart + 1 + laneIndex[r]!.size, cross: b, lines: route.edge.label, x: Math.max(0, b - Math.floor(w / 2)), w })
      }
    }
    pts.push(toXY(endMain, crossOf(ri, route.items.length - 1)))
    const { atStart, atEnd } = tips[ri]!
    if (atEnd !== 'none') heads.push({ at: pts[pts.length - 1]!, kind: atEnd, forward: true })
    if (atStart !== 'none') heads.push({ at: pts[0]!, kind: atStart, forward: false })
    return { pts, style: route.edge.style }
  })

  // TD labels sit across their line; two in one gap that would touch are moved apart along the rank.
  if (dir === 'down') {
    const placed: typeof labels = []
    for (const l of [...labels].sort((a, b) => a.x - b.x)) {
      for (const p of placed) {
        const rows = l.main < p.main + p.lines.length && p.main < l.main + l.lines.length
        if (rows && l.x <= p.x + p.w && p.x <= l.x + l.w) l.x = p.x + p.w + 1
      }
      placed.push(l)
    }
  }
  const crossTotal = dir === 'down' ? Math.max(crossSize, ...labels.map(l => l.x + l.w)) : crossSize
  const canvas = dir === 'down' ? new Canvas(crossTotal, mainSize, t.glyphs) : new Canvas(mainSize, crossTotal, t.glyphs)

  // Lines first; boxes, labels and heads are set over them.
  for (const p of paths) canvas.path(p.pts, p.style, 'edge')

  for (const item of items.values()) {
    if (!item.node) continue
    const p = toXY(mainStart(item.key), crossAt.get(item.key)!)
    const w = dir === 'down' ? item.cross : item.main
    const h = dir === 'down' ? item.main : item.cross
    const g: BoxGlyphs = t.glyphs.boxes[item.node.box] ?? t.glyphs.boxes[ft.plainBox]!
    canvas.box(p.x, p.y, w, h, g, 'border')
    // Label centred both ways: a box can be taller than its label when it holds extra ports.
    const top = p.y + 1 + Math.floor((h - 2 - item.node.lines.length) / 2)
    item.node.lines.forEach((line, i) => {
      canvas.write(p.x + 1 + Math.floor((w - 2 - width(line)) / 2), top + i, line, 'text')
    })
  }

  for (const l of labels) {
    if (dir === 'down') {
      // Each line centred inside the label's block.
      l.lines.forEach((line, i) => canvas.write(l.x + Math.floor((l.w - width(line)) / 2), l.main + i, line, 'edgeLabel'))
    } else {
      // One cell of line is left each side of the text.
      canvas.write(l.main + 1, l.cross, l.lines.join(' '), 'edgeLabel')
    }
  }

  for (const hd of heads) {
    if (hd.kind === 'none') continue
    const set = t.glyphs.heads[hd.kind]
    const glyph = dir === 'down' ? (hd.forward ? set.down : set.up) : hd.forward ? set.right : set.left
    canvas.put(hd.at.x, hd.at.y, glyph, 'edge')
  }

  return canvas.art(chart.warnings)
}

/**
 * Draws a flowchart from its header words (`flowchart`, `LR`) and body
 * lines. Returns a drawing with warnings for lines it could not read; an
 * unknown direction gives an empty drawing and a warning.
 */
export function flowchart(header: Line, body: Line[], t: Tuning): Art {
  const word = header.text.trim().split(/\s+/)[1] ?? 'TD'
  const dir = t.flowchart.directions[word]
  if (!dir) return { rows: [], width: 0, warnings: [fill(t.text.unsupported, { line: header.n, text: word })] }
  const chart = read(dir, body, t)
  if (chart.nodes.size === 0) return { rows: [], width: 0, warnings: [...chart.warnings, t.text.empty] }
  return draw(chart, t)
}
