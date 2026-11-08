//! The helper desk: the pane's second view (DESIGN.md, additions), reached by `/roster view desk` and the data's
//! hotkey. Its top row names the desk, counts the agents and their tokens, and holds the switch back to the deck
//! and the close control. Under it the main loop's to-do bar, then one row per subagent, newest first: status and
//! task, type with steps and tool calls, its share of the agents' tokens, and the tool it is running now.
//!
//! Docked it lists the data's `rows` agents in four lines each; inline above the prompt it is a summary of at most
//! the pane's `inlineRows`, an agent a line. Like the deck it draws a snapshot and never touches state: the live
//! clock, the switch and the close come in as builders from register.tsx. Every text, glyph and width is data.
//!
//! Lines are rows of separate Texts in a Box, never Texts nested in a truncating Text or Texts with edge spaces,
//! because a graphical surface wraps the one and collapses the other.

import type { ElementTable, RenderChildren, RenderElement } from 'claude-code'

import { tuning as T } from '../data/agent-roster'
import type { Card, Colors, DeskState } from '../types'
import { barOf, deskRows, progressOf, shareBarCells, todoBarCells } from './desk-rules'
import type { DeskRow } from './desk-rules'
import { accentFor, cardLabel, cells } from './geometry'
import type { Settings } from './records'
import { clip, fill, tokensShort } from './words'

const H = T.desk
const HX = T.deskText
const G = T.glyphs
const Z = T.sizes

/**
 * Cells a plain Button with a hotkey adds before its label: the key, a colon and a space. Structural: how the
 * terminal draws such a Button.
 */
const HOTKEY_CELLS = 3

/** The close control's name, the deck's own: one pane, one close. */
const X_CLOSE = T.text.closeLabel

/** Everything one desk drawing needs. */
export type DeskInput = {
  els: ElementTable
  /** The body's width, already held to the pane's minimum. */
  width: number
  isInline: boolean
  settings: Settings
  colors: Colors
  cards: Card[]
  desk: DeskState
  /** A live clock from `since`, stopped at `endAt`. */
  timer: (key: string, since: number, endAt: number | null, color: string) => RenderChildren
  /** Back to the deck: the switch on the top row and its hotkey. */
  toDeck: () => void
  /** Closes the pane: the close control. */
  close: () => void
}

/** Draws the desk: the inline summary, or the docked list. */
export function drawDesk(d: DeskInput): RenderElement {
  const { Box } = d.els
  const rows = deskRows(d.cards, d.desk.tallies)
  const todo = todoLine(d)
  if (d.isInline) {
    // The top row and the to-do bar come first; agents take what is left, one row kept for "+N more" when needed.
    const left = T.pane.inlineRows - 1 - (todo === null ? 0 : 1)
    const fits = rows.length <= left ? rows.length : Math.max(0, left - 1)
    return (
      <Box flexDirection="column" width={d.width}>
        {topRow(d, rows)}
        {todo}
        {rows.slice(0, fits).map(r => agentLine(d, r))}
        {rows.length > fits ? moreLine(d, rows.length - fits) : null}
      </Box>
    )
  }
  const shown = rows.slice(0, H.rows)
  return (
    <Box flexDirection="column" width={d.width}>
      {topRow(d, rows)}
      {todo}
      {rows.length === 0 ? quiet(d, HX.noAgents, true) : null}
      {shown.map(r => agentBlock(d, r))}
      {rows.length > shown.length ? moreLine(d, rows.length - shown.length) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- pieces

/** Dim words, cut at the edge or wrapped. */
function quiet(d: DeskInput, text: string, wraps = false): RenderElement {
  const { Text } = d.els
  return (
    <Text dimColor wrap={wraps ? 'wrap' : 'truncate'}>
      {text}
    </Text>
  )
}

/** A line of pieces: each piece a Text that keeps its cells, the last one cut to what is left. */
function row(d: DeskInput, key: string, pieces: RenderElement[]): RenderElement {
  const { Box } = d.els
  return (
    <Box key={key} columnGap={1} overflow="hidden" width={d.width}>
      {pieces}
    </Box>
  )
}

/** An agent's colour: its accent where the data turns accents on, else the palette's agent colour. */
function agentColor(d: DeskInput, id: string): string {
  if (!T.features.accents) return d.colors.agent
  return accentFor(id, d.settings.palette === 'pastel' ? T.accents.pastel : T.accents.theme, d.colors.agent)
}

/** The glyph and colour a status draws in: running in the agent's colour, done, failed, anything else stopped. */
function statusMark(d: DeskInput, c: Card): { glyph: string; color: string } {
  if (c.status === 'running') return { glyph: G.running, color: agentColor(d, c.id) }
  if (c.status === 'done') return { glyph: G.done, color: d.colors.gate }
  if (c.status === 'failed') return { glyph: G.failed, color: d.colors.warn }
  return { glyph: G.stopped, color: d.colors.dim }
}

/**
 * The top row: the title and counts in what the controls leave, then the switch back to the deck (a plain Button
 * on the data's hotkey) and the close control at the trailing edge.
 */
function topRow(d: DeskInput, rows: DeskRow[]): RenderElement {
  const { Box, Text, Button } = d.els
  const running = rows.filter(r => r.card.status === 'running').length
  const tokens = rows.reduce((n, r) => n + r.tokens, 0)
  const controls = HOTKEY_CELLS + cells(HX.back) + Z.closeGap + cells(G.close)
  const room = Math.max(0, d.width - controls - Z.closeGap)
  const isNarrow = d.width < Z.narrowBelow
  const counts = fill(isNarrow ? HX.countsNarrow : HX.counts, { running, total: rows.length })
  const words = [HX.title, counts]
  if (!isNarrow && tokens > 0) words.push(fill(HX.tokens, { tokens: tokensShort(tokens) }))
  return (
    <Box key="desk-top" width={d.width}>
      <Box width={room} overflow="hidden">
        <Text bold color={d.colors.main} wrap="truncate">
          {words.join(HX.sep)}
        </Text>
      </Box>
      <Box marginLeft={Z.closeGap} flexShrink={0}>
        <Button key="desk-back" plain hotkey={H.hotkey} label={HX.back} onPress={d.toDeck} />
      </Box>
      <Box marginLeft={Z.closeGap} flexShrink={0}>
        <Button key="dismiss" role="dismiss" plain label={X_CLOSE} onPress={d.close}>
          {G.close}
        </Button>
      </Box>
    </Box>
  )
}

/** The to-do bar: lit for the items done, the count, and the item at hand. None when there is nothing left to do. */
function todoLine(d: DeskInput): RenderElement | null {
  const { Text } = d.els
  const p = progressOf(d.desk.todos)
  if (p === null) return null
  const bar = barOf(p.done, p.total, todoBarCells(d.width), H.barOn, H.barOff)
  const pieces = [
    <Text color={d.colors.main}>{bar.on + bar.off}</Text>,
    <Text bold>{fill(HX.todoCount, { done: p.done, total: p.total })}</Text>,
  ]
  if (p.current !== null && p.current.text !== '') {
    pieces.push(quiet(d, fill(HX.todoItem, { item: clip(p.current.text, H.itemChars) })))
  }
  return row(d, 'desk-todo', pieces)
}

/** What the agent is at: the tool running now, else the last it called, else that it has called none. */
function activity(r: DeskRow): string {
  if (r.now !== null) return fill(HX.now, { mark: H.nowMark, tool: r.now })
  if (r.last !== null) return fill(HX.last, { tool: r.last })
  return HX.idle
}

/** A docked agent: status and task with its clock; type, steps and calls; its token share; what it is at. */
function agentBlock(d: DeskInput, r: DeskRow): RenderElement {
  const { Box, Text } = d.els
  const c = r.card
  const mark = statusMark(d, c)
  const color = agentColor(d, c.id)
  const share = shareBarCells(d.width)
  const bar = pctBar(r.pct, share)
  return (
    <Box key={`desk-${c.id}`} flexDirection="column" marginTop={1} width={d.width}>
      <Box width={d.width} justifyContent="space-between">
        <Box overflow="hidden" columnGap={1}>
          <Text color={mark.color}>{mark.glyph}</Text>
          <Text bold color={color} wrap="truncate">
            {clip(cardLabel(c), H.labelChars)}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {d.timer(`desk-clock-${c.id}`, c.spawnedAt, c.status === 'running' ? null : c.endedAt, mark.color)}
        </Box>
      </Box>
      {quiet(d, fill(HX.meta, { type: typeOf(c), steps: c.steps, calls: r.calls }))}
      {row(d, `desk-share-${c.id}`, [
        <Text>
          {bar.on === '' ? null : <Text color={color}>{bar.on}</Text>}
          {bar.off === '' ? null : <Text color={d.colors.faint}>{bar.off}</Text>}
        </Text>,
        quiet(d, fill(HX.share, { pct: r.pct, tokens: tokensShort(r.tokens), ctx: tokensShort(c.ctx) })),
      ])}
      <Text color={r.now !== null ? color : d.colors.dim} wrap="truncate">
        {activity(r)}
      </Text>
    </Box>
  )
}

/** The type a row names: a named agent's subagent type where the data turns that on, else the card's type. */
function typeOf(c: Card): string {
  return c.name !== '' && T.features.agentName ? c.kind : c.type
}

/** A share bar lit for `pct` percent. */
function pctBar(pct: number, cellCount: number): { on: string; off: string } {
  return barOf(pct, 100, cellCount, H.shareOn, H.shareOff)
}

/** An inline agent: glyph and task, then calls, share and what it is at, cut at the edge. */
function agentLine(d: DeskInput, r: DeskRow): RenderElement {
  const { Text } = d.els
  const c = r.card
  const mark = statusMark(d, c)
  const rest = [fill(HX.meta, { type: typeOf(c), steps: c.steps, calls: r.calls }), fill(HX.pct, { pct: r.pct }), activity(r)].join(HX.sep)
  return row(d, `desk-${c.id}`, [
    <Text color={mark.color}>{mark.glyph}</Text>,
    <Text bold color={agentColor(d, c.id)}>
      {clip(cardLabel(c), Math.max(1, Math.floor(d.width / 3)))}
    </Text>,
    quiet(d, rest),
  ])
}

/** "+N more agents", for those the room leaves out. */
function moreLine(d: DeskInput, n: number): RenderElement {
  return quiet(d, fill(HX.more, { n }))
}
