//! The helper desk's rules: its stored record and that record's repair, the main loop's to-do list kept with its
//! words (TodoWrite, TaskCreate, TaskUpdate and the desktop app's plan tool), the progress the bar draws, and the
//! per-agent tallies the desk adds to a card (tool calls, the calls running now, tokens) with each agent's share.
//!
//! The desk is a second view of the same pane (DESIGN.md, additions). It reads the cards the deck keeps for
//! status, name, type, steps, context and clock, and keeps only what no card holds. No `$`: the hooks module and
//! the tests both call these.

import { tuning as T } from '../data/agent-roster'
import type { AgentTally, Card, DeskState, DeskTodo, LiveCall, TodoState, ViewMode } from '../types'
import { isRecord } from './records'

const H = T.desk

/**
 * The desk record's shape tag. Structural, and apart from the deck's `STORE_SHAPE` so adding the desk did not
 * retire the deck's stored records. Change it when `DeskState` changes shape.
 */
export const DESK_SHAPE = 'agent-roster-desk-1'

/** The three views. Structural: the `ViewMode` union. */
const VIEWS: readonly ViewMode[] = ['deck', 'desk', 'office']
/** The three to-do states. Structural: the `TodoState` union, as the task tools spell them. */
const TODO_STATES: readonly TodoState[] = ['pending', 'in_progress', 'completed']
/** The status TaskUpdate gives a task it removes. Structural: the tool's own word. */
const REMOVED = 'deleted'

/** The deck, an empty list, no tallies. */
export const blankDesk: DeskState = { view: 'deck', todos: [], tallies: [] }

// ---------------------------------------------------------------- repair

/** A text field as stored, or '' when it is not text. */
function textField(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A count as stored, or 0 when it is not a finite number at or above zero. */
function countField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** A to-do state from any word, pending when it names none. */
export function asTodoState(v: unknown): TodoState {
  return TODO_STATES.find(s => s === v) ?? 'pending'
}

/** A view from a word, or null when the word names none. */
export function asViewMode(word: unknown): ViewMode | null {
  return VIEWS.find(v => v === word) ?? null
}

/** The records of a stored list, each rebuilt by `rebuild`; anything that is not a list is no records. */
function rebuiltList<R>(raw: unknown, rebuild: (r: Record<string, unknown>) => R | null): R[] {
  if (!Array.isArray(raw)) return []
  const kept: R[] = []
  for (const one of raw) {
    const r = isRecord(one) ? rebuild(one) : null
    if (r !== null) kept.push(r)
  }
  return kept
}

/** One stored tally, or null for one with no id. */
function tallyFrom(r: Record<string, unknown>): AgentTally | null {
  const id = textField(r.id)
  if (id === '') return null
  const live = rebuiltList<LiveCall>(r.live, c => (typeof c.id === 'string' && typeof c.tool === 'string' ? { id: c.id, tool: c.tool } : null))
  return { id, calls: countField(r.calls), tokens: countField(r.tokens), live, last: textField(r.last) }
}

/** The desk record as stored, rebuilt field by field so nothing broken reaches a draw. */
export function fixDesk(raw: unknown): DeskState {
  if (!isRecord(raw)) return blankDesk
  return {
    view: asViewMode(raw.view) ?? 'deck',
    todos: rebuiltList<DeskTodo>(raw.todos, t => ({ id: textField(t.id), text: textField(t.text), state: asTodoState(t.state) })),
    tallies: rebuiltList(raw.tallies, tallyFrom),
  }
}

// ---------------------------------------------------------------- the to-do list

/** Whether a tool keeps the to-do list: one of the task tools, or the desktop plan tool by its name's end. */
export function keepsTodos(tool: string): boolean {
  const named = [T.tools.todoWrite, T.tools.taskCreate, T.tools.taskUpdate]
  return named.includes(tool) || isPlanTool(tool)
}

/** Whether a tool is the desktop app's plan tool. */
export function isPlanTool(tool: string): boolean {
  return new RegExp(H.planTool).test(tool)
}

/** A list written whole (TodoWrite's `todos`, the plan tool's `items`); anything not a list writes an empty one. */
function wholeList(items: unknown): DeskTodo[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, H.todos).map((item, at) => {
    const r = isRecord(item) ? item : {}
    return { id: String(at), text: textField(r.content), state: asTodoState(r.status) }
  })
}

/** Index of a 1-based item number in `list`, or -1 when it is not one. */
function itemAt(list: DeskTodo[], n: unknown): number {
  const at = typeof n === 'number' && Number.isInteger(n) ? n - 1 : -1
  return at >= 0 && at < list.length ? at : -1
}

/** The list with item `at` set to `state`; a completed item does not go back to in progress. */
function withState(list: DeskTodo[], at: number, state: TodoState): DeskTodo[] {
  return list.map((t, i) => (i !== at || (state === 'in_progress' && t.state === 'completed') ? t : { ...t, state }))
}

/**
 * The plan tool's step: a list of `items` replaces the plan; otherwise `done` (item numbers) completes items,
 * `start` (an item number) starts one, and `advance` completes the item in progress and starts the next pending.
 */
function planStep(list: DeskTodo[], input: Record<string, unknown>): DeskTodo[] {
  if (Array.isArray(input.items)) return wholeList(input.items)
  let out = list
  if (Array.isArray(input.done)) for (const n of input.done) out = withState(out, itemAt(out, n), 'completed')
  if (input.start !== undefined) out = withState(out, itemAt(out, input.start), 'in_progress')
  const movesOn = input.advance === true
  if (movesOn) {
    out = withState(out, out.findIndex(t => t.state === 'in_progress'), 'completed')
    out = withState(out, out.findIndex(t => t.state === 'pending'), 'in_progress')
  }
  return out
}

/**
 * The to-do list after one successful main-loop call of a tool that keeps it. `made` is the id TaskCreate's result
 * names; without one the task is numbered by its place. Calls of any other tool leave the list.
 */
export function todosAfterCall(list: DeskTodo[], tool: string, input: Record<string, unknown>, made: string | null): DeskTodo[] {
  if (tool === T.tools.todoWrite) return wholeList(input.todos)
  if (tool === T.tools.taskCreate) {
    const id = made ?? String(list.length + 1)
    if (list.some(t => t.id === id) || list.length >= H.todos) return list
    return list.concat({ id, text: textField(input.subject), state: 'pending' })
  }
  if (tool === T.tools.taskUpdate) {
    const id = textField(input.taskId)
    if (input.status === REMOVED) return list.filter(t => t.id !== id)
    const subject = textField(input.subject)
    return list.map(t => (t.id !== id ? t : { ...t, text: subject || t.text, state: input.status === undefined ? t.state : asTodoState(input.status) }))
  }
  if (isPlanTool(tool)) return planStep(list, input)
  return list
}

/** What the bar draws: done of total and the item at hand. Null when there is no list, or every item is done. */
export function progressOf(list: DeskTodo[]): { done: number; total: number; current: DeskTodo | null } | null {
  const done = list.filter(t => t.state === 'completed').length
  if (list.length === 0 || done === list.length) return null
  const current = list.find(t => t.state === 'in_progress') ?? list.find(t => t.state === 'pending') ?? null
  return { done, total: list.length, current }
}

/** The to-do bar's width for a body `width` cells wide: the body less the reserve, held to the data's bounds. */
export function todoBarCells(width: number): number {
  return Math.min(H.todoMax, Math.max(H.todoMin, width - H.todoReserve))
}

/** The share bar's width for a body `width` cells wide: full where it fits beside its words, never below the minimum. */
export function shareBarCells(width: number): number {
  return Math.max(H.shareMin, Math.min(H.shareCells, width - H.shareReserve))
}

/** A bar `cellCount` cells wide, lit in proportion to `part` of `whole`; an empty whole lights nothing. */
export function barOf(part: number, whole: number, cellCount: number, on: string, off: string): { on: string; off: string } {
  const ratio = whole > 0 && Number.isFinite(part) ? Math.min(1, Math.max(0, part / whole)) : 0
  const lit = Math.round(ratio * cellCount)
  return { on: on.repeat(lit), off: off.repeat(cellCount - lit) }
}

// ---------------------------------------------------------------- tallies

/** The tallies with agent `id`'s changed by `f`, a fresh one made for an agent not yet tallied, the oldest dropped. */
function retally(tallies: AgentTally[], id: string, f: (t: AgentTally) => AgentTally): AgentTally[] {
  const at = tallies.findIndex(t => t.id === id)
  if (at >= 0) return tallies.map((t, i) => (i === at ? f(t) : t))
  return tallies.concat(f({ id, calls: 0, tokens: 0, live: [], last: '' })).slice(-H.tallies)
}

/** An agent started a tool call: one more call, its last tool, and the call running until it settles. */
export function callStarted(tallies: AgentTally[], id: string, call: LiveCall): AgentTally[] {
  return retally(tallies, id, t => ({ ...t, calls: t.calls + 1, last: call.tool, live: t.live.filter(c => c.id !== call.id).concat(call).slice(-H.liveCalls) }))
}

/** An agent's tool call settled, ran or not: it is no longer running. An agent with no tally is left alone. */
export function callEnded(tallies: AgentTally[], id: string, callId: string): AgentTally[] {
  return tallies.map(t => (t.id !== id ? t : { ...t, live: t.live.filter(c => c.id !== callId) }))
}

/** An agent's turn ended: none of its calls is running any longer. */
export function agentStopped(tallies: AgentTally[], id: string): AgentTally[] {
  return tallies.map(t => (t.id === id && t.live.length > 0 ? { ...t, live: [] } : t))
}

/** The tokens one request used: every input part and the output; parts the usage leaves out count nothing. */
export function requestTokens(usage: Partial<Record<string, number>> | null | undefined): number {
  if (!usage) return 0
  let sum = 0
  for (const part of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
    const n = usage[part]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) sum += n
  }
  return sum
}

/** An agent's request came back: its tokens added to its tally. */
export function tokensAdded(tallies: AgentTally[], id: string, tokens: number): AgentTally[] {
  if (tokens <= 0) return tallies
  return retally(tallies, id, t => ({ ...t, tokens: t.tokens + tokens }))
}

/** One row of the desk: an agent's card, its tally (zeros when it has none) and its share of the agents' tokens. */
export type DeskRow = { card: Card; calls: number; tokens: number; pct: number; now: string | null; last: string | null }

/**
 * The desk's rows, newest agent first: each card with its tally. The share is of the tokens every listed agent used;
 * whole percents, so a share under one half reads 0. The tool running now is the latest call still live; the last
 * tool is the one it started last, so a call cut off by the agent's end still names it.
 */
export function deskRows(cards: Card[], tallies: AgentTally[]): DeskRow[] {
  const byId = new Map(tallies.map(t => [t.id, t] as const))
  const sum = cards.reduce((n, c) => n + (byId.get(c.id)?.tokens ?? 0), 0)
  return cards
    .slice()
    .reverse()
    .map(card => {
      const t = byId.get(card.id)
      const tokens = t?.tokens ?? 0
      const latest = t?.live[t.live.length - 1]
      return {
        card,
        calls: t?.calls ?? 0,
        tokens,
        pct: sum > 0 ? Math.round((100 * tokens) / sum) : 0,
        now: card.status === 'running' && latest ? latest.tool : null,
        last: t && t.last !== '' ? t.last : null,
      }
    })
}
