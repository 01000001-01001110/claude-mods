//! The bookkeeping the hooks apply to events, as pure functions over the records: the context gauge and the
//! compaction count, the permission gate's tallies, the main turn, the architect's consults, agent cards and the
//! loops no card claims. Each takes a record and returns the next one; none touches `$`.

import { tuning as T } from '../data/agent-roster'
import type { ArchitectLog, CallNote, Card, Check, GateLog, MomentId, OtherLoop, Receipt, Tally, TodoItem, TurnTally, Usage, Verdict } from '../types'
import { FAMILIES, VERDICTS, zeroTally } from './records'

// ---------------------------------------------------------------- context and compactions

/** What a `summary` usage breakdown says about compaction, as far as the gauge needs it. */
export type Breakdown = { rawMaxTokens: number; isAutoCompactEnabled: boolean } | null | undefined

/** The compaction window a breakdown names: only with auto-compaction on, and only when below the model's window. */
export function compactionWindow(b: Breakdown, window: number): number | null {
  if (!b || !b.isAutoCompactEnabled) return null
  const limit = b.rawMaxTokens
  return limit > 0 && limit < window ? limit : null
}

/**
 * The window the gauge measures against (the compaction window when it is the smaller, else the model's) and the
 * fill of it from the real token reading. No fill without a reading or without a window.
 */
export function gaugeBasis(u: Pick<Usage, 'tokens' | 'window' | 'compactWindow'>): { pct: number | null; window: number } {
  const cw = u.compactWindow
  const basis = cw !== null && cw > 0 && cw < u.window ? cw : u.window
  if (u.tokens === null || !(basis > 0)) return { pct: null, window: basis }
  return { pct: (100 * u.tokens) / basis, window: basis }
}

/**
 * At a measurement under model window `window`: whether this measurement should read the compaction window (not
 * read for this window yet, fewer misses than the data allows), with that claim written into the usage so no
 * second read starts. A window other than the last one starts its misses afresh.
 */
export function claimWindowRead(u: Usage, window: number): { usage: Usage; isClaimed: boolean } {
  const misses = window === u.window ? u.compactMisses : 0
  const claim = window > 0 && window !== u.compactFor && misses < T.timing.compactTries
  const next: Usage = { ...u, compactMisses: misses }
  if (claim) next.compactFor = window
  return { usage: next, isClaimed: claim }
}

/**
 * The usage once a compaction-window read for `window` came back. A read that a newer claim replaced (the model
 * changed while it ran) changes nothing; one that failed or had no breakdown counts a miss and frees the claim, so
 * the next measurement asks again.
 */
export function afterWindowRead(u: Usage, window: number, b: Breakdown): Usage {
  if (window !== u.compactFor) return u
  if (!b) return { ...u, compactFor: 0, compactWindow: null, compactMisses: u.compactMisses + 1 }
  return { ...u, compactMisses: 0, compactWindow: compactionWindow(b, window) }
}

/** The main loop moved to another model, which may compact in another window: forget the reading. */
export function forgetWindowRead(u: Usage): Usage {
  return { ...u, compactFor: 0, compactMisses: 0, compactWindow: null }
}

/**
 * A main-loop request about to go out, and whether the host reports a context fill for it. The host reports none
 * until the first response after a new session, a /clear or a compaction; so a request that finds no fill after a
 * response came back follows a compaction. It is counted as an estimate until session.compact reaches this
 * plugin, whose count then takes over. The usage comes back as the same object when nothing changed.
 */
export function atRequest(u: Usage, isReported: boolean, now: number): { usage: Usage; isCompaction: boolean } {
  if (isReported) return { usage: u.hasFill ? u : { ...u, hasFill: true }, isCompaction: false }
  // Nothing was there to lose: still waiting for the first response.
  if (u.hasFill === false) return { isCompaction: false, usage: u }
  const emptied: Usage = { ...u, hasFill: false }
  if (u.isCompactHooked) return { usage: emptied, isCompaction: false }
  emptied.compactions = u.compactions + 1
  emptied.lastCompactAt = now
  emptied.isCompactEstimate = true
  return { usage: emptied, isCompaction: true }
}

/** A main-loop response came back: the context has a fill until the next compaction. */
export function atResponse(u: Usage): Usage {
  if (u.hasFill) return u
  return { ...u, hasFill: true }
}

/**
 * session.compact has reached this plugin: every later compaction will too, so a count estimated before it (a
 * rewind to the first prompt reads the same as a compaction) is dropped.
 */
export function compactHooked(u: Usage): Usage {
  if (u.isCompactHooked) return u
  const next: Usage = { ...u, isCompactHooked: true }
  if (u.isCompactEstimate) {
    next.compactions = 0
    next.lastCompactAt = null
    next.isCompactEstimate = false
  }
  return next
}

/** The compaction badge, `⟲2`, or `⟲~2` while estimated; empty before the first compaction. */
export function compactBadge(u: Pick<Usage, 'compactions' | 'isCompactEstimate'>): string {
  if (!(u.compactions > 0)) return ''
  const mark = u.isCompactEstimate ? T.text.estimateMark : ''
  return T.glyphs.compaction + mark + String(u.compactions)
}

// ---------------------------------------------------------------- the gate

/** The newest `max` checks, never dropping an open ask: the call that settles it must still find it. */
export function keepRecent(list: Check[], max: number): Check[] {
  if (list.length <= max) return list
  let toDrop = list.length - max
  const kept = list.filter(c => {
    if (toDrop === 0 || c.verdict === 'ask') return true
    toDrop -= 1
    return false
  })
  // Open asks alone could still pile up; a hard cap keeps the list bounded.
  return kept.slice(-2 * max)
}

/** `t` with one more `v`. */
function bump(t: Tally, v: Verdict, by = 1): Tally {
  const out = { ...t }
  out[v] = Math.max(0, out[v] + by)
  return out
}

/** The gate with one more check counted and kept. */
export function addCheck(g: GateLog, c: Check): GateLog {
  const totals = { ...g.totals }
  totals[c.bucket] = bump(g.totals[c.bucket], c.verdict)
  return { recent: keepRecent(g.recent.concat(c), T.keep.gateChecks), totals }
}

/** An open ask settled by its call: cleared when the call ran, deny when refused. The same object when none is open. */
export function settleAsk(g: GateLog, id: string, didRun: boolean): GateLog {
  const at = g.recent.findIndex(c => c.verdict === 'ask' && c.id === id)
  if (at < 0) return g
  const asked = g.recent[at] as Check
  const outcome: Verdict = didRun ? 'cleared' : 'deny'
  const recent = g.recent.slice()
  recent[at] = { ...asked, verdict: outcome }
  const totals = { ...g.totals }
  totals[asked.bucket] = bump(bump(g.totals[asked.bucket], 'ask', -1), outcome)
  return { recent, totals }
}

/** The totals over every family, and their sum. */
export function gateTotals(g: GateLog): Tally & { total: number } {
  const sum: Tally = { ...zeroTally }
  for (const f of FAMILIES) for (const v of VERDICTS) sum[v] += g.totals[f][v]
  let total = 0
  for (const v of VERDICTS) total += sum[v]
  return { ...sum, total }
}

// ---------------------------------------------------------------- the turn and the architect

/**
 * The turn after one tool call. Errors and the error streak belong to the main loop (a subagent's failure is its
 * own); edits count from every loop, so delegated work still reaches "before done".
 */
export function tallyCall(t: TurnTally, call: { inSubagent: boolean; hasFailed: boolean; isEdit: boolean }): TurnTally {
  const edits = call.isEdit ? t.edits + 1 : t.edits
  if (call.inSubagent) return { ...t, edits }
  if (!call.hasFailed) return { ...t, edits, errorStreak: 0 }
  return { ...t, edits, errors: t.errors + 1, errorStreak: t.errorStreak + 1 }
}

/** Which moment a consult falls at, inferred from the turn so far. */
export function momentNow(t: Pick<TurnTally, 'edits' | 'errorStreak'>): MomentId {
  if (t.errorStreak >= T.sizes.errorRepeats) return 'repeat'
  if (t.edits > 0) return 'done'
  return 'plan'
}

/** The architect with a consult opened; an id it already knows is left as it is. */
export function openConsult(a: ArchitectLog, c: { id: string; at: number; moment: MomentId; via: string }): ArchitectLog {
  if (a.consults.findIndex(x => x.id === c.id) >= 0) return a
  const consults = a.consults.concat({ ...c, endAt: null })
  return { ...a, consults: consults.slice(-T.keep.consults) }
}

/** Closes the named consult, or the latest still open; advice, when given, becomes the last advice. */
export function closeConsult(a: ArchitectLog, at: number, advice: string | null, id?: string): ArchitectLog {
  let target = -1
  for (let i = a.consults.length - 1; i >= 0 && target < 0; i -= 1) {
    const c = a.consults[i]
    if (c && c.endAt === null && (id === undefined || id === c.id)) target = i
  }
  const consults = a.consults.map((c, i) => (i === target ? { ...c, endAt: at } : c))
  return { ...a, consults, lastAdvice: advice === null ? a.lastAdvice : advice }
}

/** Whether any consult is open. */
export function isConsulting(a: ArchitectLog): boolean {
  return a.consults.findIndex(c => c.endAt === null) >= 0
}

/** The consults on one row of `width` cells, first consult to now: a mark where each began, a heavy run while it ran. */
export function consultTrack(a: ArchitectLog, now: number, width: number): string {
  const G = T.glyphs
  const first = a.consults[0]
  // Under four cells a track has no room to say anything: a plain rule.
  if (first === undefined || width < 4) return G.consultIdle.repeat(Math.max(0, width))
  const last = width - 1
  const span = Math.max(1, now - first.at)
  const cellOf = (t: number) => Math.min(last, Math.floor(((t - first.at) / span) * last))
  const track: string[] = Array.from({ length: width }, () => G.consultIdle)
  a.consults.forEach(c => {
    const begin = cellOf(c.at)
    const end = cellOf(c.endAt ?? now)
    for (let k = begin + 1; k <= end; k += 1) track[k] = G.consultRun
    track[begin] = G.consult
  })
  return track.join('')
}

/** The receipt of a finished main turn. A cost added below the data's `costDeltaMin` is not shown. */
export function receiptFor(t: TurnTally, end: { durationMs: number; agentsSince: number; costAtEnd: number | null; reason: string }): Receipt {
  let costDelta: number | null = null
  if (end.costAtEnd !== null && t.costAtStart !== null) {
    const added = end.costAtEnd - t.costAtStart
    if (added >= T.sizes.costDeltaMin) costDelta = added
  }
  return { durationMs: end.durationMs, agents: end.agentsSince, edits: t.edits, errors: t.errors, costDelta, reason: end.reason }
}

// ---------------------------------------------------------------- agents and loops

/** The usage a model request reports, as far as a card needs it. */
export type RequestUsage = Partial<Record<'input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens', number>> | null

/** A card after one model request: its context is that request's whole input; its output adds up. */
export function cardAfterStep(c: Card, s: { model: string; usage: RequestUsage; stopReason: string | null }): Card {
  const u = s.usage ?? {}
  const produced = u.output_tokens ?? 0
  let whole = 0
  for (const part of [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]) whole += part ?? 0
  return {
    ...c,
    steps: c.steps + 1,
    ctx: whole > 0 ? whole : c.ctx,
    out: c.out + produced,
    model: c.model ? c.model : s.model,
    lastStop: s.stopReason,
  }
}

/** A card with one more tool call, keeping the data's `cardTools` newest. */
export function cardWithCall(c: Card, call: CallNote): Card {
  return { ...c, tools: c.tools.concat(call).slice(-T.keep.cardTools) }
}

/** A card running again after it finished (resumed by SendMessage); its clock still counts from its first spawn. */
export function runAgain(c: Card): Card {
  return { ...c, endedAt: null, status: 'running' }
}

/**
 * The cards with a spawned one placed. An id already there is that agent resumed: its card runs again where it
 * stands, keeping its tallies, with the new task and model, so no two cards share an id.
 */
export function placeCard(cards: Card[], card: Card): Card[] {
  if (cards.findIndex(c => c.id === card.id) < 0) return cards.concat(card).slice(-T.keep.cards)
  return cards.map(c => {
    if (c.id !== card.id) return c
    return runAgain({ ...c, model: card.model || c.model, description: card.description || c.description })
  })
}

/** One more step of a loop no card claims. */
export function loopStep(loops: OtherLoop[], id: string, at: number): OtherLoop[] {
  const found = loops.findIndex(l => l.id === id)
  const fresh: OtherLoop = { id, firstAt: at, lastAt: at, steps: 1, isDone: false }
  const next = found < 0 ? loops.concat(fresh) : loops.map((l, i) => (i === found ? { ...l, lastAt: at, steps: l.steps + 1 } : l))
  return next.slice(-T.keep.loops)
}

/** Whether a loop is still going: not finished, and a step within the data's `loopActiveMs`. */
export function loopIsLive(l: OtherLoop, now: number): boolean {
  if (l.isDone) return false
  return now - l.lastAt < T.timing.loopActiveMs
}

/** Each card's bar on one shared axis of `width` cells, first spawn to now: the cells before, in and after its bar. */
export function laneCells(cards: Card[], now: number, width: number): { id: string; before: number; bar: number; after: number }[] {
  const starts = cards.map(c => c.spawnedAt).filter(t => t > 0)
  const origin = Math.min(now, ...starts)
  const span = Math.max(1, now - origin)
  const toCell = (t: number) => ((t - origin) / span) * width
  return cards.map(c => {
    const begin = Math.floor(toCell(Math.max(c.spawnedAt, origin)))
    const end = Math.max(begin + 1, Math.ceil(toCell(c.endedAt ?? now)))
    const before = Math.min(begin, width)
    const through = Math.min(end, width)
    return { id: c.id, before, bar: through - before, after: width - through }
  })
}

// ---------------------------------------------------------------- the main loop's task list

/** The list a TodoWrite call wrote, whole: one item per todo, done when completed. */
export function todosFromWrite(todos: unknown): TodoItem[] {
  if (!Array.isArray(todos)) return []
  return todos.map((t, i) => ({ id: String(i), isDone: typeof t === 'object' && t !== null && (t as { status?: unknown }).status === 'completed' }))
}

/** The list with a task TaskCreate made, open; an id already there is left as it is. */
export function todosAfterCreate(list: TodoItem[], id: string): TodoItem[] {
  if (id === '' || list.some(t => t.id === id)) return list
  return list.concat({ id, isDone: false })
}

/** The list after TaskUpdate set a task's status: deleted leaves the list, completed is done, any other is open. */
export function todosAfterUpdate(list: TodoItem[], id: string, status: unknown): TodoItem[] {
  if (typeof status !== 'string') return list
  if (status === 'deleted') return list.filter(t => t.id !== id)
  return list.map(t => (t.id === id ? { ...t, isDone: status === 'completed' } : t))
}

/** Done and total for the steps row; null for an empty list, which draws no row. */
export function stepsOf(list: TodoItem[]): { done: number; total: number } | null {
  if (list.length === 0) return null
  return { done: list.filter(t => t.isDone).length, total: list.length }
}
