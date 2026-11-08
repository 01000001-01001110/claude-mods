//! The helper desk's tests (DESIGN.md, additions). Expectations are computed from the shipped data (`T.desk`,
//! `T.deskText`), so a re-tune does not break them and a broken data file does. The rules are tested on plain values,
//! every threshold at its boundaries; the view is driven through the engine (`/roster view`, spawns, steps, tool
//! calls, turn ends, the hotkey and the close control) and its golden frames are asserted on what they say, on the
//! terminal and the desktop, docked and inline. Stored state from another shape is seeded through `state.get`.
//!
//! The deck's own tests are in roster.test.tsx; this file only checks the deck is left exactly as it was.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { tuning as T } from '../data/agent-roster'
import type { AgentTally, Card, DeskTodo } from '../types'
import {
  DESK_SHAPE,
  agentStopped,
  asTodoState,
  asViewMode,
  barOf,
  blankDesk,
  callEnded,
  callStarted,
  deskRows,
  fixDesk,
  isPlanTool,
  keepsTodos,
  progressOf,
  requestTokens,
  shareBarCells,
  todoBarCells,
  todosAfterCall,
  tokensAdded,
} from './desk-rules'
import { cells } from './geometry'
import { STORE_SHAPE, blankCard } from './records'
import { fill, tokensShort } from './words'

const H = T.desk
const HX = T.deskText
const G = T.glyphs
const PANE = T.pane.id
const PLUGIN = 'agent-roster'

type Dollar = Parameters<TestBody>[0]
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const re = (s: string) => new RegExp(escape(s))
const exact = (s: string) => new RegExp(`^${escape(s)}$`)

// ---------------------------------------------------------------- the host beneath

/** The host's answers a drawing test needs: a mocked clock, the status line, turns, the pane opening. */
function host(on: On) {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
  return clock
}

/** A Pane drawing request `bodyColumns` wide, docked unless said otherwise. */
function paneAsk(bodyColumns: number, placement: 'dock' | 'inline' = 'dock') {
  return {
    plugin: PLUGIN,
    component: 'Pane' as const,
    requestId: PANE,
    props: { title: T.pane.title, isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }
}

let callN = 0
/** A spawn request as the engine raises it. */
function spawnAsk(subagentType: string, description: string) {
  return {
    prompt: description,
    description,
    subagentType,
    tool_use_id: `hs${++callN}`,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  }
}

/** `/roster <args>`, its reply. */
async function roster($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: T.pane.command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  return r.text ?? ''
}

/** A model beneath turn.step answering at once with these token counts. */
function modelUsing(on: On, input: number, output: number) {
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    }
  })
}

/** One model request of agent `agentId`, run to its end. */
async function agentStep($: Dollar, agentId: string) {
  const s = $.turn.step({ turnId: 'HS', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId })
  for await (const _ of s) void _
  await s.result
}

// ---------------------------------------------------------------- reading drawings

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Drawn => typeof n === 'object' && n !== null && typeof (n as Drawn).type === 'string'
const kidsOf = (n: Drawn) => ((n.children ?? []) as unknown[]).flat(Infinity as 1)
const textIn = (n: unknown): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : isNode(n) ? kidsOf(n).map(textIn).join('') : '')

/** A Button as the terminal draws it: a plain one's hotkey and a colon, then its children's text, else its label. */
const buttonText = (n: Drawn) => `${n.props?.plain && n.props.hotkey ? `${String(n.props.hotkey)}: ` : ''}${textIn(n) || String(n.props?.label ?? '')}`

/** The lines of a drawing: each Text and Button, and each row Box of Texts as one line, joined by its gap. */
function linesOf(n: unknown, out: string[] = []): string[] {
  if (!isNode(n)) return out
  if (n.type === 'Text' || n.type === 'Button') {
    out.push(n.type === 'Button' ? buttonText(n) : textIn(n))
    return out
  }
  const kids = kidsOf(n).filter(isNode)
  const isRow = n.type === 'Box' && n.props?.flexDirection !== 'column' && kids.length > 0 && kids.every(k => k.type === 'Text')
  if (isRow) {
    out.push(kids.map(textIn).join(' '.repeat(typeof n.props?.columnGap === 'number' ? n.props.columnGap : 0)))
    return out
  }
  for (const k of kids) linesOf(k, out)
  return out
}

/** The fewest cells each element needs, where every Box given a width must hold what it contains. */
function spills(n: unknown, out: string[] = [], at = ''): number {
  if (typeof n === 'string') return cells(n)
  if (!isNode(n)) return 0
  const p = n.props ?? {}
  const here = `${at}/${String(p.key ?? n.type)}`
  if (n.type === 'Text') return p.wrap === undefined ? cells(textIn(n)) : 1
  if (n.type === 'Button') return cells(kidsOf(n).length ? textIn(n) : String(p.label ?? '')) + (p.plain ? (p.hotkey ? 3 : 0) : 4)
  if (n.type === 'Client') return typeof p.width === 'number' ? p.width : 5
  if (n.type !== 'Box') return 0
  const inner = kidsOf(n).filter(c => c !== null && c !== undefined && c !== false && c !== '').map((c, i) => spills(c, out, `${here}[${i}]`))
  const gap = typeof (p.columnGap ?? p.gap) === 'number' ? Number(p.columnGap ?? p.gap) : 0
  const content = p.flexDirection === 'column' ? Math.max(0, ...inner) : inner.reduce((a, b) => a + b, 0) + gap * Math.max(0, inner.length - 1)
  const margin = (typeof p.marginLeft === 'number' ? p.marginLeft : 0) + (typeof p.marginRight === 'number' ? p.marginRight : 0)
  if (typeof p.width === 'number') {
    if (content > p.width) out.push(`${here}: needs ${content} in ${p.width}`)
    return p.width + margin
  }
  return (p.overflow === 'hidden' ? 0 : content) + margin
}

/** What a graphical surface cannot keep whole: a truncating Text nesting Texts, or a Text in a Box with edge spaces. */
function graphicalFaults(n: unknown, out: string[] = [], parent = ''): string[] {
  if (!isNode(n)) return out
  const kids = kidsOf(n).filter(isNode)
  if (n.type === 'Text') {
    const text = textIn(n)
    if (n.props?.wrap === 'truncate' && kids.some(k => k.type === 'Text')) out.push(`truncates nested Texts "${text}"`)
    if (parent === 'Box' && text !== text.trim()) out.push(`edge spaces "${text}"`)
    return out
  }
  for (const k of kids) graphicalFaults(k, out, n.type)
  return out
}

/** The desk's lines at `cols`, on `surface`, docked or inline. */
async function deskLines($: Dollar, cols: number, placement: 'dock' | 'inline' = 'dock', surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...paneAsk(cols, placement), surface })
  const tree = await ui.drawn()
  await ui.unmount()
  return { lines: linesOf(tree), tree }
}

// ---------------------------------------------------------------- fixtures

const card = (id: string, o: Partial<Card> = {}): Card => ({ ...blankCard, id, type: 'general-purpose', kind: 'general-purpose', description: `task ${id}`, spawnedAt: 1, ...o })
const tally = (id: string, o: Partial<AgentTally> = {}): AgentTally => ({ id, calls: 0, tokens: 0, live: [], last: '', ...o })
const todo = (id: string, state: DeskTodo['state'], text = `item ${id}`): DeskTodo => ({ id, text, state })

// ================================================================ rules

test('the desk record repairs field by field: a foreign value reads blank, a broken field falls back, an unknown view is the deck', () => {
  expect(fixDesk(undefined)).toEqual(blankDesk)
  expect(fixDesk(null)).toEqual(blankDesk)
  expect(fixDesk(['desk'])).toEqual(blankDesk)
  expect(fixDesk({ view: 'desk' }).view).toBe('desk')
  expect(fixDesk({ view: 'grid' }).view).toBe('deck')
  const fixed = fixDesk({
    view: 7,
    todos: [{ id: 3, text: null, state: 'blocked' }, 'x', { id: 'a', text: 'b', state: 'completed' }],
    tallies: [{ calls: 2 }, { id: 'k', calls: -1, tokens: Number.NaN, live: [{ id: 'c' }, { id: 'c2', tool: 'Bash' }] }, null],
  })
  expect(fixed).toEqual({
    view: 'deck',
    todos: [todo('', 'pending', ''), todo('a', 'completed', 'b')],
    tallies: [{ id: 'k', calls: 0, tokens: 0, live: [{ id: 'c2', tool: 'Bash' }], last: '' }],
  })
  expect([asViewMode('deck'), asViewMode('desk'), asViewMode('DESK'), asViewMode(undefined)]).toEqual(['deck', 'desk', null, null])
  expect([asTodoState('in_progress'), asTodoState('completed'), asTodoState('done')]).toEqual(['in_progress', 'completed', 'pending'])
  // Its own tag, apart from the deck's: adding the desk did not retire the deck's records.
  expect(String(DESK_SHAPE) === String(STORE_SHAPE)).toBe(false)
})

test('the to-do list follows TodoWrite, TaskCreate and TaskUpdate; other tools leave it', () => {
  const written = todosAfterCall([], T.tools.todoWrite, { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c' }, 'junk'] }, null)
  expect(written).toEqual([todo('0', 'completed', 'a'), todo('1', 'in_progress', 'b'), todo('2', 'pending', 'c'), todo('3', 'pending', '')])
  expect(todosAfterCall(written, T.tools.todoWrite, { todos: 'none' }, null)).toEqual([])
  expect(todosAfterCall(written, 'Read', { todos: [] }, null)).toBe(written)
  // TaskCreate: the result's id, or numbered by place without one; an id already there is not added twice.
  let list = todosAfterCall([], T.tools.taskCreate, { subject: 'first' }, 't1')
  list = todosAfterCall(list, T.tools.taskCreate, { subject: 'second' }, null)
  expect(list).toEqual([todo('t1', 'pending', 'first'), todo('2', 'pending', 'second')])
  expect(todosAfterCall(list, T.tools.taskCreate, { subject: 'again' }, 't1')).toBe(list)
  // TaskUpdate: a status, a new subject, a removal; an update with no status keeps the state.
  list = todosAfterCall(list, T.tools.taskUpdate, { taskId: 't1', status: 'in_progress' }, null)
  expect(list[0]).toEqual(todo('t1', 'in_progress', 'first'))
  list = todosAfterCall(list, T.tools.taskUpdate, { taskId: 't1', subject: 'renamed' }, null)
  expect(list[0]).toEqual(todo('t1', 'in_progress', 'renamed'))
  list = todosAfterCall(list, T.tools.taskUpdate, { taskId: '2', status: 'deleted' }, null)
  expect(list).toEqual([todo('t1', 'in_progress', 'renamed')])
  expect(todosAfterCall(list, T.tools.taskUpdate, { taskId: 'nope', status: 'completed' }, null)).toEqual(list)
})

test('the list keeps at most the data\'s items: written whole or created one by one', () => {
  const many = Array.from({ length: H.todos + 1 }, (_, i) => ({ content: `n${i}` }))
  expect(todosAfterCall([], T.tools.todoWrite, { todos: many }, null).length).toBe(H.todos)
  const full = Array.from({ length: H.todos }, (_, i) => todo(`f${i}`, 'pending'))
  expect(todosAfterCall(full, T.tools.taskCreate, { subject: 'one more' }, 'x')).toBe(full)
  const almost = full.slice(1)
  expect(todosAfterCall(almost, T.tools.taskCreate, { subject: 'one more' }, 'x').length).toBe(H.todos)
})

test('the desktop plan tool is matched by its name\'s end and writes, completes, starts and advances items', () => {
  const plan = 'mcp__app__update_plan'
  expect([isPlanTool(plan), isPlanTool('update_plan'), isPlanTool('update_plan_v2'), keepsTodos(plan), keepsTodos('Bash')]).toEqual([true, true, false, true, false])
  for (const t of [T.tools.todoWrite, T.tools.taskCreate, T.tools.taskUpdate]) expect(keepsTodos(t)).toBe(true)
  let list = todosAfterCall([], plan, { items: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] }, null)
  expect(list.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
  list = todosAfterCall(list, plan, { start: 1 }, null)
  expect(list.map(t => t.state)).toEqual(['in_progress', 'pending', 'pending'])
  list = todosAfterCall(list, plan, { advance: true }, null)
  expect(list.map(t => t.state)).toEqual(['completed', 'in_progress', 'pending'])
  // Numbers outside the list, and starting a completed item, change nothing.
  expect(todosAfterCall(list, plan, { done: [0, 4, 1.5], start: 1 }, null)).toEqual(list)
  list = todosAfterCall(list, plan, { done: [2, 3] }, null)
  expect(list.map(t => t.state)).toEqual(['completed', 'completed', 'completed'])
  // Advancing with nothing in progress and nothing pending leaves the list.
  expect(todosAfterCall(list, plan, { advance: true }, null)).toEqual(list)
})

test('the bar shows done of total and the item at hand, and nothing when the list is empty or all done', () => {
  expect(progressOf([])).toBe(null)
  expect(progressOf([todo('a', 'completed'), todo('b', 'completed')])).toBe(null)
  expect(progressOf([todo('a', 'completed'), todo('b', 'pending'), todo('c', 'in_progress')])).toEqual({ done: 1, total: 3, current: todo('c', 'in_progress') })
  expect(progressOf([todo('a', 'completed'), todo('b', 'pending')])?.current).toEqual(todo('b', 'pending'))
})

test("bar widths hold to the data's bounds, just under, at and just over each", () => {
  const atMin = H.todoReserve + H.todoMin
  const atMax = H.todoReserve + H.todoMax
  expect([todoBarCells(atMin - 1), todoBarCells(atMin), todoBarCells(atMin + 1)]).toEqual([H.todoMin, H.todoMin, H.todoMin + 1])
  expect([todoBarCells(atMax - 1), todoBarCells(atMax), todoBarCells(atMax + 1)]).toEqual([H.todoMax - 1, H.todoMax, H.todoMax])
  const fullAt = H.shareReserve + H.shareCells
  const minAt = H.shareReserve + H.shareMin
  expect([shareBarCells(fullAt - 1), shareBarCells(fullAt), shareBarCells(fullAt + 1)]).toEqual([H.shareCells - 1, H.shareCells, H.shareCells])
  expect([shareBarCells(minAt - 1), shareBarCells(minAt), shareBarCells(minAt + 1)]).toEqual([H.shareMin, H.shareMin, H.shareMin + 1])
})

test('a bar lights in proportion, clamped, and lights nothing for an empty whole', () => {
  expect(barOf(1, 4, 8, '#', '.')).toEqual({ on: '##', off: '......' })
  expect(barOf(4, 4, 8, '#', '.')).toEqual({ on: '########', off: '' })
  expect(barOf(9, 4, 8, '#', '.')).toEqual({ on: '########', off: '' })
  expect(barOf(-1, 4, 8, '#', '.')).toEqual({ on: '', off: '........' })
  expect(barOf(3, 0, 8, '#', '.')).toEqual({ on: '', off: '........' })
  expect(barOf(Number.NaN, 4, 8, '#', '.')).toEqual({ on: '', off: '........' })
})

test('tallies count each call as it starts, show it running until it settles, and add tokens', () => {
  let t = callStarted([], 'a', { id: 'c1', tool: 'Read' })
  t = callStarted(t, 'a', { id: 'c2', tool: 'Bash' })
  expect(t).toEqual([tally('a', { calls: 2, last: 'Bash', live: [{ id: 'c1', tool: 'Read' }, { id: 'c2', tool: 'Bash' }] })])
  t = callEnded(t, 'a', 'c1')
  expect(t[0]?.live).toEqual([{ id: 'c2', tool: 'Bash' }])
  // A call that settles for an agent with no tally makes none.
  expect(callEnded(t, 'b', 'c9')).toEqual(t)
  t = tokensAdded(t, 'a', 120)
  t = tokensAdded(t, 'b', 30)
  expect(t.map(x => [x.id, x.tokens])).toEqual([['a', 120], ['b', 30]])
  expect(tokensAdded(t, 'a', 0)).toBe(t)
  t = agentStopped(t, 'a')
  expect(t[0]?.live).toEqual([])
  expect(agentStopped(t, 'a')).toEqual(t)
})

test("tallies keep the data's agents and running calls at most, the oldest going first", () => {
  let t: AgentTally[] = []
  for (let i = 0; i <= H.tallies; i += 1) t = tokensAdded(t, `g${i}`, 1)
  expect(t.length).toBe(H.tallies)
  expect(t[0]?.id).toBe('g1')
  let one: AgentTally[] = []
  for (let i = 0; i <= H.liveCalls; i += 1) one = callStarted(one, 'a', { id: `c${i}`, tool: 'Read' })
  expect(one[0]?.live.length).toBe(H.liveCalls)
  expect(one[0]?.live[0]?.id).toBe('c1')
  expect(one[0]?.calls).toBe(H.liveCalls + 1)
})

test('a request counts every input part and the output; absent or broken parts count nothing', () => {
  expect(requestTokens(null)).toBe(0)
  expect(requestTokens(undefined)).toBe(0)
  expect(requestTokens({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 })).toBe(244)
  expect(requestTokens({ input_tokens: -5, output_tokens: Number.NaN, cache_read_input_tokens: 7 })).toBe(7)
})

test('rows list the newest agent first, each with its share of the agents\' tokens and what it is at', () => {
  const cards = [card('a'), card('b'), card('c', { status: 'done' })]
  const tallies = [tally('a', { tokens: 300, calls: 4, last: 'Grep', live: [{ id: 'x', tool: 'Read' }, { id: 'y', tool: 'Bash' }] }), tally('c', { tokens: 100, live: [{ id: 'z', tool: 'Edit' }] })]
  const rows = deskRows(cards, tallies)
  expect(rows.map(r => r.card.id)).toEqual(['c', 'b', 'a'])
  expect(rows.map(r => r.pct)).toEqual([25, 0, 75])
  expect(rows.map(r => r.calls)).toEqual([0, 0, 4])
  // The tool running now is the latest live call, and only while the agent runs.
  expect(rows.map(r => r.now)).toEqual([null, null, 'Bash'])
  expect(rows.map(r => r.last)).toEqual([null, null, 'Grep'])
  expect(deskRows([card('q')], []).map(r => [r.pct, r.tokens])).toEqual([[0, 0]])
})

// ================================================================ the view, through the engine

test('/roster view switches to the desk and back; an unknown view gets the usage; a pane not shown says why', async ($, on) => {
  host(on)
  expect(await roster($, `${H.verb} desk`)).toBe(fill(HX.viewSet, { view: 'desk' }))
  expect((await deskLines($, 66)).lines[0]).toMatch(re(HX.title))
  expect(await roster($, `${H.verb} grid`)).toBe(HX.viewUsage)
  expect(await roster($, H.verb)).toBe(HX.viewUsage)
  // A bad word leaves the view as it was.
  expect((await deskLines($, 66)).lines[0]).toMatch(re(HX.title))
  expect(await roster($, `${H.verb} deck`)).toBe(fill(HX.viewSet, { view: 'deck' }))
  const deck = await deskLines($, 66)
  expect(deck.lines.some(l => l.includes(HX.title))).toBe(false)
  expect(deck.lines.some(l => l.includes(T.text.brand))).toBe(true)
})

test('a view set while the pane cannot be placed says why', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'too narrow' } }) as never)
  expect(await roster($, `${H.verb} desk`)).toBe(fill(HX.viewHidden, { view: 'desk', reason: 'too narrow' }))
})

/** A drawing as JSON without the press handles, which the engine numbers afresh on every mount. */
const settled = (tree: unknown) => JSON.stringify(tree, (key, value) => (key === 'press' ? undefined : value))

test('the deck is drawn exactly as before once the view has been to the desk and back', async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'same1' }))
  await $.turn.start({ text: 'fan out', turnId: 'SM' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Write the parser tests'))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const placement of ['dock', 'inline'] as const) {
      const before = settled((await deskLines($, 66, placement, surface)).tree)
      await roster($, `${H.verb} desk`)
      await roster($, `${H.verb} deck`)
      expect(settled((await deskLines($, 66, placement, surface)).tree)).toBe(before)
    }
  }
})

test('golden frame, docked: header, to-do bar, and per agent its task, calls, token share and the tool running now', async ($, on) => {
  const time = host(on)
  await time.advance(3_600_000)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `dk${++n}` }))
  modelUsing(on, 600, 150)
  // A beneath tool.call that holds `held` open until released, so a call can be drawn while it runs.
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const isIn = new Promise<void>(r => (entered = r))
  on('tool.call', async (_$, e) => {
    if (e.tool_use_id === 'held') {
      entered()
      await new Promise<void>(r => (release = r))
    }
    return { result: {}, text: 'ok' } as never
  })
  await $.turn.start({ text: 'fan out', turnId: 'DK' })
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'map the lexer', status: 'completed' }, { content: 'write the parser', status: 'in_progress' }, { content: 'review', status: 'pending' }] } as never)
  await $.agent.spawn(spawnAsk('general-purpose', 'Write the parser tests'))
  await $.agent.spawn(spawnAsk('Explore', 'Map the call sites'))
  await agentStep($, 'dk1')
  await agentStep($, 'dk1')
  await agentStep($, 'dk2')
  await $.tool.call({ tool: 'Grep', tool_use_id: 'g1', agentId: 'dk2', pattern: 'x' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', agentId: 'dk1', file_path: '/w/a.ts' } as never)
  const running = $.tool.call({ tool: 'Bash', tool_use_id: 'held', agentId: 'dk1', command: 'npm test' } as never)
  await isIn
  await roster($, `${H.verb} desk`)
  const cols = 66
  for (const surface of ['terminal', 'desktop'] as const) {
    const { lines, tree } = await deskLines($, cols, 'dock', surface)
    const per = 750
    const todoBar = barOf(1, 3, todoBarCells(cols), H.barOn, H.barOff)
    const share = (pct: number) => barOf(pct, 100, shareBarCells(cols), H.shareOn, H.shareOff)
    const expected = [
      [HX.title, fill(HX.counts, { running: 2, total: 2 }), fill(HX.tokens, { tokens: tokensShort(3 * per) })].join(HX.sep),
      `${H.hotkey}: ${HX.back}`,
      G.close,
      [todoBar.on + todoBar.off, fill(HX.todoCount, { done: 1, total: 3 }), fill(HX.todoItem, { item: 'write the parser' })].join(' '),
      // Newest first: the Explore agent, one step, its Grep settled.
      `${G.running} Map the call sites`,
      fill(HX.meta, { type: 'Explore', steps: 1, calls: 1 }),
      [share(33).on + share(33).off, fill(HX.share, { pct: 33, tokens: tokensShort(per), ctx: tokensShort(600) })].join(' '),
      fill(HX.last, { tool: 'Grep' }),
      `${G.running} Write the parser tests`,
      fill(HX.meta, { type: 'general-purpose', steps: 2, calls: 2 }),
      [share(67).on + share(67).off, fill(HX.share, { pct: 67, tokens: tokensShort(2 * per), ctx: tokensShort(600) })].join(' '),
      fill(HX.now, { mark: H.nowMark, tool: 'Bash' }),
    ]
    expect(lines).toEqual(expected)
    // Each clock is the agent's own: a live Client keyed by its id, which draws no text into the tree.
    for (const id of ['dk1', 'dk2']) expect(JSON.stringify(tree).includes(`"key":"desk-clock-${id}"`)).toBe(true)
    const back: string[] = []
    expect(spills(tree, back)).toBe(cols)
    expect(back).toEqual([])
    if (surface === 'desktop') expect(graphicalFaults(tree)).toEqual([])
  }
  release()
  await running
  // Settled, the call is the last one, not the one running now.
  const after = (await deskLines($, cols)).lines
  expect(after).toContain(fill(HX.last, { tool: 'Bash' }))
  expect(after.some(l => l.includes(fill(HX.now, { mark: H.nowMark, tool: 'Bash' })))).toBe(false)
})

test('golden frame, inline: a summary of at most the pane\'s rows, an agent a line, the rest counted', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `il${++n}` }))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await $.turn.start({ text: 'fan out', turnId: 'IL' })
  await roster($, `${H.verb} desk`)
  await $.agent.spawn(spawnAsk('general-purpose', 'only one'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const { lines, tree } = await deskLines($, 80, 'inline', surface)
    expect(lines.slice(3)).toEqual([[G.running, 'only one', [fill(HX.meta, { type: 'general-purpose', steps: 0, calls: 0 }), fill(HX.pct, { pct: 0 }), HX.idle].join(HX.sep)].join(' ')])
    if (surface === 'desktop') expect(graphicalFaults(tree)).toEqual([])
  }
  // Exactly as many agents as the rows left: no "more" row. One more: the last row is the count.
  const room = T.pane.inlineRows - 1
  for (let i = 1; i < room; i += 1) await $.agent.spawn(spawnAsk('general-purpose', `agent ${i}`))
  const full = (await deskLines($, 80, 'inline')).lines
  expect(full.length - 3).toBe(room)
  expect(full.some(l => l.startsWith('+'))).toBe(false)
  await $.agent.spawn(spawnAsk('general-purpose', 'one too many'))
  const over = (await deskLines($, 80, 'inline')).lines
  expect(over.length - 3).toBe(room)
  expect(over[over.length - 1]).toBe(fill(HX.more, { n: 2 }))
  // A to-do list takes a row: one agent fewer, counted.
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a', status: 'pending' }] } as never)
  const withTodo = (await deskLines($, 80, 'inline')).lines
  expect(withTodo.length - 3).toBe(room)
  expect(withTodo[withTodo.length - 1]).toBe(fill(HX.more, { n: 3 }))
})

test("docked, the desk lists the data's rows of agents and counts the rest", async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `rw${++n}` }))
  await roster($, `${H.verb} desk`)
  for (let i = 0; i < H.rows; i += 1) await $.agent.spawn(spawnAsk('general-purpose', `agent ${i}`))
  expect((await deskLines($, 66)).lines.some(l => l.startsWith('+'))).toBe(false)
  await $.agent.spawn(spawnAsk('general-purpose', 'extra'))
  const lines = (await deskLines($, 66)).lines
  expect(lines[lines.length - 1]).toBe(fill(HX.more, { n: 1 }))
  expect(lines.filter(l => l.startsWith(`${G.running} `)).length).toBe(H.rows)
})

test('with no agents the desk says so, and an empty or finished list draws no bar', async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  const empty = (await deskLines($, 66)).lines
  expect(empty.slice(3)).toEqual([HX.noAgents])
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a', status: 'completed' }] } as never)
  expect((await deskLines($, 66)).lines.slice(3)).toEqual([HX.noAgents])
})

test('a subagent\'s own to-do list, or a refused or failed list call, does not move the bar', async ($, on) => {
  host(on)
  on('tool.call', (_$, e) => (e.tool_use_id === 'bad' ? { result: {}, text: 'no', isError: true } : { result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  const list = (status: string) => ({ tool: T.tools.todoWrite, todos: [{ content: 'x', status }] })
  await $.tool.call({ ...list('pending'), tool_use_id: 'sub', agentId: 'someone' } as never)
  await $.tool.call({ ...list('pending'), tool_use_id: 'bad' } as never)
  expect((await deskLines($, 66)).lines.slice(3)).toEqual([HX.noAgents])
  await $.tool.call({ ...list('pending'), tool_use_id: 'good' } as never)
  expect((await deskLines($, 66)).lines[3]).toMatch(re(fill(HX.todoCount, { done: 0, total: 1 })))
})

test('TaskCreate ids come from the result and the plan tool works through the engine', async ($, on) => {
  host(on)
  let made = 0
  on('tool.call', (_$, e) => (e.tool === T.tools.taskCreate ? { result: { task: { id: `k${++made}` } }, text: 'ok' } : { result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  await $.tool.call({ tool: T.tools.taskCreate, tool_use_id: 'c1', subject: 'parse', description: 'd' } as never)
  await $.tool.call({ tool: T.tools.taskCreate, tool_use_id: 'c2', subject: 'lex', description: 'd' } as never)
  await $.tool.call({ tool: T.tools.taskUpdate, tool_use_id: 'u1', taskId: 'k2', status: 'in_progress' } as never)
  expect((await deskLines($, 66)).lines[3]).toMatch(re(`${fill(HX.todoCount, { done: 0, total: 2 })} ${fill(HX.todoItem, { item: 'lex' })}`))
  await $.tool.call({ tool: 'mcp__app__update_plan', tool_use_id: 'p1', items: [{ content: 'one' }, { content: 'two' }] } as never)
  await $.tool.call({ tool: 'mcp__app__update_plan', tool_use_id: 'p2', done: [1] } as never)
  expect((await deskLines($, 66)).lines[3]).toMatch(re(`${fill(HX.todoCount, { done: 1, total: 2 })} ${fill(HX.todoItem, { item: 'two' })}`))
})

test("a prompt the person types clears the list only where the data says so; a turn the engine opens never does", async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a', status: 'pending' }] } as never)
  await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 'N1' })
  expect((await deskLines($, 66)).lines[3]).toMatch(re(fill(HX.todoCount, { done: 0, total: 1 })))
  await $.turn.start({ text: 'next thing', turnId: 'N2' })
  const kept = (await deskLines($, 66)).lines[3] ?? ''
  expect(re(fill(HX.todoCount, { done: 0, total: 1 })).test(kept)).toBe(!H.clearTodosOnPrompt)
})

test('an agent\'s running calls clear when its turn ends, and its clock stops', async ($, on) => {
  const clock = host(on)
  modelUsing(on, 10, 5)
  await clock.advance(3_600_000)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'en1' }))
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const isIn = new Promise<void>(r => (entered = r))
  on('tool.call', async () => {
    entered()
    await new Promise<void>(r => (release = r))
    return { result: {}, text: 'ok' } as never
  })
  await roster($, `${H.verb} desk`)
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  const pending = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', agentId: 'en1', command: 'sleep' } as never)
  await isIn
  expect((await deskLines($, 66)).lines).toContain(fill(HX.now, { mark: H.nowMark, tool: 'Bash' }))
  await clock.advance(65_000)
  await $.turn.complete({ answer: 'ok', durationMs: 65_000, isAborted: false, turnId: 'E', agentId: 'en1', reason: 'answer' })
  const ui = await $.ui.mount({ ...paneAsk(66), surface: 'terminal' })
  expect(textIn(await ui.drawn({ in: 'desk-clock-en1' }))).toBe('1:05')
  await ui.advance(T.timing.clockTickMs * 5)
  expect(textIn(await ui.drawn({ in: 'desk-clock-en1' }))).toBe('1:05')
  await ui.unmount()
  const done = (await deskLines($, 66, 'dock', 'desktop')).lines
  expect(done).toContain(`${G.done} Work`)
  // Cut off by the agent's end, the call is its last, not one running now.
  expect(done).toContain(fill(HX.last, { tool: 'Bash' }))
  expect(done.some(l => l.includes(fill(HX.now, { mark: H.nowMark, tool: 'Bash' })))).toBe(false)
  // Resumed (a step from the finished agent runs it again), the call its end cut off is not shown as running.
  await agentStep($, 'en1')
  const resumed = (await deskLines($, 66)).lines
  expect(resumed).toContain(`${G.running} Work`)
  expect(resumed.some(l => l.includes(fill(HX.now, { mark: H.nowMark, tool: 'Bash' })))).toBe(false)
  release()
  await pending
})

test('the switch on the top row carries the data\'s hotkey and goes back to the deck; the close control closes the pane', async ($, on) => {
  host(on)
  const closed: string[] = []
  on('ui.close', (_$, e) => (closed.push(e.id), { value: undefined }) as never)
  for (const placement of ['dock', 'inline'] as const) {
    for (const surface of ['terminal', 'desktop'] as const) {
      await roster($, `${H.verb} desk`)
      const ui = await $.ui.mount({ ...paneAsk(66, placement), surface })
      const back = await ui.find({ type: 'Button', key: 'desk-back' } as never)
      expect([back?.props.hotkey, back?.props.label, back?.props.plain]).toEqual([H.hotkey, HX.back, true])
      const dismiss = await ui.find({ type: 'Button', key: 'dismiss' } as never)
      expect([dismiss?.props.role, dismiss?.props.label]).toEqual(['dismiss', T.text.closeLabel])
      await ui.press({ key: 'dismiss' })
      await ui.press({ key: 'desk-back' })
      await ui.unmount()
      const lines = (await deskLines($, 66, placement, surface)).lines
      expect(lines.some(l => l.includes(HX.title))).toBe(false)
    }
  }
  expect(closed).toEqual([PANE, PANE, PANE, PANE])
})

test('every desk line fits the pane from its minimum width up, docked and inline, on every surface', { timeoutMs: 60_000 }, async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `wd${++n}` }))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  modelUsing(on, 123_456, 7_890)
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a very long to-do item '.repeat(6), status: 'in_progress' }] } as never)
  await $.agent.spawn(spawnAsk('a-very-long-subagent-type-name', 'An agent with a description far longer than any pane is wide, to be cut'))
  await agentStep($, 'wd1')
  await $.tool.call({ tool: 'mcp__some_server__a_tool_with_a_long_name', tool_use_id: 'm1', agentId: 'wd1' } as never)
  await roster($, `${H.verb} desk`)
  const widths = [T.pane.minColumns, T.sizes.narrowBelow - 1, T.sizes.narrowBelow, H.todoReserve + H.todoMin, H.shareReserve + H.shareCells, 66, 110]
  for (const cols of widths) {
    for (const placement of ['dock', 'inline'] as const) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const { tree } = await deskLines($, cols, placement, surface)
        const out: string[] = []
        spills(tree, out)
        expect([cols, placement, surface, ...out]).toEqual([cols, placement, surface])
        if (surface === 'desktop') expect(graphicalFaults(tree)).toEqual([])
      }
    }
  }
})

test("the counts go short below the data's narrow width, and the token count is left off there", async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'nw1' }))
  modelUsing(on, 100, 50)
  await roster($, `${H.verb} desk`)
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  const top = async (cols: number) => (await deskLines($, cols)).lines[0]
  // No tokens yet: no token count, at any width.
  expect(await top(T.sizes.narrowBelow)).toBe([HX.title, fill(HX.counts, { running: 1, total: 1 })].join(HX.sep))
  await agentStep($, 'nw1')
  const wide = [HX.title, fill(HX.counts, { running: 1, total: 1 }), fill(HX.tokens, { tokens: tokensShort(150) })].join(HX.sep)
  const narrow = [HX.title, fill(HX.countsNarrow, { running: 1, total: 1 })].join(HX.sep)
  expect(await top(T.sizes.narrowBelow)).toBe(wide)
  expect(await top(T.sizes.narrowBelow - 1)).toBe(narrow)
})

test("the to-do bar's drawn width follows the body at each of the data's bounds", async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } as never)
  for (const cols of [H.todoReserve + H.todoMin - 1, H.todoReserve + H.todoMin + 1, H.todoReserve + H.todoMax + 1]) {
    const line = (await deskLines($, cols)).lines[3] ?? ''
    const bar = line.split(' ')[0] ?? ''
    expect(cells(bar)).toBe(todoBarCells(cols))
    expect(bar.startsWith(H.barOn.repeat(Math.round(todoBarCells(cols) / 2)))).toBe(true)
  }
})

test('/roster reset empties the desk\'s list and tallies but keeps the view', async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'rs1' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await roster($, `${H.verb} desk`)
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw', todos: [{ content: 'a', status: 'pending' }] } as never)
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', agentId: 'rs1' } as never)
  expect(await roster($, 'reset')).toBe(T.text.command.reset)
  const lines = (await deskLines($, 66)).lines
  expect(lines[0]).toMatch(re(HX.title))
  expect(lines.slice(3)).toEqual([HX.noAgents])
})

// ---------------------------------------------------------------- stored state from other versions

/** Answers `state.get` for `key` with `stored` until the mod writes that key. */
function seedKey(on: On, key: string, stored: unknown) {
  let isLeft = true
  on('state.get', (_$, e, next) => ((e as { key?: string }).key === key && isLeft ? ({ value: { value: stored, version: 1 } } as never) : next(e)))
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key === key) isLeft = false
    return next(e)
  })
}

for (const [name, stored, isDesk] of [
  ['an unshaped value', { view: 'desk', todos: 'x' }, false],
  ['another shape tag', { shape: 'agent-roster-desk-0', value: { view: 'desk', tallies: {} } }, false],
  ['the deck\'s tag', { shape: STORE_SHAPE, value: { view: 'desk' } }, false],
  ['this tag, every field broken', { shape: DESK_SHAPE, value: { view: 'desk', todos: [null, { state: 9 }], tallies: [{ id: 'x', calls: 'many', live: 'Bash' }] } }, true],
] as const) {
  test(`desk state stored as ${name} draws, ${isDesk ? 'as the desk' : 'as the deck'}, on every surface and placement`, async ($, on) => {
    host(on)
    seedKey(on, 'desk', stored)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x' }))
    await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const placement of ['dock', 'inline'] as const) {
        const { lines } = await deskLines($, 66, placement, surface)
        expect(lines.some(l => l.startsWith(T.text.drawFailed.split('{')[0] as string))).toBe(false)
        expect(lines.some(l => l.includes(HX.title))).toBe(isDesk)
        expect(lines.includes(G.close)).toBe(true)
      }
    }
  })
}
