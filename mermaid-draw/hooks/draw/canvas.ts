//! The drawing surface every diagram is painted on: a grid of terminal cells.
//! Lines are kept as the sides each cell joins (up, down, left, right) and
//! turned into glyphs only at the end, so two lines that meet become a corner,
//! a tee or a cross by themselves. Text is written glyph by glyph with its
//! display width: a wide glyph takes its cell and the one after it.

import type { Art, BoxGlyphs, Glyphs, LineStyle, Role, Span } from '../../types'
import { glyphs as split } from './width'

/** Side bits a cell's line joins. Structural: a bit layout, not a tunable. */
export const UP = 1
export const DOWN = 2
export const LEFT = 4
export const RIGHT = 8

/** A point on the grid. */
export interface Point {
  x: number
  y: number
}

interface Cell {
  /** A glyph set outright (text, box, head); wins over any line through the cell. */
  ch?: string
  /** True on the right half of a wide glyph: drawn as nothing. */
  tail?: boolean
  mask: number
  style: LineStyle
  role: Role | 'none'
}

/** The junctions key for a mask: the joined sides spelled `u`, `d`, `l`, `r` in that order. */
export function maskKey(mask: number): string {
  return (mask & UP ? 'u' : '') + (mask & DOWN ? 'd' : '') + (mask & LEFT ? 'l' : '') + (mask & RIGHT ? 'r' : '')
}

/** A fixed-size grid of cells; writes outside it are dropped. */
export class Canvas {
  readonly width: number
  readonly height: number
  private readonly cells: Cell[][]

  /** An empty grid `width` cells across and `height` down, drawn with `glyphs`. */
  constructor(width: number, height: number, private readonly glyphs: Glyphs) {
    this.width = Math.max(0, width)
    this.height = Math.max(0, height)
    this.cells = Array.from({ length: this.height }, () => Array.from({ length: this.width }, (): Cell => ({ mask: 0, style: 'solid', role: 'none' })))
  }

  private at(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x]
  }

  /** Sets one cell to a one-cell glyph. */
  put(x: number, y: number, ch: string, role: Role): void {
    const cell = this.at(x, y)
    if (!cell) return
    // Writing over either half of a wide glyph clears the other half.
    if (cell.tail) this.clear(x - 1, y)
    else if (this.at(x + 1, y)?.tail) this.clear(x + 1, y)
    cell.ch = ch
    cell.tail = false
    cell.role = role
  }

  private clear(x: number, y: number): void {
    const cell = this.at(x, y)
    if (!cell) return
    cell.ch = ' '
    cell.tail = false
  }

  /** Writes `text` from `(x, y)` rightwards; a wide glyph that would cross the right edge is dropped. */
  write(x: number, y: number, text: string, role: Role): void {
    let col = x
    for (const g of split(text)) {
      if (col + g.width > this.width) break
      if (col >= 0) {
        this.put(col, y, g.text, role)
        if (g.width === 2) {
          this.put(col + 1, y, '', role)
          this.at(col + 1, y)!.tail = true
        }
      }
      col += g.width
    }
  }

  /** True when a cell holds a glyph set outright (a label, a box, a head). */
  isSet(x: number, y: number): boolean {
    const ch = this.at(x, y)?.ch
    return ch !== undefined && ch !== ' '
  }

  /** Adds the sides in `mask` to a cell's line. */
  join(x: number, y: number, mask: number, style: LineStyle, role: Role): void {
    const cell = this.at(x, y)
    if (!cell) return
    cell.mask |= mask
    cell.style = style
    if (cell.ch === undefined) cell.role = role
  }

  /**
   * Draws a line through orthogonal corner points. Each cell joins its
   * neighbours along the path, so the ends join only inward.
   */
  path(points: Point[], style: LineStyle, role: Role): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      const dx = Math.sign(b.x - a.x)
      const dy = Math.sign(b.y - a.y)
      let x = a.x
      let y = a.y
      while (x !== b.x || y !== b.y) {
        const nx = x + (x !== b.x ? dx : 0)
        const ny = y + (x !== b.x ? 0 : dy)
        const toward = nx > x ? RIGHT : nx < x ? LEFT : ny > y ? DOWN : UP
        const back = toward === RIGHT ? LEFT : toward === LEFT ? RIGHT : toward === DOWN ? UP : DOWN
        this.join(x, y, toward, style, role)
        this.join(nx, ny, back, style, role)
        x = nx
        y = ny
      }
    }
  }

  /** Draws a box's frame with `g`, `w` by `h` cells from `(x, y)`. */
  box(x: number, y: number, w: number, h: number, g: BoxGlyphs, role: Role): void {
    if (w < 2 || h < 2) return
    const right = x + w - 1
    const bottom = y + h - 1
    for (let i = x + 1; i < right; i++) {
      this.put(i, y, g.h, role)
      this.put(i, bottom, g.h, role)
    }
    for (let j = y + 1; j < bottom; j++) {
      this.put(x, j, g.left, role)
      this.put(right, j, g.right, role)
    }
    this.put(x, y, g.tl, role)
    this.put(right, y, g.tr, role)
    this.put(x, bottom, g.bl, role)
    this.put(right, bottom, g.br, role)
  }

  /** The glyph a cell draws as. */
  private glyph(cell: Cell): string {
    if (cell.tail) return ''
    if (cell.ch !== undefined) return cell.ch
    if (cell.mask === 0) return ' '
    const line = this.glyphs.lines[cell.style]
    // A straight run keeps its style (dotted, thick); a meeting of lines is drawn from the junction table.
    if ((cell.mask & (LEFT | RIGHT)) === 0) return line.v
    if ((cell.mask & (UP | DOWN)) === 0) return line.h
    return this.glyphs.junctions[maskKey(cell.mask)] ?? ' '
  }

  /** The finished drawing: rows of same-role spans, right-trimmed, and the widest row's width. */
  art(warnings: string[] = []): Art {
    const rows: Span[][] = []
    let widest = 0
    for (const line of this.cells) {
      let end = line.length
      while (end > 0 && this.glyph(line[end - 1]!) === ' ') end--
      widest = Math.max(widest, end)
      const spans: Span[] = []
      for (let i = 0; i < end; i++) {
        const cell = line[i]!
        const text = this.glyph(cell)
        const role = text === ' ' ? 'none' : cell.role
        const last = spans[spans.length - 1]
        if (last && last.role === role) last.text += text
        else spans.push({ text, role })
      }
      rows.push(spans)
    }
    // Blank rows at the bottom carry nothing.
    while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop()
    return { rows, width: widest, warnings }
  }
}

/** A drawing's rows as plain strings (tests, and width checks). */
export function plain(art: Art): string[] {
  return art.rows.map(row => row.map(s => s.text).join(''))
}
