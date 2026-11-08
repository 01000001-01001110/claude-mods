//! The office's tests (DESIGN.md, additions). Expectations are computed from the shipped data (`T.office`,
//! `T.officeText`, `officeArt`), so a re-tune does not break them and a broken data file does. The rules are tested
//! on plain values, every threshold at its boundaries: the room's columns and rows, the props that fit, the clock's
//! hands at two times, the desktop scale. The view is driven through the engine (`/roster view office`, spawns,
//! held tool calls, permission asks, turn ends, the timer, the hotkey and the close control) and its golden frames
//! are asserted on what they draw: the terminal's Raster decoded back to colours and read region by region against
//! the sprites, the desktop's SVG parsed back to pixels the same way, every word, the hover cards, the room's growth
//! and the inline rows. Stored state from another shape is seeded through `state.get`.
//!
//! The pictures are read with the tests' own decoders (base64 cells, SVG paths) and checked against the art's
//! letter grids directly, so a fault in the module's compositing, packing or path merging shows.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { tuning as T } from '../data/agent-roster'
import { officeArt as A } from '../data/office-sprites'
import type { ArtSet, Card, GateLog, OfficeStateId, Sprite } from '../types'
import { DESK_SHAPE, blankDesk } from './desk-rules'
import { accentFor } from './geometry'
import {
  agentColors,
  base64,
  cardPlace,
  colorWord,
  deskCells,
  desktopScale,
  floorLetter,
  frameAt,
  frameCount,
  halfBlocks,
  handAngles,
  handTip,
  isMoving,
  linePixels,
  localTime,
  officeStateOf,
  packCells,
  paintRoom,
  pathsOf,
  roomLayout,
  roomSvg,
  seatsFor,
  shirtOf,
  terminalRoomWidth,
  toolNow,
  wallLetter,
} from './office-rules'
import type { Paint, RoomLayout, Seat, SetName } from './office-rules'
import { rasterKey } from './office'
import { STORE_SHAPE, blankCard, blankGate } from './records'
import { clip, counted, fill, tokensShort } from './words'

const O = T.office
const OX = T.officeText
const G = T.glyphs
const PANE = T.pane.id
const PLUGIN = 'agent-roster'
const STATES = Object.keys(O.states) as OfficeStateId[]
const DEFAULT = 0x01000000
const TERM: SetName = A.terminalSet
const FINE: SetName = A.graphicalSet
const SETS = Object.keys(A.sets) as SetName[]
/** The SVG size the engine accepts (SvgProps.source). */
const SVG_LIMIT = 131072

type Dollar = Parameters<TestBody>[0]

// ---------------------------------------------------------------- the host beneath

/** The host's answers a drawing test needs: a mocked clock, the status line, turns, the pane, blits and redraws recorded. */
function host(on: On) {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  const blits: { key: string; cells: string; columns?: number; rows?: number }[] = []
  on('ui.blit', (_$, e) => {
    const b = e as { key: string; cells?: string; columns?: number; rows?: number }
    blits.push({ key: b.key, cells: b.cells ?? '', columns: b.columns, rows: b.rows })
    return { value: {} } as never
  })
  const redraws = { n: 0 }
  on('ui.invalidate', (_$, e, next) => {
    if ((e as { event?: string }).event === 'ui.render' || e === ('ui.render' as never)) redraws.n += 1
    return next(e)
  })
  return { clock, blits, redraws }
}

/** Counts state reads: with no event and no drawing only the office's timer reads state. */
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

const hexOf = (n: number) => `#${n.toString(16).padStart(6, '0')}`

/** A Raster's pixels back from its half-block cells: two pixel rows a cell row (upper half, lower half). */
function rasterPixels(encoded: string, columns: number): Paint {
  const out: Paint = []
  for (const row of decodeCells(encoded, columns)) {
    const top: (string | null)[] = []
    const bottom: (string | null)[] = []
    for (const [glyph, fg, bg] of row) {
      if (glyph === '▀') {
        top.push(fg === DEFAULT ? null : hexOf(fg))
        bottom.push(bg === DEFAULT ? null : hexOf(bg))
      } else if (glyph === '▄') {
        top.push(null)
        bottom.push(fg === DEFAULT ? null : hexOf(fg))
      } else {
        top.push(null)
        bottom.push(null)
      }
    }
    out.push(top, bottom)
  }
  return out
}

/**
 * An SVG's pixels back from its markup, in art pixels: every `<path>` outside the animation groups, each
 * `M x y h w v h h-w z` a filled rectangle. Also its size, viewBox and the groups' count.
 */
function svgPixels(source: string): { paint: Paint; width: number; height: number; viewW: number; viewH: number; groups: string[] } {
  const head = /width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(source)
  const [width, height, viewW, viewH] = (head ?? []).slice(1).map(Number) as [number, number, number, number]
  const paint: Paint = Array.from({ length: viewH }, () => Array<string | null>(viewW).fill(null))
  const groups = Array.from(source.matchAll(/<g opacity="0">(.*?)<\/g>/g), m => m[1] as string)
  // Patterns: each a tile of paths, repeated under the rectangles that name it, before the paths.
  const tiles = new Map<string, Paint>()
  for (const m of source.matchAll(/<pattern id="(\w+)" width="(\d+)" height="(\d+)" patternUnits="userSpaceOnUse">(.*?)<\/pattern>/g)) {
    const tile: Paint = Array.from({ length: Number(m[3]) }, () => Array<string | null>(Number(m[2])).fill(null))
    fillPaths(tile, m[4] as string)
    tiles.set(m[1] as string, tile)
  }
  for (const m of source.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="url\(#(\w+)\)"\/>/g)) {
    const [x, y, w, h] = m.slice(1, 5).map(Number) as [number, number, number, number]
    const tile = tiles.get(m[5] as string) ?? [[null]]
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) if (paint[yy]) (paint[yy] as (string | null)[])[xx] = tile[yy % tile.length]?.[xx % (tile[0] ?? []).length] ?? null
    }
  }
  const still = source.replace(/<g opacity="0">.*?<\/g>/g, '').replace(/<defs>.*?<\/defs>/g, '')
  fillPaths(paint, still)
  return { paint, width, height, viewW, viewH, groups }
}

/** Paints every `<path>` in `markup` into `paint`. */
function fillPaths(paint: Paint, markup: string) {
  for (const m of markup.matchAll(/<path fill="(#[0-9a-f]{6})" d="([^"]+)"\/>/g)) {
    for (const r of (m[2] as string).matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)) {
      const [x, y, w, h] = r.slice(1, 5).map(Number) as [number, number, number, number]
      for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) if (paint[yy]) (paint[yy] as (string | null)[])[xx] = m[1] as string
    }
  }
}

/** A sprite's colours as the tests read the art: the palette, then `extra` (an agent's ramps); clear is null. */
function spriteColors(s: Sprite, extra: Record<string, string> = {}): (string | null)[][] {
  return s.map(line => Array.from(line).map(ch => (ch === A.clear ? null : (extra[ch] ?? A.palette[ch] ?? null))))
}

/** The `w` by `h` block of `paint` at (x, y). */
const region = (paint: Paint, x: number, y: number, w: number, h: number) => paint.slice(y, y + h).map(r => r.slice(x, x + w))

/** Asserts every drawn pixel of `s` shows at (x, y) in `paint`, except where `covered(dx, dy)` says a later layer is on top. */
function expectSprite(label: string, paint: Paint, s: Sprite, x: number, y: number, extra: Record<string, string> = {}, covered: (dx: number, dy: number) => boolean = () => false) {
  const want = spriteColors(s, extra)
  const wrong: string[] = []
  want.forEach((row, dy) =>
    row.forEach((c, dx) => {
      if (c === null || covered(dx, dy)) return
      const got = paint[y + dy]?.[x + dx] ?? null
      if (got !== c) wrong.push(`${dx},${dy}: ${got} != ${c}`)
    }),
  )
  expect([label, wrong.slice(0, 3)]).toEqual([label, []])
}

/** Whether the chair covers a pose pixel (dx, dy) of an agent laid at the set's `agentAt`. */
function chairCovers(set: ArtSet) {
  const D = set.desk
  return (dx: number, dy: number) => {
    const cx = D.agentAt.x + dx - D.chairAt.x
    const cy = D.agentAt.y + dy - D.chairAt.y
    const ch = D.chair[cy]?.[cx]
    return ch !== undefined && ch !== A.clear
  }
}

/**
 * Asserts desk `i` of a painted room shows the seat: the state's screen frame exactly, the agent's pose frame in its
 * own colours where the chair leaves it, the chair; an empty desk the empty screen and no agent.
 */
function expectDesk(label: string, paint: Paint, layout: RoomLayout, i: number, seat: Seat | null) {
  const set = A.sets[layout.setName]
  const D = set.desk
  const at = layout.desks[i] as { x: number; y: number }
  const look = seat === null ? null : O.states[seat.state]
  const screens = set.screens[look?.screen ?? O.emptyScreen] as Sprite[]
  const screen = screens[(seat?.frame ?? 0) % screens.length] as Sprite
  expect([label, 'screen', region(paint, at.x + D.screenAt.x, at.y + D.screenAt.y, (screen[0] ?? '').length, screen.length)]).toEqual([label, 'screen', spriteColors(screen)])
  expectSprite(`${label} chair`, paint, D.chair, at.x + D.chairAt.x, at.y + D.chairAt.y)
  if (seat !== null && look !== null) {
    const poses = set.poses[look.pose] as Sprite[]
    expectSprite(`${label} agent`, paint, poses[seat.frame % poses.length] as Sprite, at.x + D.agentAt.x, at.y + D.agentAt.y, agentColors(seat.id), chairCovers(set))
  } else {
    // No agent: no shirt colour anywhere on the desk.
    const shirts = new Set(A.shirts.flat())
    expect([label, region(paint, at.x, at.y, layout.deskW, layout.deskH).flat().some(c => c !== null && shirts.has(c))]).toEqual([label, false])
  }
}

/** The office drawn at `cols`, on `surface`, docked or inline. */
async function officeAt($: Dollar, cols: number, placement: 'dock' | 'inline' = 'dock', surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...paneAsk(cols, placement), surface })
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}

/** A desk's hover Box in a drawing, by agent id. */
const deskBox = (tree: unknown, id: string) => findNode(tree, n => n.type === 'Box' && n.props?.key === `office-desk-${id}`)
/** The card inside a desk's hover box. */
const cardIn = (box: Drawn | undefined) => (box ? findNode(box, n => n !== box && n.type === 'Box' && n.props?.position === 'absolute') : undefined)
/** A legend entry's three texts: swatch, name, state. */
const legendOf = (tree: unknown, id: string) => {
  const entry = findNode(tree, n => n.type === 'Box' && n.props?.key === `office-legend-${id}`)
  return entry ? kidsOf(entry).map(k => ({ text: textIn(k), color: k.props?.color })) : []
}
/** The room's picture: the terminal Raster's pixels or the desktop SVG's. */
function roomPixels(tree: unknown): Paint {
  const raster = findNode(tree, n => n.type === 'Raster')
  if (raster) return rasterPixels(String(raster.props?.cells), Number(raster.props?.columns))
  return svgPixels(String(findNode(tree, n => n.type === 'Svg')?.props?.source)).paint
}

// ---------------------------------------------------------------- fixtures

const card = (id: string, o: Partial<Card> = {}): Card => ({ ...blankCard, id, type: 'general-purpose', kind: 'general-purpose', description: `task ${id}`, spawnedAt: 1, ...o })
const gateWith = (checks: { id: string; verdict: 'rule' | 'ask' | 'cleared' | 'deny' }[]): GateLog => ({
  ...blankGate,
  recent: checks.map(c => ({ id: c.id, tool: 'Bash', bucket: 'shell', verdict: c.verdict, inSubagent: true, detail: '', at: 1 })),
})
const occupant = (id: string, state: OfficeStateId) => ({ card: card(id), tally: undefined, state })
const NOON = { hours: 12, minutes: 0 }

// ================================================================ the art

test('the art is well formed: every sprite rectangular, every letter painted, every layer inside its desk, every state drawable', () => {
  const agentLetters = new Set([...A.agentLetters.shirt, ...A.agentLetters.hair, ...A.agentLetters.skin])
  const known = (ch: string) => ch === A.clear || A.palette[ch] !== undefined
  const checkSprite = (name: string, s: Sprite, allowAgent: boolean) => {
    expect([name, s.length > 0]).toEqual([name, true])
    const w = (s[0] ?? '').length
    for (const row of s) expect([name, row.length]).toEqual([name, w])
    const unknown = s.join('').split('').filter(ch => !known(ch) && !(allowAgent && agentLetters.has(ch)))
    expect([name, unknown]).toEqual([name, []])
  }
  for (const name of SETS) {
    const set = A.sets[name]
    const D = set.desk
    checkSprite(`${name} desk`, D.base, false)
    checkSprite(`${name} chair`, D.chair, false)
    const inDesk = (s: Sprite, at: { x: number; y: number }) => at.x >= 0 && at.y >= 0 && at.x + (s[0] ?? '').length <= (D.base[0] ?? '').length && at.y + s.length <= D.base.length
    expect([name, 'chair inside', inDesk(D.chair, D.chairAt)]).toEqual([name, 'chair inside', true])
    for (const [p, frames] of Object.entries(set.poses)) frames.forEach((f, i) => {
      checkSprite(`${name} pose ${p}[${i}]`, f, true)
      expect([name, p, i, inDesk(f, D.agentAt)]).toEqual([name, p, i, true])
    })
    for (const [s, frames] of Object.entries(set.screens)) frames.forEach((f, i) => {
      checkSprite(`${name} screen ${s}[${i}]`, f, false)
      // Every screen is the same size, so a frame never leaves a piece of the one before.
      expect([name, s, i, f.length, (f[0] ?? '').length]).toEqual([name, s, i, (frames[0] ?? []).length, ((frames[0] ?? [])[0] ?? '').length])
      expect([name, s, i, inDesk(f, D.screenAt)]).toEqual([name, s, i, true])
    })
    for (const [p, s] of Object.entries(set.props)) checkSprite(`${name} prop ${p}`, s, false)
    for (const spot of [...set.wallProps, ...set.floorProps]) expect([name, spot.prop, set.props[spot.prop] !== undefined]).toEqual([name, spot.prop, true])
    expect([name, set.props[set.clock.prop] !== undefined]).toEqual([name, true])
    for (const st of STATES) {
      expect([name, st, (set.poses[O.states[st].pose] ?? []).length > 0, (set.screens[O.states[st].screen] ?? []).length > 0]).toEqual([name, st, true, true])
    }
    expect([name, (set.screens[O.emptyScreen] ?? []).length > 0]).toEqual([name, true])
    for (const ch of [...set.wall.trim, set.wall.fill, set.wall.dado.line, ...set.wall.dado.dither, ...set.wall.skirting, set.floor.seam, set.floor.edge, ...set.floor.variants]) {
      expect([name, ch, known(ch) && ch !== A.clear]).toEqual([name, ch, true])
    }
  }
  // Each shirt's mid is the agent's pastel accent, in the same order, so the shirt and the accent always agree.
  expect(A.shirts.map(s => s[1])).toEqual(T.accents.pastel)
  for (const hex of [...Object.values(A.palette), ...A.shirts.flat(), ...A.hairs.flat(), ...A.skins.flat()]) expect([hex, /^#[0-9a-f]{6}$/.test(hex)]).toEqual([hex, true])
})

test('an agent keeps its own shirt, hair and skin, its shirt matching its accent', () => {
  for (const id of ['a', 'b', 'agent-7f3a', 'x1', 'x2']) {
    const colors = agentColors(id)
    expect(colors[A.agentLetters.shirt[1]]).toBe(shirtOf(id)[1])
    expect(A.shirts.some(s => s.every((c, i) => colors[A.agentLetters.shirt[i] as string] === c))).toBe(true)
    expect(A.hairs.some(h => h.every((c, i) => colors[A.agentLetters.hair[i] as string] === c))).toBe(true)
    expect(A.skins.some(k => k.every((c, i) => colors[A.agentLetters.skin[i] as string] === c))).toBe(true)
    expect(agentColors(id)).toEqual(colors)
  }
  // Different ids land on different shirts across the list.
  expect(new Set(Array.from({ length: 24 }, (_, i) => shirtOf(`agent-${i}`)[1])).size).toBe(A.shirts.length)
})

// ================================================================ what an agent is doing

test('each agent shows its state: its end when finished; a raised hand, a progress bar or typing while it runs', () => {
  const tally = (live: { id: string; tool: string }[]) => ({ id: 'a', calls: live.length, tokens: 0, live, last: '' })
  expect(officeStateOf(card('a', { status: 'done' }), undefined, blankGate)).toBe('done')
  expect(officeStateOf(card('a', { status: 'failed' }), undefined, blankGate)).toBe('failed')
  expect(officeStateOf(card('a', { status: 'stopped' }), undefined, blankGate)).toBe('stopped')
  expect(officeStateOf(card('a'), undefined, blankGate)).toBe('typing')
  expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: 'Edit' }]), blankGate)).toBe('typing')
  for (const shell of T.tools.shell) expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: shell }]), blankGate)).toBe('watching')
  // The latest call decides: a shell call then an edit is typing again.
  expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: 'Bash' }, { id: 'c2', tool: 'Edit' }]), blankGate)).toBe('typing')
  // An ask on any live call raises the hand, ahead of the shell; once cleared or ruled it does not.
  expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: 'Bash' }]), gateWith([{ id: 'c1', verdict: 'ask' }]))).toBe('waiting')
  expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: 'Bash' }]), gateWith([{ id: 'c1', verdict: 'cleared' }]))).toBe('watching')
  expect(officeStateOf(card('a'), tally([{ id: 'c1', tool: 'Bash' }]), gateWith([{ id: 'c9', verdict: 'ask' }]))).toBe('watching')
  expect(toolNow(card('a'), tally([{ id: 'c1', tool: 'Read' }, { id: 'c2', tool: 'Grep' }]))).toBe('Grep')
  expect(toolNow(card('a', { status: 'done' }), tally([{ id: 'c1', tool: 'Read' }]))).toBe(null)
  expect(toolNow(card('a'), tally([]))).toBe(null)
})

test('only running states move, and only with motion on in the settings and in the data', () => {
  for (const s of STATES) {
    const running = s === 'typing' || s === 'watching' || s === 'waiting'
    expect([s, isMoving(s, true)]).toEqual([s, running && O.motion !== O.motionNone])
    expect([s, isMoving(s, false)]).toEqual([s, false])
    expect([s, isMoving(s, true, O.motionNone)]).toEqual([s, false])
  }
})

test('frames: each state cycles through the least common multiple of its layers, in each set; all desks in step', () => {
  const lcm = (a: number, b: number) => {
    let m = Math.max(a, b)
    while (m % a !== 0 || m % b !== 0) m += 1
    return m
  }
  for (const name of SETS) {
    for (const s of STATES) {
      const look = O.states[s]
      const want = lcm(Math.max(1, (A.sets[name].poses[look.pose] ?? []).length), Math.max(1, (A.sets[name].screens[look.screen] ?? []).length))
      expect([name, s, frameCount(name, s)]).toEqual([name, s, want])
    }
  }
  expect(frameCount(TERM, 'watching') > 1).toBe(true)
  expect(frameAt(0, 4)).toBe(0)
  expect(frameAt(O.frameMs - 1, 4)).toBe(0)
  expect(frameAt(O.frameMs, 4)).toBe(1)
  expect(frameAt(O.frameMs * 4, 4)).toBe(0)
  expect(frameAt(O.frameMs * 5, 1)).toBe(0)
  expect(frameAt(Number.NaN, 4)).toBe(0)
  expect(frameAt(-5, 4)).toBe(0)
})

// ================================================================ the room

test("desks a row: the data's columns where they fit, one fewer one pixel narrower, never none", () => {
  for (const name of SETS) {
    const D = A.sets[name].desk
    const deskW = (D.base[0] ?? '').length
    for (let n = 1; n <= D.columns; n += 1) {
      // n desks fit exactly: margins, n desks and the gaps between them.
      const exact = 2 * D.margin + (n - 1) * D.pitchX + deskW
      expect([name, n, roomLayout(name, exact, 1).columns]).toEqual([name, n, n])
      expect([name, n, roomLayout(name, exact - 1, 1).columns]).toEqual([name, n, Math.max(1, n - 1)])
    }
    expect(roomLayout(name, 1, 1).columns).toBe(1)
    expect(roomLayout(name, 10_000, 1).columns).toBe(D.columns)
  }
})

test("rows: the data's base with no agents, one more each time a row fills, up to its most, then the rest are counted", () => {
  for (const name of SETS) {
    const D = A.sets[name].desk
    const width = 2 * D.margin + (D.columns - 1) * D.pitchX + (D.base[0] ?? '').length
    const base = D.baseRows * D.columns
    const at = (n: number) => roomLayout(name, width, n)
    expect([at(0).rows, at(0).capacity, at(0).shown, at(0).more]).toEqual([D.baseRows, base, 0, 0])
    expect([at(base).rows, at(base).shown]).toEqual([D.baseRows, base])
    expect([at(base + 1).rows, at(base + 1).shown]).toEqual([D.baseRows + 1, base + 1])
    const most = D.maxRows * D.columns
    expect([at(most).rows, at(most).shown, at(most).more]).toEqual([D.maxRows, most, 0])
    expect([at(most + 1).rows, at(most + 1).shown, at(most + 1).more]).toEqual([D.maxRows, most, 1])
    expect(at(most + 1).desks.length).toBe(most)
    // A row is a pitch below the one above; the room grows by a pitch a row.
    expect(at(base + 1).height - at(base).height).toBe(D.pitchY)
    // Desks in reading order, a pitch apart, the grid centred.
    const l = at(D.columns + 1)
    expect((l.desks[1]?.x ?? 0) - (l.desks[0]?.x ?? 0)).toBe(D.pitchX)
    expect((l.desks[D.columns]?.y ?? 0) - (l.desks[0]?.y ?? 0)).toBe(D.pitchY)
    expect(l.desks[0]?.y).toBe(A.sets[name].wall.height + D.top)
    const left = l.desks[0]?.x ?? 0
    const right = width - ((l.desks[D.columns - 1]?.x ?? 0) + l.deskW)
    expect(Math.abs(left - right) <= 1).toBe(true)
  }
})

test('props: wall props in their priority order where they fit without overlapping; floor props clear of the desks', () => {
  for (const name of SETS) {
    const set = A.sets[name]
    for (const width of [24, 40, 66, 110, 144, 200, 280, 360]) {
      const l = roomLayout(name, width, 4)
      const firstDesk = l.desks[0] as { x: number; y: number }
      const gridRight = (l.desks[l.columns - 1]?.x ?? 0) + l.deskW
      for (const [i, p] of l.props.entries()) {
        expect([name, width, p.name, p.x >= 0 && p.x + p.w <= width && p.y >= 0 && p.y + p.h <= l.height]).toEqual([name, width, p.name, true])
        for (const q of l.props.slice(i + 1)) {
          const apart = p.x + p.w < q.x || q.x + q.w < p.x || p.y + p.h < q.y || q.y + q.h < p.y
          expect([name, width, p.name, q.name, apart]).toEqual([name, width, p.name, q.name, true])
        }
        const isFloor = set.floorProps.some(f => f.prop === p.name) && !set.wallProps.some(w => w.prop === p.name && w.y === p.y)
        if (isFloor) expect([name, width, p.name, p.x + p.w <= firstDesk.x - set.desk.sideGap || p.x >= gridRight + set.desk.sideGap]).toEqual([name, width, p.name, true])
      }
      // The first wall prop (the door) is placed whenever it fits, centred at its spot.
      const door = set.wallProps[0]
      const doorW = (set.props[door?.prop ?? '']?.[0] ?? '').length
      const doorX = Math.round((door?.at ?? 0) * width - doorW / 2)
      expect([name, width, l.props.some(p => p.name === door?.prop && p.x === doorX)]).toEqual([name, width, doorX >= 0 && doorX + doorW <= width])
    }
    // A wide room has every prop; a narrow one leaves some out.
    expect(roomLayout(name, name === TERM ? 140 : 360, 4).props.length).toBe(set.wallProps.length + set.floorProps.length)
    expect(roomLayout(name, 24, 4).props.length < set.wallProps.length + set.floorProps.length).toBe(true)
  }
})

test('the wall: trim on top, the wall, the dado line and its dithered band, the skirting at its foot; the floor in planks', () => {
  for (const name of SETS) {
    const set = A.sets[name]
    const W = set.wall
    const paint = paintRoom(roomLayout(name, 200, 0), [], NOON)
    const at = (x: number, y: number) => paint[y]?.[x]
    // Column 0 is clear of every prop in both sets at this width? Read a column between props instead: the left margin.
    const l = roomLayout(name, 200, 0)
    const free = Array.from({ length: 200 }, (_, x) => x).find(x => !l.props.some(p => x >= p.x && x < p.x + p.w)) as number
    W.trim.forEach((ch, y) => expect([name, y, at(free, y)]).toEqual([name, y, A.palette[ch]]))
    expect(at(free, W.trim.length)).toBe(A.palette[W.fill])
    expect(at(free, W.dado.top)).toBe(A.palette[W.dado.line])
    expect([at(free, W.dado.top + 1), at(free + 1, W.dado.top + 1)].sort()).toEqual([A.palette[W.dado.dither[0]], A.palette[W.dado.dither[1]]].sort())
    W.skirting.forEach((ch, i) => expect([name, i, at(free, W.height - W.skirting.length + i)]).toEqual([name, i, A.palette[ch]]))
    for (let y = 0; y < W.height; y += 1) expect(wallLetter(set, 3, y)).toBe(y < W.trim.length ? W.trim[y] : y >= W.height - W.skirting.length ? W.skirting[y - (W.height - W.skirting.length)] : y === W.dado.top ? W.dado.line : y > W.dado.top ? W.dado.dither[(3 + y) % 2] : W.fill)
    // Every plank's last row is a seam, its first row the lit edge (away from the seam columns).
    const F = set.floor
    for (let row = 0; row < 3; row += 1) {
      const top = W.height + row * F.plankRows
      expect([name, row, floorLetter(set, 7, top + F.plankRows - 1)]).toEqual([name, row, F.seam])
      const seams = Array.from({ length: 60 }, (_, x) => floorLetter(set, x, top + 1)).filter(ch => ch === F.seam).length
      expect([name, row, seams > 0 && seams < 60 / Math.min(...F.lengths) + 2]).toEqual([name, row, true])
      const edge = Array.from({ length: 60 }, (_, x) => floorLetter(set, x, top))
      expect([name, row, edge.every(ch => ch === F.edge || ch === F.seam)]).toEqual([name, row, true])
    }
    // Planks vary: more than one variant shows on the floor.
    const body = new Set(Array.from({ length: 200 }, (_, x) => floorLetter(set, x, W.height + 1 + F.plankRows)))
    expect(F.variants.filter(v => body.has(v)).length > 1 || new Set(F.variants).size === 1).toBe(true)
  }
})

test('the clock: hands at the local time, the hour hand moving on through its hour', () => {
  expect(handAngles(3, 0)).toEqual({ hour: 90, minute: 0 })
  expect(handAngles(15, 0)).toEqual({ hour: 90, minute: 0 })
  expect(handAngles(9, 30)).toEqual({ hour: 285, minute: 180 })
  expect(handAngles(0, 59)).toEqual({ hour: 29.5, minute: 354 })
  const pivot = { x: 10, y: 10 }
  expect(handTip(pivot, 4, 0)).toEqual({ x: 10, y: 6 })
  expect(handTip(pivot, 4, 90)).toEqual({ x: 14, y: 10 })
  expect(handTip(pivot, 4, 180)).toEqual({ x: 10, y: 14 })
  expect(handTip(pivot, 4, 270)).toEqual({ x: 6, y: 10 })
  expect(linePixels({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([0, 1, 2, 3].map(x => ({ x, y: 0 })))
  expect(linePixels({ x: 0, y: 0 }, { x: 0, y: -2 })).toEqual([0, -1, -2].map(y => ({ x: 0, y })))
  expect(linePixels({ x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([0, 1, 2].map(v => ({ x: v, y: v })))
  // The local time is the runtime's own clock face.
  for (const ms of [0, 1_700_000_000_000, 1_762_600_000_000]) {
    const d = new Date(ms)
    expect(localTime(ms)).toEqual({ hours: d.getHours(), minutes: d.getMinutes() })
  }
  expect(localTime(Number.NaN)).toEqual(localTime(0))
})

for (const [label, time] of [
  ['three o\'clock', { hours: 3, minutes: 0 }],
  ['half past nine', { hours: 21, minutes: 30 }],
] as const) {
  test(`the painted clock at ${label}: each hand's tip where its angle points, the hub on top`, () => {
    for (const name of SETS) {
      const set = A.sets[name]
      const K = set.clock
      const l = roomLayout(name, name === TERM ? 66 : 264, 0)
      const at = l.clock as { x: number; y: number }
      expect([name, at !== null]).toEqual([name, true])
      const paint = paintRoom(l, [], time)
      const px = (x: number, y: number) => paint[at.y + y]?.[at.x + x]
      // The tests' own trigonometry: degrees clockwise from twelve.
      const tip = (len: number, deg: number) => ({ x: K.pivot.x + Math.round(len * Math.sin((deg * Math.PI) / 180)), y: K.pivot.y - Math.round(len * Math.cos((deg * Math.PI) / 180)) })
      const minuteDeg = time.minutes * 6
      const hourDeg = ((time.hours % 12) + time.minutes / 60) * 30
      const m = tip(K.minuteLength, minuteDeg)
      const h = tip(K.hourLength, hourDeg)
      if (m.x !== h.x || m.y !== h.y) expect([name, 'minute', px(m.x, m.y)]).toEqual([name, 'minute', A.palette[K.minuteHand]])
      expect([name, 'hour', px(h.x, h.y)]).toEqual([name, 'hour', A.palette[K.hourHand]])
      expect([name, 'hub', px(K.pivot.x, K.pivot.y)]).toEqual([name, 'hub', A.palette[K.hub]])
      // The face elsewhere is the sprite's: a pixel on the far side from both hands is the face.
      const face = A.sets[name].props[K.prop] as Sprite
      const opposite = tip(1, (minuteDeg + 180) % 360)
      const oppositeHour = tip(1, (hourDeg + 180) % 360)
      if (opposite.x !== oppositeHour.x || opposite.y !== oppositeHour.y || K.hourLength > 1) {
        const want = A.palette[(face[opposite.y] ?? '')[opposite.x] ?? ''] ?? null
        const isHand = [m, h].some(t => linePixels(K.pivot, t).some(p => p.x === opposite.x && p.y === opposite.y))
        if (!isHand) expect([name, 'face', px(opposite.x, opposite.y)]).toEqual([name, 'face', want])
      }
    }
  })
}

test('the room painted: every desk the state it seats, empty desks an empty chair and the empty screen, props as drawn', () => {
  for (const name of SETS) {
    const occupants = STATES.map((s, i) => occupant(`p${i}`, s))
    const l = roomLayout(name, name === TERM ? 66 : 264, occupants.length)
    for (const now of [0, O.frameMs, O.frameMs * 2, O.frameMs * 3]) {
      const seats = seatsFor(l, occupants, now, true)
      const paint = paintRoom(l, seats, NOON)
      expect([name, paint.length, paint[0]?.length]).toEqual([name, l.height, l.width])
      seats.forEach((seat, i) => {
        if (seat !== null) expect([name, now, seat.frame]).toEqual([name, now, isMoving(seat.state, true) ? frameAt(now, frameCount(name, seat.state)) : 0])
        expectDesk(`${name} desk ${i} at ${now}`, paint, l, i, seat)
      })
      // Every pixel of the room is painted.
      expect([name, paint.flat().every(c => c !== null)]).toEqual([name, true])
    }
    // Props not under a desk show as drawn (the clock's face aside, under its hands).
    const paint = paintRoom(l, seatsFor(l, occupants, 0, true), NOON)
    for (const p of l.props) {
      if (p.name === A.sets[name].clock.prop) continue
      expectSprite(`${name} ${p.name}`, paint, A.sets[name].props[p.name] as Sprite, p.x, p.y)
    }
  }
})

test('seats: the first agents in spawn order, at the frame the clock is on while moving, the first frame when still', () => {
  const l = roomLayout(TERM, 66, 8)
  const occupants = [occupant('a', 'typing'), occupant('b', 'done'), occupant('c', 'watching')]
  const now = O.frameMs * 5
  const seats = seatsFor(l, occupants, now, true)
  expect(seats.length).toBe(l.capacity)
  expect(seats.slice(0, 3)).toEqual([
    { id: 'a', state: 'typing', frame: frameAt(now, frameCount(TERM, 'typing')) },
    { id: 'b', state: 'done', frame: 0 },
    { id: 'c', state: 'watching', frame: frameAt(now, frameCount(TERM, 'watching')) },
  ])
  expect(seats.slice(3).every(s => s === null)).toBe(true)
  expect(seatsFor(l, occupants, now, false).slice(0, 3).map(s => s?.frame)).toEqual([0, 0, 0])
  // Past the room's capacity nobody else is seated.
  const full = roomLayout(TERM, 66, 30)
  expect(seatsFor(full, Array.from({ length: 30 }, (_, i) => occupant(`o${i}`, 'typing')), 0, true).filter(s => s !== null).length).toBe(full.capacity)
})

// ================================================================ the terminal cells

test('half blocks: two pixel rows a cell; upper over lower, lower alone, or a blank', () => {
  const cellsOf = halfBlocks([
    ['#ff0000', null, null],
    ['#00ff00', '#0000ff', null],
    ['#123456'],
  ])
  expect(cellsOf).toEqual([
    [
      { glyph: '▀', fg: 0xff0000, bg: 0x00ff00 },
      { glyph: '▄', fg: 0x0000ff, bg: DEFAULT },
      { glyph: ' ', fg: DEFAULT, bg: DEFAULT },
    ],
    [{ glyph: '▀', fg: 0x123456, bg: DEFAULT }],
  ])
  expect(colorWord('#abcdef')).toBe(0xabcdef)
  expect(colorWord('teal')).toBe(DEFAULT)
  expect(colorWord(null)).toBe(DEFAULT)
})

test('cells pack as padded base64 of little-endian triplets', () => {
  expect(base64(new Uint8Array([1, 2, 3, 4]))).toBe('AQIDBA==')
  expect(base64(new Uint8Array([255, 254]))).toBe('//4=')
  const packed = packCells([[{ glyph: '▀', fg: 0x112233, bg: DEFAULT }]])
  expect(decodeCells(packed, 1)).toEqual([[['▀', 0x112233, DEFAULT]]])
  expect(terminalRoomWidth(66)).toBe(66)
  expect(terminalRoomWidth(512)).toBe(512)
  expect(terminalRoomWidth(513)).toBe(512)
  expect(terminalRoomWidth(0)).toBe(1)
})

// ================================================================ the desktop SVG

test('paths: one per colour, runs merged into rectangles, reading back to the same picture', () => {
  const paint: Paint = [
    ['#111111', '#111111', null, '#222222'],
    ['#111111', '#111111', '#222222', '#222222'],
    [null, '#333333', '#333333', null],
  ]
  const markup = pathsOf(paint)
  expect((markup.match(/<path /g) ?? []).length).toBe(3)
  // The 2x2 block of one colour is one rectangle.
  expect(markup).toContain('M0 0h2v2h-2z')
  const back: Paint = Array.from({ length: 3 }, () => Array<string | null>(4).fill(null))
  fillPaths(back, markup)
  expect(back).toEqual(paint)
  const l = roomLayout(FINE, 264, 4)
  const room = paintRoom(l, seatsFor(l, [occupant('a', 'typing')], 0, true), NOON)
  const again: Paint = room.map(r => r.map(() => null))
  fillPaths(again, pathsOf(room))
  expect(again).toEqual(room)
})

test('the scale: the pane over the target, whole, held to the range; the room as wide as the pane allows, up to its widest', () => {
  const D = O.desktop
  for (let scale = D.minScale; scale <= D.maxScale; scale += 1) {
    const cols = Math.ceil((scale * D.targetRoomPx) / D.columnPx)
    expect([scale, desktopScale(cols).scale]).toEqual([scale, scale])
    if (scale > D.minScale) expect([scale, desktopScale(cols - 1).scale]).toEqual([scale, scale - 1])
  }
  expect(desktopScale(1).scale).toBe(D.minScale)
  expect(desktopScale(100_000).scale).toBe(D.maxScale)
  const at66 = desktopScale(66)
  expect(at66.roomWidth).toBe(Math.min(D.maxRoomPx, Math.floor((66 * D.columnPx) / at66.scale)))
  expect(desktopScale(100_000).roomWidth).toBe(D.maxRoomPx)
  // The room fills the pane: one more art pixel would not fit.
  for (const cols of [40, 66, 110, 144]) {
    const s = desktopScale(cols)
    if (s.roomWidth < D.maxRoomPx) expect([cols, (s.roomWidth + 1) * s.scale > cols * D.columnPx]).toEqual([cols, true])
  }
})

test('the room as SVG: crisp pixels at the scale; still desks plain, moving ones a group a frame with only that frame\'s changes', () => {
  const occupants = [occupant('a', 'typing'), occupant('b', 'watching'), occupant('c', 'done')]
  const l = roomLayout(FINE, 264, occupants.length)
  const seats = seatsFor(l, occupants, 0, true)
  const moving = seats.map(s => s !== null && isMoving(s.state, true))
  const svg = roomSvg(l, seats, moving, NOON, 2)
  expect(svg).toContain('shape-rendering="crispEdges"')
  const read = svgPixels(svg)
  expect([read.width, read.height, read.viewW, read.viewH]).toEqual([l.width * 2, l.height * 2, l.width, l.height])
  // Under the groups: every desk at its first frame.
  expect(read.paint).toEqual(paintRoom(l, seats.map(s => (s === null ? null : { ...s, frame: 0 })), NOON))
  // A group for every frame after the first of each moving desk, each the discrete opacity cycle of its frame.
  const want = frameCount(FINE, 'typing') - 1 + (frameCount(FINE, 'watching') - 1)
  expect(read.groups.length).toBe(want)
  const anims = Array.from(svg.matchAll(/<animate attributeName="opacity" values="([^"]+)" dur="(\d+)ms" calcMode="discrete" repeatCount="indefinite"\/>/g))
  expect(anims.length).toBe(want)
  const typing = frameCount(FINE, 'typing')
  expect(anims[0]?.[1]).toBe(Array.from({ length: typing }, (_, k) => (k === 1 ? 1 : 0)).join(';'))
  expect(Number(anims[0]?.[2])).toBe(typing * O.frameMs)
  // Laid over the first frame, group k gives frame k of that desk exactly.
  for (let f = 1; f < typing; f += 1) {
    const over = read.paint.map(r => r.slice())
    fillPaths(over, read.groups[f - 1] as string)
    expect([f, over]).toEqual([f, paintRoom(l, seats.map((s, j) => (s === null ? null : { ...s, frame: j === 0 ? f : 0 })), NOON)])
  }
  // Nothing moving: no animation at all.
  expect(roomSvg(l, seats, seats.map(() => false), NOON, 2)).not.toContain('<animate')
})

test("the busiest room at the widest scale stays within the engine's SVG size", () => {
  const D = A.sets[FINE].desk
  const most = D.maxRows * D.columns
  const occupants = Array.from({ length: most }, (_, i) => occupant(`busy${i}`, (['typing', 'watching', 'waiting'] as const)[i % 3] ?? 'typing'))
  for (const cols of [40, 66, 110, 144, 400]) {
    const { scale, roomWidth } = desktopScale(cols)
    const l = roomLayout(FINE, roomWidth, most)
    const seats = seatsFor(l, occupants, 0, true)
    const svg = roomSvg(l, seats, seats.map(() => true), NOON, scale)
    expect([cols, svg.length < SVG_LIMIT]).toEqual([cols, true])
  }
})

// ================================================================ hover places

test('hover boxes sit over their desks: a pixel a column and two a row on the terminal, scaled on a graphical surface', () => {
  const l = roomLayout(TERM, 66, 4)
  for (let i = 0; i < 4; i += 1) {
    const at = l.desks[i] as { x: number; y: number }
    const c = deskCells(l, i, 'terminal')
    expect(c).toEqual({ left: at.x, top: Math.floor(at.y / 2), width: l.deskW, height: Math.ceil((at.y + l.deskH) / 2) - Math.floor(at.y / 2) })
  }
  const f = roomLayout(FINE, 264, 4)
  const D = O.desktop
  const c = deskCells(f, 1, 'graphical', 2)
  const at = f.desks[1] as { x: number; y: number }
  expect(c).toEqual({ left: Math.floor((at.x * 2) / D.columnPx), top: Math.floor((at.y * 2) / D.rowPx), width: Math.ceil((f.deskW * 2) / D.columnPx), height: Math.ceil((f.deskH * 2) / D.rowPx) })
  // The card stays in the pane: moved left at the right edge, never past the left one.
  expect(cardPlace(0, 66)).toEqual({ left: 0, width: O.cardCols })
  expect(cardPlace(66 - O.cardCols, 66).left).toBe(0)
  expect(cardPlace(66 - O.cardCols + 1, 66).left).toBe(-1)
  expect(cardPlace(5, 20)).toEqual({ left: -5, width: 20 })
})

// ================================================================ the view, through the engine

test('/roster view office switches to the office; the hotkey and the switch go back to the deck', async ($, on) => {
  host(on)
  expect(await roster($, `${T.desk.verb} office`)).toBe(fill(T.deskText.viewSet, { view: 'office' }))
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

test('golden frame: four agents at 66 columns (typing, at a shell, waiting on an ok, done) on the terminal and the desktop', async ($, on) => {
  const { clock } = host(on)
  await clock.advance(3_600_000)
  spawnsAs(on, 'g')
  const calls = holdCalls(on, ['g1-edit', 'g2-bash', 'g3-ask'])
  on('tool.check', (_$, e) => ({ decision: e.tool_use_id === 'g3-ask' ? 'ask' : 'allow' }) as never)
  let answer: () => void = () => undefined
  let asked: () => void = () => undefined
  const isAsked = new Promise<void>(r => (asked = r))
  on('classic.PermissionRequest', async () => {
    asked()
    await new Promise<void>(r => (answer = r))
    return { decision: { behavior: 'allow' } } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }
  })
  await roster($, `${T.desk.verb} office`)
  for (const task of ['Write the parser tests', 'Run the suite', 'Deploy the preview', 'Review the diff']) await $.agent.spawn(spawnAsk(task))
  const step = $.turn.step({ turnId: 'G', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'g1' })
  for await (const _ of step) void _
  await step.result
  const editing = $.tool.call({ tool: 'Edit', tool_use_id: 'g1-edit', agentId: 'g1', file_path: '/w/parser.test.ts', old_string: 'a', new_string: 'b' } as never)
  const shell = $.tool.call({ tool: 'Bash', tool_use_id: 'g2-bash', agentId: 'g2', command: 'npm test' } as never)
  const deploy = $.tool.call({ tool: 'Bash', tool_use_id: 'g3-ask', agentId: 'g3', command: 'deploy' } as never)
  await Promise.all([calls.entered('g1-edit'), calls.entered('g2-bash'), isAsked])
  await $.turn.complete({ answer: 'looks good', durationMs: 4000, isAborted: false, turnId: 'G4', agentId: 'g4', reason: 'answer' })
  const now = 3_600_000
  const states: [string, OfficeStateId, string][] = [
    ['g1', 'typing', 'Write the parser tests'],
    ['g2', 'watching', 'Run the suite'],
    ['g3', 'waiting', 'Deploy the preview'],
    ['g4', 'done', 'Review the diff'],
  ]
  const said = (s: OfficeStateId) => fill(O.states[s].word, { tool: s === 'watching' ? 'Bash' : '' }).trim()
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await officeAt($, 66, 'dock', surface)
    const top = findNode(tree, n => n.props?.key === 'office-top')
    expect(textIn(top?.children?.[0])).toBe([OX.title, fill(OX.counts, { running: 3, total: 4 }), fill(OX.tokens, { tokens: tokensShort(1200) })].join(OX.sep))
    const setName = surface === 'terminal' ? TERM : FINE
    const { scale, roomWidth } = desktopScale(66)
    const l = roomLayout(setName, surface === 'terminal' ? 66 : roomWidth, 4)
    const paint = roomPixels(tree)
    expect([surface, paint.length >= l.height, paint[0]?.length]).toEqual([surface, true, l.width])
    states.forEach(([id, s], i) => {
      const frame = isMoving(s, true) ? frameAt(surface === 'terminal' ? now : 0, frameCount(setName, s)) : 0
      expectDesk(`${surface} ${id}`, paint, l, i, { id, state: s, frame })
    })
    // The two desks past the agents are empty.
    expectDesk(`${surface} empty 4`, paint, l, 4, null)
    expectDesk(`${surface} empty 5`, paint, l, 5, null)
    // The legend: each agent's swatch in its shirt, its name in its accent, what it does in the state's colour.
    for (const [id, s, task] of states) {
      const entry = legendOf(tree, id)
      expect(entry.map(e => e.text)).toEqual([O.legendSwatch, clip(task, O.legendName), said(s)])
      const accent = T.features.accents ? accentFor(id, T.accents.theme, T.palettes.theme.agent) : T.palettes.theme.agent
      expect(entry.map(e => e.color)).toEqual([shirtOf(id)[1], accent, T.palettes.theme[O.states[s].color]])
    }
    if (surface === 'terminal') {
      const raster = findNode(tree, n => n.type === 'Raster')
      expect([raster?.props?.key, raster?.props?.columns, raster?.props?.rows]).toEqual([rasterKey(), l.width, Math.ceil(l.height / 2)])
    } else {
      const svg = findNode(tree, n => n.type === 'Svg')
      expect([svg?.props?.width, svg?.props?.height]).toEqual([l.width * scale, l.height * scale])
      const agents = states.map(([, s, task]) => fill(OX.legend, { name: task, state: said(s) })).join(OX.sep)
      expect(svg?.props?.alt).toBe(fill(OX.alt, { desks: l.capacity, agents }))
      // Three moving desks: their frames are animated; the done desk is not.
      expect(svgPixels(String(svg?.props?.source)).groups.length).toBe(['typing', 'watching', 'waiting'].reduce((n, s) => n + frameCount(FINE, s as OfficeStateId) - 1, 0))
      expect(findNode(tree, n => n.type === 'Raster')).toBeUndefined()
    }
  }
  calls.release('g1-edit')
  calls.release('g2-bash')
  answer()
  await Promise.all([editing, shell])
  calls.release('g3-ask')
  await deploy
})

test('a permission ask raises the hand and blinks a "?"; the desk types again once the call is cleared', async ($, on) => {
  host(on)
  spawnsAs(on, 'w')
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  on('tool.check', (_$, e) => ({ decision: e.tool_use_id === 'ask1' ? 'ask' : 'allow' }) as never)
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
    expect(legendOf(tree, 'w1').map(e => e.text)[2]).toBe(O.states.waiting.word)
    const setName = surface === 'terminal' ? TERM : FINE
    const l = roomLayout(setName, surface === 'terminal' ? 66 : desktopScale(66).roomWidth, 1)
    expectDesk(`${surface} waiting`, roomPixels(tree), l, 0, { id: 'w1', state: 'waiting', frame: 0 })
  }
  // The raised arm differs from a resting pose, and the "?" blinks: its frames differ.
  for (const name of SETS) {
    const set = A.sets[name]
    expect([name, set.poses[O.states.waiting.pose]?.[0]]).not.toEqual([name, set.poses[O.states.watching.pose]?.[0]])
    const ask = set.screens[O.states.waiting.screen] ?? []
    expect([name, ask.length > 1, ask[0]?.join('').includes('A'), ask.some(f => !f.join('').includes('A'))]).toEqual([name, true, true, true])
  }
  answer()
  await pending
  expect(legendOf(await officeAt($, 66), 'w1').map(e => e.text)[2]).toBe(O.states.typing.word)
})

test('failed: a red screen with an X; stopped: the screen off; done: a green screen and the agent leaning back', async ($, on) => {
  host(on)
  spawnsAs(on, 'f')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Breaks'))
  await $.agent.spawn(spawnAsk('Cancelled'))
  await $.agent.spawn(spawnAsk('Finishes'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'F1', agentId: 'f1', reason: 'error' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'F2', agentId: 'f2', reason: 'aborted' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'F3', agentId: 'f3', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await officeAt($, 66, 'dock', surface)
    const setName = surface === 'terminal' ? TERM : FINE
    const l = roomLayout(setName, surface === 'terminal' ? 66 : desktopScale(66).roomWidth, 3)
    const paint = roomPixels(tree)
    const words = ['f1', 'f2', 'f3'].map(id => legendOf(tree, id).map(e => e.text)[2])
    expect([surface, words]).toEqual([surface, [O.states.failed.word, O.states.stopped.word, O.states.done.word]])
    ;(['failed', 'stopped', 'done'] as const).forEach((s, i) => expectDesk(`${surface} ${s}`, paint, l, i, { id: `f${i + 1}`, state: s, frame: 0 }))
  }
  // The screens say it: red with an X, off, green with a check; done leans back (its own pose).
  for (const name of SETS) {
    const set = A.sets[name]
    const colorsOf = (screen: string) => new Set((set.screens[screen]?.[0] ?? []).join('').split(''))
    expect([name, colorsOf(O.states.failed.screen).has('r')]).toEqual([name, true])
    expect([name, colorsOf(O.states.done.screen).has('G')]).toEqual([name, true])
    expect([name, [...colorsOf(O.states.stopped.screen)].every(ch => ch === 'o' || ch === 'n')]).toEqual([name, true])
    expect([name, O.states.done.pose === 'lean', (set.poses.lean ?? []).length > 0]).toEqual([name, true, true])
  }
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
    const box = deskBox(tree, 'h1')
    const l = roomLayout(surface === 'terminal' ? TERM : FINE, surface === 'terminal' ? 66 : desktopScale(66).roomWidth, 1)
    const at = deskCells(l, 0, surface === 'terminal' ? 'terminal' : 'graphical', desktopScale(66).scale)
    expect([box?.props?.position, box?.props?.top, box?.props?.left, box?.props?.width, box?.props?.height]).toEqual(['absolute', at.top, at.left, at.width, at.height])
    const hover = cardIn(box)
    expect([hover?.props?.display, hover?.hover?.display, hover?.props?.key]).toEqual(['none', 'flex', undefined])
    expect([hover?.props?.top, hover?.props?.left, hover?.props?.width]).toEqual([O.cardTop, cardPlace(at.left, 66).left, O.cardCols])
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
  const after = cardIn(deskBox(await officeAt($, 66), 'h1'))
  const lastLine = after ? nodes(after).filter(n => n.type === 'Text').map(textIn)[1] : ''
  expect(lastLine?.startsWith(fill(OX.last, { call: '' }))).toBe(true)
  await clock.advance(65_000)
  const ui = await $.ui.mount({ ...paneAsk(66), surface: 'terminal' })
  expect(textIn(await ui.drawn({ in: 'office-clock-h1' }))).toBe('1:05')
  await ui.unmount()
})

test('a card with no calls says so, a desk at the right edge moves its card left, and empty desks have no hover', async ($, on) => {
  host(on)
  spawnsAs(on, 'e')
  await roster($, `${T.desk.verb} office`)
  for (let i = 0; i < 3; i += 1) await $.agent.spawn(spawnAsk(`agent ${i}`))
  const tree = await officeAt($, 66)
  const l = roomLayout(TERM, 66, 3)
  for (let i = 0; i < 3; i += 1) {
    const hover = cardIn(deskBox(tree, `e${i + 1}`))
    expect(nodes(hover).filter(n => n.type === 'Text').map(textIn)[1]).toBe(OX.noCalls)
    expect(hover?.props?.left).toBe(cardPlace(deskCells(l, i, 'terminal').left, 66).left)
  }
  expect((cardIn(deskBox(tree, 'e3'))?.props?.left as number) < 0).toBe(true)
  expect(nodes(tree).filter(n => String(n.props?.key ?? '').startsWith('office-desk-')).length).toBe(3)
})

test('the room grows a row when the desks fill, up to its most, then counts the rest; with none it says it is empty', { timeoutMs: 60_000 }, async ($, on) => {
  host(on)
  spawnsAs(on, 'm')
  await roster($, `${T.desk.verb} office`)
  const D = A.sets[TERM].desk
  const empty = await officeAt($, 66)
  expect(textIn(empty).includes(OX.empty)).toBe(true)
  const r0 = findNode(empty, n => n.type === 'Raster')
  const base = roomLayout(TERM, 66, 0)
  expect(r0?.props?.rows).toBe(Math.ceil(base.height / 2))
  // Every desk empty.
  for (let i = 0; i < base.capacity; i += 1) expectDesk(`empty ${i}`, roomPixels(empty), base, i, null)
  const perRow = base.columns
  for (let i = 0; i < perRow * D.baseRows; i += 1) await $.agent.spawn(spawnAsk(`d${i}`))
  expect(findNode(await officeAt($, 66), n => n.type === 'Raster')?.props?.rows).toBe(Math.ceil(base.height / 2))
  await $.agent.spawn(spawnAsk('a new row'))
  const grown = roomLayout(TERM, 66, perRow * D.baseRows + 1)
  expect(grown.rows).toBe(D.baseRows + 1)
  expect(findNode(await officeAt($, 66), n => n.type === 'Raster')?.props?.rows).toBe(Math.ceil(grown.height / 2))
  for (let i = perRow * D.baseRows + 1; i < perRow * D.maxRows; i += 1) await $.agent.spawn(spawnAsk(`d${i}`))
  const full = await officeAt($, 66)
  expect(textIn(full).includes('+')).toBe(false)
  await $.agent.spawn(spawnAsk('one more'))
  const over = await officeAt($, 66)
  expect(isNode(over) ? textIn(kidsOf(over)[kidsOf(over).length - 1]) : '').toBe(fill(OX.more, { n: 1 }))
  expect(nodes(over).filter(n => String(n.props?.key ?? '').startsWith('office-desk-')).length).toBe(perRow * D.maxRows)
  expect(nodes(over).filter(n => String(n.props?.key ?? '').startsWith('office-legend-')).length).toBe(perRow * D.maxRows)
})

test("inline: a compact row per agent, glyph and words, the rest counted past the pane's rows", async ($, on) => {
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
  const top = async (cols: number) => textIn(findNode(await officeAt($, cols), n => n.props?.key === 'office-top')?.children?.[0])
  expect(await top(T.sizes.narrowBelow)).toBe([OX.title, fill(OX.counts, { running: 1, total: 1 })].join(OX.sep))
  const step = $.turn.step({ turnId: 'N', index: 0, model: 'x', messageCount: 1, agentId: 'n1' })
  for await (const _ of step) void _
  await step.result
  expect(await top(T.sizes.narrowBelow)).toBe([OX.title, fill(OX.counts, { running: 1, total: 1 }), fill(OX.tokens, { tokens: tokensShort(150) })].join(OX.sep))
  expect(await top(T.sizes.narrowBelow - 1)).toBe([OX.title, fill(OX.countsNarrow, { running: 1, total: 1 })].join(OX.sep))
})

test("every office drawing fits from the narrowest pane up and keeps a graphical surface's text whole", { timeoutMs: 120_000 }, async ($, on) => {
  host(on)
  spawnsAs(on, 'z')
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('An agent with a description far longer than any pane is wide, to be cut', 'a-very-long-subagent-type-name'))
  await $.agent.spawn(spawnAsk('second'))
  await $.tool.call({ tool: 'mcp__some_server__a_tool_with_a_long_name', tool_use_id: 'zz', agentId: 'z1' } as never)
  for (const cols of [T.pane.minColumns, 30, 40, 66, 110, 144]) {
    for (const placement of ['dock', 'inline'] as const) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const tree = await officeAt($, cols, placement, surface)
        const width = Math.max(cols, T.pane.minColumns)
        for (const n of nodes(tree)) {
          if (n.type === 'Text' && surface === 'desktop') expect([cols, textIn(n), textIn(n) === textIn(n).trim()]).toEqual([cols, textIn(n), true])
          if (n.type === 'Box' && typeof n.props?.width === 'number') expect([cols, n.props.width <= width]).toEqual([cols, true])
          if (n.type === 'Raster') expect([cols, Number(n.props?.columns) <= width]).toEqual([cols, true])
          if (n.type === 'Box' && n.props?.position === 'absolute' && String(n.props?.key ?? '').startsWith('office-desk-')) {
            expect([cols, (n.props?.left as number) + (n.props?.width as number) <= width || surface === 'desktop']).toEqual([cols, true])
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------- motion

test('while agents run, the timer blits the whole room at each frame; when they finish it slows to the clock and blits nothing', async ($, on) => {
  const { clock, blits } = host(on)
  spawnsAs(on, 't')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('typist'))
  await $.agent.spawn(spawnAsk('finished'))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'T2', agentId: 't2', reason: 'answer' })
  // A terminal draw tells the timer the room's width.
  await officeAt($, 66)
  const n = frameCount(TERM, 'typing')
  const start = clock.now()
  for (let i = 1; i <= n; i += 1) await clock.advance(O.frameMs)
  expect(blits.map(b => b.key)).toEqual(Array.from({ length: n }, () => rasterKey()))
  const l = roomLayout(TERM, 66, 2)
  blits.forEach((b, i) => {
    const now = start + (i + 1) * O.frameMs
    expect([i, b.columns, b.rows]).toEqual([i, l.width, Math.ceil(l.height / 2)])
    const paint = rasterPixels(b.cells, l.width)
    expectDesk(`blit ${i}`, paint, l, 0, { id: 't1', state: 'typing', frame: frameAt(now, n) })
    expectDesk(`blit ${i} done`, paint, l, 1, { id: 't2', state: 'done', frame: 0 })
  })
  // Each blit shows the next frame: consecutive blits differ.
  expect(new Set(blits.map(b => b.cells)).size).toBe(Math.min(n, blits.length))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'T1', agentId: 't1', reason: 'answer' })
  await clock.advance(O.frameMs)
  const before = blits.length
  for (let i = 0; i < 10; i += 1) await clock.advance(O.frameMs)
  expect(blits.length).toBe(before)
  // A new agent starts the frames again.
  await $.agent.spawn(spawnAsk('another'))
  await officeAt($, 66)
  await clock.advance(O.frameMs)
  expect(blits.length > before).toBe(true)
})

test('a redraw is at the frame the clock is on, so it carries on from the blits', async ($, on) => {
  const { clock } = host(on)
  spawnsAs(on, 'c')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('typist'))
  const n = frameCount(TERM, 'typing')
  const l = roomLayout(TERM, 66, 1)
  for (let k = 1; k <= n; k += 1) {
    await clock.advance(O.frameMs)
    const now = clock.now()
    expectDesk(`redraw ${k}`, roomPixels(await officeAt($, 66)), l, 0, { id: 'c1', state: 'typing', frame: frameAt(now, n) })
  }
})

test('the wall clock: the room redraws when the minute turns, and not before', async ($, on) => {
  const { clock, redraws } = host(on)
  await roster($, `${T.desk.verb} office`)
  const start = clock.now()
  const toTurn = 60_000 - (start % 60_000)
  // The first look only notes the minute.
  await clock.advance(O.clockCheckMs)
  const seen = redraws.n
  const checksBefore = Math.floor((toTurn - 1) / O.clockCheckMs) - 1
  for (let i = 0; i < checksBefore; i += 1) await clock.advance(O.clockCheckMs)
  expect(redraws.n).toBe(seen)
  for (let i = 0; i < Math.ceil(60_000 / O.clockCheckMs) + 1; i += 1) await clock.advance(O.clockCheckMs)
  expect(redraws.n > seen).toBe(true)
  // Drawn after the turn, the hands are at the new minute.
  const tree = await officeAt($, 66)
  const now = clock.now()
  const l = roomLayout(TERM, 66, 0)
  expect(roomPixels(tree)).toEqual(paintRoom(l, [], localTime(now)).concat(l.height % 2 === 1 ? [Array(l.width).fill(null)] : []))
})

test('the timer runs only in the office: on the deck or the desk no state is read and nothing is blitted', async ($, on) => {
  const { clock, blits } = host(on)
  const ticks = countReads(on)
  spawnsAs(on, 'v')
  await $.agent.spawn(spawnAsk('runs'))
  await officeAt($, 66)
  const onDeck = ticks.n
  for (let i = 0; i < 4; i += 1) await clock.advance(O.frameMs)
  expect(ticks.n).toBe(onDeck)
  await roster($, `${T.desk.verb} desk`)
  const onDesk = ticks.n
  for (let i = 0; i < 4; i += 1) await clock.advance(O.clockCheckMs)
  expect(ticks.n).toBe(onDesk)
  expect(blits).toEqual([])
  await roster($, `${T.desk.verb} office`)
  await officeAt($, 66)
  await clock.advance(O.frameMs)
  expect(blits.length).toBe(1)
  await roster($, `${T.desk.verb} deck`)
  await clock.advance(O.frameMs)
  const afterDeck = ticks.n
  for (let i = 0; i < 4; i += 1) await clock.advance(O.clockCheckMs)
  expect([blits.length, ticks.n]).toEqual([1, afterDeck])
})

test('inline, or drawn only on the desktop, the timer blits nothing', async ($, on) => {
  const { clock, blits } = host(on)
  spawnsAs(on, 'k')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('runs'))
  await officeAt($, 66, 'inline')
  await officeAt($, 66, 'dock', 'desktop')
  for (let i = 0; i < 4; i += 1) await clock.advance(O.frameMs)
  expect(blits).toEqual([])
  await officeAt($, 66)
  await clock.advance(O.frameMs)
  expect(blits.length).toBe(1)
})

test('with motion off nothing moves: no blits, the first frame, an SVG without animation', { options: { motion: T.config.motionOff } }, async ($, on) => {
  const { clock, blits } = host(on)
  spawnsAs(on, 'q')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('still'))
  await officeAt($, 66)
  await clock.advance(O.frameMs * 7)
  expect(blits).toEqual([])
  const l = roomLayout(TERM, 66, 1)
  expectDesk('still', roomPixels(await officeAt($, 66)), l, 0, { id: 'q1', state: 'typing', frame: 0 })
  expect(String(findNode(await officeAt($, 66, 'dock', 'desktop'), n => n.type === 'Svg')?.props?.source)).not.toContain('<animate')
})

test('an empty room on the desktop tells a reader every desk is empty', async ($, on) => {
  host(on)
  await roster($, `${T.desk.verb} office`)
  const svg = findNode(await officeAt($, 66, 'dock', 'desktop'), n => n.type === 'Svg')
  expect(svg?.props?.alt).toBe(fill(OX.alt, { desks: roomLayout(FINE, desktopScale(66).roomWidth, 0).capacity, agents: OX.emptyDesk }))
})

test('/roster reset keeps the office as the view and empties it', async ($, on) => {
  host(on)
  spawnsAs(on, 'x')
  await roster($, `${T.desk.verb} office`)
  await $.agent.spawn(spawnAsk('Work'))
  expect(await roster($, 'reset')).toBe(T.text.command.reset)
  const tree = await officeAt($, 66)
  expect(textIn(tree).includes(OX.empty)).toBe(true)
  expect(findNode(tree, n => String(n.props?.key ?? '').startsWith('office-desk-'))).toBeUndefined()
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
        const tree = await officeAt($, 66, placement, surface)
        const text = JSON.stringify(tree)
        expect(text.includes(T.text.drawFailed.split('{')[0] as string)).toBe(false)
        expect(text.includes(`"${OX.title}`)).toBe(isOffice)
        if (isOffice && placement === 'dock') expect(findNode(tree, n => n.type === (surface === 'terminal' ? 'Raster' : 'Svg'))).toBeDefined()
      }
    }
  })
}

test('the blank desk record is the deck, so a fresh session never opens on the office', () => {
  expect(blankDesk.view).toBe('deck')
})
