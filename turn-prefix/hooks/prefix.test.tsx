//! turn-prefix tests: the shipped rules, the pure prefix rules, and each hook
//! through the engine: a prefixed prompt is stripped, its turn's requests go
//! out on the rule's model or effort, the next turn goes back, the line under
//! the answer names the model that answered, the draft is painted and named
//! above the prompt as it is typed, and the band names the running switch.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/turn-prefix'
import type { Rule } from '../types'
import { bind, countsOrigin, enqueue, fill, prefixSpan, ruleByPrefix, ruleFor, stepRule, strip } from './rules'

const HAIKU = T.rules.find(r => r.model !== undefined)!
const MAX = T.rules.find(r => r.effort !== undefined)!
const SESSION_MODEL = 'claude-opus-5-5'
const SESSION_EFFORT = 'high'

/** Fills a line the way the mod does. */
function line(template: string, rule: Rule, model = ''): string {
  return fill(template, { glyph: T.glyph, label: rule.label, prefix: rule.prefix, model })
}

interface World {
  submitted: { text: string }[]
  steps: { model: string; effort: unknown; agentId?: string }[]
  painted: { text?: string; decorations: unknown[] }[]
}

/** Hooks beneath the plugin that stand for the engine, recording what reached it. */
function engine(on: On): World {
  const world: World = { submitted: [], steps: [], painted: [] }
  mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.submit', (_, e) => {
    world.submitted.push({ text: e.text })
    return { text: e.text }
  })
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length } as never
  })
  on('prompt.change', (_, e) => ({ text: e.text, cursor: e.cursor }) as never)
  // The engine's own band, drawn beneath the plugin's line.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('prompt.paint', (_, e) => {
    world.painted.push({ text: e.text, decorations: [...e.decorations] })
    return { value: { isPainted: true, text: e.text ?? '', cursor: 0 } } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: (e as { answer?: string }).answer ?? 'answer' }) as never)
  on('turn.step', async function* (_, e) {
    world.steps.push({ model: e.model, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    yield { kind: 'text', index: 0, text: 'ok' } as never
    // The API answers with the full id of the model the request named.
    const model = e.model === 'haiku' ? 'claude-haiku-5-5' : e.model
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model, input_tokens: 10, output_tokens: 5 } } as never
  })
  return world
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** Submits a prompt as the person typed it at the composer. */
function submit($: Dollar, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never) as Promise<{ text?: string; drop?: string }>
}

/** Runs one model request of a turn and drains its stream. */
async function step($: Dollar, turnId: string, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId, index: 0, model: SESSION_MODEL, effort: SESSION_EFFORT, messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of stream) void _
}

/** A whole main turn: start, `requests` steps, complete; resolves to the text shown under the answer. */
async function turn($: Dollar, turnId: string, text: string, requests = 1): Promise<string> {
  await $.turn.start({ text, turnId } as never)
  for (let i = 0; i < requests; i++) await step($, turnId)
  const done = (await $.turn.complete({ turnId, durationMs: 1000, reason: 'answer', answer: 'the answer', isAborted: false } as never)) as { text: string }
  return done.text
}

/** One edit at the composer: `inputText` typed over `[start, end)` of `text`. */
function edit($: Dollar, text: string, inputText: string, start = text.length, end = start) {
  return ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string }> }).edit({ origin: { kind: 'composer' }, text, cursor: text.length, start, end, inputText })
}

/** The band above the prompt, mounted on a surface. */
function band(surface: 'terminal' | 'desktop', isWorking: boolean) {
  return {
    plugin: 'turn-prefix',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } },
  } as never
}

// ---------------------------------------------------------------- shipped data

test('shipped rules: _ runs the turn on Haiku, + thinks at max effort, each switches only what it names', () => {
  const underscore = ruleByPrefix('_', T)!
  expect(underscore.model).toBe('haiku')
  expect(underscore.effort).toBeUndefined()
  const plus = ruleByPrefix('+', T)!
  expect(plus.effort).toBe('max')
  expect(plus.model).toBeUndefined()
  // Every rule switches something, and no two share a prefix.
  for (const rule of T.rules) {
    expect(rule.prefix.length).toBeGreaterThan(0)
    expect(rule.model !== undefined || rule.effort !== undefined).toBe(true)
  }
  expect(new Set(T.rules.map(r => r.prefix)).size).toBe(T.rules.length)
  expect(T.origins).toContain('composer')
  expect(T.pendingMax).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- pure rules

test('ruleFor: the prefix at the start, past leading spaces; nothing elsewhere; doubled is literal', () => {
  expect(ruleFor('_ what is this', T)).toBe(HAIKU)
  expect(ruleFor('_what is this', T)).toBe(HAIKU)
  expect(ruleFor('   _ indented', T)).toBe(HAIKU)
  expect(ruleFor('+ think hard', T)).toBe(MAX)
  expect(ruleFor('plain prompt', T)).toBeUndefined()
  expect(ruleFor('a_b + c', T)).toBeUndefined()
  expect(ruleFor('', T)).toBeUndefined()
  expect(ruleFor('__init__.py is broken', T)).toBeUndefined()
  expect(ruleFor('++i overflows', T)).toBeUndefined()
  // With doubling not literal, a doubled prefix switches too.
  expect(ruleFor('__init__', { ...T, doubledIsLiteral: false })).toBe(HAIKU)
})

test('ruleFor: the longest matching prefix wins', () => {
  const both = { ...T, rules: [...T.rules, { prefix: '+!', label: 'both', model: 'haiku', effort: 'max' as const, color: 'error' }] }
  expect(ruleFor('+! go', both)?.label).toBe('both')
  expect(ruleFor('+ go', both)?.label).toBe(MAX.label)
})

test('strip removes the prefix and the space after it, and nothing else', () => {
  expect(strip('_ what is this', HAIKU)).toBe('what is this')
  expect(strip('_what', HAIKU)).toBe('what')
  expect(strip('  +   deep _ thought  ', MAX)).toBe('deep _ thought  ')
  expect(strip('_', HAIKU)).toBe('')
  expect(prefixSpan('  _ hi', HAIKU)).toEqual({ start: 2, end: 3 })
  expect(prefixSpan('+ hi', MAX)).toEqual({ start: 0, end: 1 })
})

test('countsOrigin: the person at a composer counts; peers, plugins and notifications do not', () => {
  expect(countsOrigin('composer', T)).toBe(true)
  expect(countsOrigin('bridge', T)).toBe(true)
  expect(countsOrigin(undefined, T)).toBe(true)
  for (const kind of ['peer', 'plugin', 'task-notification', 'scheduled-trigger', 'sdk']) expect(countsOrigin(kind, T)).toBe(false)
})

test('bind: a turn takes its own prompt; idle ones it did not take are dropped, queued ones wait, capped', () => {
  const idle = { text: 'a', prefix: '_', queued: false }
  const queued = { text: 'b', prefix: '+', queued: true }
  expect(bind([idle, queued], 'a', T)).toEqual({ prefix: '_', pending: [queued] })
  expect(bind([idle, queued], 'b', T)).toEqual({ prefix: '+', pending: [] })
  expect(bind([idle, queued], 'other', T)).toEqual({ prefix: '', pending: [queued] })
  expect(bind([], 'x', T)).toEqual({ prefix: '', pending: [] })
  let list = [] as ReturnType<typeof enqueue>
  for (let i = 0; i < T.pendingMax + 3; i++) list = enqueue(list, { text: `q${i}`, prefix: '_', queued: true }, T)
  expect(list.length).toBe(T.pendingMax)
  expect(list[0]!.text).toBe(`q3`)
})

test("stepRule: a main request takes its turn's rule; a subagent's only with applyToAgents", () => {
  const active = { t1: { prefix: HAIKU.prefix, model: '' } }
  expect(stepRule(active, 't1', undefined, T)).toBe(HAIKU)
  expect(stepRule(active, 't2', undefined, T)).toBeUndefined()
  expect(stepRule(active, 'sub', 'a1', { ...T, applyToAgents: false })).toBeUndefined()
  expect(stepRule(active, 'sub', 'a1', { ...T, applyToAgents: true })).toBe(HAIKU)
  expect(stepRule({}, 'sub', 'a1', { ...T, applyToAgents: true })).toBeUndefined()
  // A rule removed from the data since it was stored switches nothing.
  expect(stepRule({ t1: { prefix: '~', model: '' } }, 't1', undefined, T)).toBeUndefined()
})

// ---------------------------------------------------------------- through the engine

test('_ runs that turn on Haiku: prefix stripped, every request names haiku, effort kept, line under the answer', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ what does this regex do')
  expect(world.submitted).toEqual([{ text: 'what does this regex do' }])
  const under = await turn($, 't1', 'what does this regex do', 3)
  expect(world.steps).toEqual([0, 1, 2].map(() => ({ model: HAIKU.model, effort: SESSION_EFFORT })))
  expect(under).toBe(line(T.text.done, HAIKU, 'claude-haiku-5-5'))
})

test('+ thinks at max effort for that turn and keeps the session model', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '+ design the cache layer')
  expect(world.submitted[0]!.text).toBe('design the cache layer')
  const under = await turn($, 't1', 'design the cache layer', 2)
  expect(world.steps).toEqual([0, 1].map(() => ({ model: SESSION_MODEL, effort: MAX.effort })))
  expect(under).toBe(line(T.text.done, MAX, SESSION_MODEL))
})

test('only that turn: the next plain prompt goes back to the session model and effort, answer untouched', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ quick one')
  await turn($, 't1', 'quick one')
  await submit($, 'now the real work')
  const under = await turn($, 't2', 'now the real work', 2)
  expect(world.steps.slice(1)).toEqual([0, 1].map(() => ({ model: SESSION_MODEL, effort: SESSION_EFFORT })))
  expect(under).toBe('the answer')
  // A continuation turn with no typed prompt is not switched either.
  await turn($, 't3', '')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })
})

test('subagents a Haiku turn starts keep their own model unless applyToAgents', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ fan out')
  await $.turn.start({ text: 'fan out', turnId: 't1' } as never)
  await step($, 'agent-turn', 'a1')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT, agentId: 'a1' })
  // A subagent's own end leaves the main turn's switch in place.
  const agentEnd = (await $.turn.complete({ turnId: 'agent-turn', agentId: 'a1', durationMs: 5, reason: 'answer', answer: 'sub', isAborted: false } as never)) as { text: string }
  expect(agentEnd.text).toBe('sub')
  await step($, 't1')
  expect(world.steps.at(-1)).toEqual({ model: HAIKU.model, effort: SESSION_EFFORT })
})

test('a prefix with nothing after it is not sent, and says why', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const result = await submit($, '_   ')
  expect(result.drop).toBe(line(T.text.empty, HAIKU))
  expect(world.submitted).toEqual([])
  // Nothing was left waiting: the next turn with any text runs as the session's.
  await turn($, 't1', '')
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
})

test('slash commands, hidden prompts, peers and doubled prefixes pass exactly as typed', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '__init__.py fails to import')
  await submit($, '_ from a peer', { origin: { kind: 'peer' } })
  await submit($, '_ hidden', { isMeta: true })
  expect(world.submitted.map(s => s.text)).toEqual(['__init__.py fails to import', '_ from a peer', '_ hidden'])
  await turn($, 't1', '__init__.py fails to import')
  await turn($, 't2', '_ from a peer')
  expect(world.steps.every(s => s.model === SESSION_MODEL && s.effort === SESSION_EFFORT)).toBe(true)
})

test('a prefixed prompt typed while a turn runs waits for its own turn and leaves the running one alone', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.turn.start({ text: 'long job', turnId: 't1' } as never)
  await submit($, '_ then summarise', { turnId: 't1' })
  await step($, 't1')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })
  await $.turn.complete({ turnId: 't1', durationMs: 1, reason: 'answer', answer: 'done', isAborted: false } as never)
  const under = await turn($, 't2', 'then summarise')
  expect(world.steps.at(-1)).toEqual({ model: HAIKU.model, effort: SESSION_EFFORT })
  expect(under).toBe(line(T.text.done, HAIKU, 'claude-haiku-5-5'))
})

test('a subagent run that starts with the same text does not take the waiting prompt', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ summarise the log')
  await $.turn.start({ text: 'summarise the log', turnId: 'sub1', agentId: 'a1' } as never)
  await step($, 'sub1', 'a1')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT, agentId: 'a1' })
  await turn($, 't1', 'summarise the log')
  expect(world.steps.at(-1)).toEqual({ model: HAIKU.model, effort: SESSION_EFFORT })
})

test('an idle prefixed prompt a later hook rewrote does not switch some other turn', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ short')
  // The turn starts with other text (a hook beneath rewrote it): no binding, nothing left waiting.
  await turn($, 't1', 'short, with context added')
  await turn($, 't2', 'short')
  expect(world.steps.every(s => s.model === SESSION_MODEL)).toBe(true)
})

test('an interrupted switched turn still names its switch, without a model if no request came back', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await submit($, '+ plan it')
  await $.turn.start({ text: 'plan it', turnId: 't1' } as never)
  const done = (await $.turn.complete({ turnId: 't1', durationMs: 1, reason: 'aborted', answer: '', isAborted: true } as never)) as { text: string }
  expect(done.text).toBe(line(T.text.doneNoModel, MAX))
})

test('/clear or exit forgets waiting and running switches', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await submit($, '_ running')
  await $.turn.start({ text: 'running', turnId: 'r1' } as never)
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  await step($, 'r1')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })
  await $.turn.start({ text: 'job', turnId: 't0' } as never)
  await submit($, '_ later', { turnId: 't0' })
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  await turn($, 't1', 'later')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })
})

// ---------------------------------------------------------------- drawing

test('as you type: the prefix is painted in its colour and named above the prompt; gone when it is removed', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    await edit($, '', '_')
    expect(world.painted.at(-1)).toEqual({ text: '_', decorations: [{ start: 0, end: 1, bold: true, color: HAIKU.color }] })
    let ui = await $.ui.mount(band(surface, false))
    expect((await ui.find({ type: 'Text', text: line(T.text.typing, HAIKU) }))?.text).toBe(line(T.text.typing, HAIKU))
    // What other plugins and the engine draw there stays, under the line.
    expect((await ui.find({ type: 'Text', text: 'engine band' }))?.text).toBe('engine band')
    await ui.unmount()

    await edit($, '_', '+', 0, 1)
    ui = await $.ui.mount(band(surface, false))
    expect((await ui.find({ type: 'Text', text: line(T.text.typing, MAX) }))?.text).toBe(line(T.text.typing, MAX))
    await ui.unmount()

    // Deleted: no line, and no new paint.
    const paints = world.painted.length
    await edit($, '+', '', 0, 1)
    expect(world.painted.length).toBe(paints)
    ui = await $.ui.mount(band(surface, false))
    expect(await ui.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
    await ui.unmount()
  }
})

test('history recall and clears update the typing line too', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await ($ as unknown as { prompt: { change: (e: unknown) => Promise<unknown> } }).prompt.change({ text: '_ recalled', cursor: 0, origin: { kind: 'history' } })
  let ui = await $.ui.mount(band('terminal', false))
  expect((await ui.find({ type: 'Text', text: line(T.text.typing, HAIKU) }))?.text).toBe(line(T.text.typing, HAIKU))
  await ui.unmount()
  await ($ as unknown as { prompt: { change: (e: unknown) => Promise<unknown> } }).prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  ui = await $.ui.mount(band('terminal', false))
  expect(await ui.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  await ui.unmount()
})

test('while it runs the band names the switch; once the turn ends it is gone', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await submit($, '_ check this')
  await $.turn.start({ text: 'check this', turnId: 't1' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface, true))
    expect((await ui.find({ type: 'Text', text: line(T.text.running, HAIKU) }))?.text).toBe(line(T.text.running, HAIKU))
    await ui.unmount()
  }
  // Between requests the engine may report the session idle: no running line then.
  const idle = await $.ui.mount(band('terminal', false))
  expect(await idle.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  await idle.unmount()
  await $.turn.complete({ turnId: 't1', durationMs: 1, reason: 'answer', answer: 'x', isAborted: false } as never)
  const ui = await $.ui.mount(band('terminal', true))
  expect(await ui.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  await ui.unmount()
})

test('a plain turn running draws no band', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await submit($, 'plain')
  await $.turn.start({ text: 'plain', turnId: 't1' } as never)
  const ui = await $.ui.mount(band('terminal', true))
  expect(await ui.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  await ui.unmount()
})

test('state an earlier version stored in another shape is declined', async ($, on) => {
  const world = engine(on)
  on('state.get', () => ({ value: { value: { t1: 'haiku' }, version: 0 } }) as never)
  await $.session.start(START)
  await step($, 't1')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })
})
