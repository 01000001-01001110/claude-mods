//! Office proof: renders the office room the way the plugin does, from the shipped rules and art, without the
//! engine, so a person (or Claude) can look at it. It writes the graphical surface's SVG rasterised to a PNG, the
//! terminal's half-block Raster as a PNG (each cell an upper and a lower half), and prints the terminal render as
//! text: the half-block frame, then the same pixels as their art letters, two letter rows a terminal row.
//!
//! The PNG encoder is our own (zlib's deflate from Node, the chunks and CRC written here); nothing is downloaded.
//! The hooks are TypeScript: this script runs itself again under Node's type stripping with a resolve hook that
//! adds the `.ts` the hooks' imports leave off.
//!
//! Usage: node agent-roster/scripts/office-proof.mjs [--out <folder>] [--columns 66] [--at 2026-11-08T10:10]
//!   writes <out>/ours-4-agents.png (desktop) and <out>/ours-4-agents-terminal.png; default out: the current folder.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : fallback
}

if (!process.argv.includes('--child')) {
  // Type stripping is behind a flag on Node 22; run again with it.
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2), '--child'], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

// The hooks import '../data/agent-roster' with no extension, as the engine's bundler allows: try `.ts` then `.tsx`.
const resolver = `
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[a-z]+$/.test(spec)) {
    for (const ext of ['.ts', '.tsx']) {
      try { return await next(spec + ext, ctx) } catch {}
    }
  }
  return next(spec, ctx)
}`
register(`data:text/javascript,${encodeURIComponent(resolver)}`, pathToFileURL(here + path.sep))

const rules = await import(pathToFileURL(path.join(here, '..', 'hooks', 'office-rules.ts')).href)
const { officeArt } = await import(pathToFileURL(path.join(here, '..', 'data', 'office-sprites.ts')).href)

const out = path.resolve(arg('--out', '.'))
const columns = Number(arg('--columns', '66'))
const at = arg('--at', '2026-11-08T10:10')
const [hh, mm] = at.split('T')[1].split(':').map(Number)
const time = { hours: hh, minutes: mm }

// The four agents the brief asks for: typing, at a shell, waiting on an ok, done.
const occupants = [
  ['a1', 'typing'],
  ['a2', 'watching'],
  ['a3', 'waiting'],
  ['a4', 'done'],
].map(([id, state]) => ({ card: { id }, tally: undefined, state }))

// ---------------------------------------------------------------- PNG

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/** CRC-32 of a byte run, as PNG chunks carry it. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
/** An RGB PNG of `w` by `h` from `pixel(x, y) -> [r, g, b]`. */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = pixel(x, y)
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// ---------------------------------------------------------------- the desktop: the SVG itself, rasterised

/**
 * Rasterises the SVG the plugin draws: its size and viewBox, and every `<path>` outside the animation groups
 * (the first frame), each `M x y h w v h h-w z` a filled rectangle. Reading the SVG, not the painting, proves the
 * markup.
 */
function rasterSvg(svg) {
  const size = /width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  const [W, H, vw] = [Number(size[1]), Number(size[2]), Number(size[3])]
  const scale = W / vw
  const canvas = Array.from({ length: H }, () => Array(W).fill([255, 0, 255]))
  // The dado's pattern: a tile of paths repeated under its rectangle, before the paths.
  const pattern = /<pattern id="\w+" width="(\d+)" height="(\d+)"[^>]*>(.*?)<\/pattern>/.exec(svg)
  const band = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="url\(#\w+\)"\/>/.exec(svg)
  if (pattern && band) {
    const tile = new Map()
    for (const m of pattern[3].matchAll(/<path fill="(#[0-9a-f]{6})" d="([^"]+)"\/>/g)) {
      for (const r of m[2].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)) {
        const [x, y, w, h] = r.slice(1).map(Number)
        for (let ty = y; ty < y + h; ty += 1) for (let tx = x; tx < x + w; tx += 1) tile.set(`${tx},${ty}`, rgb(m[1]))
      }
    }
    const [bx, by, bw, bh] = band.slice(1).map(Number)
    for (let py = by * scale; py < (by + bh) * scale; py += 1) {
      for (let px = bx * scale; px < (bx + bw) * scale; px += 1) {
        canvas[py][px] = tile.get(`${Math.floor(px / scale) % Number(pattern[1])},${Math.floor(py / scale) % Number(pattern[2])}`)
      }
    }
  }
  const still = svg.replace(/<g opacity="0">.*?<\/g>/g, '').replace(/<defs>.*?<\/defs>/g, '')
  for (const m of still.matchAll(/<path fill="(#[0-9a-f]{6})" d="([^"]+)"\/>/g)) {
    const color = rgb(m[1])
    for (const r of m[2].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)) {
      const [x, y, w, h] = r.slice(1).map(Number)
      for (let py = y * scale; py < (y + h) * scale; py += 1) for (let px = x * scale; px < (x + w) * scale; px += 1) canvas[py][px] = color
    }
  }
  return { W, H, canvas, groups: (svg.match(/<g opacity="0">/g) ?? []).length, chars: svg.length }
}

const { scale, roomWidth } = rules.desktopScale(columns)
const fine = rules.roomLayout(officeArt.graphicalSet, roomWidth, occupants.length)
const fineSeats = rules.seatsFor(fine, occupants, 0, true)
const svg = rules.roomSvg(fine, fineSeats, fineSeats.map(s => s !== null && rules.isMoving(s.state, true)), time, scale)
const shot = rasterSvg(svg)
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'ours-4-agents.png'), png(shot.W, shot.H, (x, y) => shot.canvas[y][x]))

// ---------------------------------------------------------------- the terminal: half blocks

const coarse = rules.roomLayout(officeArt.terminalSet, columns, occupants.length)
const seats = rules.seatsFor(coarse, occupants, 0, true)
const paint = rules.paintRoom(coarse, seats, time)
const cells = rules.halfBlocks(paint)
const CW = 8
const CH = 16
const hex = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255]
fs.writeFileSync(
  path.join(out, 'ours-4-agents-terminal.png'),
  png(columns * CW, cells.length * CH, (x, y) => {
    const cell = cells[Math.floor(y / CH)][Math.floor(x / CW)]
    const upper = y % CH < CH / 2
    const color = upper ? (cell.glyph === '▀' ? cell.fg : cell.bg) : cell.glyph === '▀' ? cell.bg : cell.fg
    return color === 0x01000000 ? [0, 0, 0] : hex(color)
  }),
)

// The letters back from the colours, for the text render (agent colours print as their ramp letter).
const byColor = new Map(Object.entries(officeArt.palette).map(([k, v]) => [v, k]))
for (const s of seats) {
  if (s === null) continue
  for (const [letter, color] of Object.entries(rules.agentColors(s.id))) if (!byColor.has(color)) byColor.set(color, letter)
}
console.log(`desktop: ${shot.W}x${shot.H} css px, scale ${scale}, room ${fine.width}x${fine.height} art px, ${fine.columns}x${fine.rows} desks, svg ${shot.chars} chars, ${shot.groups} animation groups`)
console.log(`terminal: ${columns} columns x ${cells.length} rows, ${coarse.columns}x${coarse.rows} desks, props: ${coarse.props.map(p => p.name).join(' ')}`)
console.log('--- terminal cells (glyphs) ---')
for (const row of cells) console.log(row.map(c => c.glyph).join(''))
console.log('--- terminal pixels as art letters (two letter rows a terminal row) ---')
for (const row of paint) console.log(row.map(c => (c === null ? ' ' : (byColor.get(c) ?? '?'))).join(''))
console.log(`wrote ${path.join(out, 'ours-4-agents.png')} and ${path.join(out, 'ours-4-agents-terminal.png')}`)
