//! The office: the pane's third view (DESIGN.md, additions), reached by `/roster view office`. Each subagent has a
//! desk, in spawn order, wrapping into rows: a pixel avatar at a monitor (a Raster on the terminal, SVG where the
//! surface draws it), its name, and what it is doing. Hovering a desk reveals its card: the task, the call running
//! or the last one, tokens and the time it has taken. The top row names the office, counts the desks, and holds
//! the switch back to the deck and the close control, as the helper desk's does.
//!
//! Inline above the prompt it is compact: the top row, then an agent a line. Like the other views it draws a
//! snapshot and never writes state; the frame showing is taken from the clock, so the terminal blits that
//! register.tsx sends between draws (and the desktop's SMIL animation) carry on from it. Every text, size,
//! colour and frame is data.

import type { ElementTable, RenderChildren, RenderElement } from 'claude-code'

import { tuning as T } from '../data/agent-roster'
import type { AgentTally, Card, Colors, DeskState, GateLog, OfficeStateId } from '../types'
import { accentFor, cardLabel, cells } from './geometry'
import { cardPlace, deskCells, deskRowsOf, deskSvg, desksPerRow, frameAt, frameCount, isMoving, officeStateOf, rasterSize, svgSize, toolNow } from './office-rules'
import type { Settings } from './records'
import { clip, counted, fill, tokensShort } from './words'

const O = T.office
const OX = T.officeText
const G = T.glyphs
const Z = T.sizes

/**
 * Cells a plain Button with a hotkey adds before its label: the key, a colon and a space. Structural: how the
 * terminal draws such a Button.
 */
const HOTKEY_CELLS = 3

/** Everything one office drawing needs. */
export type OfficeInput = {
  els: ElementTable
  /** The surface drawn on: the picture is a Raster on the terminal alone. */
  surface: string
  /** The body's width, already held to the pane's minimum. */
  width: number
  isInline: boolean
  settings: Settings
  colors: Colors
  cards: Card[]
  desk: DeskState
  gate: GateLog
  /** The clock's reading for this draw: which frame shows. */
  now: number
  /** Whether running desks animate: the person's motion setting and the surface's room for it. */
  motionOn: boolean
  /** A live clock from `since`, stopped at `endAt`. */
  timer: (key: string, since: number, endAt: number | null, color: string) => RenderChildren
  /** Back to the deck: the switch on the top row and its hotkey. */
  toDeck: () => void
  /** Closes the pane: the close control. */
  close: () => void
}

/** One desk as drawn: its card, its tally, what it is doing and its place in its row. */
type Seat = { card: Card; tally: AgentTally | undefined; state: OfficeStateId; column: number }

/** The Raster's key for agent `id`'s desk: what register.tsx's blits name. */
export function rasterKey(id: string): string {
  return `office-px-${id}`
}

/** Draws the office: the inline summary, or the docked rows of desks. */
export function drawOffice(d: OfficeInput): RenderElement {
  const { Box } = d.els
  const byId = new Map(d.desk.tallies.map(t => [t.id, t] as const))
  const all = d.cards.map(card => ({ card, tally: byId.get(card.id), state: officeStateOf(card, byId.get(card.id), d.gate) }))
  if (d.isInline) {
    // The top row first; agents take what is left, one row kept for "+N more" when they do not all fit.
    const left = T.pane.inlineRows - 1
    const fits = all.length <= left ? all.length : Math.max(0, left - 1)
    return (
      <Box flexDirection="column" width={d.width}>
        {topRow(d, all)}
        {all.slice(0, fits).map(s => inlineLine(d, s))}
        {all.length > fits ? quiet(d, fill(OX.more, { n: all.length - fits })) : null}
      </Box>
    )
  }
  const shown = all.slice(0, O.maxDesks)
  const perRow = desksPerRow(d.width)
  const rows = deskRowsOf(shown, perRow)
  return (
    <Box flexDirection="column" width={d.width}>
      {topRow(d, all)}
      {all.length === 0 ? quiet(d, OX.empty, true) : null}
      {rows.map((row, r) => (
        <Box key={`office-row-${r}`} columnGap={O.deskGap} marginTop={O.rowGap} width={d.width}>
          {row.map((s, column) => deskOf(d, { ...s, column }))}
        </Box>
      ))}
      {all.length > shown.length ? quiet(d, fill(OX.more, { n: all.length - shown.length })) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- pieces

/** Dim words, cut at the edge or wrapped. */
function quiet(d: OfficeInput, text: string, wraps = false): RenderElement {
  const { Text } = d.els
  return (
    <Text dimColor wrap={wraps ? 'wrap' : 'truncate'}>
      {text}
    </Text>
  )
}

/** An agent's colour: its accent where the data turns accents on, else the palette's agent colour. */
function agentColor(d: OfficeInput, id: string): string {
  if (!T.features.accents) return d.colors.agent
  return accentFor(id, d.settings.palette === 'pastel' ? T.accents.pastel : T.accents.theme, d.colors.agent)
}

/** The words a state says under its desk, the running call filled in. */
function stateWords(s: { card: Card; tally: AgentTally | undefined; state: OfficeStateId }): string {
  return fill(O.states[s.state].word, { tool: toolNow(s.card, s.tally) ?? '' }).trim()
}

/**
 * The top row: the title and counts in what the controls leave, then the switch back to the deck (a plain Button
 * on the data's hotkey) and the close control at the trailing edge.
 */
function topRow(d: OfficeInput, all: { card: Card; tally: AgentTally | undefined }[]): RenderElement {
  const { Box, Text, Button } = d.els
  const running = all.filter(s => s.card.status === 'running').length
  const tokens = all.reduce((n, s) => n + (s.tally?.tokens ?? 0), 0)
  const controls = HOTKEY_CELLS + cells(OX.back) + Z.closeGap + cells(G.close)
  const room = Math.max(0, d.width - controls - Z.closeGap)
  const isNarrow = d.width < Z.narrowBelow
  const words = [OX.title, fill(isNarrow ? OX.countsNarrow : OX.counts, { running, total: all.length })]
  if (!isNarrow && tokens > 0) words.push(fill(OX.tokens, { tokens: tokensShort(tokens) }))
  return (
    <Box key="office-top" width={d.width}>
      <Box width={room} overflow="hidden">
        <Text bold color={d.colors.main} wrap="truncate">
          {words.join(OX.sep)}
        </Text>
      </Box>
      <Box marginLeft={Z.closeGap} flexShrink={0}>
        <Button key="office-back" plain hotkey={O.hotkey} label={OX.back} onPress={d.toDeck} />
      </Box>
      <Box marginLeft={Z.closeGap} flexShrink={0}>
        <Button key="dismiss" role="dismiss" plain label={T.text.closeLabel} onPress={d.close}>
          {G.close}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * The desk's picture: a Raster on the terminal (repainted by blits while it moves), SVG where the surface draws it
 * (animated by the surface itself), else the state's glyph on a surface with neither.
 */
function picture(d: OfficeInput, s: Seat, moving: boolean): RenderElement {
  const els = d.els
  const { Text } = els
  const frame = moving ? frameAt(d.now, frameCount(s.state)) : 0
  // Only the terminal draws a Raster: another surface's table may carry it as a fragment that draws nothing.
  if (d.surface === 'terminal' && 'Raster' in els) {
    const size = rasterSize()
    return <els.Raster key={rasterKey(s.card.id)} columns={size.columns} rows={size.rows} cells={deskCells(s.card.id, s.state, frame)} />
  }
  if ('Svg' in els) {
    const size = svgSize()
    const alt = fill(OX.alt, { name: clip(cardLabel(s.card), O.sprite.width * 2), state: stateWords(s) })
    return <els.Svg source={deskSvg(s.card.id, s.state, moving, frame)} alt={alt} width={size.width} height={size.height} />
  }
  return <Text color={d.colors[O.states[s.state].color]}>{O.states[s.state].glyph}</Text>
}

/** One desk: the picture, the agent's name, what it is doing, and the card its hover reveals. */
function deskOf(d: OfficeInput, s: Seat): RenderElement {
  const { Box, Text } = d.els
  const look = O.states[s.state]
  const moving = isMoving(s.state, d.motionOn)
  return (
    <Box key={`office-desk-${s.card.id}`} flexDirection="column" width={O.sprite.width} flexShrink={0}>
      {picture(d, s, moving)}
      <Text bold color={agentColor(d, s.card.id)} wrap="truncate">
        {clip(cardLabel(s.card), O.sprite.width)}
      </Text>
      <Text color={d.colors[look.color]} wrap="truncate">
        {clip(stateWords(s), O.sprite.width)}
      </Text>
      {hoverCard(d, s)}
    </Box>
  )
}

/**
 * The card a hover reveals, laid over the desk without moving anything: the task, the call running (else the
 * last one, else none yet), tokens with context and calls, and the time taken on a live clock.
 */
function hoverCard(d: OfficeInput, s: Seat): RenderElement {
  const { Box, Text } = d.els
  const c = s.card
  const place = cardPlace(s.column, d.width)
  const inner = Math.max(1, place.width - O.cardInset)
  const now = toolNow(c, s.tally)
  const lastCall = c.tools[c.tools.length - 1]
  const call = now !== null ? fill(OX.now, { tool: now }) : lastCall ? fill(OX.last, { call: lastCall.text || lastCall.tool }) : OX.noCalls
  const color = agentColor(d, c.id)
  const bg = d.settings.palette === 'pastel' ? O.cardBg.pastel : O.cardBg.theme
  return (
    // No key of its own: a hover applies over the nearest keyed Box, which must be the desk, not this hidden card.
    <Box
      position="absolute"
      top={O.cardTop}
      left={place.left}
      width={place.width}
      display="none"
      hover={{ display: 'flex' }}
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      backgroundColor={bg}
      paddingX={1}
    >
      <Text bold color={color} wrap="truncate">
        {clip(fill(OX.task, { task: cardLabel(c) }), inner)}
      </Text>
      <Text wrap="truncate">{clip(call, inner)}</Text>
      <Text dimColor wrap="truncate">
        {clip(fill(OX.tokensLine, { tokens: tokensShort(s.tally?.tokens ?? 0), ctx: tokensShort(c.ctx), calls: counted(s.tally?.calls ?? 0, 'call') }), inner)}
      </Text>
      <Box columnGap={1}>
        <Text dimColor>{OX.elapsed}</Text>
        {d.timer(`office-clock-${c.id}`, c.spawnedAt, c.status === 'running' ? null : c.endedAt, color)}
      </Box>
    </Box>
  )
}

/** An inline agent: the state's glyph, the agent, then what it is doing, its tokens and calls, cut at the edge. */
function inlineLine(d: OfficeInput, s: { card: Card; tally: AgentTally | undefined; state: OfficeStateId }): RenderElement {
  const { Box, Text } = d.els
  const look = O.states[s.state]
  const rest = fill(OX.line, { state: stateWords(s), tokens: tokensShort(s.tally?.tokens ?? 0), calls: counted(s.tally?.calls ?? 0, 'call') })
  return (
    <Box key={`office-${s.card.id}`} columnGap={1} overflow="hidden" width={d.width}>
      <Text color={d.colors[look.color]}>{look.glyph}</Text>
      <Text bold color={agentColor(d, s.card.id)}>
        {clip(cardLabel(s.card), Math.max(1, Math.floor(d.width / 3)))}
      </Text>
      {quiet(d, rest)}
    </Box>
  )
}
