//! Display width of text in terminal cells. CJK, fullwidth forms and emoji
//! take two cells, combining marks and joiners none, everything else one.
//! The diagram layout measures every label with this, so boxes close on the
//! right column whatever script a label is written in.

/**
 * Code point ranges drawn two cells wide. Structural, not tuning: this is the
 * Unicode East Asian Width table (W and F) plus the emoji blocks terminals
 * draw wide, and changing it would only misalign drawings.
 */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

/** Code points drawn in no cell of their own: combining marks, joiners, variation selectors. Structural (Unicode). */
const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe0fff],
]

/** The zero width joiner: the code point after it joins the glyph before (family emoji). */
const ZWJ = 0x200d

/** True when `cp` falls in one of `ranges` (sorted, binary search). */
function within(cp: number, ranges: readonly [number, number][]): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = ranges[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

/** Cells one code point takes on its own: 0, 1 or 2. Control characters take 0. */
export function cpWidth(cp: number): 0 | 1 | 2 {
  if (cp === ZWJ || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (within(cp, ZERO)) return 0
  return within(cp, WIDE) ? 2 : 1
}

/**
 * Splits text into glyphs, each with the cells it takes. A zero-width code
 * point, and anything after a joiner, rides on the glyph before it.
 */
export function glyphs(text: string): { text: string; width: 1 | 2 }[] {
  const out: { text: string; width: 1 | 2 }[] = []
  let joined = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const w = cpWidth(cp)
    const last = out[out.length - 1]
    if (last && (w === 0 || joined)) {
      last.text += ch
      joined = cp === ZWJ
      continue
    }
    joined = false
    // A lone zero-width code point with nothing before it is dropped: it cannot take a cell.
    if (w === 0) continue
    out.push({ text: ch, width: w })
  }
  return out
}

/** Cells `text` takes on one line. */
export function width(text: string): number {
  let n = 0
  for (const g of glyphs(text)) n += g.width
  return n
}
