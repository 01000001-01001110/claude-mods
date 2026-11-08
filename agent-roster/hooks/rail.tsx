//! A connector between panels, animated on the surface's own frame clock. While `active`, packets (a bright head
//! with a trailing dot) move one cell to the right each frame; otherwise it rests as a dim line. Only this region
//! redraws, not the pane.
//!
//! A surface module runs on the drawing thread without the hooks module's imports, so every glyph and timing
//! arrives in its props from the data.

import type { ClientModule, RenderChildren } from 'claude-code'

/** What the deck hands a connector. */
type RailProps = {
  active: boolean
  width: number
  color: string
  dim: string
  /** Cells where a branch meets the line. */
  marks: number[]
  /** Branches merge into what is below (┴) rather than drop from what is above (┬). */
  isMerge: boolean
  /** Ask for the monospaced face: only where the engine has it; the prop is left off otherwise. */
  mono: boolean
  /** Glyphs from the data: line, branch, merge, packet head and tail. */
  glyphs: { line: string; branch: string; merge: string; head: string; tail: string }
  stepMs: number
  /** Cells between one packet and the next. */
  spacing: number
  /** Line cells drawn past the end and clipped by the box, so the right end is always the box's edge. */
  spare: number
}

/** The frame count, in one mutable record the timer and the drawing share. */
type Ticker = { frame: number; moving: boolean }

/** The line's cells at rest: the line glyph, a branch or merge glyph where a card meets it, spare cells past the end. */
function restingCells(p: RailProps, span: number): string[] {
  const g = p.glyphs
  const joint = p.isMerge ? g.merge : g.branch
  const out: string[] = []
  for (let i = 0; i < span + p.spare; i += 1) out.push(i < span && p.marks.includes(i) ? joint : g.line)
  return out
}

/**
 * The packet glyph lighting each cell at `frame`, by index; unlit cells are empty. Packets start every `spacing`
 * cells and wrap round the line plus one gap, so the line never empties; a later packet's tail can cover an
 * earlier one's head.
 */
function packetCells(p: RailProps, span: number, frame: number): (string | undefined)[] {
  const lit: (string | undefined)[] = new Array(span).fill(undefined)
  const loop = span + p.spacing
  for (let start = 0; start < loop; start += p.spacing) {
    const head = (start + frame) % loop
    if (head < span) lit[head] = p.glyphs.head
    if (head >= 1 && head <= span) lit[head - 1] = p.glyphs.tail
  }
  return lit
}

const Rail: ClientModule<RailProps, { ticker: Ticker }> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ticker = surface.state?.ticker ?? { frame: 0, moving: props.active }
  ticker.moving = props.active
  if (!surface.state) {
    surface.setState({ ticker })
    surface.every(props.stepMs, () => {
      // A still connector costs nothing: the timer only redraws while work flows.
      if (!ticker.moving) return
      ticker.frame += 1
      surface.setState({ ticker })
    })
  }

  const span = Math.max(1, surface.columns || props.width)
  const base = restingCells(props, span)
  const faceProps = props.mono ? { mono: true } : {}
  // Clipped at its width: in a proportional face glyph widths differ, and the spare cells keep the right end at
  // the box's edge every frame whatever the face does.
  const clip = (kids: RenderChildren) => (
    <Box overflow="hidden" width={span}>
      <Box flexShrink={0}>{kids}</Box>
    </Box>
  )

  if (!props.active) {
    return clip(
      <Text {...faceProps} color={props.dim}>
        {base.join('')}
      </Text>,
    )
  }

  // Neighbouring cells that are both lit, or both unlit, share one Text: a handful of nodes a frame, not one a cell.
  const lit = packetCells(props, span, ticker.frame)
  const isLit = (i: number) => lit[i] !== undefined
  const segments: RenderChildren[] = []
  let from = 0
  for (let i = 1; i <= base.length; i += 1) {
    if (i < base.length && isLit(i) === isLit(from)) continue
    let text = ''
    for (let j = from; j < i; j += 1) text += lit[j] ?? base[j]
    const on = isLit(from)
    segments.push(
      <Text {...faceProps} bold={on} color={on ? props.color : props.dim}>
        {text}
      </Text>,
    )
    from = i
  }
  return clip(segments)
}

export default Rail
