//! The office's rules: what each agent at its desk is doing, how the room is laid out for a width (the wall and
//! its props, the floor, the grid of desks and the props beside it), and the room painted pixel by pixel from the
//! art's letter grids, the agents in their own colours and the wall clock at the local time. The terminal shows the
//! painting as one Raster of half-block cells; a graphical surface as one SVG at a whole-number scale, whose running
//! desks carry their frames as a SMIL animation.
//!
//! No `$`: the hooks module, the drawing, the tests and the proof script all call these on plain values.

import { officeArt as A } from '../data/office-sprites'
import { tuning as T } from '../data/agent-roster'
import type { AgentTally, ArtSet, Card, GateLog, OfficeStateId, Sprite } from '../types'
import { indexFor } from './geometry'

const O = T.office

/** A painted picture: rows of `#rrggbb` colours, `null` where nothing is drawn. */
export type Paint = (string | null)[][]

/** Which of the art's sets: `fine` for graphical surfaces, `coarse` for the terminal (the data says which is which). */
export type SetName = keyof typeof A.sets

/** The cell glyphs half-block painting uses. Structural: two pixel rows a cell, upper half or lower half. */
const UPPER = '▀'
const LOWER = '▄'
/** The Raster colour that means the terminal's own default. Structural: `RasterProps.cells`' encoding. */
const DEFAULT_COLOR = 0x01000000
/** Salts that pick an agent's hair and skin apart from its shirt. Structural: only their difference matters. */
const HAIR_SALT = '#hair'
const SKIN_SALT = '#skin'
/** The widest Raster the terminal takes, in columns. Structural: `RasterProps.columns`' bound. */
const RASTER_COLUMNS_MAX = 512
/** Degrees a clock hand turns per minute and per hour on the dial. Structural: a clock's geometry. */
const MINUTE_DEGREES = 6
const HOUR_DEGREES = 30

// ---------------------------------------------------------------- what an agent is doing

/**
 * The state a desk shows. A finished card shows its end (done, failed, stopped). A running one shows a hand
 * raised while one of its calls waits on a permission ask, the progress bar while its latest call is a shell
 * tool, and typing otherwise (editing, reading, thinking between calls).
 */
export function officeStateOf(card: Card, tally: AgentTally | undefined, gate: GateLog): OfficeStateId {
  if (card.status === 'done') return 'done'
  if (card.status === 'failed') return 'failed'
  if (card.status !== 'running') return 'stopped'
  const live = tally?.live ?? []
  const asking = new Set(gate.recent.filter(k => k.verdict === 'ask').map(k => k.id))
  if (live.some(c => asking.has(c.id))) return 'waiting'
  const latest = live[live.length - 1]
  if (latest !== undefined && T.tools.shell.includes(latest.tool)) return 'watching'
  return 'typing'
}

/** The tool an agent is running now: its latest call still live, and only while it runs. */
export function toolNow(card: Card, tally: AgentTally | undefined): string | null {
  if (card.status !== 'running') return null
  const live = tally?.live ?? []
  return live.length > 0 ? (live[live.length - 1]?.tool ?? null) : null
}

/** Whether a state moves: only a running state, with motion on in the data and in the person's settings. */
export function isMoving(state: OfficeStateId, motionOn: boolean, motionWord: string = O.motion): boolean {
  const running = state === 'typing' || state === 'watching' || state === 'waiting'
  return running && motionOn && motionWord !== O.motionNone
}

/** One agent as the office sees it: its card, its desk tally and its state. */
export type Occupant = { card: Card; tally: AgentTally | undefined; state: OfficeStateId }

/** Every agent in spawn order with its tally and state. */
export function occupantsOf(cards: Card[], tallies: AgentTally[], gate: GateLog): Occupant[] {
  const byId = new Map(tallies.map(t => [t.id, t] as const))
  return cards.map(card => ({ card, tally: byId.get(card.id), state: officeStateOf(card, byId.get(card.id), gate) }))
}

// ---------------------------------------------------------------- per-agent colours

/** An agent's shirt ramp `[dark, mid, light]`, stable by id; its mid is the agent's pastel accent. */
export function shirtOf(id: string): [string, string, string] {
  return A.shirts[indexFor(id, A.shirts.length)] as [string, string, string]
}

/** The colour each agent letter paints for agent `id`: its shirt, hair and skin ramps. */
export function agentColors(id: string): Record<string, string> {
  const L = A.agentLetters
  const hair = A.hairs[indexFor(id + HAIR_SALT, A.hairs.length)] as [string, string, string]
  const skin = A.skins[indexFor(id + SKIN_SALT, A.skins.length)] as [string, string]
  const out: Record<string, string> = {}
  L.shirt.forEach((ch, i) => (out[ch] = shirtOf(id)[i] as string))
  L.hair.forEach((ch, i) => (out[ch] = hair[i] as string))
  L.skin.forEach((ch, i) => (out[ch] = skin[i] as string))
  return out
}

// ---------------------------------------------------------------- frames

/** Greatest common divisor, for the frame count. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** A state's pose and screen frames in a set; a missing layer is no frames. */
function layersOf(set: ArtSet, state: OfficeStateId): { pose: Sprite[]; screen: Sprite[] } {
  const look = O.states[state]
  return { pose: set.poses[look.pose] ?? [], screen: set.screens[look.screen] ?? [] }
}

/** Frames a state's cycle takes in a set: the least common multiple of its pose's and its screen's, at least one. */
export function frameCount(setName: SetName, state: OfficeStateId): number {
  const { pose, screen } = layersOf(A.sets[setName], state)
  const a = Math.max(1, pose.length)
  const b = Math.max(1, screen.length)
  return (a * b) / gcd(a, b)
}

/** The frame showing at `now`: frames change every `frameMs`, all desks in step; one frame for a still desk. */
export function frameAt(now: number, count: number): number {
  if (count <= 1 || !Number.isFinite(now)) return 0
  return Math.floor(Math.max(0, now) / O.frameMs) % count
}

// ---------------------------------------------------------------- the room's layout

/** Something placed in the room: its name, its top-left pixel and its size. */
export type Placed = { name: string; x: number; y: number; w: number; h: number }

/** The room for a width and a number of agents: its size, the grid of desks, and every prop that fits. */
export type RoomLayout = {
  setName: SetName
  width: number
  height: number
  /** The first floor row. */
  floorTop: number
  columns: number
  rows: number
  /** Desks in the room: `columns * rows`. */
  capacity: number
  /** Agents seated; the rest are counted as more. */
  shown: number
  more: number
  /** Each desk's top-left pixel, in reading order. */
  desks: { x: number; y: number }[]
  /** The desk picture's size. */
  deskW: number
  deskH: number
  /** Props in drawing order: the wall's, then the floor's from the back. */
  props: Placed[]
  /** The clock, when it fitted on the wall. */
  clock: Placed | null
}

/** A sprite's width and height. */
function sizeOf(s: Sprite): { w: number; h: number } {
  return { w: s[0]?.length ?? 0, h: s.length }
}

/** Whether two placed things overlap, with `gap` pixels kept between them. */
function overlaps(a: Placed, b: Placed, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/**
 * The room `width` pixels wide for `agents` agents in the named set. Desks a row: the data's, fewer when the room
 * is narrower, never none. Rows: the data's base, one more for each row the agents fill, up to the data's most;
 * agents past that are counted, not seated. The grid is centred on the floor under the wall; wall props go in their
 * priority order where they fit without overlapping, and floor props beside the grid where they clear it.
 */
export function roomLayout(setName: SetName, width: number, agents: number): RoomLayout {
  const set = A.sets[setName]
  const D = set.desk
  const { w: deskW, h: deskH } = sizeOf(D.base)
  const fit = Math.floor((width - 2 * D.margin + (D.pitchX - deskW)) / D.pitchX)
  const columns = Math.max(1, Math.min(D.columns, fit))
  const rows = Math.min(D.maxRows, Math.max(D.baseRows, Math.ceil(agents / columns)))
  const capacity = columns * rows
  const shown = Math.min(agents, capacity)
  const gridW = (columns - 1) * D.pitchX + deskW
  const gridX = Math.max(0, Math.floor((width - gridW) / 2))
  const floorTop = set.wall.height
  const gridY = floorTop + D.top
  const desks = Array.from({ length: capacity }, (_, i) => ({ x: gridX + (i % columns) * D.pitchX, y: gridY + Math.floor(i / columns) * D.pitchY }))
  const gridBottom = gridY + (rows - 1) * D.pitchY + deskH + D.bottom

  const placed: Placed[] = []
  for (const spot of set.wallProps) {
    const sprite = set.props[spot.prop]
    if (sprite === undefined) continue
    const { w, h } = sizeOf(sprite)
    const one = { name: spot.prop, x: Math.round(spot.at * width - w / 2), y: spot.y, w, h }
    if (one.x < 0 || one.x + w > width || placed.some(p => overlaps(p, one, 1))) continue
    placed.push(one)
  }
  const wallCount = placed.length
  // A floor prop must leave the desks a gap: on the left it ends before the grid, on the right it starts after it.
  const clearOfGrid = (p: Placed) => p.x >= 0 && p.x + p.w <= width && (p.x + p.w <= gridX - D.sideGap || p.x >= gridX + gridW + D.sideGap)
  const tryFloor = (spot: (typeof set.floorProps)[number], y: number) => {
    const sprite = set.props[spot.prop]
    if (sprite === undefined) return
    const { w, h } = sizeOf(sprite)
    const one = { name: spot.prop, x: spot.side === 'left' ? spot.inset : width - spot.inset - w, y, w, h }
    if (y >= floorTop && clearOfGrid(one) && !placed.some(p => overlaps(p, one, 1))) placed.push(one)
  }
  for (const spot of set.floorProps) if (spot.from === 'top') tryFloor(spot, floorTop + spot.y)
  // The room is as tall as its desks, or as the props from the top need, whichever is more.
  const height = Math.max(gridBottom, ...placed.slice(wallCount).map(p => p.y + p.h + D.bottom))
  for (const spot of set.floorProps) {
    const sprite = set.props[spot.prop]
    if (spot.from === 'bottom' && sprite !== undefined) tryFloor(spot, height - spot.y - sizeOf(sprite).h)
  }
  // Floor props drawn from the back to the front, so a nearer one covers a farther one.
  const props = placed.slice(0, wallCount).concat(placed.slice(wallCount).sort((a, b) => a.y + a.h - (b.y + b.h)))
  const clock = props.find(p => p.name === set.clock.prop) ?? null
  return { setName, width, height, floorTop, columns, rows, capacity, shown, more: agents - shown, desks, deskW, deskH, props, clock }
}

// ---------------------------------------------------------------- the clock

/** The local hour (0 to 23) and minute at `now`, by the runtime's own time zone. */
export function localTime(now: number): { hours: number; minutes: number } {
  const d = new Date(Number.isFinite(now) ? now : 0)
  return { hours: d.getHours(), minutes: d.getMinutes() }
}

/** The hands' angles in degrees clockwise from twelve: the hour hand moves on through its hour as minutes pass. */
export function handAngles(hours: number, minutes: number): { hour: number; minute: number } {
  return { hour: ((hours % 12) + minutes / 60) * HOUR_DEGREES, minute: minutes * MINUTE_DEGREES }
}

/** Where a hand `length` pixels long at `degrees` ends, from the pivot: rounded to the nearest pixel. */
export function handTip(pivot: { x: number; y: number }, length: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180
  return { x: pivot.x + Math.round(length * Math.sin(rad)), y: pivot.y - Math.round(length * Math.cos(rad)) }
}

/** The pixels of a straight line from `a` to `b`, both ends included (Bresenham). */
export function linePixels(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const dx = Math.abs(b.x - a.x)
  const dy = -Math.abs(b.y - a.y)
  const sx = a.x < b.x ? 1 : -1
  const sy = a.y < b.y ? 1 : -1
  let err = dx + dy
  let { x, y } = a
  for (;;) {
    out.push({ x, y })
    if (x === b.x && y === b.y) return out
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

// ---------------------------------------------------------------- painting

/** One agent at a desk for painting: who, what it is doing, and which frame shows. */
export type Seat = { id: string; state: OfficeStateId; frame: number }

/** A canvas the room is painted on, and the palette lookups. */
class Canvas {
  readonly px: Paint
  readonly w: number
  readonly h: number
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.px = Array.from({ length: h }, () => Array<string | null>(w).fill(null))
  }
  /** Sets one pixel from a letter; a letter outside the palette and `extra` paints nothing. */
  dot(x: number, y: number, letter: string, extra?: Record<string, string>) {
    const row = this.px[y]
    if (row === undefined || x < 0 || x >= this.w) return
    const color = extra?.[letter] ?? A.palette[letter]
    if (color !== undefined) row[x] = color
  }
  /** Lays a sprite with its top-left at (x, y); see-through letters keep what is below. */
  sprite(s: Sprite | undefined, x: number, y: number, extra?: Record<string, string>) {
    s?.forEach((line, dy) => {
      Array.from(line).forEach((ch, dx) => {
        if (ch !== A.clear) this.dot(x + dx, y + dy, ch, extra)
      })
    })
  }
}

/** A small stable mix of a plank's row and number, so neighbouring planks take different letters. */
function plankMix(row: number, plank: number): number {
  return Math.abs((row * 73_856_093) ^ (plank * 19_349_663)) % 1_000_003
}

/** The wall's letter at (x, y): trim at the top, the skirting at the foot, the dado line and its dithered band. */
export function wallLetter(set: ArtSet, x: number, y: number): string {
  const W = set.wall
  if (y < W.trim.length) return W.trim[y] as string
  const skirtingFrom = W.height - W.skirting.length
  if (y >= skirtingFrom) return W.skirting[y - skirtingFrom] as string
  if (y === W.dado.top) return W.dado.line
  if (y > W.dado.top) return W.dado.dither[(x + y) % 2] as string
  return W.fill
}

/**
 * The floor's letter at (x, y) below the wall: rows of planks `plankRows` tall, the last row of each a seam; along a
 * row the data's lengths in turn, shifted `stagger` a row, a seam column where planks meet, the lit edge on top, a
 * nail just after each start, and each plank's own variant.
 */
export function floorLetter(set: ArtSet, x: number, y: number): string {
  const F = set.floor
  const py = y - set.wall.height
  const row = Math.floor(py / F.plankRows)
  const within = py % F.plankRows
  if (within === F.plankRows - 1) return F.seam
  const cycle = F.lengths.reduce((n, l) => n + l, 0)
  const along = x + row * F.stagger
  const lap = Math.floor(along / cycle)
  let at = along - lap * cycle
  let index = 0
  while (at >= (F.lengths[index] as number)) {
    at -= F.lengths[index] as number
    index += 1
  }
  if (at === 0) return F.seam
  if (within === 0) return F.edge
  const middle = Math.floor((F.plankRows - 1) / 2)
  if (F.nail !== null && at === 2 && (within === middle || within === middle + 1)) return F.nail
  return F.variants[plankMix(row, lap * F.lengths.length + index) % F.variants.length] as string
}

/**
 * The room painted: wall and floor, the props, the clock's hands at `time`, then the desks row by row (a nearer row
 * over a farther one), each the desk, its screen, its agent and the chair. `seats` holds one entry a desk, null
 * for an empty desk, which shows the data's empty screen and an empty chair.
 */
export function paintRoom(layout: RoomLayout, seats: (Seat | null)[], time: { hours: number; minutes: number }): Paint {
  const set = A.sets[layout.setName]
  const c = new Canvas(layout.width, layout.height)
  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) c.dot(x, y, y < layout.floorTop ? wallLetter(set, x, y) : floorLetter(set, x, y))
  }
  for (const p of layout.props) c.sprite(set.props[p.name], p.x, p.y)
  if (layout.clock !== null) {
    const K = set.clock
    const pivot = { x: layout.clock.x + K.pivot.x, y: layout.clock.y + K.pivot.y }
    const angles = handAngles(time.hours, time.minutes)
    for (const at of linePixels(pivot, handTip(pivot, K.minuteLength, angles.minute))) c.dot(at.x, at.y, K.minuteHand)
    for (const at of linePixels(pivot, handTip(pivot, K.hourLength, angles.hour))) c.dot(at.x, at.y, K.hourHand)
    c.dot(pivot.x, pivot.y, K.hub)
  }
  const D = set.desk
  layout.desks.forEach((at, i) => {
    const seat = seats[i] ?? null
    c.sprite(D.base, at.x, at.y)
    const look = seat === null ? null : O.states[seat.state]
    const screens = set.screens[look?.screen ?? O.emptyScreen] ?? []
    c.sprite(screens[(seat?.frame ?? 0) % Math.max(1, screens.length)], at.x + D.screenAt.x, at.y + D.screenAt.y)
    if (seat !== null && look !== null) {
      const poses = set.poses[look.pose] ?? []
      c.sprite(poses[seat.frame % Math.max(1, poses.length)], at.x + D.agentAt.x, at.y + D.agentAt.y, agentColors(seat.id))
    }
    c.sprite(D.chair, at.x + D.chairAt.x, at.y + D.chairAt.y)
  })
  return c.px
}

/**
 * The seats for a room: the first `layout.shown` agents in spawn order, at the frame showing at `now` when they
 * move, the first frame when still; empty desks after them.
 */
export function seatsFor(layout: RoomLayout, occupants: Occupant[], now: number, motionOn: boolean): (Seat | null)[] {
  return Array.from({ length: layout.capacity }, (_, i) => {
    const o = i < layout.shown ? occupants[i] : undefined
    if (o === undefined) return null
    const frame = isMoving(o.state, motionOn) ? frameAt(now, frameCount(layout.setName, o.state)) : 0
    return { id: o.card.id, state: o.state, frame }
  })
}

// ---------------------------------------------------------------- the terminal: Raster cells

/** `#rrggbb` as 0x00RRGGBB; anything else is the terminal's default colour. */
export function colorWord(hex: string | null): number {
  const m = hex === null ? null : /^#([0-9a-fA-F]{6})$/.exec(hex)
  return m ? parseInt(m[1] as string, 16) : DEFAULT_COLOR
}

/** One Raster cell: a glyph, a foreground and a background. */
export type Cell = { glyph: string; fg: number; bg: number }

/**
 * A picture as half-block cells, two pixel rows a cell row: upper half in the top pixel's colour over the bottom's,
 * the lower half alone where only the bottom is drawn, a blank where neither is.
 */
export function halfBlocks(paint: Paint): Cell[][] {
  const out: Cell[][] = []
  for (let y = 0; y < paint.length; y += 2) {
    const top = paint[y] ?? []
    const bottom = paint[y + 1] ?? []
    const row: Cell[] = []
    for (let x = 0; x < Math.max(top.length, bottom.length); x += 1) {
      const up = top[x] ?? null
      const down = bottom[x] ?? null
      if (up === null && down === null) row.push({ glyph: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR })
      else if (up === null) row.push({ glyph: LOWER, fg: colorWord(down), bg: DEFAULT_COLOR })
      else row.push({ glyph: UPPER, fg: colorWord(up), bg: down === null ? DEFAULT_COLOR : colorWord(down) })
    }
    out.push(row)
  }
  return out
}

/** Standard padded base64 of `bytes`. Written out because the engine's runtime may lack `toBase64`. */
export function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += alphabet[(n >> 18) & 63]
    out += alphabet[(n >> 12) & 63]
    out += b === undefined ? '=' : alphabet[(n >> 6) & 63]
    out += c === undefined ? '=' : alphabet[n & 63]
  }
  return out
}

/** Cells packed for a Raster: row-major little-endian u32 triplets `[codePoint, fg, bg]`, base64. */
export function packCells(cells: Cell[][]): string {
  const flat = cells.flat()
  const bytes = new Uint8Array(flat.length * 12)
  const view = new DataView(bytes.buffer)
  flat.forEach((cell, i) => {
    view.setUint32(i * 12, cell.glyph.codePointAt(0) ?? 32, true)
    view.setUint32(i * 12 + 4, cell.fg >>> 0, true)
    view.setUint32(i * 12 + 8, cell.bg >>> 0, true)
  })
  return base64(bytes)
}

/** The terminal room's width for a body `width` columns wide: a pixel a column, within the Raster's bound. */
export function terminalRoomWidth(width: number): number {
  return Math.max(1, Math.min(RASTER_COLUMNS_MAX, width))
}

/** The Raster for a room: its columns (a pixel each), its rows (two pixels each) and its packed cells. */
export function roomRaster(layout: RoomLayout, seats: (Seat | null)[], time: { hours: number; minutes: number }) {
  return { columns: layout.width, rows: Math.ceil(layout.height / 2), cells: packCells(halfBlocks(paintRoom(layout, seats, time))) }
}

// ---------------------------------------------------------------- graphical surfaces: SVG

/** The whole-number scale and the room's width in art pixels for a pane `columns` wide on a graphical surface. */
export function desktopScale(columns: number): { scale: number; roomWidth: number } {
  const D = O.desktop
  const css = Math.max(1, columns) * D.columnPx
  const scale = Math.min(D.maxScale, Math.max(D.minScale, Math.floor(css / D.targetRoomPx)))
  return { scale, roomWidth: Math.min(D.maxRoomPx, Math.floor(css / scale)) }
}

/**
 * A painting as one `<path>` per colour, each run of a colour in a row merged with the same run in the rows under
 * it into one rectangle, so a room stays well inside the surface's size limit.
 */
export function pathsOf(paint: Paint): string {
  type Open = { x: number; y: number; w: number; h: number; color: string }
  const done: Open[] = []
  let open = new Map<string, Open>()
  paint.forEach((row, y) => {
    const next = new Map<string, Open>()
    let x = 0
    while (x < row.length) {
      const color = row[x] ?? null
      let end = x + 1
      while (end < row.length && (row[end] ?? null) === color) end += 1
      if (color !== null) {
        const key = `${x},${end},${color}`
        const above = open.get(key)
        if (above !== undefined) {
          above.h += 1
          open.delete(key)
          next.set(key, above)
        } else next.set(key, { x, y, w: end - x, h: 1, color })
      }
      x = end
    }
    done.push(...open.values())
    open = next
  })
  done.push(...open.values())
  const byColor = new Map<string, string[]>()
  for (const r of done) {
    const list = byColor.get(r.color) ?? []
    list.push(`M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z`)
    byColor.set(r.color, list)
  }
  return Array.from(byColor, ([color, parts]) => `<path fill="${color}" d="${parts.join('')}"/>`).join('')
}

/** The id of the dado's SVG pattern. Structural: only the markup refers to it. */
const DADO_ID = 'dado'

/**
 * The wall's dithered dado band as one SVG pattern: a 2 by 2 tile of the two dither letters under one rectangle
 * across the band, drawn first. `rest` takes the band's pixels that still show the dither out of a painting, so
 * the paths carry only what covers the band (props), not one rectangle per dithered pixel, which alone would pass
 * the surface's size limit.
 */
export function dadoPattern(layout: RoomLayout): { markup: string; rest: (paint: Paint) => Paint } {
  const W = A.sets[layout.setName].wall
  const top = W.dado.top + 1
  const bottom = W.height - W.skirting.length
  const tone = (x: number, y: number) => A.palette[W.dado.dither[(x + y) % 2] as string] ?? null
  if (bottom <= top) return { markup: '', rest: paint => paint }
  const tile: Paint = [0, 1].map(y => [0, 1].map(x => tone(x, y)))
  const markup =
    `<defs><pattern id="${DADO_ID}" width="2" height="2" patternUnits="userSpaceOnUse">${pathsOf(tile)}</pattern></defs>` +
    `<rect x="0" y="${top}" width="${layout.width}" height="${bottom - top}" fill="url(#${DADO_ID})"/>`
  const rest = (paint: Paint) => paint.map((row, y) => (y < top || y >= bottom ? row : row.map((c, x) => (c === tone(x, y) ? null : c))))
  return { markup, rest }
}

/** The pixels of `frame` that differ from `base`; null elsewhere. */
function changed(base: Paint, frame: Paint): Paint {
  return frame.map((row, y) => row.map((color, x) => (color !== (base[y]?.[x] ?? null) ? color : null)))
}

/**
 * The room as SVG, `scale` CSS pixels an art pixel, crisp edges. Still, every seat at its first frame. A moving
 * seat's other frames are laid over it as groups, each showing only the pixels that frame changes, shown in turn
 * for `frameMs` by a discrete SMIL animation of its opacity, so the surface animates it with no redraw.
 */
export function roomSvg(layout: RoomLayout, seats: (Seat | null)[], moving: boolean[], time: { hours: number; minutes: number }, scale: number): string {
  const still = seats.map(s => (s === null ? null : { ...s, frame: 0 }))
  const base = paintRoom(layout, still, time)
  const w = layout.width
  const h = layout.height
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`
  const groups: string[] = []
  seats.forEach((seat, i) => {
    if (seat === null || moving[i] !== true) return
    const count = frameCount(layout.setName, seat.state)
    for (let f = 1; f < count; f += 1) {
      const framed = still.map((s, j) => (j === i && s !== null ? { ...s, frame: f } : s))
      const values = Array.from({ length: count }, (_, k) => (k === f ? 1 : 0)).join(';')
      const anim = `<animate attributeName="opacity" values="${values}" dur="${count * O.frameMs}ms" calcMode="discrete" repeatCount="indefinite"/>`
      groups.push(`<g opacity="0">${anim}${pathsOf(changed(base, paintRoom(layout, framed, time)))}</g>`)
    }
  })
  const dado = dadoPattern(layout)
  return `${head}${dado.markup}${pathsOf(dado.rest(base))}${groups.join('')}</svg>`
}

// ---------------------------------------------------------------- hover places

/** A desk's place in cells over the drawn room: its column and row, and its size. */
export type DeskCells = { left: number; top: number; width: number; height: number }

/**
 * Where desk `i`'s hover box sits, in cells. The terminal: a pixel a column, two a row. A graphical surface: the
 * art pixel times the scale, over the data's CSS pixels a column and a row.
 */
export function deskCells(layout: RoomLayout, i: number, surface: 'terminal' | 'graphical', scale = 1): DeskCells {
  const at = layout.desks[i] ?? { x: 0, y: 0 }
  if (surface === 'terminal') {
    const top = Math.floor(at.y / 2)
    return { left: at.x, top, width: layout.deskW, height: Math.ceil((at.y + layout.deskH) / 2) - top }
  }
  const D = O.desktop
  const left = Math.floor((at.x * scale) / D.columnPx)
  const top = Math.floor((at.y * scale) / D.rowPx)
  return { left, top, width: Math.max(1, Math.ceil((layout.deskW * scale) / D.columnPx)), height: Math.max(1, Math.ceil((layout.deskH * scale) / D.rowPx)) }
}

/**
 * Where a hover card sits against its desk: as wide as the data asks or the pane allows, moved left (a negative
 * `left`) so its right edge stays inside a pane `width` cells wide, never left of the pane's edge.
 */
export function cardPlace(deskLeft: number, width: number): { left: number; width: number } {
  const cardWidth = Math.min(O.cardCols, width)
  const left = Math.max(-deskLeft, Math.min(0, width - (deskLeft + cardWidth)))
  return { left, width: cardWidth }
}
