//! The office's rules: what each agent at its desk is doing, how the desks wrap into rows, where the hover card
//! sits, and the pictures. A desk's picture is the data's sprite (a base, a pose laid over it at the avatar's
//! place, a screen at the monitor's) painted from the data's palette with the agent's shirt and the state's tints;
//! the terminal draws it as a Raster of half-block cells, a graphical surface as SVG.
//!
//! No `$`: the hooks module, the drawing and the tests all call these on plain values.

import { tuning as T } from '../data/agent-roster'
import type { AgentTally, Card, GateLog, OfficeStateId } from '../types'
import { accentFor } from './geometry'

const O = T.office

/** A painted picture: rows of colours, `null` where nothing is drawn. */
export type Paint = (string | null)[][]

/** The cell glyphs half-block painting uses. Structural: two pixel rows a cell, upper half or lower half. */
const UPPER = '▀'
const LOWER = '▄'
/** The Raster colour that means the terminal's own default. Structural: `RasterProps.cells`' encoding. */
const DEFAULT_COLOR = 0x01000000
/** The letter a sprite row leaves see-through, and the letter painted in the agent's shirt. Structural: the sprite format. */
const CLEAR = '.'
const SHIRT = 's'

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

// ---------------------------------------------------------------- layout

/** Desks one row holds in `width` cells: each the sprite's width, `deskGap` apart; never fewer than one. */
export function desksPerRow(width: number): number {
  return Math.max(1, Math.floor((width + O.deskGap) / (O.sprite.width + O.deskGap)))
}

/** The desks split into rows of `perRow`, in order. */
export function deskRowsOf<V>(items: V[], perRow: number): V[][] {
  const rows: V[][] = []
  for (let at = 0; at < items.length; at += perRow) rows.push(items.slice(at, at + perRow))
  return rows
}

/**
 * Where a desk's hover card sits, against the desk: as wide as the data asks or the pane allows, moved left
 * (a negative `left`) so its right edge stays inside a pane `width` cells wide, never left of the pane's edge.
 */
export function cardPlace(column: number, width: number): { left: number; width: number } {
  const cardWidth = Math.min(O.cardCols, width)
  const x = column * (O.sprite.width + O.deskGap)
  const left = Math.max(-x, Math.min(0, width - (x + cardWidth)))
  return { left, width: cardWidth }
}

// ---------------------------------------------------------------- frames

/** Greatest common divisor, for the frame count. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** The pose and screen frames of a state, from the data's sprite; a missing layer is no frames. */
function layersOf(state: OfficeStateId): { pose: string[][]; screen: string[][] } {
  const look = O.states[state]
  return { pose: O.sprite.poses[look.pose] ?? [], screen: O.sprite.screens[look.screen] ?? [] }
}

/** Frames a state's cycle takes: the least common multiple of its pose's and its screen's, at least one. */
export function frameCount(state: OfficeStateId): number {
  const { pose, screen } = layersOf(state)
  const a = Math.max(1, pose.length)
  const b = Math.max(1, screen.length)
  return (a * b) / gcd(a, b)
}

/** The frame showing at `now`: frames change every `frameMs`, all desks in step; one frame for a still desk. */
export function frameAt(now: number, count: number): number {
  if (count <= 1 || !Number.isFinite(now)) return 0
  return Math.floor(Math.max(0, now) / O.frameMs) % count
}

/** `layer` laid over `rows` at (x, y): its see-through letters keep what is below, the rest replace it. */
function overlay(rows: string[][], layer: readonly string[] | undefined, x: number, y: number) {
  if (layer === undefined) return
  layer.forEach((line, dy) => {
    const row = rows[y + dy]
    if (row === undefined) return
    Array.from(line).forEach((ch, dx) => {
      if (ch !== CLEAR && x + dx < row.length) row[x + dx] = ch
    })
  })
}

/** The sprite's letters for `state` at frame `index`: the base, then the pose, then the screen. */
export function spriteLetters(state: OfficeStateId, index: number): string[][] {
  const { pose, screen } = layersOf(state)
  const rows = O.sprite.base.map(line => Array.from(line))
  overlay(rows, pose.length > 0 ? pose[index % pose.length] : undefined, O.sprite.avatar.x, O.sprite.avatar.y)
  overlay(rows, screen.length > 0 ? screen[index % screen.length] : undefined, O.sprite.screen.x, O.sprite.screen.y)
  return rows
}

/** An agent's shirt: one of the data's shirts by its id, stable for the agent. */
export function shirtOf(id: string): string {
  return accentFor(id, O.shirts, O.palette[SHIRT] ?? O.palette.S ?? '#808080')
}

/** The letters painted: the state's tints first, then the shirt, then the palette; an unknown letter draws nothing. */
export function paintOf(letters: string[][], state: OfficeStateId, shirt: string): Paint {
  const tint = O.states[state].tint
  return letters.map(row => row.map(ch => (ch === CLEAR ? null : (tint[ch] ?? (ch === SHIRT ? shirt : O.palette[ch])) ?? null)))
}

/** A desk's picture for `state` at frame `index`, painted for the agent `id`. */
export function deskPicture(id: string, state: OfficeStateId, index: number): Paint {
  return paintOf(spriteLetters(state, index), state, shirtOf(id))
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

/** The Raster's size for the sprite: its width in columns, half its height in rows. */
export function rasterSize(): { columns: number; rows: number } {
  return { columns: O.sprite.width, rows: Math.ceil(O.sprite.height / 2) }
}

/** A desk's Raster cells for `state` at frame `index`. */
export function deskCells(id: string, state: OfficeStateId, index: number): string {
  return packCells(halfBlocks(deskPicture(id, state, index)))
}

// ---------------------------------------------------------------- graphical surfaces: SVG

/** One frame's pixels as rects, a run of one colour in a row one rect. */
function rectsOf(paint: Paint, px: number): string {
  const parts: string[] = []
  paint.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const color = row[x]
      let end = x + 1
      while (end < row.length && row[end] === color) end += 1
      if (color !== null && color !== undefined) parts.push(`<rect x="${x * px}" y="${y * px}" width="${(end - x) * px}" height="${px}" fill="${color}"/>`)
      x = end
    }
  })
  return parts.join('')
}

/**
 * A desk as SVG. A still desk is its first frame. A moving one holds every frame, each shown in turn for
 * `frameMs` by a discrete SMIL animation of its opacity, so the surface animates it with no redraw.
 */
export function deskSvg(id: string, state: OfficeStateId, moving: boolean, firstFrame: number): string {
  const px = O.svgPx
  const w = O.sprite.width * px
  const h = O.sprite.height * px
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`
  const count = frameCount(state)
  if (!moving || count <= 1) return `${head}${rectsOf(deskPicture(id, state, firstFrame), px)}</svg>`
  const groups: string[] = []
  for (let i = 0; i < count; i += 1) {
    const values = Array.from({ length: count }, (_, j) => (j === i ? 1 : 0)).join(';')
    const anim = `<animate attributeName="opacity" values="${values}" dur="${count * O.frameMs}ms" calcMode="discrete" repeatCount="indefinite"/>`
    groups.push(`<g opacity="${i === 0 ? 1 : 0}">${anim}${rectsOf(deskPicture(id, state, i), px)}</g>`)
  }
  return `${head}${groups.join('')}</svg>`
}

/** The SVG's size in CSS pixels. */
export function svgSize(): { width: number; height: number } {
  return { width: O.sprite.width * O.svgPx, height: O.sprite.height * O.svgPx }
}
