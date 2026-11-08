//! agent-roster's hooks module: the wiring. Session events (turns, model requests, permission checks and tool
//! calls, spawns, compactions, measurements, assistant rows) are folded into the records in `$.state`; the status
//! line is kept; `/roster` opens, closes, resets and lays out the pane, which deck.tsx draws (desk.tsx and
//! office.tsx draw its other views). While the office shows a running agent, a timer repaints each moving desk's
//! picture in place (`$.ui.blit`), so the avatars type without a redraw.
//!
//! It only watches: every hook passes its event on unchanged. The bookkeeping is in ledger.ts, the stored shapes
//! in records.ts, the text in words.ts; every text and number is in data/agent-roster.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { tuning as T } from '../data/agent-roster'
import type { ArchitectLog, Card, Check, DeskState, GateLog, LogEntry, MainLoop, OtherLoop, RosterTypes, TurnTally, Usage, ViewState } from '../types'
import { drawDeck } from './deck'
import { drawDesk } from './desk'
import { drawOffice, rasterKey } from './office'
import { deskCells, frameAt, frameCount, isMoving, officeStateOf } from './office-rules'
import { DESK_SHAPE, agentStopped, asViewMode, blankDesk, callEnded, callStarted, fixDesk, keepsTodos, requestTokens, todosAfterCall, tokensAdded } from './desk-rules'
import { cardLabel, faultId, hasMonoFace } from './geometry'
import {
  addCheck,
  afterWindowRead,
  atRequest,
  atResponse,
  cardAfterStep,
  cardWithCall,
  claimWindowRead,
  closeConsult,
  compactHooked,
  forgetWindowRead,
  gateTotals,
  gaugeBasis,
  isConsulting,
  loopStep,
  momentNow,
  openConsult,
  placeCard,
  receiptFor,
  runAgain,
  settleAsk,
  tallyCall,
  todosAfterCreate,
  todosAfterUpdate,
  todosFromWrite,
} from './ledger'
import type { RequestUsage } from './ledger'
import {
  asLayout,
  blankArchitect,
  blankCard,
  blankGate,
  blankMain,
  blankRoster,
  blankTurn,
  blankUsage,
  blankView,
  fixArchitect,
  fixCards,
  fixGate,
  fixLog,
  fixLoops,
  fixMain,
  fixReceipt,
  fixRoster,
  fixTurn,
  fixUsage,
  fixView,
  STORE_SHAPE,
  paletteColors,
  settingsFrom,
} from './records'
import type { Settings } from './records'
import { adviceOf, answerAdvice, branchFromHead, callSummary, clip, lastFolder, taskLine, durationShort, familyOf, fill, firstPieceTiming, isEditTool, limitReading, openingLine, readHandback, stopwatch } from './words'

const X = T.text
const L = T.text.log
const Z = T.sizes
const K = T.keep
const PANE = T.pane.id

// ---------------------------------------------------------------- state

/** The tag every atom is kept under (records.ts says why). */
const SHAPE = { shape: STORE_SHAPE } as const

// The plugin name in each ref is structural: `$.state` is namespaced by it, and validate reads it as a literal.
const mainAtom = atom({ plugin: 'agent-roster', key: 'main' } as const, blankMain, SHAPE)
const usageAtom = atom({ plugin: 'agent-roster', key: 'usage' } as const, blankUsage, SHAPE)
const architectAtom = atom({ plugin: 'agent-roster', key: 'architect' } as const, blankArchitect, SHAPE)
const gateAtom = atom({ plugin: 'agent-roster', key: 'gate' } as const, blankGate, SHAPE)
const agentsAtom = atom({ plugin: 'agent-roster', key: 'agents' } as const, [] as Card[], SHAPE)
const loopsAtom = atom({ plugin: 'agent-roster', key: 'loops' } as const, [] as OtherLoop[], SHAPE)
const logAtom = atom({ plugin: 'agent-roster', key: 'log' } as const, [] as LogEntry[], SHAPE)
const turnAtom = atom({ plugin: 'agent-roster', key: 'turn' } as const, blankTurn, SHAPE)
const receiptAtom = atom({ plugin: 'agent-roster', key: 'receipt' } as const, null, SHAPE)
const viewAtom = atom({ plugin: 'agent-roster', key: 'view' } as const, blankView, SHAPE)
const rosterAtom = atom({ plugin: 'agent-roster', key: 'roster' } as const, blankRoster, SHAPE)
// The helper desk's record keeps its own tag (desk-rules.ts says why).
const deskAtom = atom({ plugin: 'agent-roster', key: 'desk' } as const, blankDesk, { shape: DESK_SHAPE })

/** A content block of an assistant row, as far as reading server-side tools needs it. */
type Block = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every load and every change goes through the record's repair (records.ts): what is stored may be broken.

async function loadMain($: EngineInterface): Promise<MainLoop> {
  return fixMain(await read($, mainAtom))
}
async function loadUsage($: EngineInterface): Promise<Usage> {
  return fixUsage(await read($, usageAtom))
}
async function loadArchitect($: EngineInterface): Promise<ArchitectLog> {
  return fixArchitect(await read($, architectAtom))
}
async function loadGate($: EngineInterface): Promise<GateLog> {
  return fixGate(await read($, gateAtom))
}
async function loadCards($: EngineInterface): Promise<Card[]> {
  return fixCards(await read($, agentsAtom))
}
async function loadTurn($: EngineInterface): Promise<TurnTally> {
  return fixTurn(await read($, turnAtom))
}
async function loadRoster($: EngineInterface): Promise<RosterTypes> {
  return fixRoster(await read($, rosterAtom))
}

async function changeMain($: EngineInterface, f: (m: MainLoop) => MainLoop) {
  await update($, mainAtom, raw => f(fixMain(raw)))
}
async function changeUsage($: EngineInterface, f: (u: Usage) => Usage) {
  await update($, usageAtom, raw => f(fixUsage(raw)))
}
async function changeArchitect($: EngineInterface, f: (a: ArchitectLog) => ArchitectLog) {
  await update($, architectAtom, raw => f(fixArchitect(raw)))
}
async function changeGate($: EngineInterface, f: (g: GateLog) => GateLog) {
  await update($, gateAtom, raw => f(fixGate(raw)))
}
async function changeCards($: EngineInterface, f: (cards: Card[]) => Card[]) {
  await update($, agentsAtom, raw => f(fixCards(raw)))
}
async function changeLoops($: EngineInterface, f: (loops: OtherLoop[]) => OtherLoop[]) {
  await update($, loopsAtom, raw => f(fixLoops(raw)))
}
async function changeTurn($: EngineInterface, f: (t: TurnTally) => TurnTally) {
  await update($, turnAtom, raw => f(fixTurn(raw)))
}
async function loadDesk($: EngineInterface): Promise<DeskState> {
  return fixDesk(await read($, deskAtom))
}
async function changeDesk($: EngineInterface, f: (s: DeskState) => DeskState) {
  await update($, deskAtom, raw => f(fixDesk(raw)))
}
async function changeView($: EngineInterface, f: (v: ViewState) => ViewState) {
  await update($, viewAtom, raw => f(fixView(raw)))
}

/** The card with `id`, changed by `f`; the others as they are. */
async function editCard($: EngineInterface, id: string, f: (c: Card) => Card) {
  await changeCards($, cards => cards.map(c => (c.id === id ? f(c) : c)))
}

/** Everything the deck draws, read at once. */
async function loadAll($: EngineInterface) {
  const [main, usage, architect, gate, cards, loops, log, turn, receipt, view, now] = await Promise.all([
    loadMain($),
    loadUsage($),
    loadArchitect($),
    loadGate($),
    loadCards($),
    read($, loopsAtom).then(fixLoops),
    read($, logAtom).then(fixLog),
    loadTurn($),
    read($, receiptAtom).then(fixReceipt),
    read($, viewAtom).then(fixView),
    $.clock.now(),
  ])
  return { main, usage, architect, gate, cards, loops, log, turn, receipt, view, now }
}

// ---------------------------------------------------------------- helpers

/** Whether this engine's Text takes `mono`; false when the engine cannot say. */
async function engineHasMono($: EngineInterface): Promise<boolean> {
  try {
    return hasMonoFace(await $.session.version())
  } catch {
    return false
  }
}

/** One line in the session log, the oldest dropped past the data's `logLines`. */
async function logLine($: EngineInterface, who: string, text: string, kind: LogEntry['kind'] = 'info', agentId: string | null = null) {
  const stamp = await $.clock.now()
  await update($, logAtom, raw => fixLog(raw).concat({ at: stamp, who, text, kind, agentId }).slice(-K.logLines))
}

/** The status line: only the fields with something to say, and no line at all when none do. */
async function paintStatus($: EngineInterface, S: Settings) {
  if (!S.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([loadUsage($), loadArchitect($), loadGate($), loadCards($)])
  const words = X.status
  const fields: string[] = []
  const pct = gaugeBasis(u).pct
  if (pct !== null) fields.push(fill(words.ctx, { pct: Math.round(pct) }))
  if (cards.length > 0) fields.push(fill(words.agents, { running: cards.filter(c => c.status === 'running').length, total: cards.length }))
  if (a.ids.length > 0 || a.consults.length > 0) {
    const label = S.architectLabel.toLowerCase()
    fields.push(isConsulting(a) ? fill(words.advising, { label }) : fill(words.architect, { label, n: a.consults.length }))
  }
  const refused = gateTotals(g).deny
  if (refused > 0) fields.push(fill(words.denied, { n: refused }))
  $.ui.status(fields.length === 0 ? undefined : fields.join(words.joiner))
}

/** The log's name for a loop: main, the agent's task cut short, or the generic agent word for one with no card. */
async function speakerFor($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (!agentId) return X.who.main
  const card = (await loadCards($)).find(c => c.id === agentId)
  if (card === undefined) return X.who.agent
  return clip(cardLabel(card), Z.whoChars)
}

/** A consult began. Its moment is inferred from the turn so far; one at "before done" puts the turn under review. */
async function beginConsult($: EngineInterface, S: Settings, id: string, via: string) {
  const moment = momentNow(await loadTurn($))
  const opened = await $.clock.now()
  await changeArchitect($, a => openConsult(a, { id, at: opened, moment, via }))
  if (moment === 'done') await changeTurn($, t => ({ ...t, isReviewing: true }))
  const said = S.moments ? fill(L.consultMoment, { moment: X.moments[moment], via }) : fill(L.consulted, { via })
  await logLine($, S.architectLabel.toLowerCase(), said, 'consult')
  await paintStatus($, S)
}

/** A consult ended, its advice the answer's first line when there is one. */
async function finishConsult($: EngineInterface, S: Settings, answer: string | null, id?: string) {
  const closedAt = await $.clock.now()
  const advice = answerAdvice(answer)
  await changeArchitect($, a => closeConsult(a, closedAt, advice, id))
  await changeTurn($, t => ({ ...t, isReviewing: false }))
  const said = advice ? fill(L.advice, { text: clip(advice, Z.adviceLogChars) }) : L.adviceReturned
  await logLine($, S.architectLabel.toLowerCase(), said, 'consult')
  await paintStatus($, S)
}

/** Advice that arrived on its own: a background architect's hand-back. Repeats of the last advice are dropped. */
async function takeAdvice($: EngineInterface, S: Settings, a: ArchitectLog, report: string) {
  const advice = adviceOf(report)
  if (!advice || advice === a.lastAdvice) return
  await changeArchitect($, x => ({ ...x, lastAdvice: advice }))
  await logLine($, S.architectLabel.toLowerCase(), fill(L.advice, { text: clip(advice, Z.adviceLogChars) }), 'consult')
}

/** Whether an agent type is the architect's: by pattern, or offered earlier under a matching description. */
async function belongsToArchitect($: EngineInterface, S: Settings, type: string): Promise<boolean> {
  if (S.architect.test(type)) return true
  return (await loadRoster($)).architectTypes.includes(type)
}

/** Opens the pane: `columns` apply where it docks beside the transcript, `rows` where it seats inline. */
async function showDeck($: EngineInterface, S: Settings) {
  return $.ui.open({ id: PANE, title: T.pane.title, columns: S.paneColumns, rows: T.pane.inlineRows })
}

/** Closes the pane: the `/roster close` command and the header's close control. */
async function hideDeck($: EngineInterface) {
  await $.ui.close({ id: PANE })
}

/** Every record back to blank but the model and the permission mode; the gauge waits for the next reading. */
async function wipeDeck($: EngineInterface) {
  await changeMain($, m => ({ ...blankMain, model: m.model, mode: m.mode }))
  await changeUsage($, u => ({ ...u, pct: null, tokens: null }))
  await changeArchitect($, () => blankArchitect)
  await changeGate($, () => blankGate)
  await changeCards($, () => [])
  await changeLoops($, () => [])
  await update($, logAtom, () => [])
  await changeTurn($, () => blankTurn)
  await update($, receiptAtom, () => null)
  await changeView($, () => blankView)
  // The desk keeps the view the person picked; its list and tallies start over with the deck.
  await changeDesk($, s => ({ ...blankDesk, view: s.view }))
}

/**
 * Reads the compaction window for model window `window`. A `summary` breakdown is estimated locally and sends no
 * request; until the host gives one, the gauge keeps the model's window.
 */
async function probeCompactWindow($: EngineInterface, window: number) {
  const reading = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  await changeUsage($, u => afterWindowRead(u, window, reading?.context.breakdown))
}

/** The session's cost, read fresh; the receipt subtracts two of these. Null where the host keeps no ledger. */
async function sessionCost($: EngineInterface): Promise<number | null> {
  const reading = await $.session.usage().catch(() => null)
  if (reading === null) return null
  return reading.cost?.usd ?? null
}

/** Keeps the permission mode an event reports, when it reports one. */
async function recordMode($: EngineInterface, mode: string | undefined) {
  if (!mode) return
  await changeMain($, m => (m.mode === mode ? m : { ...m, mode }))
}

/** Flips a finished card back to running. Whether it did is decided inside the write, so two steps cannot both log it. */
async function reviveCard($: EngineInterface, id: string): Promise<boolean> {
  let revived = false
  await changeCards($, cards => {
    const at = cards.findIndex(c => c.id === id && c.status !== 'running')
    if (at < 0) return cards
    revived = true
    return cards.map((c, i) => (i === at ? runAgain(c) : c))
  })
  return revived
}

/** What the engine measures about a session, as far as the gauge, the cost and the limits need it. */
type Measured = {
  context: { window: number; percent?: number; tokens?: number }
  cost?: { usd: number } | null
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

/** The usage fields a measurement sets, whichever event or call it came from. */
function measuredFields(r: Measured): Pick<Usage, 'window' | 'pct' | 'tokens' | 'costUsd' | 'limits'> {
  const c = r.context
  return {
    window: c.window,
    pct: typeof c.percent === 'number' ? c.percent : null,
    tokens: typeof c.tokens === 'number' ? c.tokens : null,
    costUsd: r.cost && typeof r.cost.usd === 'number' ? r.cost.usd : null,
    limits: r.rateLimits.map(limitReading),
  }
}

/**
 * The session's first readings. A resumed session already has a context fill, so its compaction window is read
 * as soon as the start settles: the model window to read it for comes back, 0 otherwise. Any other start forgets
 * the last reading (the setting may have changed) and leaves it to the first measurement.
 */
async function firstReadings($: EngineInterface): Promise<number> {
  // A host without usage (headless, an SDK host, a session not yet bound) starts without it.
  const reading = await $.session.usage().catch(() => null)
  if (reading === null) return 0
  const ctx = reading.context
  const hasTokens = ctx.tokens !== undefined
  const resumeWindow = hasTokens && ctx.window > 0 ? ctx.window : 0
  await changeUsage($, u => ({ ...u, ...measuredFields(reading), hasFill: hasTokens, compactFor: resumeWindow, compactMisses: 0 }))
  return resumeWindow
}

/**
 * Before a main-loop request: the model and effort as the request starts (so a long first request does not read
 * as no model), and a compaction inferred where session.compact never reaches this plugin. Returns whether the
 * context had a fill as the request went out.
 */
async function beforeMainRequest($: EngineInterface, model: string, effort: unknown): Promise<boolean> {
  let modelChanged = false
  await changeMain($, m => {
    modelChanged = m.model !== '' && m.model !== model
    return { ...m, model, steps: m.steps + 1, effort: effort === undefined || effort === null ? m.effort : String(effort) }
  })
  if (modelChanged) await changeUsage($, forgetWindowRead)
  const [stored, live, at] = await Promise.all([loadUsage($), $.session.usage().catch(() => null), $.clock.now()])
  if (live === null) return stored.hasFill
  const isReported = live.context.tokens !== undefined
  const preview = atRequest(stored, isReported, at)
  if (preview.usage !== stored) {
    let compacted = false
    await changeUsage($, u => {
      const step = atRequest(u, isReported, at)
      compacted = step.isCompaction
      return step.usage
    })
    if (compacted) await logLine($, X.who.main, L.compactedEstimated)
  }
  return preview.usage.hasFill
}

/** After a main-loop request: its time to first piece, and the fill a response brings. */
async function afterMainRequest($: EngineInterface, answered: boolean, sentAt: number, firstAt: number | null, hadFill: boolean) {
  if (!answered) return
  const speed = firstPieceTiming(sentAt, firstAt)
  if (speed) await changeMain($, m => ({ ...m, speed }))
  // Marked here, not at the next request: two compactions can come with one response between them.
  if (!hadFill) await changeUsage($, atResponse)
}

/** Before a subagent's request: a step from an agent whose card finished means it was resumed (SendMessage). */
async function beforeAgentRequest($: EngineInterface, S: Settings, id: string) {
  const card = (await loadCards($)).find(c => c.id === id)
  if (card === undefined || card.status === 'running') return
  if (!(await reviveCard($, id))) return
  await logLine($, await speakerFor($, id), L.resumed, 'info', id)
  await paintStatus($, S)
}

/** After a subagent's request: its card's tallies, or a step of a loop no card claims. */
async function afterAgentRequest($: EngineInterface, id: string, model: string, usage: RequestUsage | undefined, stopReason: string | null) {
  const [cards, a] = await Promise.all([loadCards($), loadArchitect($)])
  if (cards.findIndex(c => c.id === id) >= 0) {
    await editCard($, id, c => cardAfterStep(c, { model, usage: usage ?? null, stopReason }))
    if (stopReason === 'max_tokens') await logLine($, await speakerFor($, id), L.maxTokens, 'error', id)
    return
  }
  // The architect's own agents are consults, not loops.
  if (a.ids.includes(id)) return
  const seenAt = await $.clock.now()
  await changeLoops($, loops => loopStep(loops, id, seenAt))
}

/** A subagent spawned: an architect's agent opens a consult; any other gets a card, or its card back when resumed. */
async function agentSpawned($: EngineInterface, S: Settings, id: string, o: { type: string; name?: string; model: string; description: string; worktree: string | null }) {
  const dropLoop = (loops: OtherLoop[]) => loops.filter(l => l.id !== id)
  if (await belongsToArchitect($, S, o.type)) {
    await changeArchitect($, a => ({ ...a, ids: a.ids.concat(id).slice(-K.architectIds) }))
    await changeLoops($, dropLoop)
    await beginConsult($, S, id, o.type.split(':').pop() ?? X.who.agent)
    return
  }
  const bornAt = await $.clock.now()
  const card: Card = {
    ...blankCard,
    id,
    type: o.name ?? o.type,
    name: o.name ?? '',
    kind: o.type,
    worktree: o.worktree,
    model: o.model,
    description: o.description,
    spawnedAt: bornAt,
  }
  // Decided in the write: a resume whose first step already set its card running is not logged twice.
  let isFirst = true
  let isBack = false
  await changeCards($, cards => {
    const before = cards.find(c => c.id === id)
    isFirst = before === undefined
    isBack = before !== undefined && before.status !== 'running'
    return placeCard(cards, card)
  })
  await changeLoops($, dropLoop)
  if (isFirst) await logLine($, clip(cardLabel(card), Z.spawnWhoChars), fill(L.spawned, { type: card.type }), 'info', id)
  else if (isBack) await logLine($, clip(cardLabel(card), Z.spawnWhoChars), L.resumed, 'info', id)
  await paintStatus($, S)
}

/** A subagent's turn ended: a consult closes, a card finishes, or a loop no card claims is marked done. */
async function agentFinished($: EngineInterface, S: Settings, id: string, end: { reason: string; answer: string; durationMs: number; now: number }) {
  if ((await loadArchitect($)).ids.includes(id)) {
    await finishConsult($, S, end.answer, id)
    return
  }
  if ((await loadCards($)).findIndex(c => c.id === id) < 0) {
    await changeLoops($, loops => loops.map(l => (l.id === id ? { ...l, lastAt: end.now, isDone: true } : l)))
    await paintStatus($, S)
    return
  }
  const outcome: Record<string, string> = { answer: 'done', aborted: 'stopped' }
  const status = outcome[end.reason] ?? 'failed'
  await editCard($, id, c => ({ ...c, status, endedAt: end.now, answer: clip(end.answer, K.answerChars) }))
  // This run's own length: a resumed card's clock also spans the idle time between runs.
  const said = status === 'done' ? fill(L.done, { took: durationShort(end.durationMs) }) : X.statusWords[status as keyof typeof X.statusWords]
  await logLine($, await speakerFor($, id), said, status === 'done' ? 'done' : 'error', id)
  await paintStatus($, S)
}

/** The main turn ended: its receipt, and the main loop at rest. */
async function mainTurnFinished($: EngineInterface, S: Settings, durationMs: number, reason: string) {
  const [t, cards, cost] = await Promise.all([loadTurn($), loadCards($), sessionCost($)])
  const spawnedSince = cards.filter(c => c.spawnedAt >= t.startedAt).length
  const r = receiptFor(t, { durationMs, agentsSince: spawnedSince, costAtEnd: cost, reason })
  await update($, receiptAtom, () => r)
  await changeMain($, m => ({ ...m, isRunning: false }))
  await paintStatus($, S)
}

/** The main turn opened: a fresh tally, and its opening text read as a hand-back or logged as said. */
async function mainTurnOpened($: EngineInterface, S: Settings, text: string | undefined) {
  const [startedAt, costAtStart] = await Promise.all([$.clock.now(), sessionCost($)])
  await changeTurn($, () => ({ ...blankTurn, startedAt, costAtStart }))
  await changeMain($, m => ({ ...m, isRunning: true }))
  if (!text) return
  // A background architect's report reaches the main loop as the text opening a turn. Its SubagentHandback call
  // (tool.call) normally carries it first; this is the fallback.
  const handback = readHandback(text)
  if (handback !== null) {
    const a = await loadArchitect($)
    if (a.ids.includes(handback.from)) {
      await takeAdvice($, S, a, handback.body)
      return
    }
  }
  const opening = openingLine(text)
  await logLine($, opening.who, opening.text)
  // Only a prompt the person typed sets the current task: a turn the engine opened carries a message, not a task.
  const task = opening.who === X.who.you ? taskLine(text) : ''
  if (task !== '') await changeMain($, m => ({ ...m, task }))
}

/**
 * The main loop's task list after one of its successful task-list calls: TodoWrite writes it whole, TaskCreate adds
 * the task its result names, TaskUpdate sets a status. Other tools leave it.
 */
async function taskListCall($: EngineInterface, tool: string, input: object, result: unknown) {
  if (tool === T.tools.todoWrite) {
    const todos = todosFromWrite(Reflect.get(input, 'todos'))
    await changeMain($, m => ({ ...m, todos }))
  } else if (tool === T.tools.taskCreate) {
    const made: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'task') : undefined
    const id: unknown = typeof made === 'object' && made !== null ? Reflect.get(made, 'id') : undefined
    if (typeof id === 'string') await changeMain($, m => ({ ...m, todos: todosAfterCreate(m.todos, id) }))
  } else if (tool === T.tools.taskUpdate) {
    const id: unknown = Reflect.get(input, 'taskId')
    if (typeof id === 'string') await changeMain($, m => ({ ...m, todos: todosAfterUpdate(m.todos, id, Reflect.get(input, 'status')) }))
  }
}

/**
 * The desk's to-do list after a successful main-loop call of a tool that keeps it (the desktop plan tool too, which
 * the steps row does not read). TaskCreate's id is the one its result names.
 */
async function deskTodoCall($: EngineInterface, tool: string, input: object, result: unknown) {
  if (!keepsTodos(tool)) return
  const made: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'task') : undefined
  const id: unknown = typeof made === 'object' && made !== null ? Reflect.get(made, 'id') : undefined
  const fields = { ...input } as Record<string, unknown>
  await changeDesk($, s => ({ ...s, todos: todosAfterCall(s.todos, tool, fields, typeof id === 'string' ? id : null) }))
}

/** Switches the pane's view and opens it; the command's reply. */
async function switchView($: EngineInterface, S: Settings, word: string, pacer: Pacer): Promise<string> {
  const view = asViewMode(word)
  if (view === null) return T.deskText.viewUsage
  await changeDesk($, s => ({ ...s, view }))
  await paceOffice($, S, pacer)
  const shown = await showDeck($, S)
  return shown.isPlaced ? fill(T.deskText.viewSet, { view }) : fill(T.deskText.viewHidden, { view, reason: shown.reason })
}

/** The office's frame timer, held by the hooks module: none while nothing in the office moves. */
type Pacer = { timer: Timer | null }

/**
 * Starts the office's frame timer when the office is the view, motion is on and an agent runs; stops it otherwise.
 * Cheap to call from any event: with a timer already running it reads nothing.
 */
async function paceOffice($: EngineInterface, S: Settings, pacer: Pacer) {
  if (pacer.timer !== null) return
  if (!S.motion || T.office.motion === T.office.motionNone) return
  const [desk, cards] = await Promise.all([loadDesk($), loadCards($)])
  if (desk.view !== 'office' || !cards.some(c => c.status === 'running')) return
  pacer.timer = $.clock.every(T.office.frameMs, () => void officeTick($, S, pacer))
}

/**
 * One office frame: each running desk whose state moves gets its picture for the clock's frame, blitted into its
 * mounted Raster. A Raster not mounted (another surface, the pane closed, a desk past the rows shown) refuses the
 * blit, which is fine. With the office gone or nobody running, the timer stops; the next spawn or switch restarts it.
 */
async function officeTick($: EngineInterface, S: Settings, pacer: Pacer) {
  const [desk, cards, gate, now] = await Promise.all([loadDesk($), loadCards($), loadGate($), $.clock.now()])
  if (desk.view !== 'office' || !cards.some(c => c.status === 'running')) {
    pacer.timer?.cancel()
    pacer.timer = null
    return
  }
  const byId = new Map(desk.tallies.map(t => [t.id, t] as const))
  for (const card of cards.slice(0, T.office.maxDesks)) {
    const state = officeStateOf(card, byId.get(card.id), gate)
    if (!isMoving(state, S.motion)) continue
    const cells = deskCells(card.id, state, frameAt(now, frameCount(state)))
    await $.ui.blit({ requestId: PANE, key: rasterKey(card.id), cells }).catch(() => undefined)
  }
}

/**
 * The repository's name and the branch checked out, read without running git: the name from `$.session.repo()`,
 * the branch from the HEAD file of the session's working copy (a worktree's `.git` file points at its own).
 * Anything the host cannot give is left empty, and the row is not drawn.
 */
async function readWorkspace($: EngineInterface) {
  if (!T.features.repo) return
  const repo = await $.session.repo().catch(() => null)
  if (repo === null) return
  const name = repo.name ?? lastFolder(repo.root)
  let branch = ''
  const cwd = await $.session.cwd().catch(() => null)
  if (cwd !== null) {
    const asText = (v: unknown) => (typeof v === 'string' ? v : '')
    const head = asText(await $.fs.read(`${cwd}/.git/HEAD`).catch(() => ''))
    if (head !== '') branch = branchFromHead(head)
    else {
      const pointer = asText(await $.fs.read(`${cwd}/.git`).catch(() => '')).match(/^gitdir:\s*(.+)$/m)
      if (pointer) branch = branchFromHead(asText(await $.fs.read(`${(pointer[1] as string).trim()}/HEAD`).catch(() => '')))
    }
  }
  await changeMain($, m => (m.repo === name && m.branch === branch ? m : { ...m, repo: name, branch }))
}

/** A tool call settled. Returns whether its open ask was settled by it. */
async function callSettled($: EngineInterface, id: string, didRun: boolean): Promise<boolean> {
  const g = await loadGate($)
  if (settleAsk(g, id, didRun) === g) return false
  await changeGate($, x => settleAsk(x, id, didRun))
  return true
}

/** A finished tool call's effect on the turn, the card and the log. */
async function callCounted($: EngineInterface, call: { tool: string; agentId: string | undefined; didRun: boolean; isError: boolean; text: string }) {
  const hasFailed = call.didRun && call.isError
  const isEdit = call.didRun && !hasFailed && isEditTool(call.tool)
  const inSubagent = Boolean(call.agentId)
  const t = await loadTurn($)
  if (isEdit || hasFailed || (!inSubagent && t.errorStreak > 0)) await changeTurn($, x => tallyCall(x, { inSubagent, hasFailed, isEdit }))
  if (call.agentId) await editCard($, call.agentId, c => cardWithCall(c, { tool: call.tool, text: call.text, isError: hasFailed || !call.didRun }))
  // The log keeps what is worth a glance (refusals, errors and edits); the rest is on the cards.
  let entry: { said: string; kind: LogEntry['kind'] } | null = null
  if (!call.didRun) entry = { said: fill(L.callDenied, { text: call.text }), kind: 'error' }
  else if (hasFailed) entry = { said: fill(L.callFailed, { text: call.text }), kind: 'error' }
  else if (isEdit) entry = { said: call.text, kind: 'info' }
  if (entry !== null) await logLine($, await speakerFor($, call.agentId), entry.said, entry.kind, call.agentId ?? null)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const S = settingsFrom(options)
  const C = paletteColors(S.palette)
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const loopOfCall = new Map<string, string | null>()
  const isolationOfCall = new Map<string, unknown>()
  // The office's frame timer: module state, since a hot reload stops the old timer with the old module.
  const pacer: Pacer = { timer: null }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: T.pane.command, description: T.pane.commandDescription, argumentHint: T.pane.argumentHint })
    const resumeWindow = await firstReadings($)
    await readWorkspace($)
    if (S.openOnStart) void showDeck($, S).catch(() => undefined)
    await paintStatus($, S)
    await paceOffice($, S, pacer)
    const result = await next(e)
    if (resumeWindow > 0) {
      await probeCompactWindow($, resumeWindow)
      await paintStatus($, S)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    // No session.start follows a /clear: the deck starts over here.
    const isClear = e.reason === 'clear'
    if (isClear) {
      await wipeDeck($)
      await paintStatus($, S)
    }
    // The process goes on in another conversation, whose first request may find no fill: not a compaction.
    if (isClear || e.reason === 'resume') await changeUsage($, u => ({ ...u, hasFill: false }))
    return next(e)
  })

  on('command.run', { command: T.pane.command }, async ($, e) => {
    const reply = X.command
    const words = e.args.trim().split(/\s+/)
    const verb = words[0] || 'open'
    if (verb === 'close') {
      await hideDeck($)
      return { text: reply.closed }
    }
    if (verb === 'reset') {
      await wipeDeck($)
      await paintStatus($, S)
      return { text: reply.reset }
    }
    if (verb === T.desk.verb) return { text: await switchView($, S, words[1] ?? '', pacer) }
    if (verb === 'layout') {
      const layout = asLayout(words[1] ?? '')
      if (layout === null) return { text: reply.layoutUsage }
      await changeView($, v => ({ ...v, layout }))
      const shown = await showDeck($, S)
      return { text: shown.isPlaced ? fill(reply.layoutSet, { layout }) : fill(reply.layoutHidden, { layout, reason: shown.reason }) }
    }
    await readWorkspace($)
    const shown = await showDeck($, S)
    return { text: shown.isPlaced ? reply.opened : fill(reply.hidden, { reason: shown.reason }) }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await recordMode($, e.permission_mode)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const result = await next(e)
    const isArchitect = S.architect.test(e.agent) || (S.matchDescriptions && S.architect.test(e.description))
    if (isArchitect) {
      await update($, rosterAtom, raw => {
        const r = fixRoster(raw)
        if (r.architectTypes.includes(e.agent)) return r
        return { architectTypes: r.architectTypes.concat(e.agent).slice(-K.architectTypes) }
      })
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn (its spawn, or a resume by SendMessage) is its card's, not the main turn's.
    if (e.agentId === undefined) await mainTurnOpened($, S, e.text)
    // Only where the data asks: a prompt the person typed starts the desk's to-do list over.
    const isTyped = e.agentId === undefined && Boolean(e.text) && openingLine(e.text ?? '').who === X.who.you
    if (isTyped && T.desk.clearTodosOnPrompt) await changeDesk($, s => ({ ...s, todos: [] }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const id = e.agentId
      await beforeAgentRequest($, S, id)
      // A resumed agent runs again: the office moves again.
      await paceOffice($, S, pacer)
      const answer = yield* next(e)
      await afterAgentRequest($, id, e.model, answer.usage, answer.stopReason ?? null)
      const used = requestTokens(answer.usage as Partial<Record<string, number>> | null | undefined)
      if (used > 0) await changeDesk($, s => ({ ...s, tallies: tokensAdded(s.tallies, id, used) }))
      return answer
    }
    const hadFill = await beforeMainRequest($, e.model, e.effort)
    // Time the response as it passes: its first piece that is neither the engine's envelope nor the stop.
    const askedAt = await $.clock.now()
    let firstPieceAt: number | null = null
    const pieces = next(e)
    for await (const piece of pieces) {
      if (firstPieceAt === null && piece.kind !== 'engine' && piece.kind !== 'stop') firstPieceAt = await $.clock.now()
      yield piece
    }
    const answer = await pieces.result
    await afterMainRequest($, Boolean(answer.usage), askedAt, firstPieceAt, hadFill)
    return answer
  })

  on('session.measure', async ($, e, next) => {
    // The compaction window is read once per model window, claimed in the same write so no two reads overlap.
    let readWindow = false
    await changeUsage($, u => {
      const claim = claimWindowRead(u, e.context.window)
      readWindow = claim.isClaimed
      return { ...claim.usage, ...measuredFields(e) }
    })
    if (e.changed.includes('context')) await paintStatus($, S)
    const result = await next(e)
    if (readWindow) {
      await probeCompactWindow($, e.context.window)
      await paintStatus($, S)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    // Any compaction reaching here, a subagent's or a precompute too, shows nothing keeps the event from us.
    if (!(await loadUsage($)).isCompactHooked) await changeUsage($, compactHooked)
    const result = await next(e)
    // A skip is a veto (a plugin, a blocking PreCompact hook): the conversation stays as it was.
    const counts = !result.skip && !e.agentId && e.trigger !== 'precompute'
    if (counts) {
      const compactedAt = await $.clock.now()
      await changeUsage($, u => ({ ...u, lastCompactAt: compactedAt, compactions: u.compactions + 1 }))
      await logLine($, X.who.main, fill(L.compacted, { trigger: e.trigger }))
    }
    return result
  })

  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    if (!e.tool_use_id) return decided
    const check: Check = {
      id: e.tool_use_id,
      tool: e.tool,
      bucket: familyOf(e.tool),
      verdict: decided.decision === 'allow' ? 'rule' : decided.decision,
      inSubagent: Boolean(loopOfCall.get(e.tool_use_id)),
      detail: clip(callSummary(e.tool, e.input), Z.detailChars),
      at: await $.clock.now(),
    }
    await changeGate($, g => addCheck(g, check))
    // The status line changes when the call settles; only a refusal ends here.
    if (check.verdict === 'deny') {
      await logLine($, X.who.gate, fill(L.deniedByRule, { detail: check.detail }), 'error')
      await paintStatus($, S)
    }
    return decided
  })

  on('tool.call', async ($, e, next) => {
    loopOfCall.set(e.tool_use_id, e.agentId ?? null)
    // agent.spawn does not carry the Agent call's isolation: it is kept by the call's id until the spawn takes it.
    // A call whose spawn never comes (refused) leaves its entry; the oldest go past the data's `isolationCalls`.
    if (e.tool === T.agentTool) {
      isolationOfCall.set(e.tool_use_id, Reflect.get(e, 'isolation'))
      for (const old of isolationOfCall.keys()) if (isolationOfCall.size > K.isolationCalls) isolationOfCall.delete(old)
    }
    // The desk counts a subagent's call as it starts, and shows it running until it settles.
    const caller = e.agentId
    if (caller) await changeDesk($, s => ({ ...s, tallies: callStarted(s.tallies, caller, { id: e.tool_use_id, tool: String(e.tool) }) }))
    // The permission check is decided beneath this hook, inside next: its ask is settled after.
    const outcome = await next(e).finally(() => loopOfCall.delete(e.tool_use_id))
    if (caller) await changeDesk($, s => ({ ...s, tallies: callEnded(s.tallies, caller, e.tool_use_id) }))
    const didRun = outcome.deny === undefined
    const settled = await callSettled($, e.tool_use_id, didRun)
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === T.handbackTool) {
      const report: unknown = Reflect.get(e, 'message')
      if (e.agentId && typeof report === 'string') {
        const a = await loadArchitect($)
        if (a.ids.includes(e.agentId)) await takeAdvice($, S, a, report)
      }
      return outcome
    }
    if (!e.agentId && didRun && outcome.isError !== true) {
      await taskListCall($, e.tool, e, Reflect.get(outcome, 'result'))
      await deskTodoCall($, String(e.tool), e, Reflect.get(outcome, 'result'))
    }
    if (e.tool !== T.agentTool) {
      await callCounted($, { tool: e.tool, agentId: e.agentId, didRun, isError: outcome.isError === true, text: clip(callSummary(e.tool, e), Z.callChars) })
      if (!didRun) {
        await paintStatus($, S)
        return outcome
      }
    }
    if (settled) await paintStatus($, S)
    return outcome
  })

  // A server-side tool (Claude Code's advisor) never reaches tool.call; it shows only in the assistant's response
  // rows. Other doors are left alone: a managed guard keeps them from user plugins.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId || e.message.type !== 'assistant') return next(e)
    const before = await loadArchitect($)
    // Consults this row opened: their result may be in the same row, after the load above.
    const openedHere = new Set<string>()
    for (const block of e.message.content as unknown as readonly Block[]) {
      const isAdvisor = block.type === 'server_tool_use' && block.name && block.id && S.architect.test(block.name)
      if (isAdvisor && block.id && block.name) {
        if (before.seen.includes(block.id)) continue
        const id = block.id
        await changeArchitect($, a => ({ ...a, seen: a.seen.concat(id).slice(-K.seenTools) }))
        openedHere.add(id)
        await beginConsult($, S, id, fill(L.viaTool, { name: block.name }))
        continue
      }
      const resultOf = block.type.endsWith('_tool_result') ? block.tool_use_id : undefined
      if (!resultOf) continue
      const stillOpen = openedHere.has(resultOf) || (await loadArchitect($)).consults.some(c => c.endAt === null && c.id === resultOf)
      if (stillOpen) await finishConsult($, S, null, resultOf)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!e.parentAgentId) await recordMode($, e.permissionMode)
    if (spawned.deny === undefined && spawned.agentId) {
      const isolated = isolationOfCall.get(e.tool_use_id) === 'worktree'
      isolationOfCall.delete(e.tool_use_id)
      const worktree = isolated ? (e.cwd ? lastFolder(e.cwd) : '') : null
      await agentSpawned($, S, spawned.agentId, { type: e.subagentType, name: e.name, model: spawned.model, description: e.description, worktree })
      await paceOffice($, S, pacer)
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const finishedAt = await $.clock.now()
    if (e.agentId) {
      const ended = e.agentId
      await agentFinished($, S, ended, { reason: e.reason, answer: e.answer, durationMs: e.durationMs, now: finishedAt })
      await changeDesk($, s => ({ ...s, tallies: agentStopped(s.tallies, ended) }))
    }
    else await mainTurnFinished($, S, e.durationMs, e.reason)
    return result
  })

  // ---------------------------------------------------------------- drawing

  // A surface module that faulted on a surface is drawn there as plain text from then on; the other module and the
  // other surfaces keep theirs. Keyed by faultId: `desktop:rail.tsx`.
  const brokenModules = new Set<string>()
  on('ui.fault', async ($, e, next) => {
    const id = faultId(e.surface, e.module)
    if (e.requestId === PANE && !brokenModules.has(id)) {
      brokenModules.add(id)
      $.ui.log(fill(X.fault, { module: e.module, surface: e.surface, phase: e.phase, reason: e.reason }))
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Text's `mono` is refused by an engine older than the data's `monoSince`: the connectors ask for it only where
  // the engine says it is that new. Read once per load.
  let monoAnswer: Promise<boolean> | null = null

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const canAnimate = 'Client' in table
    const railOk = canAnimate && !brokenModules.has(faultId(e.surface, 'rail.tsx'))
    const clockOk = canAnimate && !brokenModules.has(faultId(e.surface, 'elapsed.tsx'))
    monoAnswer ??= engineHasMono($)
    const [snap, mono, desk] = await Promise.all([loadAll($), monoAnswer, loadDesk($)])
    const width = Math.max(T.pane.minColumns, e.props.bodyColumns)
    const isInline = e.props.placement === 'inline'
    const timer = (key: string, since: number, endAt: number | null, color: string) => {
      // A start of 0 is unknown (state saved before it was kept): no clock rather than decades.
      if (since <= 0) return <table.Text color={color}>{T.glyphs.dash}</table.Text>
      if (clockOk && 'Client' in table) {
        return <table.Client key={key} module="./elapsed.tsx" props={{ since, endAt, color, now: snap.now, tickMs: T.timing.clockTickMs }} />
      }
      return <table.Text color={color}>{stopwatch((endAt ?? snap.now) - since)}</table.Text>
    }
    if (desk.view === 'office') {
      return drawOffice({
        els: table,
        surface: e.surface,
        width,
        isInline,
        settings: S,
        colors: C,
        cards: snap.cards,
        desk,
        gate: snap.gate,
        now: snap.now,
        motionOn: S.motion,
        timer,
        toDeck: () => changeDesk($, s => ({ ...s, view: 'deck' })),
        close: () => hideDeck($),
      })
    }
    if (desk.view === 'desk') {
      return drawDesk({
        els: table,
        width,
        isInline,
        settings: S,
        colors: C,
        cards: snap.cards,
        desk,
        timer,
        toDeck: () => changeDesk($, s => ({ ...s, view: 'deck' })),
        close: () => hideDeck($),
      })
    }
    const G = T.glyphs
    const monoProp = mono ? { mono: true } : {}
    const moving = S.motion && railOk
    return drawDeck({
      ...snap,
      els: table,
      surface: e.surface,
      width,
      isInline,
      bodyRows: e.props.scroll?.bodyRows ?? e.viewport?.rows ?? Z.bodyRowsFallback,
      viewed: e.props.view?.agentId ?? null,
      settings: S,
      colors: C,
      connector: (key, active, color, width, marks = [], isMerge = false) => {
        if (!moving || !('Client' in table)) {
          return (
            <table.Text {...monoProp} color={C.faint}>
              {G.rail.repeat(Math.max(1, width))}
            </table.Text>
          )
        }
        const railProps = {
          active,
          width,
          color,
          marks,
          isMerge,
          mono,
          dim: C.faint,
          glyphs: { line: G.rail, branch: G.branch, merge: G.merge, head: G.packetHead, tail: G.packetTail },
          stepMs: T.timing.railStepMs,
          spacing: T.rail.packetSpacing,
          spare: T.rail.spare,
        }
        return <table.Client key={key} module="./rail.tsx" height={1} width={width} props={railProps} />
      },
      timer,
      toggleCard: id => () => changeView($, v => ({ ...v, expanded: v.expanded === id ? null : id })),
      toggleFamily: f => () => changeView($, v => ({ ...v, gateOpen: v.gateOpen === f ? null : f })),
      close: () => hideDeck($),
    })
  }).catch(($, e, next) => {
    // Without this a failed draw leaves the engine's empty pane.
    const table = $.ui.resolve(e)
    const why = fill(X.drawFailed, { kind: next.error.kind, message: next.error.message ?? X.noMessage })
    return (
      <table.Box width={Math.max(T.pane.fallbackMinColumns, e.props.bodyColumns)} flexDirection="column">
        <table.Text bold>{X.brand}</table.Text>
        <table.Text wrap="wrap" color={C.warn}>
          {why}
        </table.Text>
      </table.Box>
    )
  })
}
