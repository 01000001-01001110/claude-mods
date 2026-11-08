//! Sequence diagrams: participants as boxes along the top (and again at the
//! bottom), a lifeline under each, and each message, note and block rule as
//! rows down the page. Participant spacing is solved left to right so every
//! message's text fits between the two lifelines it joins.

import type { Art, HeadKind, LineStyle, Tuning } from '../../types'
import { Canvas } from './canvas'
import { labelLines } from './clean'
import { fill, type Line } from './common'
import { width } from './width'

/** Message arrows, longest first. Structural: Mermaid's grammar. Each with its stroke and head. */
const ARROWS: readonly { token: string; style: LineStyle; head: HeadKind }[] = [
  { token: '-->>', style: 'dotted', head: 'arrow' },
  { token: '->>', style: 'solid', head: 'arrow' },
  { token: '--x', style: 'dotted', head: 'cross' },
  { token: '-x', style: 'solid', head: 'cross' },
  { token: '--)', style: 'dotted', head: 'open' },
  { token: '-)', style: 'solid', head: 'open' },
  { token: '-->', style: 'dotted', head: 'none' },
  { token: '->', style: 'solid', head: 'none' },
]

/** `A->>B: text`, with optional activation marks. Structural: Mermaid's grammar. */
const MESSAGE = new RegExp(String.raw`^([^\s:+\-]+)\s*(` + ARROWS.map(a => a.token.replace(/[)>]/g, c => '\\' + c)).join('|') + String.raw`)\s*[+\-]?\s*([^\s:+\-][^:]*?)\s*:(.*)$`)
/** `Note right of A: text`, `Note over A, B: text`. */
const NOTE = /^note\s+(left of|right of|over)\s+([^:,]+?)\s*(?:,\s*([^:]+?))?\s*:(.*)$/i
/** `participant A`, `actor B as Bea`. */
const PARTICIPANT = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/

interface Who {
  id: string
  lines: string[]
  kind: 'participant' | 'actor'
}

type Event =
  | { kind: 'message'; from: number; to: number; text: string; style: LineStyle; head: HeadKind }
  | { kind: 'note'; side: 'left of' | 'right of' | 'over'; a: number; b: number; lines: string[] }
  | { kind: 'rule'; word: string; text: string }

/** Reads participants and events; problems become warnings. */
function read(body: Line[], t: Tuning): { who: Who[]; events: Event[]; warnings: string[] } {
  const st = t.sequence
  const who: Who[] = []
  const events: Event[] = []
  const warnings: string[] = []
  const stack: { word: string; n: number; silent: boolean }[] = []
  let numbered = false
  let count = 0
  const find = (id: string): number => {
    const i = who.findIndex(w => w.id === id)
    if (i >= 0) return i
    who.push({ id, lines: [id], kind: 'participant' })
    return who.length - 1
  }
  for (const { n, text: raw } of body) {
    const s = raw.trim()
    const word = s.split(/\s+/)[0]!
    const rest = s.slice(word.length).trim()
    let m: RegExpExecArray | null
    if ((m = PARTICIPANT.exec(s))) {
      const i = find(m[2]!)
      who[i]!.kind = m[1] as Who['kind']
      if (m[3] !== undefined) who[i]!.lines = labelLines(m[3], t.clean)
    } else if (word === 'autonumber') {
      numbered = true
    } else if (st.blocks.includes(word)) {
      stack.push({ word, n, silent: false })
      events.push({ kind: 'rule', word, text: rest })
    } else if (st.silentBlocks.includes(word)) {
      stack.push({ word, n, silent: true })
    } else if (st.splits.includes(word)) {
      events.push({ kind: 'rule', word, text: rest })
    } else if (word === 'end') {
      const open = stack.pop()
      if (!open) warnings.push(fill(t.text.strayEnd, { line: n, text: s }))
      else if (!open.silent) events.push({ kind: 'rule', word: '', text: '' })
    } else if (st.ignored.includes(word)) {
      continue
    } else if (st.unsupported.includes(word)) {
      warnings.push(fill(t.text.unsupported, { line: n, text: word }))
    } else if ((m = NOTE.exec(s))) {
      const a = find(m[2]!.trim())
      const b = m[3] !== undefined ? find(m[3].trim()) : a
      events.push({ kind: 'note', side: m[1]!.toLowerCase() as 'over', a: Math.min(a, b), b: Math.max(a, b), lines: labelLines(m[4]!, t.clean) })
    } else if ((m = MESSAGE.exec(s))) {
      const arrow = ARROWS.find(a => a.token === m![2])!
      const from = find(m[1]!)
      const to = find(m[3]!)
      count++
      const text = (numbered ? fill(st.autonumber, { n: count }) : '') + labelLines(m[4]!, t.clean).join(' ')
      events.push({ kind: 'message', from, to, text, style: arrow.style, head: arrow.head })
    } else {
      warnings.push(fill(t.text.badLine, { line: n, text: s }))
    }
  }
  for (const open of stack) warnings.push(fill(t.text.unclosedBlock, { line: open.n, text: open.word }))
  return { who, events, warnings }
}

/** Rows an event takes. */
function rows(e: Event): number {
  return e.kind === 'message' ? (e.from === e.to ? 3 : 2) : e.kind === 'note' ? e.lines.length + 2 : 1
}

/**
 * Solves participant centres left to right: each sits at the furthest point
 * any constraint from a participant before it asks for. `need[i][j]` is the
 * least distance from centre i to centre j (i < j).
 */
export function centres(count: number, need: Map<string, number>): number[] {
  const c: number[] = []
  for (let j = 0; j < count; j++) {
    let at = 0
    for (let i = 0; i < j; i++) at = Math.max(at, c[i]! + (need.get(`${i}:${j}`) ?? 0))
    c.push(at)
  }
  return c
}

/** Draws a sequence diagram from its body lines. */
export function sequence(_header: Line, body: Line[], t: Tuning): Art {
  const st = t.sequence
  const { who, events, warnings } = read(body, t)
  if (who.length === 0) return { rows: [], width: 0, warnings: [...warnings, t.text.empty] }

  const boxW = who.map(w => Math.max(...w.lines.map(width)) + 2 * st.padding + 2)
  const boxH = Math.max(...who.map(w => w.lines.length + 2))
  const noteW = (lines: string[]) => Math.max(...lines.map(width)) + 2 * st.padding + 2
  const need = new Map<string, number>()
  const ask = (i: number, j: number, d: number) => {
    if (i < 0 || j >= who.length || i >= j) return
    need.set(`${i}:${j}`, Math.max(need.get(`${i}:${j}`) ?? 0, d))
  }
  // Neighbouring boxes keep `gap` blank columns between them.
  for (let i = 0; i + 1 < who.length; i++) ask(i, i + 1, boxW[i]! - Math.floor(boxW[i]! / 2) + st.gap + Math.floor(boxW[i + 1]! / 2))
  const selfReach = (text: string) => Math.max(st.selfReach, width(text) + 2)
  for (const e of events) {
    if (e.kind === 'message' && e.from !== e.to) ask(Math.min(e.from, e.to), Math.max(e.from, e.to), width(e.text) + 2 * st.messagePad)
    if (e.kind === 'message' && e.from === e.to) ask(e.from, e.from + 1, selfReach(e.text) + st.messagePad)
    if (e.kind === 'note' && e.side === 'right of') ask(e.a, e.a + 1, noteW(e.lines) + 3)
    if (e.kind === 'note' && e.side === 'left of') ask(e.a - 1, e.a, noteW(e.lines) + 3)
  }
  const c = centres(who.length, need)

  // Horizontal extent of everything, so the drawing can be shifted to start at column 0.
  let lo = 0
  let hi = 0
  const span = (a: number, b: number) => {
    lo = Math.min(lo, a)
    hi = Math.max(hi, b)
  }
  who.forEach((_, i) => span(c[i]! - Math.floor(boxW[i]! / 2), c[i]! - Math.floor(boxW[i]! / 2) + boxW[i]! - 1))
  const noteBox = (e: Extract<Event, { kind: 'note' }>): { x: number; w: number } => {
    const w = noteW(e.lines)
    if (e.side === 'right of') return { x: c[e.a]! + 2, w }
    if (e.side === 'left of') return { x: c[e.a]! - 1 - w, w }
    // Over one or two: centred on them, wide enough to cover both lifelines.
    const wide = Math.max(w, c[e.b]! - c[e.a]! + 5)
    const middle = Math.floor((c[e.a]! + c[e.b]!) / 2)
    return { x: middle - Math.floor(wide / 2), w: wide }
  }
  for (const e of events) {
    if (e.kind === 'note') {
      const b = noteBox(e)
      span(b.x, b.x + b.w - 1)
    }
    if (e.kind === 'message' && e.from === e.to) span(c[e.from]!, c[e.from]! + selfReach(e.text) + 1)
  }
  const dx = -lo
  const W = hi - lo + 1
  const margin = st.lifelineMargin
  const eventsH = events.reduce((a, e) => a + rows(e), 0)
  const footY = boxH + margin + eventsH + margin
  const H = st.mirror ? footY + boxH : footY
  const canvas = new Canvas(W, H, t.glyphs)
  const X = (i: number) => c[i]! + dx

  // Lifelines first; every other part is drawn over or joined to them.
  who.forEach((_, i) => canvas.path([{ x: X(i), y: boxH }, { x: X(i), y: footY - 1 }], st.lifeline, 'border'))

  let y = boxH + margin
  for (const e of events) {
    if (e.kind === 'message' && e.from !== e.to) {
      const s = X(e.from)
      const d = X(e.to)
      const dir = Math.sign(d - s)
      const end = e.head === 'none' ? d : d - dir
      canvas.path([{ x: s, y: y + 1 }, { x: end, y: y + 1 }], e.style, 'edge')
      if (e.head !== 'none') canvas.put(end, y + 1, dir > 0 ? t.glyphs.heads[e.head].right : t.glyphs.heads[e.head].left, 'edge')
      const a = Math.min(s, d)
      const room = Math.abs(d - s) - 1
      canvas.write(a + 1 + Math.floor((room - width(e.text)) / 2), y, e.text, 'edgeLabel')
    } else if (e.kind === 'message') {
      const s = X(e.from)
      const reach = s + selfReach(e.text)
      canvas.write(s + 2, y, e.text, 'edgeLabel')
      canvas.path([{ x: s, y: y + 1 }, { x: reach, y: y + 1 }, { x: reach, y: y + 2 }, { x: s + 1, y: y + 2 }], e.style, 'edge')
      if (e.head !== 'none') canvas.put(s + 1, y + 2, t.glyphs.heads[e.head].left, 'edge')
    } else if (e.kind === 'note') {
      const b = noteBox(e)
      const g = t.glyphs.boxes[st.boxes.note]!
      const h = e.lines.length + 2
      // The note hides the lifelines behind it.
      for (let j = 1; j < h - 1; j++) canvas.write(b.x + dx + 1, y + j, ' '.repeat(b.w - 2), 'text')
      canvas.box(b.x + dx, y, b.w, h, g, 'border')
      e.lines.forEach((line, j) => canvas.write(b.x + dx + 1 + Math.floor((b.w - 2 - width(line)) / 2), y + 1 + j, line, 'text'))
    } else {
      const lifelines = new Set(who.map((_, i) => X(i)))
      for (let x = 0; x < W; x++) if (!lifelines.has(x)) canvas.put(x, y, st.rule, 'border')
      if (e.word !== '') canvas.write(1, y, fill(st.ruleLabel, { word: e.word, text: e.text }).replace(/\s+$/, ' '), 'title')
    }
    y += rows(e)
  }

  const boxes = (top: number) =>
    who.forEach((w, i) => {
      const x = X(i) - Math.floor(boxW[i]! / 2)
      canvas.box(x, top, boxW[i]!, boxH, t.glyphs.boxes[st.boxes[w.kind]]!, 'border')
      const first = top + 1 + Math.floor((boxH - 2 - w.lines.length) / 2)
      w.lines.forEach((line, j) => canvas.write(x + 1 + Math.floor((boxW[i]! - 2 - width(line)) / 2), first + j, line, 'title'))
    })
  boxes(0)
  if (st.mirror) boxes(footY)
  return canvas.art(warnings)
}
