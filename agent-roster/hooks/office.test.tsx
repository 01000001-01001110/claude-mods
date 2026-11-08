//! The office's tests (DESIGN.md, additions). Expectations are computed from the shipped data (`T.office`,
//! `T.officeText`), so a re-tune does not break them and a broken data file does. The rules are tested on plain
//! values, every threshold at its boundaries; the view is driven through the engine (`/roster view office`, spawns,
//! held tool calls, permission asks, turn ends, the frame timer, the hotkey and the close control) and its golden
//! frames are asserted on what they draw: the terminal's Raster cells decoded back to glyphs and colours, the
//! desktop's SVG, every word, the hover card, the wrapping, and the inline rows. Stored state from another shape
//! is seeded through `state.get`.
//!
//! The pictures are checked against a composite the tests build themselves from the sprite rows, so a fault in
//! the module's own compositing shows.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { tuning as T } from '../data/agent-roster'
import type { Card, GateLog, OfficeStateId } from '../types'
import { DESK_SHAPE, blankDesk } from './desk-rules'
import { cells } from './geometry'
import {
  base64,
  cardPlace,
  colorWord,
  deskCells,
  deskRowsOf,
  deskSvg,
  desksPerRow,
  frameAt,
  frameCount,
  halfBlocks,
  isMoving,
  officeStateOf,
  packCells,
  rasterSize,
  shirtOf,
  spriteLetters,
  toolNow,
} from './office-rules'
import { rasterKey } from './office'
import { STORE_SHAPE, blankCard, blankGate } from './records'
import { clip, counted, fill, tokensShort } from './words'

const O = T.office
const OX = T.officeText
const G = T.glyphs
const PANE = T.pane.id
const PLUGIN = 'agent-roster'
const W = O.sprite.width
const STATES = Object.keys(O.states) as OfficeStateId[]
const DEFAULT = 0x01000000

type Dollar = Parameters<TestBody>[0]

// ---------------------------------------------------------------- the host beneath

/** The host's answers a drawing test needs: a mocked clock, the status line, turns, the pane, blits recorded. */
function host(on: On) {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  const blits: { key: string; cells: string }[] = []
  on('ui.blit', (_$, e) => {
    const b = e as { key: string; cells?: string }
    blits.push({ key: b.key, cells: b.cells ?? '' })
    return { value: {} } as never
  })
  return { clock, blits }
}

/**
 * Counts state reads. With no event and no drawing, only the office's frame timer reads state, so reads that go on
 * while nothing happens show a timer left running. (The clock's own events are the mocked clock's to answer.)
 */
function countReads(on: On) {
  const reads = { n: 0 }
  on('state.get', (_$, e, next) => {
    reads.n += 1
    return next(e)
  })
  return reads
}

/** A Pane drawing request `bodyColumns` wide, docked unless said otherwise. */
function paneAsk(bodyColumns: number, placement: 'dock' | 'inline' = 'dock') {
  return {
    plugin: PLUGIN,
    component: 'Pane' as const,
    requestId: PANE,
    props: { title: T.pane.title, isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }
}

let callN = 0
/** A spawn request as the engine raises it. */
function spawnAsk(description: string, subagentType = 'general-purpose') {
  return {
    prompt: description,
    description,
    subagentType,
    tool_use_id: `os${++callN}`,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  }
}

/** `/roster <args>`, its reply. */
async function roster($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: T.pane.command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  return r.text ?? ''
}

/** Agents get ids `<prefix>1`, `<prefix>2`, … as they spawn. */
function spawnsAs(on: On, prefix: string) {
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `${prefix}${++n}` }))
}

/**
 * A beneath tool.call that holds every call whose id is in `held` open until `release(id)`, so a call can be
 * drawn while it runs; the others answer at once. `entered(id)` resolves once that call is held.
 */
function holdCalls(on: On, held: string[]) {
  const releases = new Map<string, () => void>()
  const arrivals = new Map<string, () => void>()
  const arrived = new Map(held.map(id => [id, new Promise<void>(r => arrivals.set(id, r))] as const))
  on('tool.call', async (_$, e) => {
    if (held.includes(e.tool_use_id)) {
      arrivals.get(e.tool_use_id)?.()
      await new Promise<void>(r => releases.set(e.tool_use_id, r))
    }
    return { result: {}, text: 'ok' } as never
  })
  return { entered: (id: string) => arrived.get(id) as Promise<void>, release: (id: string) => releases.get(id)?.() }
}

// ---------------------------------------------------------------- reading drawings

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[]; hover?: Record<string, unknown> }
const isNode = (n: unknown): n is Drawn => typeof n === 'object' && n !== null && typeof (n as Drawn).type === 'string'
const kidsOf = (n: Drawn) => ((n.children ?? []) as unknown[]).flat(Infinity as 1).filter(isNode)
const textIn = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : isNode(n) ? ((n.children ?? []) as unknown[]).flat(Infinity as 1).map(textIn).join('') : ''

/** Every node in a drawing, depth first. */
function nodes(n: unknown, out: Drawn[] = []): Drawn[] {
  if (!isNode(n)) return out
  out.push(n)
  for (const k of kidsOf(n)) nodes(k, out)
  return out
}

/** The first node `pick` accepts. */
const findNode = (tree: unknown, pick: (n: Drawn) => boolean) => nodes(tree).find(pick)

/** Raster cells decoded: `[glyph, fg, bg]` rows. */
function decodeCells(encoded: string, columns: number): [string, number, number][][] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i += 4) {
    const quad = Array.from(encoded.slice(i, i + 4)).map(ch => (ch === '=' ? -1 : alphabet.indexOf(ch)))
    const n = ((quad[0] ?? 0) << 18) | ((quad[1] ?? 0) << 12) | (Math.max(0, quad[2] ?? 0) << 6) | Math.max(0, quad[3] ?? 0)
    bytes.push((n >> 16) & 255)
    if ((quad[2] ?? -1) >= 0) bytes.push((n >> 8) & 255)
    if ((quad[3] ?? -1) >= 0) bytes.push(n & 255)
  }
  const word = (at: number) => ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
  const flat: [string, number, number][] = []
  for (let at = 0; at + 12 <= bytes.length; at += 12) flat.push([String.fromCodePoint(word(at)), word(at + 4), word(at + 8)])
  const rows: [string, number, number][][] = []
  for (let i = 0; i < flat.length; i += columns) rows.push(flat.slice(i, i + columns))
  return rows
}

/**
 * The tests' own composite of a state's frame: the sprite's base, the pose frame over it at the avatar's place,
 * the screen frame at the monitor's; then each letter's colour (tint, shirt, palette). Written apart from the
 * module's, so a fault in either shows.
 */
function expectedPaint(id: string, state: OfficeStateId, index: number): (string | null)[][] {
  const look = O.states[state]
  const grid = O.sprite.base.map(r => r.split(''))
  const lay = (frames: string[][] | undefined, at: { x: number; y: number }) => {
    const f = frames && frames.length > 0 ? frames[index % frames.length] : undefined
    f?.forEach((line, dy) => line.split('').forEach((ch, dx) => {
      const row = grid[at.y + dy]
      if (ch !== '.' && row && at.x + dx < row.length) row[at.x + dx] = ch
    }))
  }
  lay(O.sprite.poses[look.pose], O.sprite.avatar)
  lay(O.sprite.screens[look.screen], O.sprite.screen)
  return grid.map(r => r.map(ch => (ch === '.' ? null : look.tint[ch] ?? (ch === 's' ? shirtOf(id) : O.palette[ch] ?? null))))
}

/** What a Raster of `paint` must hold, cell by cell, by the half-block rule. */
function expectedCells(paint: (string | null)[][]): [string, number, number][][] {
  const word = (c: string | null) => (c === null ? DEFAULT : parseInt(c.slice(1), 16))
  const out: [string, number, number][][] = []
  for (let y = 0; y < paint.length; y += 2) {
    out.push(
      (paint[y] ?? []).map((up, x) => {
        const down = paint[y + 1]?.[x] ?? null
        if (up === null && down === null) return [' ', DEFAULT, DEFAULT]
        if (up === null) return ['▄', word(down), DEFAULT]
        return ['▀', word(up), word(down)]
      }),
    )
  }
  return out
}

/** The text of a drawn office: the top row, then each row of desks side by side (pictures as their glyphs). */
function officeText(tree: unknown, width: number): string[] {
  const lines: string[] = []
  const root = isNode(tree) ? tree : null
  if (root === null) return lines
  for (const part of kidsOf(root)) {
    const key = String(part.props?.key ?? '')
    if (key === 'office-top') {
      const pieces = nodes(part).filter(n => n.type === 'Text' || n.type === 'Button')
      lines.push(pieces.map(p => (p.type === 'Button' ? (p.props?.hotkey ? `${String(p.props.hotkey)}: ` : '') + (textIn(p) || String(p.props?.label ?? '')) : textIn(p))).join(' '))
    } else if (key.startsWith('office-row-')) {
      lines.push('')
      const columns = kidsOf(part).map(deskBox => {
        const col: string[] = []
        for (const k of kidsOf(deskBox)) {
          if (k.type === 'Raster') for (const r of decodeCells(String(k.props?.cells), Number(k.props?.columns))) col.push(r.map(c => c[0]).join(''))
          else if (k.type === 'Text') col.push(textIn(k))
        }
        return col
      })
      const height = Math.max(0, ...columns.map(c => c.length))
      for (let i = 0; i < height; i += 1) {
        const line = columns.map(c => (c[i] ?? '').padEnd(W)).join(' '.repeat(O.deskGap)).trimEnd()
        // A row of desks wider than the pane is marked, for the fit tests.
        lines.push(cells(line) > width ? `${line} <past ${width}>` : line)
      }
    } else lines.push(textIn(part))
  }
  return lines
}

/** The office drawn at `cols`, on `surface`, docked or inline. */
async function officeAt($: Dollar, cols: number, placement: 'dock' | 'inline' = 'dock', surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...paneAsk(cols, placement), surface })
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}

/** A desk's Box in a drawing, by agent id. */
const deskBox = (tree: unknown, id: string) => findNode(tree, n => n.type === 'Box' && n.props?.key === `office-desk-${id}`)

/** The two words under a desk: its name and its state. */
const deskWords = (desk: Drawn | undefined) => (desk ? kidsOf(desk).filter(k => k.type === 'Text').map(textIn) : [])

// ---------------------------------------------------------------- fixtures

const card = (id: string, o: Partial<Card> = {}): Card => ({ ...blankCard, id, type: 'general-purpose', kind: 'general-purpose', description: `task ${id}`, spawnedAt: 1, ...o })
const gateWith = (checks: { id: string; verdict: 'rule' | 'ask' | 'cleared' | 'deny' }[]): GateLog => ({
  ...blankGate,
  recent: checks.map(c => ({ id: c.id, tool: 'Bash', bucket: 'shell', verdict: c.verdict, inSubagent: true, detail: '', at: 1 })),
})

// ================================================================ the data

test("the sprite is well formed: every row the sprite's width, every layer inside it, every letter painted", () => {
  const known = new Set([...Object.keys(O.palette), '.', 's'])
  expect(O.sprite.base.length).toBe(O.sprite.height)
  for (const row of O.sprite.base) expect([row, cells(row)]).toEqual([row, W])
  const check = (frames: string[][], at: { x: number; y: number }, name: string) => {
    expect([name, frames.length > 0]).toEqual([name, true])
    for (const f of frames) {
      expect([name, at.y + f.length <= O.sprite.height]).toEqual([name, true])
      const width = cells(f[0] ?? '')
      for (const line of f) {
        expect([name, line, cells(line), at.x + cells(line) <= W]).toEqual([name, line, width, true])
        for (const ch of line) expect([name, ch, known.has(ch)]).toEqual([name, ch, true])
      }
    }
  }
  for (const [name, frames] of Object.entries(O.sprite.poses)) check(frames, O.sprite.avatar, `pose ${name}`)
  for (const [name, frames] of Object.entries(O.sprite.screens)) check(frames, O.sprite.screen, `screen ${name}`)
  for (const row of O.sprite.base) for (const ch of row) expect([ch, known.has(ch)]).toEqual([ch, true])
  for (const s of STATES) {
    const look = O.states[s]
    expect([s, O.sprite.poses[look.pose] !== undefined, O.sprite.screens[look.screen] !== undefined]).toEqual([s, true, true])
    for (const letter of Object.keys(look.tint)) expect([s, letter, known.has(letter)]).toEqual([s, letter, true])
    expect(cells(look.glyph)).toBe(1)
    expect(T.palettes.theme[look.color] !== undefined).toBe(true)
  }
  for (const hex of [...Object.values(O.palette), ...O.shirts, ...STATES.flatMap(s => Object.values(O.states[s].tint))]) expect([hex, /^#[0-9a-f]{6}$/i.test(hex)]).toEqual([hex, true])
  // A desk fits the narrowest pane, and the card never asks for less than its border and padding.
  expect(W <= T.pane.minColumns).toBe(true)
  expect(O.cardCols > O.cardInset).toBe(true)
})

// ================================================================ the rules

test('each agent shows its state: its end when finished; a raised hand, a progress bar or typing while it runs', () => {
  const idle = gateWith([])
  expect(officeStateOf(card('a', { status: 'done' }), undefined, idle)).toBe('done')
  expect(officeStateOf(card('a', { status: 'failed' }), undefined, idle)).toBe('failed')
  expect(officeStateOf(card('a', { status: 'stopped' }), undefined, idle)).toBe('stopped')
  expect(officeStateOf(card('a', { status: 'whatever' }), undefined, idle)).toBe('stopped')
  const tally = (live: { id: string; tool: string }[]) => ({ id: 'a', calls: live.length, tokens: 0, live, last: '' })
  expect(officeStateOf(card('a'), undefined, idle)).toBe('typing')
  expect(officeStateOf(card('a'), tally([{ id: 'e', tool: 'Edit' }]), idle)).toBe('typing')
  for (const shell of T.tools.shell) expect(officeStateOf(card('a'), tally([{ id: 'b', tool: shell }]), idle)).toBe('watching')
  // The latest live call decides between a shell and anything else.
  expect(officeStateOf(card('a'), tally([{ id: 'b', tool: 'Bash' }, { id: 'r', tool: 'Read' }]), idle)).toBe('typing')
  // A live call with an open ask raises the hand, over a shell; an ask settled or another agent's does not.
  const live = tally([{ id: 'k', tool: 'Bash' }])
  expect(officeStateOf(card('a'), live, gateWith([{ id: 'k', verdict: 'ask' }]))).toBe('waiting')
  expect(officeStateOf(card('a'), live, gateWith([{ id: 'k', verdict: 'cleared' }]))).toBe('watching')
  expect(officeStateOf(card('a'), live, gateWith([{ id: 'other', verdict: 'ask' }]))).toBe('watching')
  // A finished agent shows its end even with a call left live.
  expect(officeStateOf(card('a', { status: 'done' }), live, gateWith([{ id: 'k', verdict: 'ask' }]))).toBe('done')
  expect(toolNow(card('a'), live)).toBe('Bash')
  expect(toolNow(card('a', { status: 'done' }), live)).toBe(null)
  expect(toolNow(card('a'), undefined)).toBe(null)
})

test('only running states move, and only with motion on in the settings and in the data', () => {
  for (const s of STATES) {
    const running = s === 'typing' || s === 'watching' || s === 'waiting'
    expect([s, isMoving(s, true)]).toEqual([s, running && O.motion !== O.motionNone])
    expect([s, isMoving(s, false)]).toEqual([s, false])
    expect([s, isMoving(s, true, O.motionNone)]).toEqual([s, false])
  }
})

test("desks per row: exactly where n desks and their gaps fit, never fewer than one", () => {
  for (const n of [1, 2, 3, 4, 7]) {
    const fits = n * W + (n - 1) * O.deskGap
    expect([n, desksPerRow(fits - 1), desksPerRow(fits), desksPerRow(fits + 1)]).toEqual([n, Math.max(1, n - 1), n, n])
  }
  expect(desksPerRow(0)).toBe(1)
  expect(deskRowsOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  expect(deskRowsOf([], 3)).toEqual([])
})

test('the hover card stays inside the pane: moved left at the right edge, never past the left one', () => {
  for (const width of [T.pane.minColumns, 40, 66, 110, 144]) {
    for (let column = 0; column < desksPerRow(width); column += 1) {
      const x = column * (W + O.deskGap)
      const p = cardPlace(column, width)
      expect([width, column, x + p.left >= 0, x + p.left + p.width <= width, p.width]).toEqual([width, column, true, true, Math.min(O.cardCols, width)])
    }
  }
  // Right at the edge: a card that just fits is not moved; one cell more moves it one left.
  const edge = O.cardCols
  expect(cardPlace(0, edge)).toEqual({ left: 0, width: O.cardCols })
  expect(cardPlace(1, W + O.deskGap + O.cardCols)).toEqual({ left: 0, width: O.cardCols })
  expect(cardPlace(1, W + O.deskGap + O.cardCols - 1)).toEqual({ left: -1, width: O.cardCols })
})

test('frames: each state cycles through the least common multiple of its layers, all desks in step', () => {
  for (const s of STATES) {
    const look = O.states[s]
    const a = O.sprite.poses[look.pose]?.length ?? 1
    const b = O.sprite.screens[look.screen]?.length ?? 1
    let lcm = Math.max(a, b)
    while (lcm % a !== 0 || lcm % b !== 0) lcm += 1
    expect([s, frameCount(s)]).toEqual([s, lcm])
  }
  const n = frameCount('typing')
  expect([frameAt(O.frameMs - 1, n), frameAt(O.frameMs, n), frameAt(O.frameMs * n - 1, n), frameAt(O.frameMs * n, n)]).toEqual([0, 1, n - 1, 0])
  expect([frameAt(123_456, 1), frameAt(Number.NaN, n), frameAt(-5, n)]).toEqual([0, 0, 0])
})

test("every state's every frame composites as the tests' own reading of the sprite", () => {
  for (const s of STATES) {
    for (let i = 0; i < frameCount(s); i += 1) {
      const letters = spriteLetters(s, i)
      expect(letters.length).toBe(O.sprite.height)
      const cellsOut = decodeCells(deskCells('agent-x', s, i), W)
      expect([s, i, cellsOut]).toEqual([s, i, expectedCells(expectedPaint('agent-x', s, i))])
    }
  }
})

test('the states look apart: a green desk when done, a red screen when failed, a raised hand, a growing bar', () => {
  const paintAt = (s: OfficeStateId, i: number) => expectedPaint('p', s, i)
  const flat = (p: (string | null)[][]) => p.flat()
  expect(flat(paintAt('done', 0))).toContain(O.states.done.tint.D)
  expect(flat(paintAt('typing', 0))).not.toContain(O.states.done.tint.D)
  expect(flat(paintAt('failed', 0))).toContain(O.palette.R)
  expect(flat(paintAt('typing', 0))).not.toContain(O.palette.R)
  // The raised hand is above the head: in the top pixel row only while waiting.
  expect(paintAt('waiting', 0)[0]?.some(c => c === O.palette.a)).toBe(true)
  expect(paintAt('typing', 0)[0]?.some(c => c === O.palette.a)).toBe(false)
  // The progress bar lights one more pixel each frame.
  const lit = (i: number) => flat(paintAt('watching', i)).filter(c => c === O.palette.g).length
  expect(Array.from({ length: frameCount('watching') }, (_, i) => lit(i))).toEqual(Array.from({ length: frameCount('watching') }, (_, i) => i + 1))
  // Typing frames differ from one another: the hands and the screen move.
  expect(deskCells('p', 'typing', 0) === deskCells('p', 'typing', 1)).toBe(false)
})

test('half blocks: two pixel rows a cell; upper over lower, lower alone, or a blank', () => {
  const red = '#ff0000'
  const blue = '#0000ff'
  expect(halfBlocks([[red, null, null, red], [blue, blue, null, null]])).toEqual([
    [
      { glyph: '▀', fg: 0xff0000, bg: 0x0000ff },
      { glyph: '▄', fg: 0x0000ff, bg: DEFAULT },
      { glyph: ' ', fg: DEFAULT, bg: DEFAULT },
      { glyph: '▀', fg: 0xff0000, bg: DEFAULT },
    ],
  ])
  expect([colorWord('#00ff80'), colorWord(null), colorWord('teal'), colorWord('#12345')]).toEqual([0x00ff80, DEFAULT, DEFAULT, DEFAULT])
  expect(rasterSize()).toEqual({ columns: W, rows: Math.ceil(O.sprite.height / 2) })
})

test('cells pack as padded base64 of little-endian triplets', () => {
  const bytes = (s: string) => Uint8Array.from(Array.from(s).map(c => c.charCodeAt(0)))
  expect([base64(bytes('Man')), base64(bytes('Ma')), base64(bytes('M')), base64(bytes(''))]).toEqual(['TWFu', 'TWE=', 'TQ==', ''])
  const packed = packCells([[{ glyph: '█', fg: 0xff8800, bg: DEFAULT }, { glyph: 'a', fg: 1, bg: 2 }]])
  expect(decodeCells(packed, 2)).toEqual([[['█', 0xff8800, DEFAULT], ['a', 1, 2]]])
})

test('a desk as SVG: still, its one frame; moving, every frame shown in turn for the data\'s time', () => {
  const still = deskSvg('q', 'done', false, 0)
  expect(still).not.toContain('<animate')
  expect(still).toContain(`fill="${O.states.done.tint.D}"`)
  const moving = deskSvg('q', 'typing', true, 0)
  const n = frameCount('typing')
  expect(moving.split('<animate').length - 1).toBe(n)
  expect(moving).toContain(`dur="${n * O.frameMs}ms"`)
  expect(moving).toContain(`values="${['1', ...Array.from({ length: n - 1 }, () => '0')].join(';')}"`)
  // A moving request for a state of one frame is drawn still.
  expect(frameCount('done')).toBe(1)
  expect(deskSvg('q', 'done', true, 0)).not.toContain('<animate')
  expect(moving.length <= 131_072).toBe(true)
})

// ================================================================ the view, through the engine

test('/roster view office switches to the office; the hotkey and the switch go back to the deck', async ($, on) => {
  host(on)
  expect(await roster($, `${T.desk.verb} office`)).toBe(fill(T.deskText.viewSet, { view: 'office' }))
  expect(officeText(await officeAt($, 66), 66)[0]).toMatch(new RegExp(`^${OX.title}`))
  expect(await roster($, `${T.desk.verb} cubicle`)).toBe(T.deskText.viewUsage)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const placement of ['dock', 'inline'] as const) {
      await roster($, `${T.desk.verb} office`)
      const ui = await $.ui.mount({ ...paneAsk(66, placement), surface })
      const back = await ui.find({ type: 'Button', key: 'office-back' } as never)
      expect([back?.props.hotkey, back?.props.label, back?.props.plain]).toEqual([O.hotkey, OX.back, true])
      const dismiss = await ui.find({ type: 'Button', key: 'dismiss' } as never)
      expect([dismiss?.props.role, dismiss?.props.label]).toEqual(['dismiss', T.text.closeLabel])
      await ui.press({ key: 'office-back' })
      await ui.unmount()
      const after = await officeAt($, 66, placement, surface)
      expect(findNode(after, n => n.props?.key === 'office-top')).toBeUndefined()
      expect(findNode(after, n => n.props?.key === 'dismiss')).toBeDefined()
    }
  }
})

test('the close control closes the pane from the office', async ($, on) => {
  host(on)
  const closed: string[] = []
  on('ui.close', (_$, e) => (closed.push(e.id), { value: undefined }) as never)
  await roster($, `${T.desk.verb} office`)
  const ui = await $.ui.mount({ ...paneAsk(66), surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(closed).toEqual([PANE])
})

test('golden frame: three agents at 66 columns, one typing, one at a shell, one done; words, pictures and counts', async ($, on) => {
  const { clock } = host(on)
  await clock.advance(3_600_000)
  spawnsAs(on, 'g')
  const calls = holdCalls(on, ['g1-edit', 'g2-bash'])
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }
  })
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Write the parser tests'))
  await $.agent.spawn(spawnAsk('Run the suite'))
  await $.agent.spawn(spawnAsk('Review the diff'))
  const step = $.turn.step({ turnId: 'G', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'g1' })
  for await (const _ of step) void _
  await step.result
  const editing = $.tool.call({ tool: 'Edit', tool_use_id: 'g1-edit', agentId: 'g1', file_path: '/w/parser.test.ts', old_string: 'a', new_string: 'b' } as never)
  const shell = $.tool.call({ tool: 'Bash', tool_use_id: 'g2-bash', agentId: 'g2', command: 'npm test' } as never)
  await Promise.all([calls.entered('g1-edit'), calls.entered('g2-bash')])
  await $.turn.complete({ answer: 'looks good', durationMs: 4000, isAborted: false, turnId: 'G3', agentId: 'g3', reason: 'answer' })
  const tree = await officeAt($, 66)
  const now = 3_600_000
  const lines = officeText(tree, 66)
  const pic = (id: string, s: OfficeStateId) => expectedCells(expectedPaint(id, s, isMoving(s, true) ? frameAt(now, frameCount(s)) : 0)).map(r => r.map(c => c[0]).join(''))
  const label = (s: string) => clip(s, W).padEnd(W)
  const rowOf = (parts: string[]) => parts.join(' '.repeat(O.deskGap)).trimEnd()
  const p1 = pic('g1', 'typing')
  const p2 = pic('g2', 'watching')
  const p3 = pic('g3', 'done')
  const expected = [
    [OX.title, fill(OX.counts, { running: 2, total: 3 }), fill(OX.tokens, { tokens: tokensShort(1200) })].join(OX.sep) + ` ${O.hotkey}: ${OX.back} ${G.close}`,
    '',
    ...p1.map((_, i) => rowOf([p1[i] ?? '', p2[i] ?? '', p3[i] ?? ''])),
    rowOf([label('Write the parser tests'), label('Run the suite'), label('Review the diff')]),
    rowOf([label(O.states.typing.word), label(fill(O.states.watching.word, { tool: 'Bash' })), label(O.states.done.word)]),
  ]
  expect(lines).toEqual(expected)
  // The colours: each desk's Raster is the tests' composite for its state, cell for cell.
  for (const [id, s] of [['g1', 'typing'], ['g2', 'watching'], ['g3', 'done']] as const) {
    const raster = findNode(tree, n => n.type === 'Raster' && n.props?.key === rasterKey(id))
    expect([id, raster?.props?.columns, raster?.props?.rows]).toEqual([id, rasterSize().columns, rasterSize().rows])
    expect([id, decodeCells(String(raster?.props?.cells), W)]).toEqual([id, expectedCells(expectedPaint(id, s, isMoving(s, true) ? frameAt(now, frameCount(s)) : 0))])
    const words = deskWords(deskBox(tree, id))
    const color = T.palettes.theme[O.states[s].color]
    const stateText = findNode(deskBox(tree, id), n => n.type === 'Text' && textIn(n) === words[1])
    expect([id, stateText?.props?.color]).toEqual([id, color])
  }
  // The desktop: SVG pictures, the same words; the running ones animate, the done one is still.
  const desk = await officeAt($, 66, 'dock', 'desktop')
  const named = { g1: 'Write the parser tests', g2: 'Run the suite', g3: 'Review the diff' }
  for (const [id, s] of [['g1', 'typing'], ['g2', 'watching'], ['g3', 'done']] as const) {
    const box = deskBox(desk, id)
    const svg = box ? findNode(box, n => n.type === 'Svg') : undefined
    const source = String(svg?.props?.source ?? '')
    expect([id, source.includes('<animate')]).toEqual([id, s !== 'done'])
    expect([id, source.includes(`fill="${shirtOf(id)}"`)]).toEqual([id, true])
    const said = s === 'watching' ? fill(O.states.watching.word, { tool: 'Bash' }) : O.states[s].word
    expect(String(svg?.props?.alt)).toBe(fill(OX.alt, { name: clip(named[id], W * 2), state: said }))
    expect(deskWords(box)).toEqual(deskWords(deskBox(tree, id)))
    expect(findNode(box, n => n.type === 'Raster')).toBeUndefined()
  }
  calls.release('g1-edit')
  calls.release('g2-bash')
  await Promise.all([editing, shell])
})

test('a permission ask raises the hand; the desk types again once the call is cleared', async ($, on) => {
  host(on)
  spawnsAs(on, 'w')
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  on('tool.check', (_$, e) => ({ decision: e.tool_use_id === 'ask1' ? 'ask' : 'allow' }) as never)
  // The person's answer to the ask is held open, so the desk can be drawn while it waits.
  let answer: () => void = () => undefined
  let asked: () => void = () => undefined
  const isAsked = new Promise<void>(r => (asked = r))
  on('classic.PermissionRequest', async () => {
    asked()
    await new Promise<void>(r => (answer = r))
    return { decision: { behavior: 'allow' } } as never
  })
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Deploy the preview'))
  const pending = $.tool.call({ tool: 'Bash', tool_use_id: 'ask1', agentId: 'w1', command: 'deploy' } as never)
  await isAsked
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await officeAt($, 66, 'dock', surface)
    expect(deskWords(deskBox(tree, 'w1'))).toEqual([clip('Deploy the preview', W), O.states.waiting.word])
  }
  const raster = findNode(await officeAt($, 66), n => n.type === 'Raster')
  expect(decodeCells(String(raster?.props?.cells), W)).toEqual(expectedCells(expectedPaint('w1', 'waiting', frameAt(0, frameCount('waiting')))))
  answer()
  await pending
  expect(deskWords(deskBox(await officeAt($, 66), 'w1'))[1]).toBe(O.states.typing.word)
})

test('a failed agent shows a red screen and a stopped one leans back at a plain desk, on both surfaces', async ($, on) => {
  host(on)
  spawnsAs(on, 'f')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Break things'))
  await $.agent.spawn(spawnAsk('Give up'))
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'F1', agentId: 'f1', reason: 'error' } as never)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'F2', agentId: 'f2', reason: 'aborted' } as never)
  const tree = await officeAt($, 66)
  for (const [id, s] of [['f1', 'failed'], ['f2', 'stopped']] as const) {
    expect(deskWords(deskBox(tree, id))[1]).toBe(O.states[s].word)
    const raster = findNode(deskBox(tree, id), n => n.type === 'Raster')
    expect(decodeCells(String(raster?.props?.cells), W)).toEqual(expectedCells(expectedPaint(id, s, 0)))
  }
  const desk = await officeAt($, 66, 'dock', 'desktop')
  const svgOf = (id: string) => String(findNode(deskBox(desk, id), n => n.type === 'Svg')?.props?.source ?? '')
  expect(svgOf('f1')).toContain(`fill="${O.palette.R}"`)
  expect(svgOf('f2')).not.toContain(`fill="${O.palette.R}"`)
  expect(svgOf('f2')).not.toContain(`fill="${O.states.done.tint.D}"`)
})

test('hovering a desk reveals its card: task, the call running or the last one, tokens, and a live clock', async ($, on) => {
  const { clock } = host(on)
  await clock.advance(3_600_000)
  spawnsAs(on, 'h')
  const calls = holdCalls(on, ['h-read'])
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }
  })
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Map the call sites'))
  const step = $.turn.step({ turnId: 'H', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'h1' })
  for await (const _ of step) void _
  await step.result
  await $.tool.call({ tool: 'Grep', tool_use_id: 'h-grep', agentId: 'h1', pattern: 'loadConfig' } as never)
  const reading = $.tool.call({ tool: 'Read', tool_use_id: 'h-read', agentId: 'h1', file_path: '/w/a.ts' } as never)
  await calls.entered('h-read')
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await officeAt($, 66, 'dock', surface)
    const desk = deskBox(tree, 'h1')
    const hover = desk ? findNode(desk, n => n.type === 'Box' && n.props?.position === 'absolute') : undefined
    expect([hover?.props?.display, hover?.hover?.display, hover?.props?.key]).toEqual(['none', 'flex', undefined])
    expect([hover?.props?.top, hover?.props?.left, hover?.props?.width]).toEqual([O.cardTop, 0, O.cardCols])
    const texts = hover ? nodes(hover).filter(n => n.type === 'Text').map(textIn) : []
    expect(texts).toEqual([
      fill(OX.task, { task: 'Map the call sites' }),
      fill(OX.now, { tool: 'Read' }),
      fill(OX.tokensLine, { tokens: tokensShort(5000), ctx: tokensShort(4000), calls: counted(2, 'call') }),
      OX.elapsed,
    ])
    expect(hover ? findNode(hover, n => n.type === 'Client' && n.props?.key === 'office-clock-h1') !== undefined : false).toBe(true)
  }
  calls.release('h-read')
  await reading
  // Settled, the card names the last call by what it was about.
  const after = deskBox(await officeAt($, 66), 'h1')
  const lastLine = after ? nodes(findNode(after, n => n.props?.position === 'absolute')).filter(n => n.type === 'Text').map(textIn)[1] : ''
  expect(lastLine?.startsWith(fill(OX.last, { call: '' }))).toBe(true)
  // The live clock in the card counts the agent's time.
  await clock.advance(65_000)
  const ui = await $.ui.mount({ ...paneAsk(66), surface: 'terminal' })
  expect(textIn(await ui.drawn({ in: 'office-clock-h1' }))).toBe('1:05')
  await ui.unmount()
})

test('a card with no calls says so, and cards at the right edge move left to stay in the pane', async ($, on) => {
  host(on)
  spawnsAs(on, 'e')
  await roster($, `${T.desk.verb} office`)
  for (let i = 0; i < 4; i += 1) await $.agent.spawn(spawnAsk(`agent ${i}`))
  const tree = await officeAt($, 66)
  for (let i = 0; i < 4; i += 1) {
    const hover = findNode(deskBox(tree, `e${i + 1}`), n => n.props?.position === 'absolute')
    expect(nodes(hover).filter(n => n.type === 'Text').map(textIn)[1]).toBe(OX.noCalls)
    expect(hover?.props?.left).toBe(cardPlace(i, 66).left)
  }
  expect(cardPlace(3, 66).left < 0).toBe(true)
})

test('desks wrap into rows at 40, 66 and 110 columns, in spawn order, each row within the pane', { timeoutMs: 60_000 }, async ($, on) => {
  host(on)
  spawnsAs(on, 'r')
  await roster($, `${T.desk.verb} office`)
  for (let i = 0; i < 8; i += 1) await $.agent.spawn(spawnAsk(`desk ${i}`))
  for (const cols of [40, 66, 110]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const tree = await officeAt($, cols, 'dock', surface)
      const rows = nodes(tree).filter(n => n.type === 'Box' && String(n.props?.key ?? '').startsWith('office-row-'))
      const per = desksPerRow(cols)
      expect([cols, rows.map(r => kidsOf(r).length)]).toEqual([cols, deskRowsOf(Array.from({ length: 8 }, (_, i) => i), per).map(r => r.length)])
      const order = rows.flatMap(r => kidsOf(r).map(k => String(k.props?.key)))
      expect(order).toEqual(Array.from({ length: 8 }, (_, i) => `office-desk-r${i + 1}`))
      for (const r of rows) {
        const n = kidsOf(r).length
        expect([cols, n * W + (n - 1) * O.deskGap <= cols, r.props?.columnGap]).toEqual([cols, true, O.deskGap])
      }
      // One more desk would not have fitted a row.
      expect((per + 1) * W + per * O.deskGap > cols).toBe(true)
    }
    for (const line of officeText(await officeAt($, cols), cols)) expect([cols, line.includes('<past')]).toEqual([cols, false])
  }
  expect([desksPerRow(40), desksPerRow(66), desksPerRow(110)]).toEqual([2, 4, 7])
})

test("past the data's desks the rest are counted; with none the office says it is empty", async ($, on) => {
  host(on)
  spawnsAs(on, 'm')
  await roster($, `${T.desk.verb} office`)
  expect(officeText(await officeAt($, 66), 66).slice(1)).toEqual([OX.empty])
  for (let i = 0; i < O.maxDesks; i += 1) await $.agent.spawn(spawnAsk(`d${i}`))
  const full = officeText(await officeAt($, 110), 110)
  expect(full.some(l => l.startsWith('+'))).toBe(false)
  await $.agent.spawn(spawnAsk('one more'))
  const over = officeText(await officeAt($, 110), 110)
  expect(over[over.length - 1]).toBe(fill(OX.more, { n: 1 }))
  const tree = await officeAt($, 110)
  expect(nodes(tree).filter(n => String(n.props?.key ?? '').startsWith('office-desk-')).length).toBe(O.maxDesks)
})

test('inline: a compact row per agent, glyph and words, the rest counted past the pane\'s rows', async ($, on) => {
  host(on)
  spawnsAs(on, 'i')
  const calls = holdCalls(on, ['i-bash'])
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('only one'))
  const running = $.tool.call({ tool: 'Bash', tool_use_id: 'i-bash', agentId: 'i1', command: 'ls' } as never)
  await calls.entered('i-bash')
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await officeAt($, 80, 'inline', surface)
    const row = findNode(tree, n => n.type === 'Box' && n.props?.key === 'office-i1')
    expect(row ? kidsOf(row).map(textIn) : []).toEqual([
      O.states.watching.glyph,
      'only one',
      fill(OX.line, { state: fill(O.states.watching.word, { tool: 'Bash' }), tokens: tokensShort(0), calls: counted(1, 'call') }),
    ])
    expect(findNode(tree, n => n.type === 'Raster' || n.type === 'Svg')).toBeUndefined()
  }
  calls.release('i-bash')
  await running
  const room = T.pane.inlineRows - 1
  for (let i = 1; i < room; i += 1) await $.agent.spawn(spawnAsk(`agent ${i}`))
  const rowsOf = async () => nodes(await officeAt($, 80, 'inline')).filter(n => n.type === 'Box' && /^office-i\d+$/.test(String(n.props?.key ?? '')))
  expect((await rowsOf()).length).toBe(room)
  expect(textIn(await officeAt($, 80, 'inline')).includes('+')).toBe(false)
  await $.agent.spawn(spawnAsk('one too many'))
  expect((await rowsOf()).length).toBe(room - 1)
  const tree = await officeAt($, 80, 'inline')
  const last = isNode(tree) ? kidsOf(tree)[kidsOf(tree).length - 1] : undefined
  expect(textIn(last)).toBe(fill(OX.more, { n: 2 }))
})

test("the top row's counts go short below the data's narrow width, and the token count is left off there", async ($, on) => {
  host(on)
  spawnsAs(on, 'n')
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }
  })
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Work'))
  const top = async (cols: number) => textIn(findNode(await officeAt($, cols), n => n.props?.key === 'office-top' )?.children?.[0])
  expect(await top(T.sizes.narrowBelow)).toBe([OX.title, fill(OX.counts, { running: 1, total: 1 })].join(OX.sep))
  const step = $.turn.step({ turnId: 'N', index: 0, model: 'x', messageCount: 1, agentId: 'n1' })
  for await (const _ of step) void _
  await step.result
  expect(await top(T.sizes.narrowBelow)).toBe([OX.title, fill(OX.counts, { running: 1, total: 1 }), fill(OX.tokens, { tokens: tokensShort(150) })].join(OX.sep))
  expect(await top(T.sizes.narrowBelow - 1)).toBe([OX.title, fill(OX.countsNarrow, { running: 1, total: 1 })].join(OX.sep))
})

test('every office drawing fits from the narrowest pane up and keeps a graphical surface\'s text whole', { timeoutMs: 60_000 }, async ($, on) => {
  host(on)
  spawnsAs(on, 'z')
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('An agent with a description far longer than any pane is wide, to be cut', 'a-very-long-subagent-type-name'))
  await $.agent.spawn(spawnAsk('second'))
  await $.tool.call({ tool: 'mcp__some_server__a_tool_with_a_long_name', tool_use_id: 'zz', agentId: 'z1' } as never)
  for (const cols of [T.pane.minColumns, W, W + O.deskGap + W - 1, 40, 66, 110, 144]) {
    for (const placement of ['dock', 'inline'] as const) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const tree = await officeAt($, cols, placement, surface)
        for (const n of nodes(tree)) {
          if (n.type === 'Text' && surface === 'desktop') expect([cols, textIn(n), textIn(n) === textIn(n).trim()]).toEqual([cols, textIn(n), true])
          if (n.type === 'Box' && typeof n.props?.width === 'number') expect([cols, n.props.width <= Math.max(cols, T.pane.minColumns)]).toEqual([cols, true])
        }
        if (placement === 'dock' && surface === 'terminal') for (const line of officeText(tree, Math.max(cols, T.pane.minColumns))) expect(line.includes('<past')).toBe(false)
      }
    }
  }
})

// ---------------------------------------------------------------- motion

test('while agents run, the timer blits each moving desk its next frame; it stops when they finish', async ($, on) => {
  const { clock, blits } = host(on)
  const ticks = countReads(on)
  spawnsAs(on, 't')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('typist'))
  await $.agent.spawn(spawnAsk('finished'))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'T2', agentId: 't2', reason: 'answer' })
  const n = frameCount('typing')
  for (let i = 1; i <= n; i += 1) await clock.advance(O.frameMs)
  // Only the running desk, one blit a frame, each the frame for the clock's time.
  expect(blits.map(b => b.key)).toEqual(Array.from({ length: n }, () => rasterKey('t1')))
  const shown = blits.map(b => decodeCells(b.cells, W))
  for (let i = 0; i < n; i += 1) expect([i, shown[i]]).toEqual([i, expectedCells(expectedPaint('t1', 'typing', (i + 1) % n))])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'T1', agentId: 't1', reason: 'answer' })
  const before = blits.length
  // The next tick finds nobody running and stops the timer: no periods after it.
  await clock.advance(O.frameMs)
  const stoppedAt = ticks.n
  for (let i = 0; i < 5; i += 1) await clock.advance(O.frameMs)
  expect(blits.length).toBe(before)
  expect(ticks.n).toBe(stoppedAt)
  // A new agent starts the timer again.
  await $.agent.spawn(spawnAsk('another'))
  await clock.advance(O.frameMs)
  expect(blits[blits.length - 1]?.key).toBe(rasterKey('t3'))
})

test('a desk is drawn at the frame the clock is on, so a redraw carries on from the blits', async ($, on) => {
  const { clock } = host(on)
  spawnsAs(on, 'c')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('typist'))
  const n = frameCount('typing')
  for (let k = 1; k <= n; k += 1) {
    await clock.advance(O.frameMs)
    // The mocked clock starts at 0.
    const now = k * O.frameMs
    const raster = findNode(await officeAt($, 66), x => x.type === 'Raster')
    expect([k, decodeCells(String(raster?.props?.cells), W)]).toEqual([k, expectedCells(expectedPaint('c1', 'typing', frameAt(now, n)))])
  }
  expect(new Set(Array.from({ length: n }, (_, k) => frameAt(O.frameMs * (k + 1), n))).size).toBe(n)
})

test('the timer runs only in the office: on the deck or the desk nothing is blitted', async ($, on) => {
  const { clock, blits } = host(on)
  const ticks = countReads(on)
  spawnsAs(on, 'v')
  await $.agent.spawn(spawnAsk('runs'))
  // No timer at all outside the office, not merely one that blits nothing: idle time reads no state.
  const onDeck = ticks.n
  for (let i = 0; i < 4; i += 1) await clock.advance(O.frameMs)
  expect(ticks.n).toBe(onDeck)
  await roster($, `${T.desk.verb} desk`)
  const onDesk = ticks.n
  for (let i = 0; i < 4; i += 1) await clock.advance(O.frameMs)
  expect(ticks.n).toBe(onDesk)
  expect(blits).toEqual([])
  await roster($, `${T.desk.verb} office`)
  await clock.advance(O.frameMs)
  expect(blits.length).toBe(1)
  await roster($, `${T.desk.verb} deck`)
  for (let i = 0; i < 4; i += 1) await clock.advance(O.frameMs)
  expect(blits.length).toBe(1)
})

test('with motion off nothing moves: no blits, the first frame, an SVG without animation', { options: { motion: T.config.motionOff } }, async ($, on) => {
  const { clock, blits } = host(on)
  spawnsAs(on, 'q')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('still'))
  await clock.advance(O.frameMs * 7)
  expect(blits).toEqual([])
  const raster = findNode(await officeAt($, 66), n => n.type === 'Raster')
  expect(decodeCells(String(raster?.props?.cells), W)).toEqual(expectedCells(expectedPaint('q1', 'typing', 0)))
  expect(String(findNode(await officeAt($, 66, 'dock', 'desktop'), n => n.type === 'Svg')?.props?.source)).not.toContain('<animate')
})

test('/roster reset keeps the office as the view and empties it', async ($, on) => {
  host(on)
  spawnsAs(on, 'x')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Work'))
  expect(await roster($, 'reset')).toBe(T.text.command.reset)
  expect(officeText(await officeAt($, 66), 66).slice(1)).toEqual([OX.empty])
})

// ---------------------------------------------------------------- stored state from other versions

/** Answers `state.get` for `key` with `stored` until the mod writes that key. */
function seedKey(on: On, key: string, stored: unknown) {
  let isLeft = true
  on('state.get', (_$, e, next) => ((e as { key?: string }).key === key && isLeft ? ({ value: { value: stored, version: 1 } } as never) : next(e)))
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key === key) isLeft = false
    return next(e)
  })
}

for (const [name, stored, isOffice] of [
  ['an unshaped value', { view: 'office' }, false],
  ['another shape tag', { shape: 'agent-roster-desk-0', value: { view: 'office' } }, false],
  ["the deck's tag", { shape: STORE_SHAPE, value: { view: 'office' } }, false],
  ['this tag, every other field broken', { shape: DESK_SHAPE, value: { view: 'office', todos: 4, tallies: [{ id: 'x', live: 'Bash', tokens: -1 }] } }, true],
] as const) {
  test(`office state stored as ${name} draws, ${isOffice ? 'as the office' : 'as the deck'}, on every surface and placement`, async ($, on) => {
    host(on)
    seedKey(on, 'desk', stored)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x' }))
    await $.agent.spawn(spawnAsk('Work'))
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const placement of ['dock', 'inline'] as const) {
        const text = JSON.stringify(await officeAt($, 66, placement, surface))
        expect(text.includes(T.text.drawFailed.split('{')[0] as string)).toBe(false)
        expect(text.includes(`"${OX.title}`)).toBe(isOffice)
      }
    }
  })
}

test('the blank desk record is the deck, so a fresh session never opens on the office', () => {
  expect(blankDesk.view).toBe('deck')
})
