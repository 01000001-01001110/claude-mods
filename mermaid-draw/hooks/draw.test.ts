//! Renderer tests: display width, the canvas, label clean-up, the flowchart
//! and sequence readers and layouts, and golden drawings of each.
//!
//! Golden drawings are our own fixtures, drawn with the shipped tuning. They
//! pin spacing and glyphs together: a re-tune of either is a change to how
//! every diagram looks, so the goldens are re-drawn and reviewed with it.

import { expect, test } from 'claude-code/testing'

import { tuning as T } from '../data/mermaid'
import type { Art, Tuning } from '../types'
import { Canvas, DOWN, LEFT, maskKey, plain, RIGHT, UP } from './draw/canvas'
import { decode, labelLines } from './draw/clean'
import { fill } from './draw/common'
import { order, rank } from './draw/flowchart'
import { render } from './draw/index'
import { centres } from './draw/sequence'
import { cpWidth, glyphs, width } from './draw/width'

const G = T.glyphs

/** Draws `source` with the shipped tuning; fails the test when the type is not drawn. */
function draw(source: string, t: Tuning = T): Art {
  const art = render(source, t)
  if (!art) throw new Error(`not drawn: ${source}`)
  return art
}

/** The drawing's rows as strings. */
function rows(source: string, t: Tuning = T): string[] {
  return plain(draw(source, t))
}

/** Every role a drawing colours, with the text drawn in it. */
function roles(art: Art): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of art.rows) for (const s of row) m.set(s.role, (m.get(s.role) ?? '') + s.text)
  return m
}

// ---------------------------------------------------------------- width

test('width: ASCII is one cell, CJK and emoji two, combining marks and joiners none', () => {
  expect(width('abc')).toBe(3)
  expect(width('日本語')).toBe(6)
  expect(width('한국')).toBe(4)
  expect(width('🎉')).toBe(2)
  expect(width('ｆｕｌｌ')).toBe(8)
  // e + combining acute accent: one glyph, one cell.
  expect(width('é')).toBe(1)
  // Family emoji joined with ZWJ draws as one wide glyph.
  expect(width('👨‍👩‍👧')).toBe(2)
  // A skin-tone modifier rides on the emoji before it.
  expect(width('👍🏽')).toBe(2)
  expect(width('')).toBe(0)
  expect(cpWidth(0x07)).toBe(0)
  expect(cpWidth(0x9f)).toBe(0)
  expect(cpWidth(0xfe0f)).toBe(0)
  // Range edges: the first and last code point of a wide block, and just outside.
  expect(cpWidth(0x4e00)).toBe(2)
  expect(cpWidth(0x9fff)).toBe(2)
  expect(cpWidth(0x4dff)).toBe(1)
  expect(cpWidth(0x1f300)).toBe(2)
  expect(cpWidth(0x1f2ff)).toBe(1)
  expect(cpWidth(0x2fffff)).toBe(1)
})

test('glyphs: zero-width code points join the glyph before; a leading one is dropped', () => {
  expect(glyphs('aé')).toEqual([
    { text: 'a', width: 1 },
    { text: 'é', width: 1 },
  ])
  expect(glyphs('́a')).toEqual([{ text: 'a', width: 1 }])
  expect(glyphs('日a')).toEqual([
    { text: '日', width: 2 },
    { text: 'a', width: 1 },
  ])
})

// ---------------------------------------------------------------- canvas

test('canvas: a bent path draws its corners from the junction table', () => {
  const c = new Canvas(4, 3, G)
  c.path([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }], 'solid', 'edge')
  const out = plain(c.art())
  expect(out[0]).toBe(G.lines.solid.h.repeat(3) + G.junctions.dl)
  expect(out[1]).toBe('   ' + G.lines.solid.v)
  expect(out[2]).toBe('   ' + G.lines.solid.v)
})

test('canvas: two lines that cross make a cross, a T makes a tee', () => {
  const c = new Canvas(3, 3, G)
  c.path([{ x: 0, y: 1 }, { x: 2, y: 1 }], 'solid', 'edge')
  c.path([{ x: 1, y: 0 }, { x: 1, y: 2 }], 'solid', 'edge')
  expect(plain(c.art())[1]).toBe(G.lines.solid.h + G.junctions.udlr + G.lines.solid.h)
  const t = new Canvas(3, 2, G)
  t.path([{ x: 0, y: 0 }, { x: 2, y: 0 }], 'solid', 'edge')
  t.path([{ x: 1, y: 0 }, { x: 1, y: 1 }], 'solid', 'edge')
  expect(plain(t.art())[0]).toBe(G.lines.solid.h + G.junctions.dlr + G.lines.solid.h)
})

test('canvas: straight runs keep their style; the mask key spells sides in u, d, l, r order', () => {
  const c = new Canvas(3, 3, G)
  c.path([{ x: 0, y: 0 }, { x: 2, y: 0 }], 'dotted', 'edge')
  c.path([{ x: 0, y: 1 }, { x: 2, y: 1 }], 'thick', 'edge')
  c.path([{ x: 0, y: 2 }, { x: 0, y: 2 }], 'solid', 'edge')
  const out = plain(c.art())
  expect(out[0]).toBe(G.lines.dotted.h.repeat(3))
  expect(out[1]).toBe(G.lines.thick.h.repeat(3))
  expect(maskKey(UP | DOWN | LEFT | RIGHT)).toBe('udlr')
  expect(maskKey(RIGHT | UP)).toBe('ur')
  expect(maskKey(0)).toBe('')
})

test('canvas: a wide glyph takes two cells; writing over either half clears the other', () => {
  const c = new Canvas(5, 1, G)
  c.write(0, 0, '日本', 'text')
  expect(plain(c.art())).toEqual(['日本'])
  expect(c.art().width).toBe(4)
  c.put(1, 0, 'x', 'text')
  expect(plain(c.art())).toEqual([' x本'])
  c.put(2, 0, 'y', 'text')
  expect(plain(c.art())).toEqual([' xy'])
})

test('canvas: writes past the edge are dropped, and a wide glyph never straddles it', () => {
  const c = new Canvas(3, 1, G)
  c.write(1, 0, 'a日', 'text')
  expect(plain(c.art())).toEqual([' a'])
  c.write(-1, 0, 'zq', 'text')
  expect(plain(c.art())).toEqual(['qa'])
  c.put(9, 9, 'x', 'text')
  expect(plain(c.art())).toEqual(['qa'])
})

test('canvas: set glyphs win over lines; art trims right blanks and empty bottom rows, merging spans by role', () => {
  const c = new Canvas(6, 3, G)
  c.write(0, 0, 'ab', 'text')
  c.path([{ x: 0, y: 0 }, { x: 4, y: 0 }], 'solid', 'edge')
  expect(c.isSet(0, 0)).toBe(true)
  expect(c.isSet(3, 0)).toBe(false)
  const art = c.art(['w'])
  expect(art.rows).toEqual([[{ text: 'ab', role: 'text' }, { text: G.lines.solid.h.repeat(3), role: 'edge' }]])
  expect(art.width).toBe(5)
  expect(art.warnings).toEqual(['w'])
})

test('canvas: a box is framed with the glyph set it is given', () => {
  const c = new Canvas(4, 3, G)
  const g = G.boxes.round!
  c.box(0, 0, 4, 3, g, 'border')
  expect(plain(c.art())).toEqual([g.tl + g.h + g.h + g.tr, g.left + '  ' + g.right, g.bl + g.h + g.h + g.br])
  // Too small to frame: nothing drawn.
  const small = new Canvas(2, 2, G)
  small.box(0, 0, 1, 2, g, 'border')
  expect(small.art().rows).toEqual([])
})

// ---------------------------------------------------------------- clean

test('clean: entity codes from the data and numeric ones decode; others are left as written', () => {
  for (const [name, ch] of Object.entries(T.clean.entities)) expect(decode(`a#${name};b`, T.clean)).toBe(`a${ch}b`)
  expect(decode('#35;1', T.clean)).toBe('#1')
  expect(decode('#9829;', T.clean)).toBe('♥')
  expect(decode('#1114111;', T.clean)).toBe(String.fromCodePoint(0x10ffff))
  expect(decode('#1114112;', T.clean)).toBe('#1114112;')
  expect(decode('#nosuch;', T.clean)).toBe('#nosuch;')
})

test('clean: labels lose wrapping quotes and split at every <br> spelling', () => {
  expect(labelLines(' "a b" ', T.clean)).toEqual(['a b'])
  expect(labelLines('one<br>two<br/>three<BR />four', T.clean)).toEqual(['one', 'two', 'three', 'four'])
  expect(labelLines('"', T.clean)).toEqual(['"'])
  expect(labelLines('', T.clean)).toEqual([''])
})

test('fill: slots are filled, unknown slots are kept', () => {
  expect(fill('{a}-{b}-{c}', { a: 1, b: 'x' })).toBe('1-x-{c}')
})

// ---------------------------------------------------------------- layout pieces

test('rank: longest path from the sources, a long link spans more ranks, a cycle turns one edge round', () => {
  const chain = rank(['A', 'B', 'C'], [
    { from: 'A', to: 'B', span: 1 },
    { from: 'B', to: 'C', span: 1 },
    { from: 'A', to: 'C', span: 1 },
  ])
  expect([...chain.ranks]).toEqual([['A', 0], ['B', 1], ['C', 2]])
  expect(chain.reversed.size).toBe(0)
  const long = rank(['A', 'B'], [{ from: 'A', to: 'B', span: 3 }])
  expect(long.ranks.get('B')).toBe(3)
  const cyc = rank(['A', 'B', 'C'], [
    { from: 'A', to: 'B', span: 1 },
    { from: 'B', to: 'C', span: 1 },
    { from: 'C', to: 'A', span: 1 },
  ])
  expect([...cyc.reversed]).toEqual([2])
  expect(cyc.ranks.get('C')).toBe(2)
})

test('order: a barycenter sweep uncrosses two edges, and zero sweeps keep the order given', () => {
  const layers = [['A', 'B'], ['Y', 'X']]
  const up = new Map([['X', ['A']], ['Y', ['B']]])
  const down = new Map([['A', ['X']], ['B', ['Y']]])
  expect(order(layers, up, down, 1)).toEqual([['A', 'B'], ['X', 'Y']])
  expect(order(layers, up, down, 0)).toEqual(layers)
})

test('centres: each participant sits at the furthest point any earlier one asks for', () => {
  const need = new Map([['0:1', 5], ['0:2', 20], ['1:2', 4]])
  expect(centres(3, need)).toEqual([0, 5, 20])
  expect(centres(2, new Map())).toEqual([0, 0])
})

// ---------------------------------------------------------------- flowchart goldens

test('golden: flowchart TD with a decision, labelled branches and a loop back', () => {
  expect(rows('flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Wait]\n  D --> B')).toEqual([
    '       ┌───────┐',
    '       │ Start │',
    '       └───────┘',
    '           │',
    '           │',
    '           ▼',
    '      ╱────────╲',
    '      ◇ Ready? ◇',
    '      ╲────────╱',
    '           │ ▲',
    '     ┌─────┴─┼────┐',
    '     │       └────┼─┐',
    '    yes          no │',
    '     ▼            ▼ │',
    '┌─────────┐   ┌──────┐',
    '│ Ship it │   │ Wait │',
    '└─────────┘   └──────┘',
  ])
})

test('golden: flowchart LR with a text-in-the-middle label', () => {
  expect(rows('flowchart LR\n  A[Start] -- go --> B(Done)')).toEqual([
    '┌───────┐      ╭──────╮',
    '│ Start │──go─▶│ Done │',
    '└───────┘      ╰──────╯',
  ])
})

test('golden: CJK and emoji labels close their boxes on the right column', () => {
  expect(rows('graph TD\n  A[日本語] --> B((🎉 party))')).toEqual([
    ' ┌────────┐',
    ' │ 日本語 │',
    ' └────────┘',
    '      │',
    '      │',
    '      ▼',
    '╔══════════╗',
    '║ 🎉 party ║',
    '╚══════════╝',
  ])
})

test('golden: LR fan-in with &, a two-way link, circle and cross heads on their own ports', () => {
  expect(rows('flowchart LR\n  A & B --> C\n  C <--> D\n  C --o E\n  C --x F')).toEqual([
    '                    ┌───┐',
    '                 ┌─▶│ D │',
    '┌───┐     ┌───┐  │  └───┘',
    '│ A │─┐   │   │  │',
    '└───┘ │   │   │  │  ┌───┐',
    '      └┬─▶│ C │─┬┼─○│ E │',
    '┌───┐  │  │   │ ││  └───┘',
    '│ B │──┘  │   │◀┼┘',
    '└───┘     └───┘ │   ┌───┐',
    '                └──×│ F │',
    '                    └───┘',
  ])
})

test('golden: front-matter title, statements after ; on the header line, entities, touching labels moved apart', () => {
  expect(rows('---\ntitle: "Build"\n---\ngraph TD; A -- go on --> B; A --> |"say #quot;hi#quot;"| C')).toEqual([
    'Build',
    '',
    '    ┌───┐',
    '    │ A │',
    '    └───┘',
    '      │',
    '  ┌───┴───┐',
    'go on say "hi"',
    '  ▼       ▼',
    '┌───┐   ┌───┐',
    '│ B │   │ C │',
    '└───┘   └───┘',
  ])
})

// ---------------------------------------------------------------- flowchart reading

test('flowchart: every shape in the data draws with its own box glyphs', () => {
  for (const shape of T.flowchart.shapes) {
    const art = draw(`flowchart LR\n  N${shape.open}label${shape.close}`)
    const g = G.boxes[shape.box]!
    const out = plain(art)
    expect(art.warnings).toEqual([])
    expect(out[0]!.startsWith(g.tl)).toBe(true)
    expect(out[1]).toBe(`${g.left} label ${g.right}`)
    expect(out[2]!.startsWith(g.bl)).toBe(true)
  }
  // A bare id is its own label in the plain box.
  const plainBox = G.boxes[T.flowchart.plainBox]!
  expect(rows('flowchart LR\n  N')).toEqual([plainBox.tl + plainBox.h.repeat(3) + plainBox.tr, `${plainBox.left} N ${plainBox.right}`, plainBox.bl + plainBox.h.repeat(3) + plainBox.br])
})

test('flowchart: a quoted label may hold the closing delimiter', () => {
  expect(rows('flowchart LR\n  A["x] y"]')[1]).toBe('│ x] y │')
})

test('flowchart: link strokes and heads draw from the data glyphs', () => {
  const cases: [string, string, string][] = [
    ['-->', G.lines.solid.h, G.heads.arrow.right],
    ['---', G.lines.solid.h, G.lines.solid.h],
    ['-.->', G.lines.dotted.h, G.heads.arrow.right],
    ['-.-', G.lines.dotted.h, G.lines.dotted.h],
    ['==>', G.lines.thick.h, G.heads.arrow.right],
    ['--o', G.lines.solid.h, G.heads.circle.right],
    ['--x', G.lines.solid.h, G.heads.cross.right],
  ]
  for (const [link, stroke, tip] of cases) {
    const line = rows(`flowchart LR\n  A ${link} B`)[1]!
    // Between the boxes: `│ A │` then the gap, then `│ B │`.
    const gap = line.slice(5, line.length - 5)
    expect(gap).toBe(stroke.repeat(gap.length - 1) + tip)
  }
  const both = rows('flowchart LR\n  A <--> B')[1]!
  expect(both.slice(5, 6)).toBe(G.heads.arrow.left)
  expect(both.slice(-6, -5)).toBe(G.heads.arrow.right)
})

test('flowchart: TD heads point down, a loop back points up', () => {
  const out = rows('flowchart TD\n  A --> B\n  B --> A')
  expect(out.some(r => r.includes(G.heads.arrow.down))).toBe(true)
  expect(out.some(r => r.includes(G.heads.arrow.up))).toBe(true)
})

test('flowchart: a longer link adds ranks; chains, & groups and class suffixes read', () => {
  const short = draw('flowchart TD\n  A --> B')
  const long = draw('flowchart TD\n  A ----> B')
  expect(long.rows.length).toBeGreaterThan(short.rows.length)
  const chain = plain(draw('flowchart LR\n  A:::hot --> B --> C')).join('\n')
  for (const id of ['A', 'B', 'C']) expect(chain).toContain(`│ ${id} │`)
  expect(chain).not.toContain('hot')
  const fan = draw('flowchart TD\n  A & B --> C & D')
  // Four edges: two arrows reach each target's port, drawn once per target.
  expect(plain(fan).join('').split(G.heads.arrow.down).length - 1).toBe(2)
})

test('flowchart: a space between the arrow and |label| still reads (a common renderer bug)', () => {
  const out = rows('flowchart LR\n  A --> |yes| B')
  expect(out[1]).toContain('yes')
  expect(out[1]).toContain('│ B │')
})

test('flowchart: dotted and thick text-in-the-middle links read', () => {
  expect(rows('flowchart LR\n  A -. maybe .-> B')[1]).toContain(G.lines.dotted.h + 'maybe' + G.lines.dotted.h)
  expect(rows('flowchart LR\n  A == sure ==> B')[1]).toContain(G.lines.thick.h + 'sure' + G.lines.thick.h)
})

test('flowchart: styling statements are skipped without a warning', () => {
  for (const word of T.flowchart.ignored) expect(draw(`flowchart TD\n  A --> B\n  ${word} A something`).warnings).toEqual([])
})

test('flowchart: unsupported statements, unreadable lines and self loops warn with their line number', () => {
  const art = draw('flowchart TD\n  A --> B\n  subgraph one\n  B --> ?? weird\n  end\n  C --> C')
  expect(art.warnings).toEqual([
    fill(T.text.unsupported, { line: 3, text: 'subgraph' }),
    fill(T.text.badLine, { line: 4, text: 'B --> ?? weird' }),
    fill(T.text.unsupported, { line: 5, text: 'end' }),
    fill(T.text.selfLoop, { line: 6, text: 'C' }),
  ])
  // The bad line left no node behind.
  expect(plain(art).join('\n')).not.toContain('??')
})

test('flowchart: a direction outside the data is not drawn and says why; no nodes is empty', () => {
  const rl = draw('flowchart RL\n  A --> B')
  expect(rl.rows).toEqual([])
  expect(rl.warnings).toEqual([fill(T.text.unsupported, { line: 1, text: 'RL' })])
  for (const d of Object.keys(T.flowchart.directions)) expect(draw(`flowchart ${d}\n  A --> B`).rows.length).toBeGreaterThan(0)
  const empty = draw('flowchart TD\n  classDef x fill:#f00')
  expect(empty.rows).toEqual([])
  expect(empty.warnings).toEqual([T.text.empty])
  // `graph` alone runs down.
  expect(rows('graph\n  A --> B')).toEqual(rows('graph TD\n  A --> B'))
})

test('flowchart: TD labels that would overlap are moved apart, and the drawing widens to hold them', () => {
  const art = draw('flowchart TD\n  A -->|first long label| B\n  A -->|second long label| C')
  const row = plain(art).find(r => r.includes('first long label'))!
  expect(row).toContain('first long label second long label')
  expect(art.width).toBeGreaterThanOrEqual(width('first long label second long label'))
})

test('flowchart: role colours: boxes border, labels text, lines edge, edge labels edgeLabel', () => {
  const r = roles(draw('flowchart LR\n  A -->|yes| B'))
  expect(r.get('border')).toContain(G.boxes.square!.tl)
  expect(r.get('text')).toContain('A')
  expect(r.get('edge')).toContain(G.heads.arrow.right)
  expect(r.get('edgeLabel')).toBe('yes')
})

// ---------------------------------------------------------------- sequence

const SEQ = 'sequenceDiagram\n  autonumber\n  participant A as Alice\n  actor B as Bob\n  A->>B: Hello Bob\n  B-->>A: Hi\n  loop every minute\n    A->>A: think\n  end\n  Note right of B: a note\n  Note over A,B: shared\n  A-xB: bye'

test('golden: sequence with numbering, a reply, a loop, a self message, notes and a cross head', () => {
  expect(rows(SEQ)).toEqual([
    '┌───────┐        ╔═════╗',
    '│ Alice │        ║ Bob ║',
    '└───────┘        ╚═════╝',
    '    ┆               ┆',
    '    ┆ 1. Hello Bob  ┆',
    '    ├──────────────▶┆',
    '    ┆     2. Hi     ┆',
    '    ┆◀┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤',
    '┄ loop every minute ┆┄┄┄┄┄┄┄┄┄┄┄',
    '    ┆ 3. think      ┆',
    '    ├─────────┐     ┆',
    '    ┆◀────────┘     ┆',
    '┄┄┄┄┆┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┆┄┄┄┄┄┄┄┄┄┄┄',
    '    ┆               ┆ ┌┄┄┄┄┄┄┄┄┐',
    '    ┆               ┆ ┆ a note ┆',
    '    ┆               ┆ └┄┄┄┄┄┄┄┄┘',
    '  ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐',
    '  ┆      shared       ┆',
    '  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘',
    '    ┆    4. bye     ┆',
    '    ├──────────────×┆',
    '    ┆               ┆',
    '┌───────┐        ╔═════╗',
    '│ Alice │        ║ Bob ║',
    '└───────┘        ╚═════╝',
  ])
})

test('golden: sequence with CJK names and an async message', () => {
  expect(rows('sequenceDiagram\n  participant 客户\n  participant S as Server\n  客户->>S: 你好 👋\n  S--)客户: ok')).toEqual([
    '┌──────┐   ┌────────┐',
    '│ 客户 │   │ Server │',
    '└──────┘   └────────┘',
    '    ┆           ┆',
    '    ┆  你好 👋  ┆',
    '    ├──────────▶┆',
    '    ┆    ok     ┆',
    '    ┆◁┄┄┄┄┄┄┄┄┄┄┤',
    '    ┆           ┆',
    '┌──────┐   ┌────────┐',
    '│ 客户 │   │ Server │',
    '└──────┘   └────────┘',
  ])
})

test('sequence: every arrow draws its stroke and head from the data', () => {
  const cases: [string, string, string][] = [
    ['->>', G.lines.solid.h, G.heads.arrow.right],
    ['-->>', G.lines.dotted.h, G.heads.arrow.right],
    ['-x', G.lines.solid.h, G.heads.cross.right],
    ['--x', G.lines.dotted.h, G.heads.cross.right],
    ['-)', G.lines.solid.h, G.heads.open.right],
    ['--)', G.lines.dotted.h, G.heads.open.right],
  ]
  for (const [arrow, stroke, tip] of cases) {
    const line = rows(`sequenceDiagram\n  A${arrow}B: m`)[5]!
    expect(line.trimEnd().endsWith(stroke + tip + G.lines[T.sequence.lifeline].v)).toBe(true)
  }
  // No head: the line runs into the target's lifeline and joins it.
  expect(rows('sequenceDiagram\n  A->B: m')[5]!.trimEnd().endsWith(G.lines.solid.h + G.junctions.udl)).toBe(true)
  expect(rows('sequenceDiagram\n  A-->B: m')[5]!.trimEnd().endsWith(G.lines.dotted.h + G.junctions.udl)).toBe(true)
  // Activation marks are read and dropped.
  expect(rows('sequenceDiagram\n  A->>+B: m\n  B-->>-A: n').join('\n')).not.toContain('+')
})

test('sequence: a message never crowds its lifelines, however long its text', () => {
  for (const text of ['x', 'a much longer message text', '長いメッセージ']) {
    const out = rows(`sequenceDiagram\n  A->>B: ${text}`)
    const textRow = out[4]!
    const lifeline = G.lines[T.sequence.lifeline].v
    const left = textRow.indexOf(lifeline)
    const right = textRow.lastIndexOf(lifeline)
    const inner = textRow.slice(left + 1, right)
    expect(width(inner)).toBeGreaterThanOrEqual(width(text) + 2 * T.sequence.messagePad - 1)
    expect(inner.trim()).toBe(text)
  }
})

test('sequence: alt and else draw labelled rules; rect and box draw nothing, their end swallowed', () => {
  const out = rows('sequenceDiagram\n  A->>B: m\n  alt ok\n    B->>A: y\n  else bad\n    B->>A: n\n  end\n  rect rgb(0,0,0)\n    A->>B: z\n  end')
  const ruleRows = out.filter(r => r.startsWith(T.sequence.rule))
  expect(ruleRows).toHaveLength(3)
  expect(ruleRows[0]).toContain(fill(T.sequence.ruleLabel, { word: 'alt', text: 'ok' }).trim())
  expect(ruleRows[1]).toContain(fill(T.sequence.ruleLabel, { word: 'else', text: 'bad' }).trim())
  expect(out.join('\n')).not.toContain('rgb')
})

test('sequence: a stray end, an unclosed block, an unsupported and an unreadable line warn', () => {
  const art = draw('sequenceDiagram\n  A->>B: m\n  end\n  loop forever\n  create participant C\n  what is this')
  expect(art.warnings).toEqual([
    fill(T.text.strayEnd, { line: 3, text: 'end' }),
    fill(T.text.unsupported, { line: 5, text: 'create' }),
    fill(T.text.badLine, { line: 6, text: 'what is this' }),
    fill(T.text.unclosedBlock, { line: 4, text: 'loop' }),
  ])
  for (const word of T.sequence.ignored) expect(draw(`sequenceDiagram\n  A->>B: m\n  ${word} A`).warnings).toEqual([])
})

test('sequence: notes left of, right of and over sit where they say', () => {
  const left = rows('sequenceDiagram\n  participant A\n  participant B\n  Note left of B: n')
  const right = rows('sequenceDiagram\n  participant A\n  participant B\n  Note right of A: n')
  const lifeline = G.lines[T.sequence.lifeline].v
  const noteRow = (out: string[]) => out.find(r => r.includes(' n '))!
  // Left of B: the note ends before B's lifeline; right of A: it starts after A's.
  const l = noteRow(left)
  expect(l.lastIndexOf(lifeline)).toBeGreaterThan(l.indexOf(' n '))
  const r = noteRow(right)
  expect(r.indexOf(lifeline)).toBeLessThan(r.indexOf(' n '))
  // A note left of the first participant pushes the drawing right instead of off the edge.
  expect(rows('sequenceDiagram\n  participant A\n  Note left of A: far left').some(row => row.includes('far left'))).toBe(true)
})

test('sequence: mirror draws the participants again at the bottom', () => {
  const on = rows('sequenceDiagram\n  A->>B: m')
  const off = rows('sequenceDiagram\n  A->>B: m', { ...T, sequence: { ...T.sequence, mirror: false } })
  const boxH = 3
  expect(on.length - off.length).toBe(boxH)
  expect(on.slice(-boxH)).toEqual(on.slice(0, boxH))
})

test('sequence: participants are named in title colour; messages in edgeLabel; no participants is empty', () => {
  const r = roles(draw('sequenceDiagram\n  A->>B: hi'))
  expect(r.get('title')).toBe('ABAB')
  expect(r.get('edgeLabel')).toBe('hi')
  const empty = draw('sequenceDiagram\n  autonumber')
  expect(empty.rows).toEqual([])
  expect(empty.warnings).toEqual([T.text.empty])
})

// ---------------------------------------------------------------- front door

test('render: unknown types, an empty source and unclosed front matter are not drawn', () => {
  expect(render('gantt\n  title x', T)).toBeNull()
  expect(render('pie\n  "a": 1', T)).toBeNull()
  expect(render('', T)).toBeNull()
  expect(render('%% only a comment', T)).toBeNull()
  expect(render('---\ntitle: x\ngraph TD\n  A-->B', T)).toBeNull()
})

test('render: comments, directives, blank lines and CRLF line ends are ignored', () => {
  const clean = rows('flowchart LR\n  A --> B')
  expect(rows('\n%%{init: {"theme":"dark"}}%%\r\nflowchart LR\r\n  %% a note\r\n\r\n  A --> B\r\n')).toEqual(clean)
})
