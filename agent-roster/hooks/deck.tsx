//! The deck's drawing. `drawDeck` works out what every panel shares once (the `Kit`), then hands it to one
//! function per panel: main, architect, gate, agents (cards or lanes) and the expanded card, other loops, the
//! receipt and the log. The docked deck stacks them in one column, or two from the data's `wideFrom`; inline above
//! the prompt it is a summary of at most the data's `inlineRows`. The desktop also gets a time axis in SVG.
//!
//! It draws a snapshot and never touches state. The animated connectors and live clocks are handed in as builders
//! from register.tsx, because a `Client` element's module path must be a literal in the hooks module's own source.
//! Every text, glyph, width and threshold comes from the data.

import type { ElementTable, RenderChildren, RenderElement } from 'claude-code'

import { tuning as T } from '../data/agent-roster'
import type { ArchitectLog, Card, Check, Colors, Family, GateLog, LayoutId, LogEntry, MainLoop, OtherLoop, PanelId, Receipt, TurnTally, Usage, ViewState } from '../types'
import { accentFor, cardLabel, cells, legendThatFits, logBudget, marksFor, meter, piecesInRoom, twoRowTitle } from './geometry'
import { compactBadge, consultTrack, gateTotals, gaugeBasis, isConsulting, laneCells, loopIsLive, stepsOf } from './ledger'
import { FAMILIES } from './records'
import type { Settings } from './records'
import { clip, counted, dollars, durationShort, fill, limitShortName, modelName, timeOfDay, timingLabel, tokensShort, untilReset } from './words'

const X = T.text
const G = T.glyphs
const Z = T.sizes
const K = T.keep
const F = T.features

/**
 * Cells a bordered box with one column of padding each side takes from its width. Structural: two border cells
 * and two padding cells. The one-cell paddings, gaps and margins written in place below are that same box style.
 */
const BOX_CHROME = 4

/** The moments in the order the architect panel lists them. Structural: the `MomentId` union. */
const MOMENTS = ['plan', 'repeat', 'done'] as const

/** Panels with no connector drawn above them, and panels with none drawn below. Structural: the deck's flow. */
const NO_LINK_ABOVE: ReadonlySet<PanelId> = new Set<PanelId>(['agents', 'log', 'loops'])
const NO_LINK_BELOW: ReadonlySet<PanelId> = new Set<PanelId>(['agents', 'loops'])
/** Which column of the wide layout each panel sits in; the log runs both. Structural: the wide layout. */
const LEFT_COLUMN: ReadonlySet<PanelId> = new Set<PanelId>(['main', 'architect', 'gate'])
const RIGHT_COLUMN: ReadonlySet<PanelId> = new Set<PanelId>(['agents', 'loops', 'receipt'])

/** Everything one drawing needs: the surface, the pane's size, the state snapshot and the builders it cannot make here. */
export type DeckInput = {
  els: ElementTable
  surface: string
  /** The body's width, already held to the data's minimum. */
  width: number
  isInline: boolean
  bodyRows: number
  /** The agent whose transcript the person is viewing, if any. */
  viewed: string | null
  settings: Settings
  colors: Colors
  main: MainLoop
  usage: Usage
  architect: ArchitectLog
  gate: GateLog
  cards: Card[]
  loops: OtherLoop[]
  log: LogEntry[]
  turn: TurnTally
  receipt: Receipt | null
  view: ViewState
  now: number
  /** A connector: animated while `active` where the surface can, else a still line. */
  connector: (key: string, active: boolean, color: string, width: number, marks?: number[], isMerge?: boolean) => RenderChildren
  /** A live clock from `since`, stopped at `endAt`. */
  timer: (key: string, since: number, endAt: number | null, color: string) => RenderChildren
  toggleCard: (id: string) => () => void
  toggleFamily: (family: Family) => () => void
  /** Closes the pane: the header's close control. */
  close: () => void
}

/** Text in one style. */
type Run = { text: string; color?: string; isDim?: boolean; isBold?: boolean }
/** A piece of a line: kept whole with `indent` cells of margin before it; or, when it `stretches`, one run that truncates to the room left. */
type Chunk = { runs: Run[]; indent?: number; stretches?: boolean }

/** What every panel of one drawing shares, worked out once. */
type Kit = {
  d: DeckInput
  els: ElementTable
  C: Colors
  S: Settings
  W: number
  isTerminal: boolean
  layout: LayoutId
  model: string
  advising: boolean
  running: Card[]
  hasArchitect: boolean
  totals: ReturnType<typeof gateTotals>
  /** Who decided an ask that then ran: the auto-mode classifier, or the person. */
  decider: string
  archWord: string
  ctx: ReturnType<typeof gaugeBasis>
  /** A graphical surface draws a border flush against the line above; the legend keeps a row of air there. */
  legendAir: number
  expanded: Card | undefined
  liveLoops: number
}

/** Draws the whole pane: the inline summary, or the docked deck. */
export function drawDeck(d: DeckInput): RenderElement {
  const k = kitFor(d)
  const isMini = k.layout === 'mini' || (k.layout === 'auto' && d.isInline)
  return isMini ? miniDeck(k) : dockedDeck(k)
}

function kitFor(d: DeckInput): Kit {
  const S = d.settings
  const isTerminal = d.surface === 'terminal'
  return {
    d,
    els: d.els,
    C: d.colors,
    S,
    W: d.width,
    isTerminal,
    layout: d.view.layout ?? S.layout,
    model: modelName(d.main.model),
    advising: isConsulting(d.architect),
    running: d.cards.filter(c => c.status === 'running'),
    hasArchitect: d.architect.ids.length > 0 || d.architect.consults.length > 0,
    totals: gateTotals(d.gate),
    decider: d.main.mode === X.autoMode ? X.decider.auto : X.decider.other,
    archWord: S.architectLabel.toLowerCase(),
    ctx: gaugeBasis(d.usage),
    legendAir: isTerminal ? 0 : 1,
    expanded: d.cards.find(c => c.id === d.view.expanded),
    liveLoops: d.loops.filter(l => loopIsLive(l, d.now)).length,
  }
}

// ---------------------------------------------------------------- shared pieces

/** A span's style as Text props: only the ones it sets. */
function spanProps(s: Run): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {}
  if (s.color) props.color = s.color
  if (s.isDim) props.dimColor = true
  if (s.isBold) props.bold = true
  return props
}

/** Cells a piece's text takes. */
function pieceCells(p: Chunk): number {
  let n = 0
  for (const s of p.runs) n += cells(s.text)
  return n
}

/**
 * A line of coloured pieces drawn as a row of boxes, so a graphical surface (which wraps nested Texts and collapses
 * spaces) keeps it on one line. Pieces that do not fit are left out from the end, unless one is a `fill` piece,
 * which truncates instead.
 */
function lineOf(k: Kit, pieces: (Chunk | null)[], room: number, gap: number = Z.lineGap, justify?: 'center'): RenderElement {
  const { Box, Text } = k.els
  const present = pieces.filter((p): p is Chunk => p !== null)
  const hasFill = present.some(p => p.stretches === true)
  const kept = hasFill ? present : present.slice(0, piecesInRoom(present.map(p => ({ width: pieceCells(p), indent: p.indent })), room, gap))
  const drawPiece = (p: Chunk) => {
    const [head] = p.runs
    if (p.stretches && head) {
      return (
        <Text wrap="truncate" {...spanProps(head)}>
          {head.text}
        </Text>
      )
    }
    const body = p.runs.length === 1 && head ? <Text {...spanProps(head)}>{head.text}</Text> : <Text>{p.runs.map(s => <Text {...spanProps(s)}>{s.text}</Text>)}</Text>
    return (
      <Box {...(p.indent ? { marginLeft: p.indent } : {})} flexShrink={0}>
        {body}
      </Box>
    )
  }
  return (
    <Box {...(justify ? { justifyContent: justify } : {})} overflow="hidden" columnGap={gap} width={room}>
      {kept.map(drawPiece)}
    </Box>
  )
}

/** A row of marks, its newest kept at the right where a surface draws them wider than counted. */
function marksRow(k: Kit, strip: RenderChildren, indent = 0): RenderElement {
  const { Box, Text } = k.els
  return (
    <Box {...(indent ? { marginLeft: indent } : {})} overflow="hidden">
      <Text wrap="truncate-start">{strip}</Text>
    </Box>
  )
}

/** A panel's frame: a bordered column `w` wide, one cell of padding each side; `extra` adds or overrides box props. */
function framed(k: Kit, color: string, w: number, kids: RenderChildren[], extra: Record<string, unknown> = {}): RenderElement {
  const { Box } = k.els
  const props = { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, width: w, ...extra }
  return <Box {...(props as unknown as Record<string, never>)}>{kids}</Box>
}

/** A title row: `left` takes what it can, `right` keeps its whole width. */
function titleRow(k: Kit, left: RenderChildren, right: RenderChildren | null, width?: number): RenderElement {
  const { Box } = k.els
  return (
    <Box {...(width === undefined ? {} : { width })} justifyContent="space-between">
      {left}
      {right === null ? null : <Box flexShrink={0}>{right}</Box>}
    </Box>
  )
}

/**
 * A top row with the pane's close control at its trailing edge: `line` is drawn in what the control leaves. The
 * terminal draws the control as a plain clickable Button; a desktop draws its native close control there.
 */
function withClose(k: Kit, line: (room: number) => RenderElement): RenderElement {
  const { Box, Button } = k.els
  const room = k.W - cells(G.close) - Z.closeGap
  return (
    <Box width={k.W}>
      {line(room)}
      <Box marginLeft={Z.closeGap} flexShrink={0}>
        <Button key="dismiss" role="dismiss" plain label={X.closeLabel} onPress={k.d.close}>
          {G.close}
        </Button>
      </Box>
    </Box>
  )
}

/** A panel's bold coloured title, cut at the edge. */
function heading(k: Kit, color: string, text: string): RenderElement {
  const { Text } = k.els
  return (
    <Text bold color={color} wrap="truncate">
      {text}
    </Text>
  )
}

/** Dim text, with a wrap mode when given. */
function dimText(k: Kit, text: string, wrap?: 'truncate' | 'wrap'): RenderElement {
  const { Text } = k.els
  return (
    <Text {...(wrap ? { wrap } : {})} dimColor>
      {text}
    </Text>
  )
}

/** Text in one colour, with a wrap mode when given. */
function tinted(k: Kit, color: string, text: string, wrap?: 'truncate' | 'wrap' | 'truncate-middle'): RenderElement {
  const { Text } = k.els
  return (
    <Text {...(wrap ? { wrap } : {})} color={color}>
      {text}
    </Text>
  )
}

/** A gauge reading's colour: the warning colour from the data's `warnPct`. */
function gaugeColor(k: Kit, pct: number): string {
  return pct >= Z.warnPct ? k.C.warn : k.C.main
}

/** A verdict's colour. */
function verdictColor(k: Kit, c: Check): string {
  const C = k.C
  switch (c.verdict) {
    case 'rule':
      return C.gate
    case 'cleared':
      return C.cleared
    case 'ask':
      return C.amber
    default:
      return C.warn
  }
}

/** A check as one mark on the gate strip: dimmed when it came from a subagent. */
function checkMark(k: Kit, c: Check): RenderElement {
  const { Text } = k.els
  return (
    <Text dimColor={c.inSubagent} color={verdictColor(k, c)}>
      {c.verdict === 'deny' ? G.denied : G.check}
    </Text>
  )
}

/** An agent's own colour, stable by its id (data `accents`); the palette's agent colour where accents are off. */
function accentOf(k: Kit, agentId: string): string {
  if (!F.accents) return k.C.agent
  return accentFor(agentId, k.S.palette === 'pastel' ? T.accents.pastel : T.accents.theme, k.C.agent)
}

/** A card's colour by status. */
function statusColor(k: Kit, c: Card): string {
  if (c.status === 'failed') return k.C.warn
  if (c.status === 'done') return k.C.gate
  return k.C.agent
}

/** A card's status glyph. */
function statusGlyph(c: Card): string {
  const byStatus: Record<string, string> = { running: G.running, done: G.done, failed: G.failed }
  return byStatus[c.status] ?? G.stopped
}

/** A card's status in words. */
function statusWord(c: Card): string {
  return (X.statusWords as Record<string, string>)[c.status] ?? c.status
}

/** The receipt's sentence for a finished turn. */
function lastTurnText(x: Receipt): string {
  return fill(X.lastTurn, {
    duration: durationShort(x.durationMs),
    agents: counted(x.agents, 'agent'),
    edits: counted(x.edits, 'edit'),
    errors: counted(x.errors, 'error'),
  })
}

// ---------------------------------------------------------------- main

function mainPanel(k: Kit, w: number): RenderElement {
  const { Text } = k.els
  const { C } = k
  const m = k.d.main
  const u = k.d.usage
  const room = w - BOX_CHROME
  const lit = Math.min(Z.effortCells, T.efforts[m.effort] ?? 0)
  const effortBar = G.effortOn.repeat(lit) + G.effortOff.repeat(Z.effortCells - lit)
  const effortLine = lineOf(
    k,
    [
      {
        runs: [
          { text: X.effort, isDim: true },
          { text: `${effortBar} `, color: C.main },
          { text: m.effort || G.dash, color: C.main, isBold: true },
        ],
      },
      m.mode ? { runs: [{ text: fill(X.mode, { mode: m.mode }), isDim: true }] } : null,
      { runs: [{ text: fill(X.req, { n: m.steps }), isDim: true }] },
    ],
    room,
    Z.effortGap,
  )

  const pct = k.ctx.pct
  let contextLine: RenderElement | null = null
  if (pct !== null) {
    const gauge = meter(pct, Z.ctxGauge)
    const hasBadge = u.compactions > 0
    contextLine = lineOf(
      k,
      [
        {
          runs: [
            { text: X.ctx, isDim: true },
            { text: gauge.on, color: gaugeColor(k, pct) },
            { text: gauge.off, color: C.faint },
            { text: fill(X.pct, { pct: Math.round(pct) }), isBold: true },
          ],
        },
        u.tokens === null ? null : { runs: [{ text: fill(X.tokens, { used: tokensShort(u.tokens), window: tokensShort(k.ctx.window) }), isDim: true }] },
        hasBadge ? { indent: Z.badgeLead, runs: [{ text: compactBadge(u), color: C.amber }] } : null,
        // Left out first where the line is short; the badge's ~ still says it.
        hasBadge && u.isCompactEstimate ? { runs: [{ text: X.estimated, color: C.faint }] } : null,
      ],
      room,
    )
  }

  const hasCost = u.costUsd !== null
  let spendLine: RenderElement | null = null
  if (hasCost || u.limits.length > 0) {
    const limitPieces = u.limits.slice(0, Z.limitsShown).map((l, i): Chunk => {
      const gauge = meter(l.pct, Z.limitGauge)
      // The time to each reset only where the line has room for both windows.
      const resetIn = w < Z.resetFrom ? '' : untilReset(l.resetsAt, k.d.now)
      const tail = resetIn === '' ? '' : fill(X.limitReset, { glyph: G.reset, in: resetIn })
      let gapBefore = 0
      if (i > 0) gapBefore = Z.limitLead
      else if (hasCost) gapBefore = Z.limitLeadAfterCost
      return {
        indent: gapBefore,
        runs: [
          { text: `${limitShortName(l.kind)} `, isDim: true },
          { text: gauge.on, color: gaugeColor(k, l.pct) },
          { text: gauge.off, color: C.faint },
          { text: fill(X.limitPct, { pct: Math.round(l.pct) }) + tail, isDim: true },
        ],
      }
    })
    const costPiece: Chunk | null = u.costUsd === null ? null : { runs: [{ text: dollars(u.costUsd), color: C.text }] }
    spendLine = lineOf(k, [costPiece, ...limitPieces], room)
  }

  const speedLine = m.speed ? dimText(k, fill(X.lastReq, { speed: timingLabel(m.speed) }), 'truncate') : null
  const state = <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? X.working : X.idleState}</Text>
  // Beyond the reference layout (DESIGN.md), each only when its value exists: the current task, the task list's steps, the repo.
  const taskLine = F.task && m.task !== '' ? tinted(k, C.text, fill(X.mainTask, { task: m.task }), 'truncate') : null
  const steps = F.steps ? stepsOf(m.todos) : null
  const stepsLine = steps === null ? null : tinted(k, C.main, fill(X.mainSteps, { done: steps.done, total: steps.total }), 'truncate')
  const repoText = m.branch === '' ? fill(X.repoOnly, { repo: m.repo }) : fill(X.repoBranch, { repo: m.repo, branch: m.branch })
  const repoLine = F.repo && m.repo !== '' ? dimText(k, repoText, 'truncate') : null
  const title = titleRow(k, heading(k, C.main, fill(X.main, { model: k.model })), state)
  return framed(k, C.main, w, [title, taskLine, stepsLine, repoLine, effortLine, contextLine, spendLine, speedLine])
}

// ---------------------------------------------------------------- architect

function architectPanel(k: Kit, w: number): RenderElement {
  const { Box, Text } = k.els
  const { C, S } = k
  const a = k.d.architect
  const now = k.d.now
  const latest = a.consults.length > 0 ? a.consults[a.consults.length - 1] : undefined
  const count = (
    <Text>
      <Text dimColor>{X.consults}</Text>
      <Text bold color={C.arch}>
        {String(a.consults.length)}
      </Text>
    </Text>
  )
  let since: RenderElement
  if (latest === undefined) since = dimText(k, X.notConsulted)
  else if (k.advising) since = dimText(k, fill(X.consultingSince, { clock: timeOfDay(latest.at) }), 'truncate')
  else {
    const ended = latest.endAt ?? latest.at
    since = dimText(k, fill(X.lastConsult, { ago: durationShort(now - ended), took: durationShort((latest.endAt ?? now) - latest.at) }), 'truncate')
  }
  const moments = S.moments ? (
    <Box columnGap={Z.sectionGap} flexWrap="wrap">
      {MOMENTS.map(id => {
        const isOn = latest?.moment === id
        return (
          <Text bold={isOn} color={isOn ? C.arch : C.dim}>
            {`${isOn ? G.momentOn : G.momentOff} ${X.moments[id]}`}
          </Text>
        )
      })}
      {tinted(k, C.faint, X.inferred)}
    </Box>
  ) : null
  const title = fill(X.archTitle, { label: S.architectLabel, state: k.advising ? X.advising : X.onCall })
  return framed(k, C.arch, w, [
    titleRow(k, heading(k, C.arch, title), count),
    // Both ends are anchors (the first consult, now): cut, it loses the middle.
    tinted(k, C.arch, consultTrack(a, now, Math.max(Z.timelineMin, w - Z.timelineInset)), 'truncate-middle'),
    since,
    moments,
    a.lastAdvice ? tinted(k, C.arch, `${G.advice} ${a.lastAdvice}`, 'truncate') : null,
  ])
}

// ---------------------------------------------------------------- gate

/** The gate's totals as pieces: in words where they all fit, in numbers alone where not, colours saying which is which. */
function gateTotalPieces(k: Kit, isShort: boolean): Chunk[] {
  const { C, totals: n } = k
  const said = (count: number, word: string) => (isShort ? `${count}` : `${count} ${word}`)
  const pieces: Chunk[] = [
    { runs: [{ text: G.check, color: C.gate }, { text: ` ${said(n.rule, X.allowedWord)}`, isDim: true }] },
    { runs: [{ text: G.check, color: C.cleared }, { text: ` ${said(n.cleared, k.decider)}`, isDim: true }] },
  ]
  if (n.ask > 0) pieces.push({ runs: [{ text: `${G.check} ${said(n.ask, X.pendingWord)}`, color: C.amber }] })
  pieces.push({ runs: [{ text: `${G.denied} ${said(n.deny, X.deniedWord)}`, color: n.deny > 0 ? C.warn : C.dim }] })
  return pieces
}

/** One drill-down row: the verdict in a box of its own width (padding spaces collapse on a graphical surface), then what the call was about. */
function drillRow(k: Kit, c: Check, w: number): RenderElement {
  const { Box, Text } = k.els
  const word = c.verdict === 'cleared' ? k.decider : X.drillWords[c.verdict]
  return (
    <Box overflow="hidden" columnGap={1} width={w - BOX_CHROME}>
      <Box flexShrink={0} width={Z.drillVerdictCols}>
        <Text>
          {tinted(k, verdictColor(k, c), `${c.verdict === 'deny' ? G.denied : G.check} `)}
          {tinted(k, k.C.dim, word)}
        </Text>
      </Box>
      <Text wrap="truncate" dimColor={c.inSubagent}>
        {clip(c.detail, Math.max(Z.drillDetailMin, w - Z.drillDetailInset))}
      </Text>
    </Box>
  )
}

function gatePanel(k: Kit, w: number): RenderElement {
  const { Box, Text, Button } = k.els
  const { C, S } = k
  const g = k.d.gate
  const room = w - BOX_CHROME
  const opened = k.d.view.gateOpen
  const recentMarks = g.recent.slice(-Math.max(Z.gateStripMin, marksFor(room, k.isTerminal)))
  const inWords = gateTotalPieces(k, false)
  const fits = piecesInRoom(inWords.map(p => ({ width: pieceCells(p) })), room, Z.gateGap)
  const isShort = fits < inWords.length
  const showNote = !isShort && w >= Z.subagentNoteFrom && g.recent.some(c => c.inSubagent)
  const familyButtons = FAMILIES.map(f => {
    const t = g.totals[f]
    const sum = t.rule + t.cleared + t.ask + t.deny
    const label = fill(X.familyButton, { family: X.families[f], n: sum }) + (opened === f ? G.expandOpen : '')
    return <Button key={`gate-${f}`} plain hotkey={T.keys[f]} label={label} dimColor={sum === 0} onPress={k.d.toggleFamily(f)} />
  })
  const drill = opened
    ? g.recent
        .filter(c => c.bucket === opened)
        .slice(-K.drillChecks)
        .map(c => drillRow(k, c, w))
    : null
  return framed(k, C.gate, w, [
    titleRow(k, heading(k, C.gate, fill(X.gateTitle, { label: S.gateLabel })), <Text dimColor>{fill(X.checks, { n: k.totals.total })}</Text>),
    recentMarks.length > 0 ? marksRow(k, recentMarks.map(c => checkMark(k, c))) : tinted(k, C.faint, X.noChecks),
    lineOf(k, [...(isShort ? gateTotalPieces(k, true) : inWords), showNote ? { runs: [{ text: X.subagentNote, color: C.faint }] } : null], room, Z.gateGap),
    // In a narrow pane the three buttons wrap rather than run past the box.
    <Box flexWrap="wrap" columnGap={Z.sectionGap}>
      {familyButtons}
    </Box>,
    drill,
  ])
}

// ---------------------------------------------------------------- agents: cards up to the limit, lanes beyond it

/** The agents heading: counts, and the keys that expand a card. */
function agentsHeading(k: Kit, w: number, keys: number): RenderElement {
  const { Text } = k.els
  const total = k.d.cards.length
  const isNarrow = w < Z.narrowBelow
  const title = (
    <Text wrap="truncate" bold>
      {fill(isNarrow ? X.agentsNarrow : X.agentsWide, { running: k.running.length, total })}
    </Text>
  )
  const hint = total > 0 ? tinted(k, k.C.faint, fill(X.expandRange, { n: Math.min(total, keys) }) + (isNarrow ? '' : X.expandWord)) : null
  return titleRow(k, title, hint, w)
}

/** One swimlane: glyph, a label that is the card's key, its bar on the shared axis, and its clock. */
function laneRow(k: Kit, c: Card, i: number, labelW: number, cell: { before: number; bar: number; after: number } | undefined): RenderElement {
  const { Box, Text, Button } = k.els
  const isViewed = k.d.viewed === c.id
  const color = statusColor(k, c)
  return (
    <Box columnGap={1}>
      <Text bold={isViewed} color={color}>
        {isViewed ? G.viewed : statusGlyph(c)}
      </Text>
      <Box flexShrink={0} width={labelW}>
        <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={clip(cardLabel(c), labelW - Z.laneLabelInset)} onPress={k.d.toggleCard(c.id)} />
      </Box>
      <Box flexShrink={0}>
        <Text>
          {tinted(k, k.C.faint, G.laneTrack.repeat(cell?.before ?? 0))}
          {tinted(k, color, G.laneBar.repeat(cell?.bar ?? 1))}
          {tinted(k, k.C.faint, G.laneTrack.repeat(cell?.after ?? 0))}
        </Text>
      </Box>
      {k.d.timer(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, k.C.dim)}
    </Box>
  )
}

/** One agent card `cardW` wide. */
function agentCard(k: Kit, c: Card, i: number, cardW: number): RenderElement {
  const { Box, Text, Button } = k.els
  const { C } = k
  const isViewed = k.d.viewed === c.id
  const hitCap = c.lastStop === 'max_tokens'
  const [top, second] = twoRowTitle(cardLabel(c), cardW - Z.cardTitleInset, cardW - Z.cardTitleRest)
  const sameModel = c.model === '' || modelName(c.model) === k.model
  // A named agent shows its subagent type beside its name (DESIGN.md); the reference layout shows the name alone.
  const named = F.agentName && c.name !== '' && c.kind !== '' && c.kind !== c.name
  const who = named ? fill(X.namedType, { name: c.name, type: c.kind }) : c.type
  const kind = sameModel ? who : fill(X.typeModel, { type: who, model: modelName(c.model) })
  const worktreeLine =
    F.worktree && c.worktree !== null ? dimText(k, c.worktree === '' ? X.cardWorktreeBare : fill(X.cardWorktree, { name: c.worktree }), 'truncate') : null
  const stats = c.steps > 0 ? fill(X.cardStats, { ctx: tokensShort(c.ctx), out: tokensShort(c.out), steps: c.steps }) : X.starting
  const glyph = statusGlyph(c)
  const state = cardW < Z.cardStatusFrom ? glyph : `${glyph} ${hitCap ? X.maxTokens : statusWord(c)}`
  return framed(
    k,
    hitCap ? C.warn : accentOf(k, c.id),
    cardW,
    [
      <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={top} onPress={k.d.toggleCard(c.id)} />,
      <Text wrap="truncate" bold>
        {second}
      </Text>,
      tinted(k, C.dim, kind, 'truncate'),
      dimText(k, stats, 'truncate'),
      worktreeLine,
      <Box columnGap={1}>
        {tinted(k, hitCap ? C.warn : statusColor(k, c), state)}
        <Box flexShrink={0}>{k.d.timer(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
      </Box>,
    ],
    { borderStyle: isViewed ? 'double' : 'round', borderDimColor: !isViewed && c.status !== 'running' },
  )
}

function agentsPanel(k: Kit, w: number): RenderElement {
  const { Box } = k.els
  const cards = k.d.cards
  const { perRow, capacity } = cardGrid(k, w)
  const asLanes = cards.length > capacity
  const head = agentsHeading(k, w, asLanes ? K.lanes : capacity)
  if (cards.length === 0) {
    return (
      <Box width={w} flexDirection="column">
        {head}
        {tinted(k, k.C.faint, X.noAgents)}
      </Box>
    )
  }
  if (asLanes) {
    const laned = cards.slice(-K.lanes)
    // A lane is its glyph, a label, the bar and a clock: in a narrow pane the label narrows first, then the bar.
    const labelW = Math.min(Z.laneLabelMax, Math.max(Z.laneLabelMin, w - Z.laneLabelReserve))
    const axis = laneCells(laned, k.d.now, Math.max(Z.laneBarMin, w - Z.laneBarReserve - labelW))
    const hidden = cards.length - laned.length
    return (
      <Box width={w} flexDirection="column">
        {head}
        {hidden > 0 ? tinted(k, k.C.faint, fill(X.earlier, { n: hidden })) : null}
        {laned.map((c, i) => laneRow(k, c, i, labelW, axis[i]))}
      </Box>
    )
  }
  const shown = cards.slice(-capacity)
  // Cards share a row's width: one a row (stacked) takes all of it.
  const inRow = Math.min(perRow, shown.length)
  const cardW = Math.max(Z.cardMin, Math.floor((w - inRow + 1) / inRow))
  // Where each card's branch meets the connectors: the middle of each box in a row.
  const branchAt = Array.from({ length: inRow }, (_, i) => (cardW + 1) * i + Math.floor(cardW / 2))
  const flowing = k.running.length > 0
  const rows: RenderElement[] = []
  for (let first = 0; first < shown.length; first += perRow) {
    const row = shown.slice(first, first + perRow)
    rows.push(<Box columnGap={1}>{row.map((c, i) => agentCard(k, c, first + i, cardW))}</Box>)
  }
  return (
    <Box width={w} flexDirection="column">
      {head}
      {k.d.connector('fan-out', flowing, k.C.agent, w, branchAt)}
      {rows}
      {k.d.connector('merge', flowing, k.C.agent, w, branchAt, true)}
    </Box>
  )
}

/**
 * How the agent cards are laid out in a panel `w` wide. A row holds the data's `cardsPerRow` (never more than
 * `maxCards`, nor more than fit at the data's `cardMin` cells each with a cell of gap); rows stack until
 * `maxCards`. Past `capacity` agents the panel draws lanes. With `cardsPerRow` at `maxCards` or more there is
 * one row, and the capacity is what fits in it.
 */
function cardGrid(k: Kit, w: number): { perRow: number; capacity: number } {
  const wanted = Math.max(1, Math.min(Z.cardsPerRow, k.S.maxCards))
  const fits = Math.floor((w + 1) / (Z.cardMin + 1))
  const perRow = Math.max(1, Math.min(wanted, fits))
  const rows = Math.ceil(k.S.maxCards / wanted)
  return { perRow, capacity: Math.min(k.S.maxCards, perRow * rows) }
}

/** The expanded card: its full task, meta, last calls and answer. Nothing when no card is expanded. */
function expandedPanel(k: Kit, w: number): RenderElement | null {
  const { Text } = k.els
  const { C } = k
  const c = k.expanded
  if (c === undefined) return null
  const meta = fill(X.expandedMeta, { type: c.type, model: modelName(c.model), status: statusWord(c), steps: c.steps })
  return framed(
    k,
    C.agent,
    w,
    [
      <Text bold wrap="wrap">
        {c.description || c.type}
      </Text>,
      dimText(k, meta, 'truncate'),
      c.tools.length > 0 ? null : tinted(k, C.faint, X.noCalls),
      c.tools.map(call => tinted(k, call.isError ? C.warn : C.text, `${call.isError ? G.denied : G.callOk} ${call.text}`, 'truncate')),
      c.answer ? dimText(k, `${G.advice} ${clip(c.answer, K.expandedAnswerChars)}`, 'wrap') : null,
    ],
    { borderStyle: 'single' },
  )
}

// ---------------------------------------------------------------- other loops, receipt, log

/** Loops no card claims: a count and a dot each. Nothing when there are none. */
function loopsPanel(k: Kit, w: number): RenderElement | null {
  const { Box, Text } = k.els
  const { C } = k
  const loops = k.d.loops
  if (loops.length === 0) return null
  const isNarrow = w < Z.narrowBelow
  const dots = loops.slice(-Math.max(Z.loopDotsMin, marksFor(w - Z.loopDotsReserve, k.isTerminal))).map(l => {
    if (loopIsLive(l, k.d.now)) return tinted(k, C.agent, G.loopLive)
    return l.isDone ? tinted(k, C.dim, G.loopDone) : tinted(k, C.faint, G.loopIdle)
  })
  return (
    <Box columnGap={1} width={w}>
      <Text bold>{isNarrow ? X.loopsNarrow : X.loopsWide}</Text>
      {dimText(k, fill(isNarrow ? X.loopsCountNarrow : X.loopsCountWide, { n: loops.length, active: k.liveLoops }))}
      {marksRow(k, dots, 1)}
    </Box>
  )
}

/** The receipt: the turn in progress, else the last one. */
function receiptPanel(k: Kit, w: number): RenderElement {
  const { Box } = k.els
  const { C } = k
  const m = k.d.main
  const t = k.d.turn
  const r = k.d.receipt
  let body: RenderElement
  if (m.isRunning) {
    body = (
      <Box overflow="hidden" columnGap={1} width={w - BOX_CHROME}>
        {tinted(k, C.main, fill(X.backTo, { glyph: G.running, model: k.model.toLowerCase() }), 'truncate')}
        <Box flexShrink={0}>{k.d.timer('turn-clock', t.startedAt, null, C.main)}</Box>
        {w < Z.receiptCountsFrom ? null : dimText(k, fill(X.turnCounts, { edits: counted(t.edits, 'edit'), errors: counted(t.errors, 'error') }), 'truncate')}
      </Box>
    )
  } else if (r) {
    const isAnswer = r.reason === 'answer'
    body = lineOf(
      k,
      [
        { runs: [{ text: isAnswer ? G.done : G.failed, color: isAnswer ? C.gate : C.warn }] },
        { stretches: true, runs: [{ text: lastTurnText(r) }] },
        r.costDelta === null ? null : { runs: [{ text: fill(X.costAdded, { usd: dollars(r.costDelta) }), color: C.main }] },
      ],
      w - BOX_CHROME,
    )
  } else {
    body = tinted(k, C.faint, X.noTurn)
  }
  return framed(k, C.main, w, [body, t.isReviewing ? tinted(k, C.arch, fill(X.reviewing, { label: k.archWord }), 'wrap') : null], {
    borderDimColor: !(m.isRunning || t.isReviewing),
  })
}

/** Rows the deck above the log takes, by the data's per-part estimates: the log gets what is left. */
function rowsAboveLog(k: Kit): number {
  const R = Z.rows
  const d = k.d
  const parts = [
    R.header,
    k.legendAir,
    R.main,
    d.main.speed ? R.speed : 0,
    R.link,
    k.hasArchitect ? R.architect : 0,
    R.gate,
    d.view.gateOpen ? R.drill : 0,
    d.cards.length > k.S.maxCards ? R.lanesHead + Math.min(K.lanes, d.cards.length) : R.cards + R.cardStack * (stackedRows(k) - 1),
    k.expanded ? R.expanded : 0,
    F.task && d.main.task !== '' ? R.task : 0,
    F.steps && d.main.todos.length > 0 ? R.steps : 0,
    F.repo && d.main.repo !== '' ? R.repo : 0,
    F.worktree && d.cards.length <= k.S.maxCards && d.cards.some(c => c.worktree !== null) ? R.cardExtra * stackedRows(k) : 0,
    d.loops.length > 0 ? R.loops : 0,
    R.receipt,
  ]
  return parts.reduce((sum, n) => sum + n, 0)
}

/** Rows of cards the agents panel stacks (1 when it sets them side by side, or has none). */
function stackedRows(k: Kit): number {
  const wanted = Math.max(1, Math.min(Z.cardsPerRow, k.S.maxCards))
  return Math.max(1, Math.ceil(Math.min(k.d.cards.length, k.S.maxCards) / wanted))
}

/** A log line's speaker colour: by kind first, then by who. */
function speakerColor(k: Kit, l: LogEntry): string {
  const { C } = k
  const who = X.who
  if (l.kind === 'error') return C.warn
  if (l.kind === 'consult') return C.arch
  const byWho: Record<string, string> = { [who.main]: C.main, [who.gate]: C.gate, [who.you]: C.text }
  return byWho[l.who] ?? (l.agentId ? accentOf(k, l.agentId) : C.agent)
}

/** The session log, filtered to the agent in view; in a narrow pane a line keeps its minute and a shorter name. */
function logPanel(k: Kit, w: number): RenderElement {
  const { Box, Text } = k.els
  const { C, d } = k
  const isNarrow = w < Z.narrowBelow
  const mine = d.viewed === null ? d.log : d.log.filter(l => l.agentId === d.viewed)
  const lines = mine.slice(-logBudget(d.bodyRows, rowsAboveLog(k)))
  const rows = lines.map(l => {
    // HH:MM is the first five characters of the clock. Structural: the clock's format.
    const clock = isNarrow ? timeOfDay(l.at).slice(0, 5) : timeOfDay(l.at)
    return (
      <Box>
        <Box flexShrink={0} width={isNarrow ? Z.logClockColsNarrow : Z.logClockCols}>
          {tinted(k, C.faint, clock)}
        </Box>
        <Box flexShrink={0} width={isNarrow ? Z.logWhoColsNarrow : Z.logWhoCols}>
          <Text bold wrap="truncate" color={speakerColor(k, l)}>
            {l.who}
          </Text>
        </Box>
        {tinted(k, l.kind === 'error' ? C.warn : C.text, l.text, 'truncate')}
      </Box>
    )
  })
  return framed(k, C.faint, w, [dimText(k, d.viewed ? X.logTitleAgent : X.logTitle, 'truncate'), lines.length === 0 ? tinted(k, C.faint, X.logEmpty) : null, rows], { marginTop: 1 })
}

// ---------------------------------------------------------------- the docked deck

/** Each panel's drawing function. */
const PANELS: Record<PanelId, (k: Kit, w: number) => RenderElement | null> = {
  main: mainPanel,
  architect: architectPanel,
  gate: gatePanel,
  agents: agentsPanel,
  loops: loopsPanel,
  receipt: receiptPanel,
  log: logPanel,
}

/** Panels in one column with the flow between them. The agents panel draws its own connectors; loops and the log take none. */
function panelColumn(k: Kit, ids: PanelId[], w: number): RenderElement {
  const { Box } = k.els
  return (
    <Box width={w} flexDirection="column">
      {ids.map((id, i) => {
        const above = ids[i - 1]
        const isBare = above === undefined || NO_LINK_ABOVE.has(id) || NO_LINK_BELOW.has(above)
        const isArch = id === 'architect'
        return (
          <Box flexDirection="column">
            {isBare ? null : k.d.connector(`link-${id}`, isArch ? k.advising : k.d.main.isRunning, isArch ? k.C.arch : k.C.main, w)}
            {PANELS[id](k, w)}
            {id === 'agents' ? expandedPanel(k, w) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/** The panels with something to show, in the configured order: most sessions never spawn an agent. */
function panelsShown(k: Kit): PanelId[] {
  const d = k.d
  const blank: Partial<Record<PanelId, boolean>> = {
    architect: !k.hasArchitect,
    gate: k.totals.total === 0 && d.gate.recent.length === 0,
    agents: d.cards.length === 0,
    loops: d.loops.length === 0,
    receipt: !d.main.isRunning && !d.receipt,
  }
  return k.S.panels.filter(id => blank[id] !== true)
}

function dockedDeck(k: Kit): RenderElement {
  const { Box, Text } = k.els
  const { C, S, W } = k
  const m = k.d.main
  const panels = panelsShown(k)
  const isWide = k.layout === 'wide' || (k.layout === 'auto' && W >= Z.wideFrom)
  let body: RenderElement
  if (isWide) {
    const half = Math.floor((W - Z.wideGap) / 2)
    body = (
      <Box flexDirection="column">
        <Box columnGap={Z.wideGap}>
          {panelColumn(k, panels.filter(p => LEFT_COLUMN.has(p)), half)}
          {panelColumn(k, panels.filter(p => RIGHT_COLUMN.has(p)), half)}
        </Box>
        {panels.indexOf('log') >= 0 ? logPanel(k, W) : null}
      </Box>
    )
  } else {
    body = panelColumn(k, panels, W)
  }

  // In a narrow pane the frame's own title names it, so the header starts at the model.
  const header = withClose(k, room =>
    lineOf(
    k,
    [
      W < Z.narrowBelow
        ? null
        : {
            runs: [
              { text: X.brand, isBold: true },
              { text: X.brandSep, color: C.dim, isBold: true },
            ],
          },
      {
        runs: [
          { text: k.model.toUpperCase(), color: C.main, isBold: true },
          { text: m.isRunning ? X.works : X.idle, isBold: true },
        ],
      },
      k.hasArchitect
        ? {
            runs: [
              { text: X.headerSep, color: C.dim, isBold: true },
              { text: S.architectLabel, color: C.arch, isBold: true },
              { text: k.advising ? X.headerAdvising : X.headerOnCall, isBold: true },
            ],
          }
        : null,
    ],
    room,
    Z.lineGap,
    'center',
  ),
  )

  const legendItems = [
    { label: X.legendMain, color: C.main },
    { label: X.legendAgents, color: C.agent },
    { label: S.gateLabel.toLowerCase(), color: C.gate },
  ]
  if (k.hasArchitect) legendItems.push({ label: k.archWord, color: C.arch })
  const legend = (
    <Box key="legend" marginBottom={k.legendAir} columnGap={Z.sectionGap} justifyContent="center">
      {legendThatFits(legendItems, W).map(item => (
        <Box flexShrink={0}>
          <Text>
            {tinted(k, item.color, G.legend)}
            {dimText(k, ` ${item.label}`)}
          </Text>
        </Box>
      ))}
    </Box>
  )

  return (
    <Box width={W} flexDirection="column">
      {header}
      {legend}
      {body}
      {!k.isTerminal && k.d.cards.length > 0 && 'Svg' in k.els ? timeAxis(k) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- inline above the prompt

/** The inline summary: vitals, the gate strip, up to the data's `miniAgents` agents, loops and the last turn. */
function miniDeck(k: Kit): RenderElement {
  const { Box, Text } = k.els
  const { C, S, W, d } = k
  const u = d.usage
  const m = d.main
  const r = d.receipt
  const n = k.totals
  const finished = d.cards.filter(c => c.status !== 'running').reverse()
  const listed = k.running.concat(finished).slice(0, K.miniAgents)
  const counts = fill(X.gateCounts, {
    rule: n.rule,
    cleared: n.cleared,
    decider: k.decider,
    pending: n.ask > 0 ? fill(X.gatePending, { n: n.ask }) : '',
    deny: n.deny,
  })
  // The strip takes what the label, the counts and the two gaps between them leave.
  const recent = d.gate.recent.slice(-Math.max(Z.miniStripMin, marksFor(W - S.gateLabel.length - 2 - counts.length, k.isTerminal)))
  const badge = u.compactions > 0 ? compactBadge(u) : ''
  const pct = k.ctx.pct
  let ctxPiece: Chunk | null = null
  if (pct !== null) {
    const gauge = meter(pct, Z.miniGauge)
    ctxPiece = {
      runs: [
        { text: X.miniCtx, isDim: true },
        { text: gauge.on, color: gaugeColor(k, pct) },
        { text: gauge.off, color: C.faint },
        { text: fill(X.pct, { pct: Math.round(pct) }) },
      ],
    }
    if (badge) ctxPiece.runs.push({ text: ` ${badge}`, color: C.amber })
  } else if (badge) {
    ctxPiece = { runs: [{ text: badge, color: C.amber }] }
  }
  const vitals = withClose(k, room =>
    lineOf(
    k,
    [
      {
        runs: [
          { text: k.model, color: C.main, isBold: true },
          { text: ` ${m.isRunning ? X.working : X.idleState}`, color: m.isRunning ? C.main : C.dim },
        ],
      },
      ctxPiece,
      u.costUsd === null ? null : { runs: [{ text: fill(X.miniCost, { usd: dollars(u.costUsd) }), isDim: true }] },
      k.hasArchitect ? { runs: [{ text: fill(X.miniArch, { label: k.archWord, state: k.advising ? X.advising : d.architect.consults.length }), color: C.arch }] } : null,
    ],
    room,
  ),
  )
  const countsColor = n.deny > 0 ? C.warn : n.ask > 0 ? C.amber : C.dim
  const gateRow =
    recent.length === 0 ? null : (
      <Box columnGap={1}>
        {dimText(k, S.gateLabel.toLowerCase())}
        {marksRow(k, recent.map(c => checkMark(k, c)))}
        {tinted(k, countsColor, counts, 'truncate')}
      </Box>
    )
  const agentRows = listed.map(c => (
    <Box columnGap={1}>
      {tinted(k, statusColor(k, c), statusGlyph(c))}
      <Box flexShrink={0} width={Math.max(Z.miniTitleMin, W - Z.miniTitleReserve)}>
        <Text wrap="truncate">{cardLabel(c)}</Text>
      </Box>
      {c.steps > 0 ? dimText(k, `${X.ctx}${tokensShort(c.ctx)}`) : null}
      {d.timer(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
    </Box>
  ))
  const more = d.cards.length - listed.length
  return (
    <Box width={W} flexDirection="column">
      {vitals}
      {gateRow}
      {agentRows}
      {more > 0 ? tinted(k, C.faint, fill(X.miniMore, { n: more }), 'truncate') : null}
      {d.loops.length > 0 ? dimText(k, fill(X.miniLoops, { n: d.loops.length, active: k.liveLoops }), 'truncate') : null}
      {r && !m.isRunning ? dimText(k, lastTurnText(r) + (r.costDelta === null ? '' : fill(X.miniCostAdded, { usd: dollars(r.costDelta) })), 'truncate') : null}
    </Box>
  )
}

// ---------------------------------------------------------------- the desktop's time axis

/** An SVG fill for a card's bar: SVG takes no theme keys, so the data's fixed mid-tones. */
function barFill(c: Card): string {
  const P = T.svg.colors
  if (c.status === 'running') return P.running
  if (c.status === 'done') return P.done
  return c.status === 'failed' ? P.failed : P.other
}

/** The agents on a time axis as SVG. No pixel size on the element, so a narrow pane scales it down. */
function timeAxis(k: Kit): RenderChildren {
  const V = T.svg
  const cards = k.d.cards
  const Svg = (k.els as ElementTable<'desktop'>).Svg
  const plotted = cards.slice(-V.maxRows)
  const axis = laneCells(plotted, k.d.now, V.axisCells)
  const usable = V.widthPx - V.barInsetPx
  let shapes = ''
  plotted.forEach((c, row) => {
    const cell = axis[row]
    const left = V.barLeftPx + ((cell?.before ?? 0) / V.axisCells) * usable
    const width = Math.max(V.minBarPx, ((cell?.bar ?? 1) / V.axisCells) * usable)
    const top = row * V.rowPx
    // Markup characters are dropped from the label rather than escaped: it is a short name, not content.
    const name = clip(cardLabel(c), V.labelChars).replace(/[<&>]/g, '')
    shapes += `<text x="${V.textX}" y="${top + V.textBaselinePx}" font-size="${V.fontPx}" fill="${V.colors.label}">${name}</text>`
    shapes += `<rect x="${left}" y="${top + V.barTopPx}" width="${width}" height="${V.barHeightPx}" rx="${V.barRadiusPx}" fill="${barFill(c)}"/>`
  })
  const height = V.rowPx * Math.min(V.maxRows, cards.length) + V.bottomPx
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${V.widthPx}" height="${height}" viewBox="0 0 ${V.widthPx} ${height}">${shapes}</svg>`
  return <Svg source={source} alt={fill(X.svgAlt, { n: cards.length })} />
}
