//! agent-roster's tests. Expectations are computed from the shipped data
//! (`T`), so a re-tune does not break them and a broken data file does.
//! Pure rules are tested on plain values; every hook is driven through the
//! engine (`$.turn.*`, `$.tool.*`, `$.agent.spawn`, `$.session.*`,
//! `$.command.run`, `$.ui.mount`), on the terminal and graphical surfaces,
//! with time from `mock.clock`. Drawings are asserted on what they say.
//!
//! The blocks run from the pure rules to the drawings, then our own checks:
//! layout fit, faults, the mono face, stored state from other versions, and
//! the close control.

import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'

import { tuning as T } from '../data/agent-roster'
import type { Check } from '../types'
import { accentFor, cardLabel, cells, faultId, hasMonoFace, legendThatFits, logBudget, marksFor, meter, piecesInRoom, twoRowTitle } from './geometry'
import {
  addCheck,
  afterWindowRead,
  cardAfterStep,
  claimWindowRead,
  closeConsult,
  compactionWindow,
  consultTrack,
  forgetWindowRead,
  gateTotals,
  gaugeBasis,
  keepRecent,
  laneCells,
  momentNow,
  openConsult,
  placeCard,
  receiptFor,
  runAgain,
  settleAsk,
  tallyCall,
} from './ledger'
import { STORE_SHAPE, blankArchitect, blankGate, blankTurn, blankUsage, fixCard, fixGate, fixLog, fixMain, fixReceipt, fixUsage, fixView, settingsFrom } from './records'
import { adviceOf, callSummary, clip, dollars, durationShort, fill, firstPieceTiming, limitReading, limitShortName, mask, modelName, openingLine, readHandback, stopwatch, timingLabel, tokensShort, untilReset } from './words'

const X = T.text
const L = T.text.log
const G = T.glyphs
const Z = T.sizes
const PANE = T.pane.id
const PLUGIN = 'agent-roster'

type Dollar = Parameters<TestBody>[0]
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

// ---------------------------------------------------------------- the host beneath

/** The host's answers every drawing test needs: a mocked clock, the status line, turns. */
function host(on: On, o: { status?: boolean } = {}) {
  const clock = mock.clock(on)
  if (o.status !== false) on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

/** A Pane drawing request at `bodyColumns`, docked unless said otherwise. */
function paneAsk(bodyColumns: number, placement: 'dock' | 'inline' = 'dock', view: { agentId?: string } = {}) {
  return {
    plugin: PLUGIN,
    component: 'Pane' as const,
    requestId: PANE,
    props: { title: T.pane.title, isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view },
  }
}

let spawnN = 0
/** A spawn request as the engine raises it. */
function spawnAsk(subagentType: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    prompt: description,
    description,
    subagentType,
    tool_use_id: `tu${++spawnN}`,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...extra,
  }
}

/** A step's usage. */
const usageOf = (input: number, output: number, model = 'claude-sonnet-5-5') => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model })

/** A model beneath turn.step that answers at once with `usage`. */
function quietModel(on: On, usage = usageOf(10, 5), stopReason: 'end_turn' | 'max_tokens' = 'end_turn') {
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason, usage }
  })
}

/** Runs one model request to its end. */
async function step($: Dollar, o: { agentId?: string; model?: string } = {}) {
  const s = $.turn.step({ turnId: 'S1', index: 0, model: o.model ?? 'claude-opus-5-5', messageCount: 1, ...(o.agentId ? { agentId: o.agentId } : {}) })
  for await (const _ of s) void _
  await s.result
}

/** An assistant response row carrying `content`. */
function row($: Dollar, content: unknown[], door: 'response' | 'hook-context' = 'response') {
  return $.session
    .append({ message: { type: 'assistant', role: 'assistant', content: content as never }, door, origin: { kind: 'model', model: 'claude-opus-5-5' } as never, uuid: `u${++spawnN}` })
    .catch(() => undefined) // the kit has no transcript to keep rows in
}

/** Mounts, reads, unmounts. */
async function drawn<S extends 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal'>($: Dollar, req: ReturnType<typeof paneAsk>, surface: S = 'terminal' as S) {
  return $.ui.mount({ ...req, surface })
}

// ---------------------------------------------------------------- width checks

// The kit lays nothing out, so this measures the drawn tree as a row layout would: the fewest cells each
// element needs without spilling, and every Box given a width must hold what it contains.
type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Drawn => typeof n === 'object' && n !== null && typeof (n as Drawn).type === 'string'
const textIn = (n: unknown): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : isNode(n) ? (n.children ?? []).map(textIn).join('') : '')
const gapOf = (v: unknown) => (typeof v === 'number' ? v : v === undefined ? 0 : 1)
const widestWord = (s: string) => Math.max(0, ...s.split(/\s+/).map(cells))

function cellsNeeded(n: unknown, out: string[], at: string): number {
  if (typeof n === 'string') return widestWord(n)
  if (!isNode(n)) return 0
  const p = n.props ?? {}
  const here = `${at}/${String(p.key ?? n.type)}`
  if (n.type === 'Text') return p.wrap === undefined ? cells(textIn(n)) : p.wrap === 'wrap' ? widestWord(textIn(n)) : 1
  // A plain Button with a hotkey draws `1: ` before its label. One with children draws them; its label only names it.
  if (n.type === 'Button') return cells(n.children?.length ? textIn(n) : String(p.label ?? '')) + (p.plain ? (p.hotkey ? 3 : 0) : 4)
  if (n.type === 'Client') return typeof p.width === 'number' ? p.width : 5
  if (n.type !== 'Box') return 0
  const inner = (n.children ?? []).filter(c => c !== null && c !== undefined && c !== false && c !== '').map((c, i) => cellsNeeded(c, out, `${here}[${i}]`))
  const isColumn = p.flexDirection === 'column'
  const content = isColumn || p.flexWrap === 'wrap' ? Math.max(0, ...inner) : inner.reduce((a, b) => a + b, 0) + gapOf(p.columnGap ?? p.gap) * Math.max(0, inner.length - 1)
  const need = content + (p.borderStyle ? 2 : 0) + 2 * gapOf(p.paddingX ?? p.padding)
  const margin = gapOf(p.marginLeft) + gapOf(p.marginRight) + 2 * gapOf(p.marginX)
  if (typeof p.width === 'number') {
    if (need > p.width) out.push(`${here}: needs ${need} in ${p.width}`)
    return p.width + margin
  }
  return (p.overflow === 'hidden' ? 0 : need) + margin
}

function spills(tree: unknown, columns: number): string[] {
  const out: string[] = []
  const need = cellsNeeded(tree, out, '')
  if (need > columns) out.push(`root: needs ${need} in ${columns}`)
  return out
}

/** What a graphical surface cannot keep whole: a truncating Text nesting Texts, or a Text in a Box with edge spaces. */
function graphicalFaults(n: unknown, out: string[], at = '', parent = ''): string[] {
  if (!isNode(n)) return out
  const p = n.props ?? {}
  const here = `${at}/${String(p.key ?? n.type)}`
  const kids = (n.children ?? []).filter(isNode)
  if (n.type === 'Text') {
    const text = textIn(n)
    if (p.wrap === 'truncate' && kids.some(k => k.type === 'Text')) out.push(`${here}: truncates nested Texts "${text}"`)
    if (parent === 'Box' && text !== text.trim()) out.push(`${here}: edge spaces "${text}"`)
    return out
  }
  kids.forEach((k, i) => graphicalFaults(k, out, `${here}[${i}]`, n.type))
  return out
}

// ================================================================ rules and drawings

// ---- pure rules

test('credentials are masked before anything is stored, and a call names its last two path parts', () => {
  expect(mask('curl -H "Authorization: Bearer abc.def.ghi123" x')).not.toContain('abc.def')
  expect(mask(`export OPENAI_API_KEY=${['sk', 'proj', '1234567890abcdef'].join('-')}`)).not.toContain('1234567890')
  expect(mask(`gh auth --token ${['ghp', 'abcdefghijklmnop'].join('_')}`)).not.toContain('abcdefghijklmnop')
  expect(mask('psql postgres://bob:hunter2@db/x')).not.toContain('hunter2')
  expect(mask('password=hunter2 ls')).not.toContain('hunter2')
  expect(mask('ls -la src/')).toBe('ls -la src/')
  expect(callSummary('Read', { file_path: 'C:\\Users\\me\\proj\\src\\main.ts' })).toBe('Read → src/main.ts')
})

const aCheck = (id: string, verdict: Check['verdict'], bucket: Check['bucket'] = 'shell', inSubagent = false): Check => ({ id, tool: 'Bash', bucket, verdict, inSubagent, detail: 'Bash → ls', at: 1 })

test('an open ask is settled by its call: cleared when it ran, deny when refused, nothing for an unknown id', () => {
  let g = addCheck(blankGate, aCheck('a', 'ask'))
  g = addCheck(g, aCheck('b', 'ask'))
  g = addCheck(g, aCheck('c', 'rule', 'file'))
  g = settleAsk(g, 'a', true)
  g = settleAsk(g, 'b', false)
  expect(settleAsk(g, 'zzz', true)).toBe(g)
  const s = gateTotals(g)
  expect([s.rule, s.ask, s.cleared, s.deny, s.total]).toEqual([1, 0, 1, 1, 3])
  expect(g.recent.map(c => c.verdict)).toEqual(['cleared', 'deny', 'rule'])
})

test('the gate tallies each family on its own', () => {
  let g = blankGate
  g = addCheck(g, aCheck('r1', 'rule', 'file'))
  g = addCheck(g, aCheck('a1', 'ask', 'shell'))
  g = addCheck(g, aCheck('a2', 'ask', 'shell'))
  g = addCheck(g, aCheck('d1', 'deny', 'other'))
  g = settleAsk(settleAsk(g, 'a1', true), 'a2', false)
  expect(g.totals.file).toEqual({ rule: 1, ask: 0, cleared: 0, deny: 0 })
  expect(g.totals.shell).toEqual({ rule: 0, ask: 0, cleared: 1, deny: 1 })
  expect(g.totals.other.deny).toBe(1)
  expect(gateTotals(g)).toEqual({ rule: 1, ask: 0, cleared: 1, deny: 2, total: 4 })
  expect(gateTotals(blankGate).total).toBe(0)
})

test('a first-version gate reads as empty, then records', () => {
  const g = fixGate({ file: { allow: 3, ask: 1, deny: 0, cleared: 2 }, shell: null })
  expect(gateTotals(g).total).toBe(0)
  const next = addCheck(g, aCheck('n1', 'rule', 'file'))
  expect([next.totals.file.rule, next.recent.length]).toEqual([1, 1])
})

test('an open ask survives trimming until it settles', () => {
  let g = addCheck(blankGate, aCheck('old-ask', 'ask'))
  for (let i = 0; i < T.keep.gateChecks + 40; i += 1) g = addCheck(g, aCheck(`r${i}`, 'rule', 'file'))
  expect(g.recent.length).toBe(T.keep.gateChecks)
  expect(g.recent.some(c => c.id === 'old-ask')).toBe(true)
  expect(gateTotals(settleAsk(g, 'old-ask', true)).ask).toBe(0)
  expect(keepRecent([aCheck('a', 'rule'), aCheck('b', 'rule')], 5).length).toBe(2)
})

test('edits count from every loop, errors from the main loop only', () => {
  const t = { ...blankTurn, errorStreak: 1 }
  expect(tallyCall(t, { inSubagent: true, hasFailed: false, isEdit: true }).edits).toBe(1)
  expect(tallyCall(t, { inSubagent: true, hasFailed: true, isEdit: false }).errorStreak).toBe(1)
  expect(tallyCall(t, { inSubagent: false, hasFailed: true, isEdit: false })).toEqual({ ...t, errorStreak: 2, errors: 1 })
  expect(tallyCall(t, { inSubagent: false, hasFailed: false, isEdit: false }).errorStreak).toBe(0)
  expect(momentNow(tallyCall(blankTurn, { inSubagent: true, hasFailed: false, isEdit: true }))).toBe('done')
  // The repeat threshold from the data: just under is still the plan, at it is a repeat.
  expect(momentNow({ edits: 0, errorStreak: Z.errorRepeats - 1 })).toBe('plan')
  expect(momentNow({ edits: 0, errorStreak: Z.errorRepeats })).toBe('repeat')
})

test("a card's context is its latest request's whole input; its output adds up", () => {
  let c = fixCard({ id: 'x' })
  c = cardAfterStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 500 }, stopReason: 'tool_use' })
  c = cardAfterStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 40_000, output_tokens: 700 }, stopReason: 'max_tokens' })
  expect([c.ctx, c.out, c.steps, c.lastStop, c.model]).toEqual([40_005, 1200, 2, 'max_tokens', 'claude-sonnet-5-5'])
  // A request with no usage keeps the context it had.
  expect(cardAfterStep(c, { model: 'x', usage: null, stopReason: null }).ctx).toBe(40_005)
})

test('a resumed agent runs again on its own card, with its tallies and its newest task and model', () => {
  const a = { ...fixCard({ id: 'a', description: 'first', spawnedAt: 5, model: 'claude-sonnet-5-5' }), status: 'done', endedAt: 100, steps: 4, out: 900 }
  const cards = placeCard(placeCard(placeCard([], a), fixCard({ id: 'b' })), fixCard({ id: 'a', description: 'again', spawnedAt: 200 }))
  expect(cards.map(c => `${c.id}:${c.description}`)).toEqual(['a:again', 'b:'])
  expect(cards[0] && [cards[0].status, cards[0].endedAt, cards[0].steps, cards[0].out, cards[0].spawnedAt]).toEqual(['running', null, 4, 900, 5])
  expect([runAgain(a).status, runAgain(a).endedAt]).toEqual(['running', null])
  expect(placeCard([a], fixCard({ id: 'a', model: 'claude-opus-5-5' }))[0]?.model).toBe('claude-opus-5-5')
  expect(placeCard([a], fixCard({ id: 'a' }))[0]?.model).toBe('claude-sonnet-5-5')
})

test('consults open once per id, close by id, and share one timeline', () => {
  let a = openConsult(blankArchitect, { id: 's1', at: 0, moment: 'plan', via: 'advisor tool' })
  a = openConsult(a, { id: 's1', at: 5, moment: 'plan', via: 'again' })
  a = closeConsult(a, 10, null, 's1')
  a = openConsult(a, { id: 's2', at: 90, moment: 'done', via: 'advisor tool' })
  expect(a.consults.length).toBe(2)
  expect(a.consults[0]?.endAt).toBe(10)
  const track = consultTrack(a, 100, 11)
  expect(cells(track)).toBe(11)
  expect(track.startsWith(`${G.consult}${G.consultRun}`)).toBe(true)
  expect(track.split(G.consult).length - 1).toBe(2)
  // Too narrow to say anything: a plain rule.
  expect(consultTrack(a, 100, 3)).toBe(G.consultIdle.repeat(3))
})

test('settings are read leniently: anything malformed falls back to the data', () => {
  const D = T.config
  const d = settingsFrom({})
  expect([d.maxCards, d.paneColumns, d.layout, d.motion, d.moments, d.panels.length]).toEqual([D.maxCards, D.paneColumns, D.layout, true, D.moments, D.panels.length])
  expect(d.architect.test('fable-advisor:fable-advisor')).toBe(true)
  const c = settingsFrom({ architectPattern: '([', maxCards: 99, layout: 'diagonal', panels: 'log, gate ,nope,gate', motion: D.motionOff })
  expect(c.architect.test('advisor')).toBe(true)
  expect([c.maxCards, c.layout, c.motion]).toEqual([D.maxCardsMax, 'auto', false])
  expect(settingsFrom({ maxCards: -3 }).maxCards).toBe(D.maxCardsMin)
  expect([46.4, 12, Number.NaN, '90'].map(n => settingsFrom({ paneColumns: n }).paneColumns)).toEqual([46, D.paneColumnsMin, D.paneColumns, D.paneColumns])
  expect(c.panels).toEqual(['log', 'gate'])
  expect(settingsFrom({ panels: 'nothing,valid' }).panels).toEqual(D.panels)
})

test('records saved under an older shape still read', () => {
  expect(fixLog([{ at: '08:00:00', who: 'jev', text: 'x' }])[0]).toEqual({ at: 0, who: 'jev', text: 'x', agentId: null, kind: 'info' })
  const g = fixGate({ file: { allow: 1 } })
  expect([g.recent, g.totals.shell.rule]).toEqual([[], 0])
  expect(fixCard({ id: 'a', status: 'done' }).tools).toEqual([])
  expect(fixLog('not a list')).toEqual([])
})

test('layout arithmetic: lanes share an axis, the log takes its share, the legend never wraps, names read as people say them', () => {
  const cards = [
    { ...fixCard({}), id: 'a', spawnedAt: 1000, endedAt: 1050 },
    { ...fixCard({}), id: 'b', spawnedAt: 1050, endedAt: null },
  ]
  const [a, b] = laneCells(cards, 1100, 20)
  expect(a).toEqual({ id: 'a', before: 0, bar: 10, after: 10 })
  expect([b?.before, (b?.before ?? 0) + (b?.bar ?? 0) + (b?.after ?? 0)]).toEqual([10, 20])
  // The log's rows: never below the minimum, never above the maximum, what is left between.
  expect([logBudget(10, 40), logBudget(50, 40), logBudget(200, 40)]).toEqual([Z.logRowsMin, 50 - 40 - Z.logRowsSpare, Z.logRowsMax])
  expect(legendThatFits([{ label: 'main' }, { label: 'agents' }, { label: 'architect' }], 20).map(x => x.label)).toEqual(['main', 'agents'])
  expect([marksFor(64, true), marksFor(64, false), marksFor(6, false)]).toEqual([64, Math.floor(64 / Z.graphicalMarkCells), Math.floor(6 / Z.graphicalMarkCells)])
  expect([limitShortName('five_hour'), limitShortName('seven_day_opus')]).toEqual(['5h', '7d opus'])
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
  expect(modelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5')
  expect(modelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
  expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
  expect(modelName('claude-3-opus-20240229')).toBe('Opus 3')
  expect(modelName('z-ai/glm-5.3-flash-with-a-long-name')).toBe(`z-ai/glm-5.3-flash-wi${G.ellipsis}`)
  expect(modelName('')).toBe(G.dash)
  expect(openingLine('fix the parser')).toEqual({ who: X.who.you, text: 'fix the parser' })
  const hb = '<agent-message from="a1940a83d593229d5">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Add gate tests: redaction edge cases.\n  - more\n</agent-message>'
  expect(readHandback(hb)).toEqual({ from: 'a1940a83d593229d5', body: 'Add gate tests: redaction edge cases.' })
  expect(readHandback('<agent-message from="x">\nPlain report line\n</agent-message>')).toEqual({ from: 'x', body: 'Plain report line' })
  expect(readHandback('fix the parser')).toBe(null)
  expect(adviceOf('## Ship it after one more gate test.\n- details')).toBe('Ship it after one more gate test.')
  expect(adviceOf('[Subagent hand-back] header\n\n**Fix card overflow first**')).toBe('Fix card overflow first')
  expect(adviceOf('')).toBe('')
  expect(openingLine('<agent-message from="a1492260715f3be7b"> [Subagent hand-back]')).toEqual({ who: X.who.engine, text: fill(L.engineFrom, { tag: 'agent message', from: 'a1492260' }) })
  // A cost added under the data's minimum is not shown; at it, it is.
  expect(receiptFor({ ...blankTurn, costAtStart: 5 }, { durationMs: 1, agentsSince: 0, costAtEnd: 5, reason: 'answer' }).costDelta).toBe(null)
  expect(receiptFor({ ...blankTurn, costAtStart: 1 }, { durationMs: 1, agentsSince: 0, costAtEnd: 1 + Z.costDeltaMin * 0.9, reason: 'answer' }).costDelta).toBe(null)
  expect(receiptFor({ ...blankTurn, costAtStart: 1, edits: 2 }, { durationMs: 1000, agentsSince: 3, costAtEnd: 1.5, reason: 'answer' }).costDelta).toBe(0.5)
  expect(twoRowTitle('Write tinyqueue test suite', 13, 16)).toEqual(['Write', `tinyqueue test${G.ellipsis}`])
  expect(twoRowTitle('Short', 13, 16)).toEqual(['Short', ''])
})

test("a request's timing is its time to the first piece of response, and no output rate", () => {
  expect(firstPieceTiming(1000, 1800)).toEqual({ ttftMs: 800 })
  expect(firstPieceTiming(1000, null)).toBe(null)
  expect(timingLabel({ ttftMs: 1250 })).toBe(fill(X.ttft, { s: '1.3' }))
  // A rate kept by an older shape is not drawn.
  expect(timingLabel({ ttftMs: 800, tokPerS: 9844 } as { ttftMs: number })).toBe(fill(X.ttft, { s: '0.8' }))
})

test('a limit keeps its reset time, drawn as the time left', () => {
  expect(limitReading({ kind: 'five_hour', percentUsed: 19, resetsAt: '1970-01-01T03:10:00.000Z' })).toEqual({ kind: 'five_hour', pct: 19, resetsAt: 11_400_000 })
  expect(limitReading({ kind: 'seven_day', percentUsed: 3 }).resetsAt).toBe(null)
  expect(limitReading({ kind: 'spend_limit', percentUsed: 1, resetsAt: 'soon' }).resetsAt).toBe(null)
  expect([untilReset(11_400_000, 0), untilReset(25 * 60_000 + 5_000, 0), untilReset(4 * 86_400_000 + 2 * 3_600_000, 0)]).toEqual(['3h10m', '25m', '4d2h'])
  expect([untilReset(null, 0), untilReset(undefined, 0), untilReset(5, 10), untilReset(10, 10)]).toEqual(['', '', '', ''])
})

// ---- drawings

const mainTitle = (model = G.dash) => exact(fill(X.main, { model }))

test('a fresh session draws on every surface and width, empty panels left out', async ($, on) => {
  host(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const cols of [40, 60, 86, 120]) {
      const ui = await drawn($, paneAsk(cols), surface)
      expect(await ui.find({ text: mainTitle() })).toBeDefined()
      expect(await ui.find({ text: exact(X.logTitle) })).toBeDefined()
      expect(await ui.find({ text: re('agents ·') })).toBeUndefined()
      expect(await ui.find({ text: re(fill(X.gateTitle, { label: T.config.gateLabel })) })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('inline above the prompt, the pane is a summary of at most the data\'s rows', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `m${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  await $.turn.start({ text: 'go', turnId: 'M1' })
  for (const d of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawnAsk('general-purpose', `task ${d}`))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'm-k1' })
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await drawn($, paneAsk(80, 'inline'), surface)
    const root = (await ui.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length <= T.pane.inlineRows).toBe(true)
    expect(await ui.find({ text: re(fill(X.miniMore, { n: 5 - T.keep.miniAgents })) })).toBeDefined()
    expect(await ui.find({ text: re(`1 ${X.allowedWord}`) })).toBeDefined()
    expect(await ui.find({ text: re(X.logTitle) })).toBeUndefined()
    await ui.unmount()
  }
})

test('/clear starts the deck fresh', async ($, on) => {
  host(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'c1' }))
  await $.turn.start({ text: 'go', turnId: 'C1' })
  await $.agent.spawn(spawnAsk('Explore', 'look around'))
  const before = await drawn($, paneAsk(64))
  expect(await before.find({ text: re('look around') })).toBeDefined()
  await before.unmount()
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re('look around') })).toBeUndefined()
  await ui.unmount()
})

test('colours are theme keys by default', async ($, on) => {
  host(on)
  const ui = await drawn($, paneAsk(64))
  expect((await ui.find({ text: mainTitle() }))?.props.color).toBe(T.palettes.theme.main)
  await ui.unmount()
})

test('the pastel palette draws its fixed colours', { options: { palette: 'pastel' } }, async ($, on) => {
  host(on)
  const ui = await drawn($, paneAsk(64))
  expect((await ui.find({ text: mainTitle() }))?.props.color).toBe(T.palettes.pastel.main)
  await ui.unmount()
})

test('subagents are cards, then lanes past the limit; a card expands on its key', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ag${++n}` }))
  await $.turn.start({ text: 'fan out', turnId: 'T1' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Write the parser tests'))
  await $.agent.spawn(spawnAsk('Explore', 'Map the call sites'))
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re('Write the parser') })).toBeDefined()
  expect(await ui.find({ text: re('Sonnet 5.5') })).toBeDefined()
  await ui.press({ key: 'card-ag1' })
  expect(await ui.find({ text: exact('Write the parser tests') })).toBeDefined()
  await ui.unmount()
  await $.agent.spawn(spawnAsk('general-purpose', 'Implement the parser'))
  await $.agent.spawn(spawnAsk('general-purpose', 'Review the parser'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const lanes = await drawn($, paneAsk(64), surface)
    expect(await lanes.find({ text: re(fill(X.agentsWide, { running: 4, total: 4 })) })).toBeDefined()
    expect(await lanes.find({ text: re(G.laneBar) })).toBeDefined()
    await lanes.unmount()
  }
})

test('a server-side advisor is read from assistant rows: advising, then on call', async ($, on) => {
  host(on)
  await $.turn.start({ text: 'plan it', turnId: 'T2' })
  await row($, [{ type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} }])
  const mid = await drawn($, paneAsk(64))
  expect(await mid.find({ text: re(fill(X.archTitle, { label: T.config.architectLabel, state: X.advising })) })).toBeDefined()
  expect(await mid.find({ text: re(`${G.momentOn} ${X.moments.plan}`) })).toBeDefined()
  await mid.unmount()
  await row($, [{ type: 'advisor_tool_result', tool_use_id: 'srv1', content: { type: 'advisor_redacted_result' } }])
  const after = await drawn($, paneAsk(64))
  expect(await after.find({ text: re(fill(X.archTitle, { label: T.config.architectLabel, state: X.onCall })) })).toBeDefined()
  expect(await after.find({ text: /^1$/ })).toBeDefined()
  await after.unmount()
})

test('the server-side advisor is read only from rows that come in by the response door', async ($, on) => {
  host(on)
  await $.turn.start({ text: 'plan it', turnId: 'T5' })
  const advising = re(fill(X.archTitle, { label: T.config.architectLabel, state: X.advising }))
  await row($, [{ type: 'server_tool_use', id: 'srvH', name: 'advisor', input: {} }], 'hook-context')
  const before = await drawn($, paneAsk(64))
  expect(await before.find({ text: advising })).toBeUndefined()
  await before.unmount()
  await row($, [{ type: 'server_tool_use', id: 'srvR', name: 'advisor', input: {} }])
  const after = await drawn($, paneAsk(64))
  expect(await after.find({ text: advising })).toBeDefined()
  await after.unmount()
})

test('the gate strip fills from checks and a family opens its masked drill-down', async ($, on) => {
  host(on)
  on('tool.check', (_$, e) => ({ decision: e.tool === 'Read' ? 'allow' : 'ask' }))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a/b.ts' }, tool_use_id: 'k1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefgh12345" api' }, tool_use_id: 'k2' })
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(fill(X.checks, { n: 2 })) })).toBeDefined()
  expect(await ui.find({ text: re(`1 ${X.pendingWord}`) })).toBeDefined()
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer •••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefgh12345/ })).toBeUndefined()
  // The button says it is open; pressed again it closes.
  expect(await ui.find({ key: 'gate-shell' }).then(b => String(b?.props.label))).toBe(fill(X.familyButton, { family: X.families.shell, n: 1 }) + G.expandOpen)
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer •••/ })).toBeUndefined()
  await ui.unmount()
})

test('settings relabel, hide panels and turn the moments off', { options: { architectLabel: 'REVIEWER', panels: 'main,architect,agents,log', moments: false } }, async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'r1' }))
  await $.turn.start({ text: 'review it', turnId: 'T3' })
  await $.agent.spawn(spawnAsk('fable-advisor:fable-advisor', 'final review'))
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(fill(X.archTitle, { label: 'REVIEWER', state: X.advising })) })).toBeDefined()
  expect(await ui.find({ text: re(fill(X.gateTitle, { label: T.config.gateLabel })) })).toBeUndefined()
  expect(await ui.find({ text: re(X.moments.plan) })).toBeUndefined()
  expect(await ui.find({ text: re(fill(L.consulted, { via: 'fable-advisor' })) })).toBeDefined()
  await ui.unmount()
})

test('a consult that opens and closes in one row ends, and its review with it', async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'go', turnId: 'T4' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)
  await row($, [
    { type: 'server_tool_use', id: 'srv9', name: 'advisor', input: {} },
    { type: 'advisor_tool_result', tool_use_id: 'srv9', content: { type: 'advisor_redacted_result' } },
  ])
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(fill(X.archTitle, { label: T.config.architectLabel, state: X.onCall })) })).toBeDefined()
  expect(await ui.find({ text: re(`${G.momentOn} ${X.moments.done}`) })).toBeDefined()
  expect(await ui.find({ text: re(fill(X.reviewing, { label: T.config.architectLabel.toLowerCase() })) })).toBeUndefined()
  await ui.unmount()
})

test('with no architect anywhere, its panel and legend entry stay hidden', async ($, on) => {
  host(on)
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(T.config.architectLabel) })).toBeUndefined()
  expect(await ui.find({ text: exact(` ${T.config.architectLabel.toLowerCase()}`) })).toBeUndefined()
  await ui.unmount()
})

test('stacked, up to maxCards agents stay cards at every width: a pane too narrow to set them side by side does not fall back to lanes', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `w${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'W1' })
  for (const d of ['alpha', 'beta', 'gamma']) await $.agent.spawn(spawnAsk('Explore', `task ${d}`))
  // Three cards need 3 × cardMin + 2 cells of gap.
  const fits = 3 * Z.cardMin + 2
  const narrow = await drawn($, paneAsk(fits - 1))
  expect(await narrow.find({ text: re(G.laneBar) })).toBeUndefined()
  expect(cardBoxes(await narrow.drawn()).length).toBe(3)
  await narrow.unmount()
  const wide = await drawn($, paneAsk(fits))
  expect(await wide.find({ text: re(G.laneBar) })).toBeUndefined()
  expect(await wide.find({ text: re('task gamma') })).toBeDefined()
  await wide.unmount()
})

test("a background architect's advice is read from its hand-back", async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'fab1' }))
  await $.turn.start({ text: 'review it', turnId: 'H1' })
  await $.agent.spawn(spawnAsk('fable-advisor:fable-advisor', 'final review'))
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'H1', agentId: 'fab1', reason: 'answer' })
  await $.turn.start({ text: '<agent-message from="fab1">\n[Subagent hand-back] The report follows:\n  Ship it after one more gate test.\n</agent-message>', turnId: 'H2' })
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: exact(`${G.advice} Ship it after one more gate test.`) })).toBeDefined()
  expect(await ui.find({ text: exact(fill(L.advice, { text: 'Ship it after one more gate test.' })) })).toBeDefined()
  await ui.unmount()
})

test("each limit shows the time to its reset from the data's width, and not below it", async ($, on) => {
  host(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const at = (ms: number) => new Date(ms).toISOString()
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19, resetsAt: at(3 * 3_600_000 + 10 * 60_000) },
      { kind: 'seven_day', percentUsed: 3, resetsAt: at(4 * 86_400_000 + 2 * 3_600_000) },
    ],
    changed: ['rateLimits'],
  })
  // The main box is the pane's width when docked in one column: the threshold applies to it directly.
  for (const cols of [Z.resetFrom, 120]) {
    const ui = await drawn($, paneAsk(cols))
    expect(await ui.find({ text: re(`19% ${G.reset}3h10m`) })).toBeDefined()
    expect(await ui.find({ text: re(`3% ${G.reset}4d2h`) })).toBeDefined()
    await ui.unmount()
  }
  const narrow = await drawn($, paneAsk(Z.resetFrom - 1))
  expect(await narrow.find({ text: /19%/ })).toBeDefined()
  expect(await narrow.find({ text: re(G.reset) })).toBeUndefined()
  await narrow.unmount()
})

test('the main box shows the last request\'s time to first token, measured on the mocked clock', async ($, on) => {
  const clock = host(on)
  on('turn.step', async function* (_$, e) {
    await clock.sleep(800)
    yield { kind: 'text' as const, index: 0, text: 'hello' }
    await clock.sleep(2000)
    const usage = usageOf(10, 120, 'claude-opus-5-5')
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  const before = await drawn($, paneAsk(40))
  expect(await before.find({ text: re(fill(X.ttft, { s: '' }).trim()) })).toBeUndefined()
  await before.unmount()
  const s = $.turn.step({ turnId: 'S1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const first = s.next()
  await clock.advance(800)
  expect((await first).value).toEqual({ kind: 'text', index: 0, text: 'hello' })
  const stop = s.next()
  await clock.advance(2000)
  await stop
  for await (const _ of s) void _
  await s.result
  for (const cols of [40, 64, 120]) {
    const ui = await drawn($, paneAsk(cols))
    expect(await ui.find({ text: exact(fill(X.lastReq, { speed: fill(X.ttft, { s: '0.8' }) })) })).toBeDefined()
    expect(await ui.find({ text: /tok\/s/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('on a graphical surface, rows of marks hold fewer, keep the newest and clip at their box', async ($, on) => {
  host(on)
  on('tool.check', (_$, e) => ({ decision: e.tool_use_id === 'g29' ? 'deny' : 'allow' }))
  quietModel(on)
  for (let i = 0; i < 30; i += 1) await $.tool.check({ tool: 'Read', input: { file_path: `/f${i}.ts` }, tool_use_id: `g${i}` })
  await step($, { agentId: 'wf1' })
  await row($, [{ type: 'server_tool_use', id: 'srvG', name: 'advisor', input: {} }])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const cols of [40, 64, 120]) {
      const ui = await drawn($, paneAsk(cols), surface)
      const strip = await ui.find({ type: 'Text', text: new RegExp(`^[${G.check}${G.denied}]{2,}$`) })
      const room = cols - 4
      expect(strip?.props.wrap).toBe('truncate-start')
      expect(strip?.text.length).toBe(Math.min(30, Math.max(Z.gateStripMin, marksFor(room, surface === 'terminal'))))
      expect(strip?.text.endsWith(G.denied)).toBe(true)
      expect((await ui.find({ type: 'Text', text: exact(G.loopLive) }))?.props.wrap).toBe('truncate-start')
      expect((await ui.find({ type: 'Text', text: new RegExp(`^[${G.consultIdle}${G.consultRun}${G.consult}]+$`) }))?.props.wrap).toBe('truncate-middle')
      expect((await ui.find({ key: 'legend' }))?.props.marginBottom).toBe(surface === 'terminal' ? 0 : 1)
      await ui.unmount()
    }
  }
})

test("the inline summary's strip holds fewer marks on a graphical surface and keeps the newest", async ($, on) => {
  host(on)
  on('tool.check', (_$, e) => ({ decision: e.tool_use_id === 'n59' ? 'deny' : 'allow' }))
  for (let i = 0; i < 60; i += 1) await $.tool.check({ tool: 'Bash', input: { command: `ls ${i}` }, tool_use_id: `n${i}` })
  const counts = fill(X.gateCounts, { rule: 59, cleared: 0, decider: X.decider.other, pending: '', deny: 1 })
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await drawn($, paneAsk(80, 'inline'), surface)
    const room = 80 - T.config.gateLabel.length - 2 - counts.length
    const strip = await ui.find({ type: 'Text', text: new RegExp(`^[${G.check}${G.denied}]{2,}$`) })
    expect(strip?.props.wrap).toBe('truncate-start')
    expect(strip?.text.length).toBe(marksFor(room, surface === 'terminal'))
    expect(strip?.text.endsWith(G.denied)).toBe(true)
    expect(await ui.find({ text: exact(counts) })).toBeDefined()
    await ui.unmount()
  }
})

test('a draw that fails says why instead of leaving the pane empty', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => {
    throw new Error('boom')
  })
  for (const cols of [40, 64, 120]) {
    const ui = await drawn($, paneAsk(cols))
    expect(await ui.find({ text: exact(X.brand) })).toBeDefined()
    expect(await ui.find({ text: re(fill(X.drawFailed, { kind: 'throw', message: '' }).split(':')[0] as string) })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished agent that takes another step runs again, in the pane and the status line', async ($, on) => {
  mock.clock(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'r1' }))
  quietModel(on)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Audit the parser'))
  await step($, { agentId: 'r1', model: 'claude-sonnet-5-5' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'R1', agentId: 'r1', reason: 'answer' })
  expect(status[status.length - 1]).toMatch(re(fill(X.status.agents, { running: 0, total: 1 })))
  await step($, { agentId: 'r1', model: 'claude-sonnet-5-5' })
  expect(status[status.length - 1]).toMatch(re(fill(X.status.agents, { running: 1, total: 1 })))
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(`${G.running} ${X.statusWords.running}`) })).toBeDefined()
  expect(await ui.find({ text: re(`${G.done} ${X.statusWords.done}`) })).toBeUndefined()
  expect(await ui.find({ text: exact(L.resumed) })).toBeDefined()
  expect(await ui.find({ text: re(fill(X.cardStats, { ctx: 10, out: 10, steps: 2 })) })).toBeDefined()
  await ui.unmount()
})

test('the docked pane asks for the width set in paneColumns', { options: { paneColumns: 46 } }, async ($, on) => {
  host(on)
  const asked: (number | undefined)[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => (asked.push(e.columns), { value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(asked).toEqual([46])
})

test('the gauge measures against a compaction window set below the model window', () => {
  const u = { ...blankUsage, tokens: 200_000, window: 1_000_000, compactWindow: 400_000 }
  expect(gaugeBasis(u)).toEqual({ pct: 50, window: 400_000 })
  expect(gaugeBasis({ ...u, tokens: 100_000 })).toEqual({ pct: 25, window: 400_000 })
  for (const compactWindow of [null, 1_000_000, 1_500_000, 0]) expect(gaugeBasis({ ...u, compactWindow })).toEqual({ pct: 20, window: 1_000_000 })
  expect(gaugeBasis({ ...u, tokens: null })).toEqual({ pct: null, window: 400_000 })
  expect(gaugeBasis(blankUsage)).toEqual({ pct: null, window: 0 })
  expect(gaugeBasis({ ...blankUsage, tokens: 5 }).pct).toBeNull()
})

test('a breakdown names a compaction window only when auto-compaction is on and it is below the model window', () => {
  const b = { rawMaxTokens: 400_000, isAutoCompactEnabled: true }
  expect(compactionWindow(b, 1_000_000)).toBe(400_000)
  expect(compactionWindow({ ...b, isAutoCompactEnabled: false }, 1_000_000)).toBeNull()
  expect(compactionWindow({ ...b, rawMaxTokens: 1_000_000 }, 1_000_000)).toBeNull()
  expect(compactionWindow(b, 200_000)).toBeNull()
  expect(compactionWindow({ ...b, rawMaxTokens: 0 }, 1_000_000)).toBeNull()
  expect(compactionWindow(undefined, 1_000_000)).toBeNull()
  expect(compactionWindow(null, 1_000_000)).toBeNull()
})

/** A host whose `session.usage` gives a breakdown only to a call that asks for one; returns what was asked. */
function usageHost(on: On, o: { window: () => number; compact: number | null; isEnabled?: boolean; tokens?: number }) {
  const asked: (string | undefined)[] = []
  on('session.usage', (_$, e) => {
    asked.push(e.breakdown)
    const breakdown = e.breakdown && o.compact !== null ? { rawMaxTokens: o.compact, isAutoCompactEnabled: o.isEnabled ?? true, totalTokens: 123, percentage: 99 } : undefined
    return { value: { startedAt: 0, rateLimits: [], context: { window: o.window(), ...(o.tokens !== undefined ? { tokens: o.tokens } : {}), ...(breakdown ? { breakdown: breakdown as never } : {}) } } }
  })
  return asked
}

test('the gauge, status line and inline summary use the compaction window, read once per model window', async ($, on) => {
  mock.clock(on)
  let status: string | undefined
  on('ui.status', (_$, e) => ((status = e.text), { value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  let window = 1_000_000
  const asked = usageHost(on, { window: () => window, compact: 400_000 })
  const measure = (tokens: number) => $.session.measure({ context: { window, tokens, percent: tokens / (window / 100) }, rateLimits: [], changed: ['context'] })
  for (const t of [100_000, 150_000, 200_000]) await measure(t)
  // Three measurements, one summary breakdown: never `full`, which would send requests.
  expect(asked.filter(Boolean)).toEqual(['summary'])
  expect(status).toBe(fill(X.status.ctx, { pct: 50 }))
  for (const cols of [40, 64, 120]) {
    const ui = await drawn($, paneAsk(cols))
    expect(await ui.find({ text: re('200k/400k') })).toBeDefined()
    expect(await ui.find({ text: re(fill(X.pct, { pct: 50 })) })).toBeDefined()
    expect(await ui.find({ text: /1\.0M/ })).toBeUndefined()
    await ui.unmount()
    const mini = await drawn($, paneAsk(cols, 'inline'))
    expect(await mini.find({ text: re(fill(X.pct, { pct: 50 })) })).toBeDefined()
    await mini.unmount()
  }
  // At the warning threshold of the compaction window the gauge warns; just under, it does not.
  await measure(400_000 * (Z.warnPct - 1) / 100)
  const under = await drawn($, paneAsk(64))
  expect((await under.find({ type: 'Text', text: new RegExp(`^${G.gaugeOn}+$`) }))?.props.color).toBe(T.palettes.theme.main)
  await under.unmount()
  await measure(400_000 * Z.warnPct / 100)
  const warn = await drawn($, paneAsk(64))
  expect((await warn.find({ type: 'Text', text: new RegExp(`^${G.gaugeOn}+$`) }))?.props.color).toBe(T.palettes.theme.warn)
  await warn.unmount()
  // A smaller model window: read again, and a compaction window above it no longer counts.
  window = 200_000
  await measure(100_000)
  expect(asked.filter(Boolean)).toEqual(['summary', 'summary'])
  const small = await drawn($, paneAsk(64))
  expect(await small.find({ text: re('100k/200k') })).toBeDefined()
  await small.unmount()
})

function holdsModelWindow(name: string, h: { compact: number | null; isEnabled?: boolean }, asks: number) {
  test(name, async ($, on) => {
    mock.clock(on)
    on('ui.status', () => ({ value: undefined }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    const asked = usageHost(on, { window: () => 1_000_000, ...h })
    for (const tokens of [50_000, 100_000, 200_000, 250_000, 300_000]) {
      await $.session.measure({ context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] })
    }
    expect(asked.filter(Boolean).length).toBe(asks)
    for (const cols of [40, 64, 120]) {
      const ui = await drawn($, paneAsk(cols))
      expect(await ui.find({ text: /300k\/1\.0M/ })).toBeDefined()
      expect(await ui.find({ text: re(fill(X.pct, { pct: 30 })) })).toBeDefined()
      await ui.unmount()
    }
  })
}
holdsModelWindow("a host with no breakdown keeps the model window and stops asking after the data's tries", { compact: null }, T.timing.compactTries)
holdsModelWindow('with auto-compaction off the gauge keeps the model window and is asked once', { compact: 400_000, isEnabled: false }, 1)

test('a resumed session reads its compaction window at start, and /clear leaves the reading alone', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.register', () => ({ value: { command: T.pane.command } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const asked = usageHost(on, { window: () => 1_000_000, compact: 400_000, tokens: 200_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(asked).toEqual([undefined, 'summary'])
  const resumed = await drawn($, paneAsk(64))
  expect(await resumed.find({ text: re('200k/400k') })).toBeDefined()
  await resumed.unmount()
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  await $.session.measure({ context: { window: 1_000_000, tokens: 100_000, percent: 10 }, rateLimits: [], changed: ['context'] })
  expect(asked).toEqual([undefined, 'summary'])
  const cleared = await drawn($, paneAsk(64))
  expect(await cleared.find({ text: re('100k/400k') })).toBeDefined()
  expect(await cleared.find({ text: re(fill(X.pct, { pct: 25 })) })).toBeDefined()
  await cleared.unmount()
})

test('a compaction-window read that fails is asked again at the next measurement', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  let reads = 0
  on('session.usage', (_$, e) => {
    if (e.breakdown && ++reads === 1) return { deny: 'not bound yet' }
    const breakdown = e.breakdown ? { rawMaxTokens: 400_000, isAutoCompactEnabled: true } : undefined
    return { value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, ...(breakdown ? { breakdown: breakdown as never } : {}) } } }
  })
  const measure = (tokens: number) => $.session.measure({ context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] })
  await measure(100_000)
  const failed = await drawn($, paneAsk(64))
  expect(await failed.find({ text: /100k\/1\.0M/ })).toBeDefined()
  await failed.unmount()
  await measure(200_000)
  await measure(300_000)
  expect(reads).toBe(2)
  const read = await drawn($, paneAsk(64))
  expect(await read.find({ text: re('300k/400k') })).toBeDefined()
  expect(await read.find({ text: re(fill(X.pct, { pct: 75 })) })).toBeDefined()
  await read.unmount()
})

test('a compaction-window read is claimed once per model window, misses retried to the cap, stale reads dropped', () => {
  const b = { rawMaxTokens: 400_000, isAutoCompactEnabled: true }
  const first = claimWindowRead({ ...blankUsage, window: 1_000_000 }, 1_000_000)
  expect([first.isClaimed, first.usage.compactFor]).toEqual([true, 1_000_000])
  expect(claimWindowRead(first.usage, 1_000_000).isClaimed).toBe(false)
  expect(afterWindowRead(first.usage, 1_000_000, b).compactWindow).toBe(400_000)
  const switched = claimWindowRead({ ...first.usage, window: 1_000_000 }, 200_000).usage
  expect(afterWindowRead(switched, 1_000_000, b)).toBe(switched)
  let u = first.usage
  for (let i = 0; i < T.timing.compactTries; i += 1) {
    const c = claimWindowRead(u, 1_000_000)
    expect(c.isClaimed || i === 0).toBe(true)
    u = afterWindowRead(c.isClaimed ? c.usage : u, 1_000_000, i % 2 ? null : undefined)
  }
  expect([u.compactFor, u.compactMisses, u.compactWindow]).toEqual([0, T.timing.compactTries, null])
  expect(claimWindowRead(u, 1_000_000).isClaimed).toBe(false)
  expect(claimWindowRead(u, 200_000).isClaimed).toBe(true)
  expect(claimWindowRead(forgetWindowRead({ ...u, compactWindow: 400_000 }), 1_000_000).isClaimed).toBe(true)
  expect(forgetWindowRead({ ...u, compactWindow: 400_000 }).compactWindow).toBe(null)
  expect(claimWindowRead({ ...blankUsage }, 0).isClaimed).toBe(false)
})

/** A host where the context fill reported at each request can be set, and compactions can be vetoed. */
function hostWithFill($: Dollar, on: On) {
  host(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  let veto: string | undefined
  on('session.compact', (_$, e) => (veto ? { skip: veto } : { messages: e.messages }))
  let fillNow: number | undefined
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, ...(fillNow !== undefined ? { tokens: fillNow } : {}) } } }))
  quietModel(on, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0, model: 'x' })
  return {
    request: async (tokens: number | undefined, agentId?: string) => {
      fillNow = tokens
      await step($, agentId ? { agentId } : {})
    },
    measure: (tokens: number) => $.session.measure({ context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] }),
    vetoCompactions: (why: string | undefined) => {
      veto = why
    },
    shown: async () => {
      const ui = await drawn($, paneAsk(64))
      const mark = (await ui.find({ type: 'Text', text: new RegExp(`^${G.compaction}`) }))?.text ?? null
      const isEstimated = (await ui.find({ type: 'Text', text: exact(X.estimated) })) !== undefined
      const logged = (await ui.findAll({ type: 'Text', text: /^context compacted/ })).map(n => n.text)
      await ui.unmount()
      return { mark, isEstimated, logged }
    },
  }
}

test('where session.compact never arrives, a request that finds the context emptied counts an estimated compaction', async ($, on) => {
  const h = hostWithFill($, on)
  await h.measure(60_000)
  await h.request(undefined)
  await h.request(60_000)
  expect(await h.shown()).toEqual({ mark: null, isEstimated: false, logged: [] })
  await h.request(undefined)
  expect(await h.shown()).toEqual({ mark: `${G.compaction}${X.estimateMark}1`, isEstimated: true, logged: [L.compactedEstimated] })
  await h.request(undefined)
  await h.request(undefined, 'sub1')
  expect((await h.shown()).mark).toBe(`${G.compaction}${X.estimateMark}2`)
  const out: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [24, 28, 32, 36, 40, 64, 120]) {
      for (const placement of ['dock', 'inline'] as const) {
        const ui = await drawn($, paneAsk(cols, placement), surface)
        for (const s of spills(await ui.drawn(), cols)) out.push(`${surface} ${placement} ${cols}: ${s}`)
        await ui.unmount()
      }
    }
  }
  expect(out).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  await h.request(undefined)
  await h.measure(30_000)
  expect((await h.shown()).mark).toBe(`${G.compaction}${X.estimateMark}2`)
  await $.session.end({ reason: 'resume', sessionId: 's' } as never)
  await h.request(undefined)
  expect((await h.shown()).mark).toBe(`${G.compaction}${X.estimateMark}2`)
})

test('once session.compact arrives its count is the real one: estimates before it are dropped, none after', async ($, on) => {
  const h = hostWithFill($, on)
  await h.measure(60_000)
  await h.request(60_000)
  await h.request(undefined)
  expect((await h.shown()).mark).toBe(`${G.compaction}${X.estimateMark}1`)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'the summary', toolUses: [] }] })
  await h.request(undefined)
  await h.request(60_000)
  await h.request(undefined)
  expect(await h.shown()).toEqual({ mark: `${G.compaction}1`, isEstimated: false, logged: [L.compactedEstimated, fill(L.compacted, { trigger: 'auto' })] })
})

test('a compaction that comes back skipped is neither counted nor logged', async ($, on) => {
  const h = hostWithFill($, on)
  await h.measure(60_000)
  const compact = () => $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'the summary', toolUses: [] }] })
  h.vetoCompactions('a PreCompact hook blocked it')
  await compact()
  expect(await h.shown()).toEqual({ mark: null, isEstimated: false, logged: [] })
  h.vetoCompactions(undefined)
  await compact()
  expect(await h.shown()).toEqual({ mark: `${G.compaction}1`, isEstimated: false, logged: [fill(L.compacted, { trigger: 'manual' })] })
})

test("a surface module's fault key is the same for either separator and the bare name", () => {
  expect(faultId('desktop', 'hooks/rail.tsx')).toBe('desktop:rail.tsx')
  expect(faultId('desktop', 'hooks\\rail.tsx')).toBe(faultId('desktop', 'rail.tsx'))
  expect(faultId('terminal', 'hooks/elapsed.tsx')).not.toBe(faultId('desktop', 'hooks/elapsed.tsx'))
})

test("the monospaced face is asked of the data's release and later only", () => {
  const [ma, mi, pa] = T.monoSince
  const v = (a: number, b: number, c: number) => `${a}.${b}.${c}`
  const at = (version: string, base?: string) => hasMonoFace({ version, ...(base !== undefined ? { base } : {}) })
  expect([at(v(ma, mi, pa - 1), v(ma, mi, pa - 1)), at(v(ma, mi, pa - 12), v(ma, mi, pa - 12))]).toEqual([false, false])
  expect([at(v(ma, mi, pa), v(ma, mi, pa)), at(v(ma, mi, pa + 10), v(ma, mi, pa + 10)), at(v(ma, mi + 1, 0), v(ma, mi + 1, 0)), at(v(ma + 1, 0, 0), v(ma + 1, 0, 0))]).toEqual([true, true, true, true])
  expect([at(v(ma, mi - 1, 999), v(ma, mi - 1, 999)), at(v(ma - 1, 9, 400), v(ma - 1, 9, 400))]).toEqual([false, false])
  expect(at(`${v(ma, mi, pa + 1)}-dev.20261001.t101500.sha1a2b3c4`, `${v(ma, mi, pa + 1)}-dev`)).toBe(true)
  expect(at(`${v(ma, mi, pa - 3)}-dev.20260920.t101500.sha1a2b3c4`, `${v(ma, mi, pa - 3)}-dev`)).toBe(false)
  expect([at(v(ma, mi, pa + 11)), at(v(ma, mi, pa - 9))]).toEqual([true, false])
  expect([at('local'), at(''), hasMonoFace(null), hasMonoFace(undefined)]).toEqual([false, false, false, false])
})

test('switching to another model with the same window reads its compaction window afresh', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  let compact = 400_000
  let reads = 0
  on('session.usage', (_$, e) => {
    if (e.breakdown) reads += 1
    const breakdown = e.breakdown ? { rawMaxTokens: compact, isAutoCompactEnabled: true } : undefined
    return { value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, ...(breakdown ? { breakdown: breakdown as never } : {}) } } }
  })
  quietModel(on, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' })
  const measure = (tokens: number) => $.session.measure({ context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] })
  await step($, { model: 'claude-opus-5-5[1m]' })
  await measure(300_000)
  await step($, { model: 'claude-opus-5-5[1m]' })
  await measure(360_000)
  expect(reads).toBe(1)
  compact = 700_000
  await step($, { model: 'claude-sonnet-5-5[1m]' })
  await measure(360_000)
  expect(reads).toBe(2)
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re('360k/700k') })).toBeDefined()
  expect(await ui.find({ text: re(fill(X.pct, { pct: 51 })) })).toBeDefined()
  await ui.unmount()
})

test('a resume through agent.spawn logs once, whichever of its spawn and first step lands first; "done" times the run', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  quietModel(on)
  let isStepFirst = false
  on('agent.spawn', async (_$, e) => {
    if (e.resume && isStepFirst) await step($, { agentId: 'r1' })
    return { model: 'claude-sonnet-5-5', agentId: e.resume?.agentId ?? 'r1' }
  })
  const complete = (durationMs: number) => $.turn.complete({ answer: 'ok', durationMs, isAborted: false, turnId: 'R1', agentId: 'r1', reason: 'answer' })
  const count = async (pattern: RegExp) => {
    const ui = await drawn($, paneAsk(64))
    const n = (await ui.findAll({ text: pattern })).length
    await ui.unmount()
    return n
  }
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Audit the parser'))
  await step($, { agentId: 'r1' })
  await clock.advance(60_000)
  await complete(60_000)
  await clock.advance(30 * 60_000)
  await $.agent.spawn({ ...spawnAsk('general-purpose', 'Audit it again'), resume: { agentId: 'r1' } })
  await step($, { agentId: 'r1' })
  expect(await count(exact(L.resumed))).toBe(1)
  await clock.advance(90_000)
  await complete(90_000)
  isStepFirst = true
  await $.agent.spawn({ ...spawnAsk('general-purpose', 'And once more'), resume: { agentId: 'r1' } })
  expect(await count(exact(L.resumed))).toBe(2)
  expect(await count(exact('Audit the parser'))).toBe(0)
  expect(await count(exact(fill(L.done, { took: '1m00s' })))).toBe(1)
  expect(await count(exact(fill(L.done, { took: '1m30s' })))).toBe(1)
})

test("a subagent's turn start is its own: no prompt line, and the main turn keeps its counts", async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'refactor it', turnId: 'T1' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.start({ text: 'Look at the parser again', turnId: 'A1', agentId: 'sub1' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'T1', reason: 'answer' })
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re('Look at the parser again') })).toBeUndefined()
  expect(await ui.find({ text: re('refactor it') })).toBeDefined()
  expect(await ui.find({ text: re(` 1 ${X.plurals.edit[0]} ·`) })).toBeDefined()
  await ui.unmount()
})

test('a line keeps the pieces that fit, in order, counting leads and gaps', () => {
  const pieces = [{ width: 5 }, { width: 5, indent: 2 }, { width: 3 }]
  expect([piecesInRoom(pieces, 13, 1), piecesInRoom(pieces, 12, 1), piecesInRoom(pieces, 17, 1), piecesInRoom(pieces, 4, 1)]).toEqual([2, 1, 3, 0])
  expect([cells('■ ▰▱ 48%'), cells('')]).toEqual([8, 0])
})

/** A session with every panel busy: compaction window, limits, consults with advice, checks of each kind, agents, a loop. */
async function fullSession($: Dollar, on: On) {
  const clock = host(on)
  await clock.advance(3_600_000)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('tool.check', (_$, e) => ({ decision: (e.tool_use_id ?? '').endsWith('7') ? 'deny' : 'allow' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.subagentType.includes('advisor') ? 'adv1' : `b${++n}` }))
  const usage = { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'ok' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  await $.session.measure({
    context: { window: 1_000_000, tokens: 360_000, percent: 36 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 82, resetsAt: new Date(3 * 3_600_000).toISOString() },
      { kind: 'seven_day_opus', percentUsed: 40, resetsAt: new Date(4 * 86_400_000).toISOString() },
    ],
    cost: { usd: 123.45 },
    changed: ['context', 'rateLimits', 'cost'],
  } as never)
  await $.turn.start({ text: 'Refactor the configuration loader and keep every public name stable please', turnId: 'B1' })
  await step($, { model: 'claude-opus-5-5[1m]' })
  const tools = [
    { tool: 'Bash', input: { command: 'npm run test -- --reporter=verbose --coverage packages/configuration-loader' } },
    { tool: 'Read', input: { file_path: '/Users/someone/projects/a-very-long-repository-name/src/configuration/loader.ts' } },
    { tool: 'WebFetch', input: { url: 'https://example.com/a/very/long/documentation/path/for/the/loader' } },
  ]
  for (let i = 0; i < 60; i += 1) await $.tool.check({ ...tools[i % 3]!, tool_use_id: `k${i}` })
  await $.tool.call({ tool: 'Edit', file_path: '/x/loader.ts', old_string: 'a', new_string: 'b', tool_use_id: 'edit1' } as never)
  await $.agent.spawn(spawnAsk('fable-advisor:fable-advisor', 'final review of the loader'))
  await $.turn.complete({ answer: 'Ship it once the configuration loader keeps its public names and the migration test covers the old shape', durationMs: 9000, isAborted: false, turnId: 'A1', agentId: 'adv1', reason: 'answer' })
  for (const d of ['Write the configuration loader regression tests', 'Map every call site of the old loader', 'Review the migration path for saved state']) {
    await $.agent.spawn(spawnAsk('general-purpose', d))
  }
  await step($, { agentId: 'b1', model: 'claude-opus-5-5[1m]' })
  await step($, { agentId: 'wf-unclaimed-loop', model: 'claude-opus-5-5[1m]' })
  await clock.advance(95_000)
  await $.turn.complete({ answer: '', durationMs: 95_000, isAborted: false, turnId: 'B1', reason: 'answer' })
}

test('every panel fits the pane at every width from the minimum, on every surface and placement, in lines a graphical surface keeps whole', { timeoutMs: 60_000 }, async ($, on) => {
  await fullSession($, on)
  const failures: string[] = []
  const sweep = async (label: string) => {
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      for (let cols = T.pane.minColumns; cols <= Z.narrowBelow; cols += 1) {
        for (const placement of ['dock', 'inline'] as const) {
          const ui = await drawn($, paneAsk(cols, placement), surface)
          for (const s of spills(await ui.drawn(), cols)) failures.push(`${label} ${placement} ${cols}: ${s}`)
          await ui.unmount()
        }
      }
      for (const cols of [64, 120]) {
        const ui = await drawn($, paneAsk(cols), surface)
        for (const s of spills(await ui.drawn(), cols)) failures.push(`${label} dock ${cols}: ${s}`)
        await ui.unmount()
      }
    }
  }
  await sweep('lanes, finished')
  const opener = await drawn($, paneAsk(64))
  await opener.press({ key: 'gate-shell' })
  await opener.press({ key: 'card-b1' })
  await opener.unmount()
  await $.turn.start({ text: 'and once more', turnId: 'B2' })
  await sweep('drill-down, expanded, running')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [24, 32, 40, 64, 120]) {
      for (const placement of ['dock', 'inline'] as const) {
        const ui = await drawn($, paneAsk(cols, placement), surface)
        for (const f of graphicalFaults(await ui.drawn(), [])) failures.push(`${surface} ${placement} ${cols}: ${f}`)
        await ui.unmount()
      }
    }
  }
  expect([...new Set(failures)]).toEqual([])
})

test('one agent card fits from the minimum width, and the desktop time axis takes no pixel size', async ($, on) => {
  const clock = host(on)
  await clock.advance(3_600_000)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'one' }))
  await $.turn.start({ text: 'go', turnId: 'O1' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Write the configuration loader regression tests'))
  const failures: string[] = []
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (let cols = T.pane.minColumns; cols <= Z.narrowBelow; cols += 1) {
      const ui = await drawn($, paneAsk(cols), surface)
      for (const s of spills(await ui.drawn(), cols)) failures.push(`${surface} ${cols}: ${s}`)
      const svg = await ui.find({ type: 'Svg' })
      if (surface === 'terminal') expect(svg).toBeUndefined()
      else {
        expect([svg !== undefined, svg?.props.width, svg?.props.height]).toEqual([true, undefined, undefined])
        expect(String(svg?.props.alt)).toBe(fill(X.svgAlt, { n: 1 }))
        expect(String(svg?.props.source)).toContain(T.svg.colors.running)
      }
      await ui.unmount()
    }
  }
  expect(failures).toEqual([])
})

// ---- the monospaced face on the connectors

/** The engine's answer to `$.session.version()`: a release, a refusal (null), or asked afresh each call. */
function engineVersion(on: On, version: string | null | (() => string | null)) {
  on('session.version', () => {
    const v = typeof version === 'function' ? version() : version
    return v === null ? { deny: 'no version here' } : { value: { version: v, base: v } }
  })
}

/** A pane of one Text in the monospaced face, to ask whether the engine running the tests draws it. */
const monoProbe: Plugin = {
  name: 'mono-probe',
  register(on) {
    on('ui.render', { component: 'Pane', requestId: 'mono-probe' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      // A plugin in `plugins` runs on its own, without this file's imports: the glyph is written out.
      return h(Text, { mono: true }, '─') as RenderElement
    })
  },
}

async function kitDrawsMono($: Dollar): Promise<boolean> {
  try {
    const ui = await $.ui.mount({ ...paneAsk(24), plugin: 'mono-probe', requestId: 'mono-probe', surface: 'terminal' })
    await ui.drawn()
    await ui.unmount()
    return true
  } catch (err) {
    if (/Text prop "mono" is not allowed/.test(String(err))) return false
    throw err
  }
}

const releaseAt = (offset: number) => `${T.monoSince[0]}.${T.monoSince[1]}.${T.monoSince[2] + offset}`
const railRe = new RegExp(`^[${G.rail}${G.packetHead}${G.packetTail}${G.branch}${G.merge}]+$`)

test('a running connector keeps its length every frame: clipped at its width, the packet moving on the mocked timer', { plugins: [monoProbe] }, async ($, on) => {
  host(on)
  let hasMono = false
  engineVersion(on, () => releaseAt(hasMono ? 10 : -4))
  on('tool.check', () => ({ decision: 'allow' }))
  hasMono = await kitDrawsMono($)
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'r1' })
  await $.turn.start({ text: 'go', turnId: 'R1' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await drawn($, paneAsk(64), surface)
    expect((await ui.find({ key: 'link-gate' }))?.type).toBe('Client')
    const heads = new Set<number>()
    for (let frame = 0; frame < 30; frame += 1) {
      const tree = (await ui.drawn({ in: 'link-gate' })) as Drawn
      const texts: Drawn[] = []
      const walk = (n: unknown) => (isNode(n) ? (n.type === 'Text' ? texts.push(n) : (n.children ?? []).forEach(walk)) : undefined)
      walk(tree)
      const line = texts.map(textIn).join('')
      expect([tree.type, tree.props?.width, tree.props?.overflow]).toEqual(['Box', 64, 'hidden'])
      expect(cells(line)).toBe(64 + T.rail.spare)
      expect(texts.every(t => t.props?.mono === (hasMono ? true : undefined))).toBe(true)
      expect(railRe.test(line)).toBe(true)
      const head = [...line].slice(0, 64).indexOf(G.packetHead)
      if (head >= 0) heads.add(head)
      // A packet is a bright head with its trailing dot one cell behind.
      if (head > 0) expect([...line][head - 1]).toBe(G.packetTail)
      await ui.advance(T.timing.railStepMs)
    }
    expect(heads.size > 5).toBe(true)
    await ui.unmount()
  }
})

function textsWithMono(n: unknown, out: string[], at: string): string[] {
  if (!isNode(n)) return out
  const here = `${at}/${String(n.props?.key ?? n.type)}`
  if (n.type === 'Text' && n.props !== undefined && 'mono' in n.props) out.push(here)
  ;(n.children ?? []).forEach((c, i) => textsWithMono(c, out, `${here}[${i}]`))
  return out
}

/** A turn running with a check in the gate on an engine at `version`, drawn for a few frames: Texts naming `mono`, and the connectors' lines. */
async function facesFor($: Dollar, on: On, version: string | null | ((kit: boolean) => string)) {
  host(on)
  let pinned = typeof version === 'function' ? null : version
  engineVersion(on, () => pinned)
  on('tool.check', () => ({ decision: 'allow' }))
  let hasMono: boolean | undefined
  if (typeof version === 'function') {
    hasMono = await kitDrawsMono($)
    pinned = version(hasMono)
  }
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'r1' })
  await $.turn.start({ text: 'go', turnId: 'R1' })
  const named: string[] = []
  const lines: string[] = []
  const still = new RegExp(`^${G.rail}{64}$`)
  const walkLines = (n: unknown) => {
    if (!isNode(n)) return
    if (n.type === 'Text' && still.test(textIn(n))) lines.push(textIn(n))
    else (n.children ?? []).forEach(walkLines)
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await drawn($, paneAsk(64), surface)
    for (let frame = 0; frame < 3; frame += 1) {
      const tree = await ui.drawn()
      textsWithMono(tree, named, surface)
      walkLines(tree)
      for (const key of ['link-gate', 'link-receipt']) {
        if ((await ui.find({ key }))?.type !== 'Client') continue
        const rail = await ui.drawn({ in: key })
        textsWithMono(rail, named, `${surface}:${key}`)
        lines.push(textIn(rail))
      }
      await ui.advance(T.timing.railStepMs)
    }
    await ui.unmount()
  }
  return { named, lines, hasMono }
}

test('on an engine before the mono release nothing asks for the face, and the connectors still run', async ($, on) => {
  const { named, lines } = await facesFor($, on, releaseAt(-4))
  expect(named).toEqual([])
  expect(lines.length).toBe(2 * 2 * 3)
  expect(lines.every(l => cells(l) === 64 + T.rail.spare && railRe.test(l))).toBe(true)
  expect(lines.some(l => l.includes(G.packetHead) || l.includes(G.packetTail))).toBe(true)
})

test('an engine that will not say its version gets no monospaced face either', async ($, on) => {
  expect((await facesFor($, on, null)).named).toEqual([])
})

test('with motion off, the still connector is drawn without the face before the mono release', { options: { motion: 'off' } }, async ($, on) => {
  const { named, lines } = await facesFor($, on, releaseAt(-4))
  expect(named).toEqual([])
  expect(lines.length).toBe(2 * 2 * 3)
})

test('with motion off, the still connector keeps the face from the mono release', { plugins: [monoProbe], options: { motion: 'off' } }, async ($, on) => {
  const { named, lines, hasMono } = await facesFor($, on, kit => releaseAt(kit ? 0 : -4))
  expect(lines.length).toBe(2 * 2 * 3)
  expect(named.length).toBe(hasMono ? lines.length : 0)
})

// ================================================================ our own

test('secrets are masked in the log, on cards and in the drill-down, before they are cut', async ($, on) => {
  host(on)
  const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz'].join('_')
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 's1' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {}, text: 'failed', isError: true }))
  await $.turn.start({ text: 'go', turnId: 'Q1' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Push it'))
  await $.tool.call({ tool: 'Bash', command: `git push https://bob:${token}@github.com/x`, tool_use_id: 'q1', agentId: 's1' } as never)
  await $.tool.call({ tool: 'Bash', command: `gh auth --token ${token} status`, tool_use_id: 'q2' } as never)
  const ui = await drawn($, paneAsk(120))
  await ui.press({ key: 'card-s1' })
  await ui.press({ key: 'gate-shell' })
  const all = (await ui.findAll({ type: 'Text', text: /./ })).map(n => n.text).join('\n')
  expect(all).not.toContain('abcdefghij')
  expect(all).toContain('•••')
  await ui.unmount()
})

test('an ask raised inside a call is settled once next() returns: cleared when it ran, denied when refused', async ($, on) => {
  host(on)
  on('tool.check', () => ({ decision: 'ask' }))
  // The person allows each ask; beneath, the second call is then refused, as a session refuses one.
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }) as never)
  on('tool.call', (_$, e) => (String((e as { command?: string }).command).startsWith('rm') ? { deny: 'refused' } : { result: {}, text: 'ok' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'z1' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'Bash', command: 'rm x', tool_use_id: 'z2' } as never).catch(() => undefined)
  const ui = await drawn($, paneAsk(64))
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: re(X.pendingWord) })).toBeUndefined()
  expect((await ui.findAll({ text: exact(X.decider.other) })).length).toBe(1)
  expect((await ui.findAll({ text: exact(X.drillWords.deny) })).length).toBe(1)
  expect((await ui.find({ text: exact(fill(L.callDenied, { text: 'Bash → rm x' })) }))?.props.color).toBe(T.palettes.theme.warn)
  await ui.unmount()
})

test('/roster answers each subcommand from the data, and an unknown layout gets the usage', async ($, on) => {
  host(on)
  let isPlaced = true
  const closed: string[] = []
  on('ui.open', () => (isPlaced ? { value: { isPlaced: true as const } } : { value: { isPlaced: false as const, reason: 'too narrow' } }) as never)
  on('ui.close', (_$, e) => (closed.push(e.id), { value: undefined }) as never)
  const run = async (args: string) => (await $.command.run({ command: T.pane.command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })).text
  const R = X.command
  expect(await run('')).toBe(R.opened)
  expect(await run('close')).toBe(R.closed)
  expect(closed).toEqual([PANE])
  expect(await run('layout diagonal')).toBe(R.layoutUsage)
  expect(await run('layout wide')).toBe(fill(R.layoutSet, { layout: 'wide' }))
  isPlaced = false
  expect(await run('layout mini')).toBe(fill(R.layoutHidden, { layout: 'mini', reason: 'too narrow' }))
  expect(await run('')).toBe(fill(R.hidden, { reason: 'too narrow' }))
  // The layout override sticks: mini draws the summary even docked.
  const ui = await drawn($, paneAsk(120))
  expect(await ui.find({ text: re(X.logTitle) })).toBeUndefined()
  await ui.unmount()
})

test('/roster reset empties the deck but keeps the model and the permission mode', async ($, on) => {
  host(on)
  quietModel(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await $.turn.start({ text: 'go', turnId: 'X1' })
  await step($, { model: 'claude-opus-5-5' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Something', { permissionMode: 'plan' }))
  expect((await $.command.run({ command: T.pane.command, args: 'reset', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })).text).toBe(X.command.reset)
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re('Something') })).toBeUndefined()
  expect(await ui.find({ text: mainTitle('Opus 5.5') })).toBeDefined()
  expect(await ui.find({ text: exact(fill(X.mode, { mode: 'plan' })) })).toBeDefined()
  expect(await ui.find({ text: exact(X.logEmpty) })).toBeDefined()
  await ui.unmount()
})

test('the status line says only what it has, joined by the data, and goes away with statusLine off', async ($, on) => {
  host(on, { status: false })
  const said: (string | undefined)[] = []
  on('ui.status', (_$, e) => (said.push(e.text), { value: undefined }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'st1' }))
  on('tool.check', () => ({ decision: 'deny' }))
  await $.turn.start({ text: 'go', turnId: 'ST' })
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 'st-k' })
  const S = X.status
  expect(said[said.length - 1]).toBe([fill(S.agents, { running: 1, total: 1 }), fill(S.denied, { n: 1 })].join(S.joiner))
  expect(said.some(s => s === undefined)).toBe(false)
})

test('with statusLine off, the status entry is cleared', { options: { statusLine: false } }, async ($, on) => {
  host(on, { status: false })
  const said: (string | undefined)[] = []
  on('ui.status', (_$, e) => (said.push(e.text), { value: undefined }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'st2' }))
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  expect(said.length > 0 && said.every(s => s === undefined)).toBe(true)
})

test('the layout turns two-column at the data\'s width and the header drops the brand below its narrow width', async ($, on) => {
  host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'lw1' }))
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  const columnsAt = async (cols: number) => {
    const ui = await drawn($, paneAsk(cols))
    const brand = await ui.find({ text: exact(X.brand) })
    // Two columns: the main box is half the body wide.
    const box = (await ui.findAll({ type: 'Box' })).find(b => b.props.borderColor === T.palettes.theme.main && b.props.borderStyle === 'round')
    await ui.unmount()
    return { brand: brand !== undefined, mainWidth: box?.props.width }
  }
  expect(await columnsAt(Z.wideFrom - 1)).toEqual({ brand: true, mainWidth: Z.wideFrom - 1 })
  expect(await columnsAt(Z.wideFrom)).toEqual({ brand: true, mainWidth: Math.floor((Z.wideFrom - Z.wideGap) / 2) })
  expect((await columnsAt(Z.narrowBelow - 1)).brand).toBe(false)
  expect((await columnsAt(Z.narrowBelow)).brand).toBe(true)
})

test("a card says its status in words from the data's width, and a glyph alone below it", async ($, on) => {
  const clock = host(on)
  await clock.advance(60_000)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'cw1' }))
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  // One card fills the agents panel: cardW is the body width.
  const word = `${G.running} ${X.statusWords.running}`
  const under = await drawn($, paneAsk(Z.cardStatusFrom - 1))
  expect(await under.find({ text: exact(word) })).toBeUndefined()
  expect(await under.find({ text: exact(G.running) })).toBeDefined()
  await under.unmount()
  const at = await drawn($, paneAsk(Z.cardStatusFrom))
  expect(await at.find({ text: exact(word) })).toBeDefined()
  await at.unmount()
})

test("the running receipt shows the turn's counts from the data's width", async ($, on) => {
  const clock = host(on)
  await clock.advance(60_000)
  await $.turn.start({ text: 'go', turnId: 'RC' })
  const counts = re(fill(X.turnCounts, { edits: `0 ${X.plurals.edit[1]}`, errors: `0 ${X.plurals.error[1]}` }))
  const under = await drawn($, paneAsk(Z.receiptCountsFrom - 1))
  expect(await under.find({ text: counts })).toBeUndefined()
  await under.unmount()
  const at = await drawn($, paneAsk(Z.receiptCountsFrom))
  expect(await at.find({ text: counts })).toBeDefined()
  await at.unmount()
})

test('a live clock ticks on the surface timer, and stops when its agent ends', async ($, on) => {
  const clock = host(on)
  await clock.advance(3_600_000)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ck1' }))
  await $.agent.spawn(spawnAsk('general-purpose', 'Work'))
  const ui = await drawn($, paneAsk(64))
  expect(textIn(await ui.drawn({ in: 'card-clock-ck1' }))).toBe('0:00')
  await ui.advance(T.timing.clockTickMs * 5)
  expect(textIn(await ui.drawn({ in: 'card-clock-ck1' }))).toBe('0:05')
  await ui.unmount()
  await clock.advance(70_000)
  await $.turn.complete({ answer: 'ok', durationMs: 70_000, isAborted: false, turnId: 'C', agentId: 'ck1', reason: 'answer' })
  const done = await drawn($, paneAsk(64))
  expect(textIn(await done.drawn({ in: 'card-clock-ck1' }))).toBe('1:10')
  await done.advance(T.timing.clockTickMs * 5)
  expect(textIn(await done.drawn({ in: 'card-clock-ck1' }))).toBe('1:10')
  await done.unmount()
})

test("another loop reads active until the data's quiet time, then idle; a finished one reads done", async ($, on) => {
  const clock = host(on)
  await clock.advance(3_600_000)
  quietModel(on)
  await step($, { agentId: 'lp1' })
  const dots = async () => {
    const ui = await drawn($, paneAsk(64))
    const found = await ui.find({ text: re(fill(X.loopsCountWide, { n: 1, active: 1 })) })
    await ui.unmount()
    return found !== undefined
  }
  await clock.advance(T.timing.loopActiveMs - 1)
  expect(await dots()).toBe(true)
  await clock.advance(1)
  expect(await dots()).toBe(false)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'L', agentId: 'lp1', reason: 'answer' })
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: exact(G.loopDone) })).toBeDefined()
  await ui.unmount()
})

test('a subagent that ends on max_tokens, fails, or is stopped is logged and drawn as such', async ($, on) => {
  const clock = host(on)
  await clock.advance(3_600_000)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `e${++n}` }))
  quietModel(on, usageOf(10, 5), 'max_tokens')
  for (const d of ['One', 'Two']) await $.agent.spawn(spawnAsk('general-purpose', d))
  await step($, { agentId: 'e1' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'E', agentId: 'e2', reason: 'error' })
  const ui = await drawn($, paneAsk(80))
  expect(await ui.find({ text: exact(L.maxTokens) })).toBeDefined()
  expect(await ui.find({ text: exact(`${G.running} ${X.maxTokens}`) })).toBeDefined()
  expect(await ui.find({ text: exact(X.statusWords.failed) })).toBeDefined()
  expect(await ui.find({ text: exact(`${G.failed} ${X.statusWords.failed}`) })).toBeDefined()
  await ui.unmount()
  await $.agent.spawn(spawnAsk('general-purpose', 'Three'))
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'E', agentId: 'e3', reason: 'aborted' })
  const after = await drawn($, paneAsk(80))
  expect(await after.find({ text: exact(X.statusWords.stopped) })).toBeDefined()
  await after.unmount()
})

test('viewing an agent filters the log to it and marks its lane', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `v${++n}` }))
  for (const d of ['A', 'B', 'C', 'D']) await $.agent.spawn(spawnAsk('general-purpose', `Task ${d}`))
  const ui = await drawn($, paneAsk(64, 'dock', { agentId: 'v2' }))
  expect(await ui.find({ text: exact(X.logTitleAgent) })).toBeDefined()
  expect((await ui.findAll({ text: /^spawned/ })).length).toBe(1)
  expect(await ui.find({ text: exact(G.viewed) })).toBeDefined()
  await ui.unmount()
})

test('an agent type offered with a matching description counts as the architect only with matchDescriptions', { options: { matchDescriptions: true } }, async ($, on) => {
  host(on)
  on('agent.offer', () => ({ isOffered: true }) as never)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'od1' }))
  await $.agent.offer({ agent: 'reviewer-bot', description: 'The architect who reviews plans' } as never).catch(() => undefined)
  await $.agent.spawn(spawnAsk('reviewer-bot', 'look it over'))
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: re(fill(X.archTitle, { label: T.config.architectLabel, state: X.advising })) })).toBeDefined()
  await ui.unmount()
})

// ================================================================ stored state from other versions, and the close control

/** The earliest agent-roster's records, as the engine kept them: `{ shape, value }` under the same keys, other fields. */
const OLD_ROSTER: Record<string, unknown> = {
  receipt: { shape: 'receipt-1', value: { turnId: 't', startedAt: 1, durationMs: 5, agents: 1, edits: 2, errors: 0, denied: 0, costAtStart: 1, costAdded: 0.5 } },
  main: { shape: 'main-1', value: { permissionMode: 'default', compactions: 3 } },
  usage: { shape: 'usage-1', value: { context: { tokens: 1000, window: 200_000 }, rateLimits: [], cost: 2, categories: [], categoriesMax: 0 } },
  loops: { shape: 'loops-1', value: { main: { model: 'claude-opus-5-5', steps: 4 } } },
  gate: { shape: 'gate-1', value: [{ id: 'g1', verdict: 'allow', tool: 'Bash', family: 'shell', inAgent: false, at: 1 }] },
  log: { shape: 'log-1', value: [{ at: 1, loop: 'main', kind: 'prompt', text: 'x' }] },
  view: { shape: 'view-1', value: { expanded: '', drill: '', layout: '', closed: false } },
  consults: { shape: 'consults-1', value: [{ id: 'c', label: 'x', startedAt: 1, endedAt: 0, inferred: true }] },
}

/** The same keys under this version's tag, every field the wrong type: the repair, not the tag, must hold these. */
const BROKEN_CURRENT: Record<string, unknown> = {
  receipt: { shape: STORE_SHAPE, value: { durationMs: 'soon', agents: null, costDelta: undefined, reason: 7 } },
  main: { shape: STORE_SHAPE, value: { model: 5, effort: { level: 'max' }, steps: 'two', speed: { tokPerS: 9 } } },
  usage: { shape: STORE_SHAPE, value: { pct: '40', tokens: Number.NaN, window: null, costUsd: 'free', limits: [{ kind: 'five_hour' }, 'x'], compactions: '1' } },
  agents: { shape: STORE_SHAPE, value: [{ id: 'a', ctx: 'lots', out: null, spawnedAt: 'then', tools: [null, { tool: 1 }] }, 'not a card'] },
  gate: { shape: STORE_SHAPE, value: { recent: [{ id: 'k', verdict: 'maybe', bucket: 'shell' }], totals: { shell: { rule: 'x' } } } },
  architect: { shape: STORE_SHAPE, value: { consults: [{ id: 'c', at: 'x' }], ids: [1, 'a'], lastAdvice: 4 } },
  view: { shape: STORE_SHAPE, value: { expanded: 3, gateOpen: 'everything', layout: 'diagonal' } },
  turn: { shape: STORE_SHAPE, value: { startedAt: 'x', costAtStart: 'y' } },
}

/** Answers `state.get` with `seeded` for each key until the mod writes that key; every other read goes to the kit. */
function seedState(on: On, seeded: Record<string, unknown>) {
  const left = new Map(Object.entries(seeded))
  on('state.get', (_$, e, next) => {
    const key = (e as { key?: string }).key ?? ''
    return left.has(key) ? ({ value: { value: left.get(key), version: 1 } } as never) : next(e)
  })
  on('state.set', (_$, e, next) => {
    left.delete((e as { key?: string }).key ?? '')
    return next(e)
  })
}

/** Every drawing, docked and inline, on the terminal and the desktop: the failures it shows instead of the deck. */
async function drawFailures($: Dollar): Promise<string[]> {
  const out: string[] = []
  const failed = re(X.drawFailed.split('{')[0] as string)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const placement of ['dock', 'inline'] as const) {
      const ui = await drawn($, paneAsk(80, placement), surface)
      const bad = await ui.find({ text: failed })
      if (bad) out.push(`${surface} ${placement}: ${bad.text}`)
      else if (!(await ui.find({ text: re(G.close) }))) out.push(`${surface} ${placement}: drew no deck`)
      await ui.unmount()
    }
  }
  return out
}

for (const [name, seeded] of [
  ['an older agent-roster', OLD_ROSTER],
  ['this version, every field broken', BROKEN_CURRENT],
] as const) {
  test(`state stored by ${name} draws without failing, reached by a session start`, async ($, on) => {
    host(on)
    seedState(on, seeded)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    expect(await drawFailures($)).toEqual([])
  })

  test(`state stored by ${name} draws without failing, reached by /roster with no session start (a reload mid-session)`, async ($, on) => {
    host(on)
    seedState(on, seeded)
    on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
    const r = await $.command.run({ command: T.pane.command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
    expect(r.text).toBe(X.command.opened)
    expect(await drawFailures($)).toEqual([])
  })
}

test('an older version\'s records read as blank, field by field, and a broken field never reaches a formatter', () => {
  const r = fixReceipt({ turnId: 't', durationMs: 5, agents: 1, costAdded: 0.5 })
  expect(r).toEqual({ durationMs: 5, agents: 1, edits: 0, errors: 0, costDelta: null, reason: '' })
  expect(fixReceipt('done')).toBe(null)
  expect(fixReceipt({ costDelta: undefined })?.costDelta).toBe(null)
  expect(fixMain({ permissionMode: 'x', model: 5, steps: 'two', speed: { tokPerS: 1 } })).toEqual(fixMain(undefined))
  const u = fixUsage({ costUsd: 'free', tokens: 12, limits: [{ kind: 'five_hour', pct: 3 }, { kind: 'x' }, 7] })
  expect([u.costUsd, u.tokens, u.limits]).toEqual([null, 12, [{ kind: 'five_hour', pct: 3, resetsAt: null }]])
  expect(fixView({ expanded: '', gateOpen: 'shell', layout: '' })).toEqual({ expanded: null, gateOpen: 'shell', layout: null })
  expect(fixGate({ recent: [{ id: 'k', verdict: 'allow', bucket: 'shell' }, { id: 'j', verdict: 'deny', bucket: 'file' }] }).recent.map(c => c.id)).toEqual(['j'])
  expect(fixCard({ id: 'a', tools: [null, { tool: 'Bash', text: 'ls', isError: 'no' }] }).tools).toEqual([{ tool: 'Bash', text: 'ls', isError: false }])
})

test('every formatter is total: a value that is not a finite number prints as the dash, never throws', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number, null as unknown as number, 'x' as unknown as number]
  for (const n of bad) {
    expect([tokensShort(n), dollars(n), durationShort(n), stopwatch(n)]).toEqual([G.dash, G.dash, G.dash, G.dash])
    expect(timingLabel({ ttftMs: n })).toBe(fill(X.ttft, { s: G.dash }))
    expect(meter(n, 4)).toEqual({ on: '', off: G.gaugeOff.repeat(4) })
  }
  // Just inside: real numbers still print.
  expect([tokensShort(999), dollars(99.994), durationShort(59_400), stopwatch(59_999)]).toEqual(['999', '$99.99', '59s', '0:59'])
})

for (const placement of ['dock', 'inline'] as const) {
  test(`the close control at the top row's trailing edge closes the pane like /roster close (${placement})`, async ($, on) => {
    host(on)
    const closed: string[] = []
    on('ui.close', (_$, e) => (closed.push(e.id), { value: undefined }) as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await drawn($, paneAsk(placement === 'dock' ? 64 : 80, placement), surface)
      const tree = (await ui.drawn()) as Drawn
      // The control is the last thing on the first row, a plain dismiss Button that draws the data's glyph and is named by its label.
      const top = (tree.children ?? []).filter(isNode)[0]
      const last = (top?.children ?? []).filter(isNode).pop()
      const control = (last?.children ?? []).filter(isNode)[0]
      expect([control?.type, control?.props?.role, control?.props?.plain, control?.props?.label, textIn(control)]).toEqual(['Button', 'dismiss', true, X.closeLabel, G.close])
      await ui.press({ key: 'dismiss' })
      expect(closed.length).toBe(surface === 'terminal' ? 1 : 2)
      await ui.unmount()
    }
    expect(closed).toEqual([PANE, PANE])
  })
}

test('the top row leaves the close control its cells: the header drops pieces from its end before it would spill', async ($, on) => {
  host(on)
  for (const cols of [T.pane.minColumns, Z.narrowBelow - 1, Z.narrowBelow, 40, 64]) {
    const ui = await drawn($, paneAsk(cols))
    const top = ((await ui.drawn()) as Drawn).children?.filter(isNode)[0]
    const line = top?.children?.filter(isNode)[0]
    expect([top?.props?.width, line?.props?.width]).toEqual([cols, cols - cells(G.close) - Z.closeGap])
    expect(spills(top, cols)).toEqual([])
    await ui.unmount()
  }
})

test('a record under the current shape tag reads; the same record under another tag is declined', async ($, on) => {
  host(on)
  const record = { ...fixMain(undefined), model: 'claude-haiku-4-5' }
  let stored: unknown = undefined
  on('state.get', (_$, e, next) => ((e as { key?: string }).key === 'main' ? ({ value: { value: stored, version: 1 } } as never) : next(e)))
  for (const [shape, model] of [
    [STORE_SHAPE, 'Haiku 4.5'],
    ['main-1', G.dash],
  ] as const) {
    stored = { shape, value: record }
    const ui = await drawn($, paneAsk(64))
    expect(await ui.find({ text: exact(fill(X.main, { model })) })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished line keeps its kind through the repair; an older kind reads as info', () => {
  expect(fixLog([{ kind: 'done' }, { kind: 'consult' }, { kind: 'error' }, { kind: 'prompt' }]).map(l => l.kind)).toEqual(['done', 'consult', 'error', 'info'])
})

test('a measurement that carries a cost shows it; one without leaves no cost', async ($, on) => {
  host(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 1_000_000, tokens: 1000, percent: 0.1 }, rateLimits: [], changed: ['cost'], cost: { usd: 1.25 } } as never)
  const ui = await drawn($, paneAsk(64))
  expect(await ui.find({ text: exact(dollars(1.25)) })).toBeDefined()
  await ui.unmount()
  await $.session.measure({ context: { window: 1_000_000, tokens: 1000, percent: 0.1 }, rateLimits: [], changed: ['cost'] } as never)
  const after = await drawn($, paneAsk(64))
  expect(await after.find({ text: exact(dollars(1.25)) })).toBeUndefined()
  await after.unmount()
})

test('the receipt stays lit while a review runs after its turn, and dims once the review ends', async ($, on) => {
  host(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'go', turnId: 'RV' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)
  await row($, [{ type: 'server_tool_use', id: 'srvR', name: 'advisor', input: {} }])
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'RV', reason: 'answer' } as never)
  const reviewing = fill(X.reviewing, { label: T.config.architectLabel.toLowerCase() })
  /** The receipt's frame: with no agent cards drawn, the one bordered Box that sets borderDimColor. */
  const receiptBox = (n: unknown): Drawn | undefined => {
    if (!isNode(n)) return undefined
    if (n.type === 'Box' && n.props !== undefined && 'borderDimColor' in n.props) return n
    return (n.children ?? []).flat(Infinity as 1).map(receiptBox).find(Boolean)
  }
  const during = await drawn($, paneAsk(64))
  expect(await during.find({ text: exact(reviewing) })).toBeDefined()
  expect(receiptBox(await during.drawn())?.props?.borderDimColor).toBe(false)
  await during.unmount()
  await row($, [{ type: 'advisor_tool_result', tool_use_id: 'srvR', content: { type: 'advisor_redacted_result' } }])
  const after = await drawn($, paneAsk(64))
  expect(await after.find({ text: exact(reviewing) })).toBeUndefined()
  expect(receiptBox(await after.drawn())?.props?.borderDimColor).toBe(true)
  await after.unmount()
})

// ================================================================ golden frames: stacked cards (DESIGN.md)

/** Every bordered card Box in a drawing, with the row Box that holds it and that row's parent. */
function cardBoxes(n: unknown, parent: Drawn | null = null, grand: Drawn | null = null, out: { card: Drawn; row: Drawn | null; stack: Drawn | null }[] = []) {
  if (!isNode(n)) return out
  const kids = (n.children ?? []).flat(Infinity as 1) as unknown[]
  const isCard = n.type === 'Box' && n.props?.borderStyle !== undefined && kids.some(k => isNode(k) && k.type === 'Button' && String(k.props?.key ?? '').startsWith('card-'))
  if (isCard) out.push({ card: n, row: parent, stack: grand })
  for (const k of kids) cardBoxes(k, n, parent, out)
  return out
}

/** The width of the column the agents panel sits in: the whole pane, or its half from the data's `wideFrom`. */
const agentsColumn = (cols: number) => (cols >= Z.wideFrom ? Math.floor((cols - Z.wideGap) / 2) : cols)

for (const cols of [40, 66, 110]) {
  test(`up to maxCards agents are full-width cards stacked one above another, docked at ${cols} columns`, async ($, on) => {
    host(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `st${++n}` }))
    await $.turn.start({ text: 'fan out', turnId: 'ST' })
    const tasks = ['Write the parser tests', 'Map the call sites', 'Review the lexer']
    for (const t of tasks.slice(0, T.config.maxCards)) await $.agent.spawn(spawnAsk('general-purpose', t))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await drawn($, paneAsk(cols), surface)
      const found = cardBoxes(await ui.drawn())
      expect(found.length).toBe(Math.min(tasks.length, T.config.maxCards))
      for (const [i, f] of found.entries()) {
        // Its own row: the row holds this card alone, so the card's top border starts a row of its own.
        expect((f.row?.children ?? []).flat(Infinity as 1).filter(isNode).length).toBe(Z.cardsPerRow)
        // Full width of the agents column.
        expect(f.card.props?.width).toBe(agentsColumn(cols))
        // In order: card i+1's row comes after card i's in the same stack.
        expect(f.stack).toBe(found[0]?.stack ?? null)
        const rows = (f.stack?.children ?? []).flat(Infinity as 1)
        if (i > 0) expect(rows.indexOf(f.row) > rows.indexOf(found[i - 1]?.row)).toBe(true)
        const key = (f.card.children ?? []).flat(Infinity as 1).find(x => isNode(x) && x.type === 'Button') as Drawn | undefined
        expect((tasks[i] as string).startsWith(String(key?.props?.label ?? '?'))).toBe(true)
      }
      expect(await ui.find({ text: re(G.laneBar) })).toBeUndefined()
      expect(spills(await ui.drawn(), cols)).toEqual([])
      await ui.unmount()
    }
  })
}

test('more than maxCards agents compress to swimlanes, one row each, on terminal and desktop', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ln${++n}` }))
  await $.turn.start({ text: 'fan out', turnId: 'LN' })
  for (let i = 0; i <= T.config.maxCards; i += 1) await $.agent.spawn(spawnAsk('general-purpose', `lane task ${i}`))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 66, 110]) {
      const ui = await drawn($, paneAsk(cols), surface)
      const tree = await ui.drawn()
      expect(cardBoxes(tree)).toEqual([])
      // One lane a row, each with its key button, as many as the data keeps.
      const keys: string[] = []
      const walk = (x: unknown) => {
        if (!isNode(x)) return
        if (x.type === 'Button' && String(x.props?.key ?? '').startsWith('card-')) keys.push(String(x.props?.key))
        for (const k of (x.children ?? []).flat(Infinity as 1)) walk(k)
      }
      walk(tree)
      expect(keys.length).toBe(Math.min(T.config.maxCards + 1, T.keep.lanes))
      expect(await ui.find({ text: re(G.laneBar) })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('each stacked row of cards takes its rows from the log, by the data, and each card keeps its own key', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `lg${++n}` }))
  for (let i = 0; i < 12; i += 1) await $.turn.start({ text: `prompt ${i}`, turnId: `LG${i}` })
  const logRows = async (bodyRows: number) => {
    const ask = paneAsk(66)
    const ui = await $.ui.mount({ ...ask, props: { ...ask.props, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
    const rows = (await ui.findAll({ type: 'Text', text: /^(\d\d|--):(\d\d|--):(\d\d|--)$/ })).length
    const keys = cardBoxes(await ui.drawn()).map(f => ((f.card.children ?? []).flat(Infinity as 1).find(x => isNode(x) && x.type === 'Button') as Drawn | undefined)?.props?.hotkey)
    await ui.unmount()
    return { rows, keys }
  }
  await $.agent.spawn(spawnAsk('general-purpose', 'one'))
  // A body where one card leaves the log between its minimum and maximum.
  let body = 20
  while ((await logRows(body)).rows <= Z.logRowsMin && body < 80) body += 1
  const one = await logRows(body)
  expect(one.rows > Z.logRowsMin && one.rows < Z.logRowsMax).toBe(true)
  await $.agent.spawn(spawnAsk('general-purpose', 'two'))
  await $.agent.spawn(spawnAsk('general-purpose', 'three'))
  const three = await logRows(body + 2 * Z.rows.cardStack)
  expect(three.rows).toBe(one.rows)
  expect(three.keys).toEqual(['1', '2', '3'])
})

// ================================================================ golden frames: beyond the reference layout (DESIGN.md)

/** The bordered card Box of the agent with `id`. */
async function cardOf($: Dollar, id: string, cols = 66): Promise<Drawn | undefined> {
  const ui = await drawn($, paneAsk(cols))
  const card = cardBoxes(await ui.drawn()).find(f =>
    (f.card.children ?? []).flat(Infinity as 1).some(x => isNode(x) && x.type === 'Button' && x.props?.key === `card-${id}`),
  )?.card
  await ui.unmount()
  return card
}

test('the main box names the current task: the first line of the prompt the person typed, and none before one', async ($, on) => {
  host(on)
  const before = await drawn($, paneAsk(66))
  expect(await before.find({ text: re(fill(X.mainTask, { task: '' }).trim()) })).toBeUndefined()
  await before.unmount()
  await $.turn.start({ text: '\n  fix the parser  \nand then the lexer', turnId: 'TK1' })
  const ui = await drawn($, paneAsk(66))
  expect(await ui.find({ text: exact(fill(X.mainTask, { task: 'fix the parser' })) })).toBeDefined()
  await ui.unmount()
  // A turn the engine opened (a hand-back, a notification) is a message, not a task: the task stays.
  await $.turn.start({ text: '<task-notification>\ndone</task-notification>', turnId: 'TK2' })
  const after = await drawn($, paneAsk(66))
  expect(await after.find({ text: exact(fill(X.mainTask, { task: 'fix the parser' })) })).toBeDefined()
  await after.unmount()
})

test('the steps row follows the main loop\'s task list (TodoWrite, TaskCreate, TaskUpdate) and is absent without one', async ($, on) => {
  host(on)
  let next = 0
  on('tool.call', (_$, e) => (e.tool === T.tools.taskCreate ? { result: { task: { id: `t${++next}`, subject: 's' } }, text: 'ok' } : { result: {}, text: 'ok' }) as never)
  await $.turn.start({ text: 'go', turnId: 'SP' })
  const steps = async () => {
    const ui = await drawn($, paneAsk(66))
    const row = (await ui.find({ text: new RegExp(`^${fill(X.mainSteps, { done: 'X', total: 'Y' }).replace('X', '\\d+').replace('Y', '\\d+')}$`) }))?.text ?? null
    await ui.unmount()
    return row
  }
  expect(await steps()).toBe(null)
  const todo = (status: string) => ({ content: 'c', status, activeForm: 'a' })
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw1', todos: [todo('completed'), todo('in_progress'), todo('pending')] } as never)
  expect(await steps()).toBe(fill(X.mainSteps, { done: 1, total: 3 }))
  // A subagent's list is its own: the main loop's row does not move.
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw2', agentId: 'sub', todos: [todo('completed')] } as never)
  expect(await steps()).toBe(fill(X.mainSteps, { done: 1, total: 3 }))
  // The task tools: a fresh list written empty, then two created, one completed, one deleted.
  await $.tool.call({ tool: T.tools.todoWrite, tool_use_id: 'tw3', todos: [] } as never)
  expect(await steps()).toBe(null)
  await $.tool.call({ tool: T.tools.taskCreate, tool_use_id: 'tc1', subject: 'a', description: 'a' } as never)
  await $.tool.call({ tool: T.tools.taskCreate, tool_use_id: 'tc2', subject: 'b', description: 'b' } as never)
  expect(await steps()).toBe(fill(X.mainSteps, { done: 0, total: 2 }))
  await $.tool.call({ tool: T.tools.taskUpdate, tool_use_id: 'tu1', taskId: 't1', status: 'completed' } as never)
  expect(await steps()).toBe(fill(X.mainSteps, { done: 1, total: 2 }))
  await $.tool.call({ tool: T.tools.taskUpdate, tool_use_id: 'tu2', taskId: 't2', status: 'deleted' } as never)
  expect(await steps()).toBe(fill(X.mainSteps, { done: 1, total: 1 }))
})

for (const how of ['branch', 'worktree', 'no branch', 'no repo'] as const) {
  test(`the main box names the repo and its branch from the working copy, without running git (${how})`, async ($, on) => {
    host(on)
    on('ui.open', () => ({ value: { isPlaced: true as const } }) as never)
    on('session.repo', () => ({ value: how === 'no repo' ? null : { root: '/w/claude-mods', remote: null, internal: false, name: null } }) as never)
    on('session.cwd', () => ({ value: '/w/claude-mods' }) as never)
    on('fs.read', (_$, e) => {
      const path = String((e as { path?: string }).path ?? '').replace(/\\/g, '/')
      if (how === 'branch' && path.endsWith('/claude-mods/.git/HEAD')) return { value: 'ref: refs/heads/feature-x\n' } as never
      if (how === 'worktree' && path.endsWith('/claude-mods/.git')) return { value: 'gitdir: /w/main/.git/worktrees/wt1\n' } as never
      if (how === 'worktree' && path.endsWith('/worktrees/wt1/HEAD')) return { value: 'ref: refs/heads/agent-wt\n' } as never
      return { deny: 'no such file' } as never
    })
    await $.command.run({ command: T.pane.command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
    const ui = await drawn($, paneAsk(66))
    const want = {
      branch: fill(X.repoBranch, { repo: 'claude-mods', branch: 'feature-x' }),
      worktree: fill(X.repoBranch, { repo: 'claude-mods', branch: 'agent-wt' }),
      'no branch': fill(X.repoOnly, { repo: 'claude-mods' }),
      'no repo': null,
    }[how]
    if (want === null) expect(await ui.find({ text: re('claude-mods') })).toBeUndefined()
    else expect(await ui.find({ text: exact(want) })).toBeDefined()
    await ui.unmount()
  })
}

test('a card shows its worktree when the agent was spawned with worktree isolation, and nothing more when not', async ($, on) => {
  host(on)
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id === 'iso' ? 'wt1' : 'plain1' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  await $.turn.start({ text: 'go', turnId: 'WT' })
  // The Agent call with worktree isolation, then the spawn it makes (the kit cannot spawn from beneath a call).
  await $.tool.call({ tool: T.agentTool, tool_use_id: 'iso', isolation: 'worktree', prompt: 'p', description: 'isolated work', subagent_type: 'Explore' } as never)
  await $.agent.spawn({ ...spawnAsk('Explore', 'isolated work'), tool_use_id: 'iso', cwd: '/w/.claude/worktrees/agent-7f3a' })
  await $.agent.spawn(spawnAsk('Explore', 'shared work'))
  const isolated = await cardOf($, 'wt1')
  const shared = await cardOf($, 'plain1')
  expect(textIn(isolated)).toContain(fill(X.cardWorktree, { name: 'agent-7f3a' }))
  expect(textIn(shared)).not.toContain(X.cardWorktreeBare)
})

test('a named agent shows its type beside its name; an unnamed one its type alone', async ($, on) => {
  host(on)
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: (e as { name?: string }).name ? 'named1' : 'anon1' }))
  await $.turn.start({ text: 'go', turnId: 'NM' })
  await $.agent.spawn(spawnAsk('Explore', 'scouting', { name: 'scout' }))
  await $.agent.spawn(spawnAsk('Explore', 'looking'))
  expect(textIn(await cardOf($, 'named1'))).toContain(fill(X.namedType, { name: 'scout', type: 'Explore' }))
  const anon = textIn(await cardOf($, 'anon1'))
  expect(anon).toContain('Explore')
  expect(anon).not.toContain(fill(X.namedType, { name: '', type: 'Explore' }).trim())
})

test('each agent keeps its own accent: its card border and its name in the log match, stable by id', async ($, on) => {
  host(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `acc${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'AC' })
  await $.agent.spawn(spawnAsk('Explore', 'first look'))
  await $.agent.spawn(spawnAsk('Explore', 'second look'))
  for (const id of ['acc1', 'acc2']) {
    const accent = accentFor(id, T.accents.theme, T.palettes.theme.agent)
    expect(T.accents.theme).toContain(accent)
    expect((await cardOf($, id))?.props?.borderColor).toBe(accent)
    const ui = await drawn($, paneAsk(66))
    const label = clip(id === 'acc1' ? 'first look' : 'second look', Z.spawnWhoChars)
    expect((await ui.find({ type: 'Text', text: exact(label) }))?.props.color).toBe(accent)
    await ui.unmount()
  }
  expect(accentFor('acc1', T.accents.theme, 'x')).toBe(accentFor('acc1', T.accents.theme, 'y'))
  expect(accentFor('acc1', [], 'fallback')).toBe('fallback')
  // The main loop and the gate keep their own colours in the log.
  const ui = await drawn($, paneAsk(66))
  expect((await ui.find({ type: 'Text', text: exact(X.who.you) }))?.props.color).toBe(T.palettes.theme.text)
  await ui.unmount()
})

test('the main box rows the additions take come out of the log, by the data', async ($, on) => {
  host(on)
  // Plenty of log lines that set no task: failed edits by a subagent.
  on('tool.call', () => ({ result: {}, text: 'ok', isError: true }) as never)
  for (let i = 0; i < 14; i += 1) await $.tool.call({ tool: 'Edit', tool_use_id: `le${i}`, agentId: 'x', file_path: `/f${i}` } as never)
  const rows = async (bodyRows: number) => {
    const ask = paneAsk(66)
    const ui = await $.ui.mount({ ...ask, props: { ...ask.props, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
    const n = (await ui.findAll({ type: 'Text', text: /^(\d\d|--):(\d\d|--):(\d\d|--)$/ })).length
    await ui.unmount()
    return n
  }
  let body = 10
  while ((await rows(body)) <= Z.logRowsMin && body < 80) body += 1
  const before = await rows(body + 1)
  expect(before > Z.logRowsMin && before < Z.logRowsMax).toBe(true)
  await $.turn.start({ text: 'a task now', turnId: 'LT' })
  expect(await rows(body + 1 + Z.rows.task)).toBe(before)
})
