//! The office: the pane's third view (DESIGN.md, additions), reached by `/roster view office`. A pixel-art room: a
//! wall with a door, bookshelves, a clock at the local time, a picture, a notice and a water cooler; a wood floor
//! with a manager's desk, a plant and bins; and in the middle a grid of desks, one per subagent in spawn order, each
//! agent seen from behind at its monitor, the screen saying what it is doing. Empty desks show an empty chair; the
//! room grows a row at a time up to the data's most, then counts the rest. Hovering a desk reveals its card: the
//! task, the call running or the last one, tokens and the time it has taken. A legend under the room names each
//! agent in its shirt's colour. The top row names the office, counts the agents, and holds the switch back to the
//! deck and the close control, as the helper desk's does.
//!
//! The terminal draws the room as one Raster (a pixel a column, two a row) from the simpler art set; a graphical
//! surface as one SVG at a whole-number scale from the detailed set. Inline above the prompt it is compact: the top
//! row, then an agent a line. Like the other views it draws a snapshot and never writes state; the frame showing
//! is taken from the clock, so the terminal blits register.tsx sends between draws (and the desktop's SMIL
//! animation) carry on from it. Every text, size, colour and frame is data.

import type { ElementTable, RenderChildren, RenderElement } from 'claude-code'

import { officeArt as A } from '../data/office-sprites'
import { tuning as T } from '../data/agent-roster'
import type { Card, Colors, DeskState, GateLog } from '../types'
import { accentFor, cardLabel, cells } from './geometry'
import {
  cardPlace,
  deskCells,
  desktopScale,
  isMoving,
  localTime,
  occupantsOf,
  roomLayout,
  roomRaster,
  roomSvg,
  seatsFor,
  shirtOf,
  terminalRoomWidth,
  toolNow,
} from './office-rules'
import type { DeskCells, Occupant, RoomLayout } from './office-rules'
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
  /** The surface drawn on: the room is a Raster on the terminal alone. */
  surface: string
  /** The body's width, already held to the pane's minimum. */
  width: number
  isInline: boolean
  settings: Settings
  colors: Colors
  cards: Card[]
  desk: DeskState
  gate: GateLog
  /** The clock's reading for this draw: which frame shows, and the wall clock's time. */
  now: number
  /** Whether running desks animate: the person's motion setting. */
  motionOn: boolean
  /** A live clock from `since`, stopped at `endAt`. */
  timer: (key: string, since: number, endAt: number | null, color: string) => RenderChildren
  /** Back to the deck: the switch on the top row and its hotkey. */
  toDeck: () => void
  /** Closes the pane: the close control. */
  close: () => void
}

/** The terminal Raster's key: what register.tsx's blits name. */
export const ROOM_RASTER = 'office-room-px'

/** The terminal room's Raster key (a function so a test reads what the module draws). */
export function rasterKey(): string {
  return ROOM_RASTER
}

/** Draws the office: the inline summary, or the docked room with its legend. */
export function drawOffice(d: OfficeInput): RenderElement {
  const { Box } = d.els
  const all = occupantsOf(d.cards, d.desk.tallies, d.gate)
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
  const isTerminal = d.surface === 'terminal' && 'Raster' in d.els
  const scaled = desktopScale(d.width)
  const layout = roomLayout(isTerminal ? A.terminalSet : A.graphicalSet, isTerminal ? terminalRoomWidth(d.width) : scaled.roomWidth, all.length)
  const seated = all.slice(0, layout.shown)
  return (
    <Box flexDirection="column" width={d.width}>
      {topRow(d, all)}
      {room(d, layout, all, isTerminal, scaled.scale)}
      {all.length === 0 ? quiet(d, OX.empty, true) : legend(d, seated)}
      {layout.more > 0 ? quiet(d, fill(OX.more, { n: layout.more })) : null}
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

/** The words a state says, the running call filled in. */
function stateWords(s: Occupant): string {
  return fill(O.states[s.state].word, { tool: toolNow(s.card, s.tally) ?? '' }).trim()
}

/**
 * The top row: the title and counts in what the controls leave, then the switch back to the deck (a plain Button
 * on the data's hotkey) and the close control at the trailing edge.
 */
function topRow(d: OfficeInput, all: Occupant[]): RenderElement {
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

/** What the room says to a reader that cannot see it: the desks, then each agent and what it is doing. */
function altOf(layout: RoomLayout, seated: Occupant[]): string {
  const agents = seated.map(s => fill(OX.legend, { name: cardLabel(s.card), state: stateWords(s) })).join(OX.sep)
  return fill(OX.alt, { desks: layout.capacity, agents: agents === '' ? OX.emptyDesk : agents })
}

/**
 * The room: a Raster on the terminal (repainted by blits while agents move), an SVG where the surface draws one
 * (animated by the surface itself), else nothing but the legend. Over it, one hover box a seated agent's desk.
 */
function room(d: OfficeInput, layout: RoomLayout, all: Occupant[], isTerminal: boolean, scale: number): RenderElement | null {
  const els = d.els
  const seats = seatsFor(layout, all, d.now, d.motionOn)
  const time = localTime(d.now)
  const seated = all.slice(0, layout.shown)
  const boxes = seated.map((s, i) => hoverBox(d, s, deskCells(layout, i, isTerminal ? 'terminal' : 'graphical', scale)))
  if (isTerminal && 'Raster' in els) {
    const r = roomRaster(layout, seats, time)
    return (
      <els.Box key="office-room" width={r.columns} height={r.rows} flexShrink={0}>
        <els.Raster key={ROOM_RASTER} columns={r.columns} rows={r.rows} cells={r.cells} />
        {boxes}
      </els.Box>
    )
  }
  if ('Svg' in els) {
    const moving = seats.map(s => s !== null && isMoving(s.state, d.motionOn))
    const source = roomSvg(layout, seats, moving, time, scale)
    return (
      <els.Box key="office-room" flexShrink={0}>
        <els.Svg source={source} alt={altOf(layout, seated)} width={layout.width * scale} height={layout.height * scale} />
        {boxes}
      </els.Box>
    )
  }
  return null
}

/**
 * A desk's hover box, laid over its picture without moving anything, keyed so the pointer anywhere on the desk
 * reveals the card inside it.
 */
function hoverBox(d: OfficeInput, s: Occupant, at: DeskCells): RenderElement {
  const { Box } = d.els
  return (
    <Box key={`office-desk-${s.card.id}`} position="absolute" top={at.top} left={at.left} width={at.width} height={at.height}>
      {hoverCard(d, s, at.left)}
    </Box>
  )
}

/**
 * The card a hover reveals: the task, the call running (else the last one, else none yet), tokens with context and
 * calls, and the time taken on a live clock. Moved left to stay inside the pane.
 */
function hoverCard(d: OfficeInput, s: Occupant, deskLeft: number): RenderElement {
  const { Box, Text } = d.els
  const c = s.card
  const place = cardPlace(deskLeft, d.width)
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

/**
 * The legend under the room: per seated agent, a swatch in its shirt's colour, its name in its accent and what it
 * is doing in the state's colour, wrapping as the pane allows.
 */
function legend(d: OfficeInput, seated: Occupant[]): RenderElement {
  const { Box, Text } = d.els
  return (
    <Box key="office-legend" flexWrap="wrap" columnGap={O.legendGap} width={d.width}>
      {seated.map(s => (
        <Box key={`office-legend-${s.card.id}`} columnGap={1} flexShrink={0}>
          <Text color={shirtOf(s.card.id)[1]}>{O.legendSwatch}</Text>
          <Text bold color={agentColor(d, s.card.id)}>
            {clip(cardLabel(s.card), O.legendName)}
          </Text>
          <Text color={d.colors[O.states[s.state].color]}>{stateWords(s)}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** An inline agent: the state's glyph, the agent, then what it is doing, its tokens and calls, cut at the edge. */
function inlineLine(d: OfficeInput, s: Occupant): RenderElement {
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
