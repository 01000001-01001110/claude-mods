//! effort-picker tests: the shipped tuning, every pure rule at its boundaries,
//! and each hook through the engine: a typed draft is scored and suggested
//! above the prompt (terminal and desktop), with the reason and the re-cache
//! marker; Dismiss hides it; Use carries the pick to the next prompt's turn
//! only, whose requests go out on it while the following turn goes back; a
//! turn-prefix prefix wins; the command's on, off, status, explain and ask.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tuning as T } from '../data/effort-picker'
import type { Choice, Hit, Pending, Pick, Seen, Tuning } from '../types'
import {
  choiceKey,
  choiceOf,
  claimFor,
  currentEffort,
  explainLines,
  fileMentions,
  fillIn,
  haikuQuestion,
  isAlreadyRunning,
  namesModel,
  opensWithPrefix,
  originCounts,
  pickFor,
  queueUp,
  readHaikuReply,
  reasonFor,
  rewritesCache,
  scoreDraft,
  showChoice,
  sizeBandFor,
  splitFences,
  tierFor,
} from './rules'

/** A signal's shipped weight, by id. */
function W(id: string): number {
  const s = T.signals.find(x => x.id === id)
  if (!s) throw new Error(`no signal ${id} in the data`)
  return s.weight
}
/** A signal's shipped label, by id. */
function L(id: string): string {
  return T.signals.find(x => x.id === id)!.label
}
/** The weight `n` distinct file mentions earn. */
function fileWeight(n: number): number {
  return n < T.files.from ? 0 : Math.min((n - T.files.from + 1) * T.files.weightEach, T.files.maxWeight)
}

// The session the engine stands for in the hook tests.
const SESSION_MODEL = 'claude-sonnet-5'
const SESSION_EFFORT = 'medium'
const SEEN: Seen = { model: SESSION_MODEL, effort: SESSION_EFFORT }

// Drafts; their expected picks are computed from the shipped data below.
const REFACTOR = 'refactor the auth module across src/a.ts, src/b.ts and src/c.ts'
const BUILD = 'implement the config parser for the CLI'
const RENAME = 'rename the foo variable to bar'

const REFACTOR_SCORE = W('refactor') + fileWeight(3)
const BUILD_SCORE = W('build')

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

interface Engine {
  steps: { model: string; effort: unknown; agentId?: string }[]
  toasts: string[]
  asked: { model: string; prompt: string }[]
  haikuReply: { text: string | null }
  drop: boolean
  /** When set, Haiku's answer waits for it: the test types meanwhile. */
  gate: Promise<void> | null
  /** Resolves when Haiku has been asked, so the test knows the call is open. */
  onAsked: (() => void) | null
}

/** Hooks beneath the plugin standing for the engine; records what reaches it. */
function engine(on: On): Engine {
  const world: Engine = { steps: [], toasts: [], asked: [], haikuReply: { text: 'sonnet high' }, drop: false, gate: null, onAsked: null }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.model', () => ({ value: SESSION_MODEL }) as never)
  on('command.register', () => ({ value: { command: 'effort-picker' } }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', async (_, e) => {
    world.asked.push({ model: e.model, prompt: e.prompt })
    world.onAsked?.()
    if (world.gate) await world.gate
    const text = world.haikuReply.text
    const value = text === null
      ? { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 1, output_tokens: 0 } }
      : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 2 } }
    return { value } as never
  })
  on('prompt.submit', (_, e) => (world.drop ? { drop: 'dropped' } : { text: e.text }))
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length } as never
  })
  on('prompt.change', (_, e) => ({ text: e.text, cursor: e.cursor }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'answer' }) as never)
  on('turn.step', async function* (_, e) {
    world.steps.push({ model: e.model, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    yield { kind: 'text', index: 0, text: 'ok' } as never
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 1, output_tokens: 1 } } as never
  })
  latest = world
  return world
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The world the latest `engine` call made, so `begin` can clear its warm-up step. */
let latest: Engine | undefined

/**
 * Starts the session and runs one plain request on its own settings, as a
 * real session has before the person types: the mod learns the effort the
 * cache is warm for. The warm-up request is not kept in `steps`.
 */
async function begin($: Dollar): Promise<void> {
  await $.session.start(START)
  await $.turn.start({ text: 'warm-up', turnId: 'warm' } as never)
  await step($, 'warm')
  await $.turn.complete({ turnId: 'warm', durationMs: 1, reason: 'answer', answer: 'a', isAborted: false } as never)
  if (latest) latest.steps.length = 0
}

/** Types `text` into an empty composer as one edit. */
function type($: Dollar, text: string) {
  return ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string }> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text })
}

/** Submits a prompt from the composer, or the given origin. */
function submit($: Dollar, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never) as Promise<{ text?: string; drop?: string }>
}

/** One model request of a turn, drained. */
async function step($: Dollar, turnId: string, agentId?: string, model = SESSION_MODEL, effort = SESSION_EFFORT): Promise<void> {
  const stream = $.turn.step({ turnId, index: 0, model, effort, messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of stream) void _
}

/** A whole main turn of `requests` requests; resolves to the line under the answer. */
async function turn($: Dollar, turnId: string, text: string, requests = 1): Promise<string> {
  await $.turn.start({ text, turnId } as never)
  for (let i = 0; i < requests; i++) await step($, turnId)
  const done = (await $.turn.complete({ turnId, durationMs: 10, reason: 'answer', answer: 'answer', isAborted: false } as never)) as { text: string }
  return done.text
}

/** Runs `/effort-picker <args>`; resolves to its text. */
async function command($: Dollar, args: string): Promise<string> {
  const r = await $.command.run({ command: 'effort-picker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  return (r as { text: string }).text
}

/** The band above the prompt on a surface. */
function band(surface: 'terminal' | 'desktop', hasSurvey = false) {
  return {
    plugin: 'effort-picker',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } },
  } as never
}

/** The suggestion line for a choice, as the band writes it. */
function suggestLine(c: Choice): string {
  return fillIn(T.text.suggest, { glyph: T.glyph, choice: showChoice(c, T) })
}
function chosenLine(c: Choice): string {
  return fillIn(T.text.chosen, { glyph: T.glyph, choice: showChoice(c, T) })
}

/** Everything the band draws as one string, '' when it leaves the band to the engine. */
async function bandText($: Dollar, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount(band(surface))
  const own = await ui.find({ type: 'Text', text: new RegExp(T.glyph) })
  const reason = await ui.find({ type: 'Text', text: /^\(/ })
  const recache = await ui.find({ type: 'Text', text: T.text.recache })
  await ui.unmount()
  return [own?.text, reason?.text, recache?.text].filter(Boolean).join(' | ')
}

// ---------------------------------------------------------------- shipped data

test('shipped tuning: tiers ascend from a floor, every pattern compiles, Haiku is off, hotkeys are single keys', () => {
  for (let i = 1; i < T.tiers.length; i++) expect(T.tiers[i]!.minScore).toBeGreaterThan(T.tiers[i - 1]!.minScore)
  for (const s of T.signals) expect(() => new RegExp(s.pattern, T.patternFlags)).not.toThrow()
  expect(() => new RegExp(T.files.pattern, T.patternFlags)).not.toThrow()
  expect(new Set(T.signals.map(s => s.id)).size).toBe(T.signals.length)
  expect(T.haiku.enabled).toBe(false)
  expect(T.cacheSafe).toEqual(['low', 'medium', 'high'])
  expect(T.deferPrefixes).toEqual(['_', '+'])
  for (const key of Object.values(T.hotkeys)) expect(/^[a-z0-9]$/.test(key)).toBe(true)
  expect(new Set(Object.values(T.hotkeys)).size).toBe(Object.values(T.hotkeys).length)
  expect(T.sizes[0]!.minChars).toBe(0)
  expect(T.startOn).toBe(true)
})

// ---------------------------------------------------------------- pure rules

test('opensWithPrefix: _ and + at the start (past spaces) defer; doubled is text; elsewhere nothing', () => {
  expect(opensWithPrefix('_ what is this', T)).toBe(true)
  expect(opensWithPrefix('   + think hard', T)).toBe(true)
  expect(opensWithPrefix('__init__.py is broken', T)).toBe(false)
  expect(opensWithPrefix('++i overflows', T)).toBe(false)
  expect(opensWithPrefix('a_b + c', T)).toBe(false)
  expect(opensWithPrefix('', T)).toBe(false)
  expect(opensWithPrefix('__init__', { ...T, doubledPrefixIsText: false })).toBe(true)
  expect(opensWithPrefix('_ x', { ...T, deferPrefixes: [''] })).toBe(false)
})

test('originCounts: composer and bridge count, no origin counts, others do not', () => {
  expect(originCounts('composer', T)).toBe(true)
  expect(originCounts('bridge', T)).toBe(true)
  expect(originCounts(undefined, T)).toBe(true)
  expect(originCounts('plugin', T)).toBe(false)
  expect(originCounts('sdk', T)).toBe(false)
})

test('splitFences: prose outside fences, blocks counted, an unclosed fence counts and hides what follows', () => {
  const f = T.fence
  expect(splitFences('plain text', T)).toEqual({ prose: 'plain text', blocks: 0 })
  expect(splitFences(`fix ${f}\nrefactor()\n${f} now`, T)).toEqual({ prose: 'fix \n now', blocks: 1 })
  expect(splitFences(`a ${f}x${f} b ${f}y${f} c`, T).blocks).toBe(2)
  const open = splitFences(`look ${f}\nrefactor everything`, T)
  expect(open.blocks).toBe(1)
  expect(open.prose.includes('refactor')).toBe(false)
})

test('fileMentions: distinct paths and names with code extensions, case folded; plain words are not files', () => {
  expect(fileMentions('edit src/a.ts and SRC/A.ts and b.py', T)).toEqual(['src/a.ts', 'b.py'])
  expect(fileMentions(String.raw`see lib\util.tsx`, T)).toEqual([String.raw`lib\util.tsx`])
  expect(fileMentions('version 1.2 and e.g. this', T)).toEqual([])
})

test('sizeBandFor: each band starts exactly at its minChars', () => {
  for (let i = 1; i < T.sizes.length; i++) {
    const band = T.sizes[i]!
    expect(sizeBandFor(band.minChars - 1, T)).toBe(T.sizes[i - 1])
    expect(sizeBandFor(band.minChars, T)).toBe(band)
    expect(sizeBandFor(band.minChars + 1, T)).toBe(band)
  }
  expect(sizeBandFor(0, T)).toBe(T.sizes[0])
})

test('scoreDraft: signals add their weights; code inside fences is not read for keywords', () => {
  expect(scoreDraft(REFACTOR, T)).toEqual({ score: REFACTOR_SCORE, hits: [{ label: L('refactor'), weight: W('refactor') }, { label: fillIn(T.files.label, { count: 3 }), weight: fileWeight(3) }] })
  expect(scoreDraft(BUILD, T).score).toBe(BUILD_SCORE)
  expect(scoreDraft(RENAME, T).score).toBe(W('small-edit'))
  expect(scoreDraft('what does this do?', T).score).toBe(W('lookup') + W('question'))
  const fenced = `look at this ${T.fence}\nrefactor(debug)\n${T.fence}`
  expect(scoreDraft(fenced, T).hits).toEqual([{ label: T.fences.label, weight: Math.min(T.fences.weightEach, T.fences.maxWeight) }])
})

test('scoreDraft: fence weight per block, capped at maxWeight', () => {
  const blocks = (n: number) => Array.from({ length: n }, () => `${T.fence}x${T.fence}`).join(' ')
  const capAt = Math.ceil(T.fences.maxWeight / T.fences.weightEach)
  const weightOf = (n: number) => scoreDraft(blocks(n), T).hits.find(h => h.label === T.fences.label)!.weight
  expect(weightOf(capAt - 1)).toBe((capAt - 1) * T.fences.weightEach)
  expect(weightOf(capAt)).toBe(T.fences.maxWeight)
  expect(weightOf(capAt + 1)).toBe(T.fences.maxWeight)
})

test('scoreDraft: files count from `from`, one step each, capped at maxWeight', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`).join(' ')
  const fileHit = (n: number) => scoreDraft(names(n), T).hits.find(h => h.label === fillIn(T.files.label, { count: n }))
  expect(fileHit(T.files.from - 1)).toBeUndefined()
  expect(fileHit(T.files.from)?.weight).toBe(T.files.weightEach)
  expect(fileHit(T.files.from + 1)?.weight).toBe(2 * T.files.weightEach)
  const capAt = T.files.from - 1 + Math.ceil(T.files.maxWeight / T.files.weightEach)
  expect(fileHit(capAt)?.weight).toBe(T.files.maxWeight)
  expect(fileHit(capAt + 1)?.weight).toBe(T.files.maxWeight)
})

test('scoreDraft: a long draft earns its size band at the boundary, not one short', () => {
  const band = T.sizes.find(b => b.weight !== 0)!
  const pad = (n: number) => 'z'.repeat(n)
  expect(scoreDraft(pad(band.minChars - 1), T).hits.find(h => h.label === band.label)).toBeUndefined()
  expect(scoreDraft(pad(band.minChars), T).hits.find(h => h.label === band.label)?.weight).toBe(band.weight)
})

test('tierFor: each tier starts exactly at its minScore; below the floor is the floor', () => {
  for (let i = 1; i < T.tiers.length; i++) {
    const tier = T.tiers[i]!
    expect(tierFor(tier.minScore - 1, T)).toBe(T.tiers[i - 1])
    expect(tierFor(tier.minScore, T)).toBe(tier)
  }
  expect(tierFor(T.tiers[0]!.minScore - 50, T)).toBe(T.tiers[0])
  expect(tierFor(1000, T)).toBe(T.tiers[T.tiers.length - 1])
})

test('reasonFor: strongest first by size of weight, labels once, at most reasonMax, joined', () => {
  const hits: Hit[] = [{ label: 'a', weight: 1 }, { label: 'b', weight: -4 }, { label: 'b', weight: 2 }, { label: 'c', weight: 3 }]
  expect(reasonFor(hits, T)).toBe(['b', 'c', 'a'].slice(0, T.reasonMax).join(T.reasonJoin))
  expect(reasonFor(hits, { ...T, reasonMax: 3 })).toBe(['b', 'c', 'a'].join(T.reasonJoin))
  expect(reasonFor([], T)).toBe('')
})

test('pickFor: too short is nothing, minChars is enough; no rule matched is nothing; the tier and reason follow the score', () => {
  const short = 'refactor ' + 'z'.repeat(Math.max(0, T.minChars - 'refactor '.length - 1))
  expect(short.length).toBe(T.minChars - 1)
  expect(pickFor(short, T)).toBeNull()
  expect(pickFor(short + 'z', T)?.score).toBe(W('refactor'))
  expect(pickFor('zzzzzzzzzzzzzzzzzzzzzzz', T)).toBeNull()
  const p = pickFor(REFACTOR, T)!
  const tier = tierFor(REFACTOR_SCORE, T)
  expect(p).toEqual({ model: tier.model, effort: tier.effort, reason: reasonFor(scoreDraft(REFACTOR, T).hits, T), source: 'rules', score: REFACTOR_SCORE, hits: scoreDraft(REFACTOR, T).hits })
  expect(pickFor(RENAME, T)?.effort).toBe(tierFor(W('small-edit'), T).effort)
  // suggestModel off: effort only.
  expect(pickFor(REFACTOR, { ...T, suggestModel: false })?.model).toBeUndefined()
})

test('choiceOf / showChoice / choiceKey', () => {
  expect(choiceOf({ model: 'opus', effort: 'max' }, T)).toEqual({ model: 'opus', effort: 'max' })
  expect(choiceOf({ model: 'opus', effort: 'max' }, { ...T, suggestModel: false })).toEqual({ effort: 'max' })
  expect(showChoice({ model: 'sonnet', effort: 'high' }, T)).toBe(`sonnet${T.choiceJoin}high`)
  expect(showChoice({ effort: 'low' }, T)).toBe('low')
  expect(choiceKey({ model: 'a', effort: 'low' })).not.toBe(choiceKey({ model: 'a', effort: 'high' }))
  expect(choiceKey({ effort: 'low' })).not.toBe(choiceKey({ model: 'a', effort: 'low' }))
})

test('namesModel, currentEffort, isAlreadyRunning', () => {
  expect(namesModel('opus', 'claude-opus-5-5')).toBe(true)
  expect(namesModel('OPUS', 'claude-opus-5-5')).toBe(true)
  expect(namesModel('haiku', 'claude-opus-5-5')).toBe(false)
  expect(namesModel('sonnet', 'sonnet')).toBe(true)
  expect(currentEffort({ model: 'x', effort: '' }, T)).toBe(T.assumedEffort)
  expect(currentEffort({ model: 'x', effort: 'low' }, T)).toBe('low')
  expect(isAlreadyRunning({ model: 'sonnet', effort: 'medium' }, SEEN, T)).toBe(true)
  expect(isAlreadyRunning({ model: 'sonnet', effort: 'high' }, SEEN, T)).toBe(false)
  expect(isAlreadyRunning({ model: 'opus', effort: 'medium' }, SEEN, T)).toBe(false)
  expect(isAlreadyRunning({ effort: 'medium' }, SEEN, T)).toBe(true)
})

test('rewritesCache: model change rewrites; low, medium, high among themselves keep; to or from max rewrites', () => {
  const at = (effort: string): Seen => ({ model: SESSION_MODEL, effort })
  expect(rewritesCache({ model: 'opus', effort: 'medium' }, at('medium'), T)).toBe(true)
  expect(rewritesCache({ model: 'sonnet', effort: 'medium' }, at('medium'), T)).toBe(false)
  expect(rewritesCache({ effort: 'high' }, at('low'), T)).toBe(false)
  expect(rewritesCache({ effort: 'low' }, at('high'), T)).toBe(false)
  expect(rewritesCache({ effort: 'max' }, at('high'), T)).toBe(true)
  expect(rewritesCache({ effort: 'high' }, at('max'), T)).toBe(true)
  expect(rewritesCache({ effort: 'max' }, at('max'), T)).toBe(false)
  expect(rewritesCache({ effort: 'xhigh' }, at('medium'), T)).toBe(true)
  // Before any request: the assumed effort.
  expect(rewritesCache({ effort: 'max' }, at(''), T)).toBe(!(T.cacheSafe as string[]).includes('max') || !(T.cacheSafe as string[]).includes(T.assumedEffort))
  expect(rewritesCache({ effort: T.assumedEffort }, at(''), T)).toBe(false)
})

test('haikuQuestion fills the task (cut to maxChars) and the tiers vocabulary', () => {
  const q = haikuQuestion('x'.repeat(T.haiku.maxChars + 50), T)
  expect(q.includes('x'.repeat(T.haiku.maxChars))).toBe(true)
  expect(q.includes('x'.repeat(T.haiku.maxChars + 1))).toBe(false)
  for (const tier of T.tiers) expect(q.includes(tier.model) && q.includes(tier.effort)).toBe(true)
})

test('readHaikuReply: model and effort words, any case or punctuation; effort alone keeps the model; no effort is nothing', () => {
  expect(readHaikuReply('Sonnet, HIGH.', T)).toEqual({ model: 'sonnet', effort: 'high', reason: T.text.haikuReason, source: 'haiku', score: 0, hits: [] })
  expect(readHaikuReply('max', T)).toEqual({ effort: 'max', reason: T.text.haikuReason, source: 'haiku', score: 0, hits: [] })
  expect(readHaikuReply('opus please', T)).toBeNull()
  expect(readHaikuReply('', T)).toBeNull()
  // "lower" is not "low": whole words only.
  expect(readHaikuReply('lower', T)).toBeNull()
  expect(readHaikuReply('opus high', { ...T, suggestModel: false })?.model).toBeUndefined()
})

test('queueUp keeps the newest pendingMax; claimFor takes the turn\'s own entry and drops older ones', () => {
  const e = (text: string): Pending => ({ text, effort: 'high' })
  let list: Pending[] = []
  for (let i = 0; i < T.pendingMax + 2; i++) list = queueUp(list, e(`p${i}`), T)
  expect(list.length).toBe(T.pendingMax)
  expect(list[0]!.text).toBe('p2')
  expect(queueUp([], e('a'), { ...T, pendingMax: 0 }).length).toBe(1)
  const claimed = claimFor([e('a'), e('b'), e('c')], 'b')
  expect(claimed.found?.text).toBe('b')
  expect(claimed.rest.map(p => p.text)).toEqual(['c'])
  expect(claimFor([e('a')], 'zzz')).toEqual({ found: undefined, rest: [e('a')] })
})

test('explainLines: rules pick lists each hit, the tier and the cache verdict; Haiku pick says so; none says so', () => {
  const p = pickFor(REFACTOR, T)!
  const lines = explainLines(p, SEEN, T)
  expect(lines[0]).toBe(fillIn(T.text.explainHead, { score: REFACTOR_SCORE, source: 'rules table' }))
  expect(lines[1]).toBe(fillIn(T.text.explainHit, { weight: `+${W('refactor')}`, label: L('refactor') }))
  expect(lines).toContain(fillIn(T.text.explainTier, { score: REFACTOR_SCORE, min: tierFor(REFACTOR_SCORE, T).minScore, choice: showChoice(p, T) }))
  const current = showChoice({ model: SESSION_MODEL, effort: SESSION_EFFORT }, T)
  expect(lines[lines.length - 1]).toBe(fillIn(rewritesCache(p, SEEN, T) ? T.text.explainCacheRewrites : T.text.explainCacheKeeps, { current }))
  expect(explainLines(pickFor(RENAME, T), SEEN, T)[1]).toBe(fillIn(T.text.explainHit, { weight: String(W('small-edit')), label: L('small-edit') }))
  const h = readHaikuReply('sonnet medium', T)!
  expect(explainLines(h, SEEN, T)).toEqual([fillIn(T.text.explainHaiku, { choice: showChoice(h, T) }), fillIn(T.text.explainCacheKeeps, { current })])
  expect(explainLines(null, SEEN, T)).toEqual([T.text.explainNone])
})

// ---------------------------------------------------------------- through the engine

test('the band is shared: what is drawn beneath the suggestion and the chosen pick stays, under them, on terminal and desktop', async ($, on) => {
  engine(on)
  await begin($)
  await type($, REFACTOR)
  const pick = pickFor(REFACTOR, T)!
  /** The band's texts in drawing order. */
  const texts = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount(band(surface))
    const all = (await ui.findAll({ type: 'Text' })).map(n => n.text ?? '')
    await ui.unmount()
    return all
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const shown = await texts(surface)
    expect(shown.indexOf(suggestLine(pick))).toBeGreaterThanOrEqual(0)
    expect(shown.at(-1)).toBe('engine band')
  }
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const shown = await texts(surface)
    expect(shown.indexOf(chosenLine(pick))).toBeGreaterThanOrEqual(0)
    expect(shown.at(-1)).toBe('engine band')
  }
})

test('typing: the band suggests the pick with its reason and the re-cache marker, on terminal and desktop', async ($, on) => {
  engine(on)
  await begin($)
  const refactor = pickFor(REFACTOR, T)!
  const build = pickFor(BUILD, T)!
  for (const surface of ['terminal', 'desktop'] as const) {
    await type($, REFACTOR)
    const shown = await bandText($, surface)
    const marker = rewritesCache(refactor, SEEN, T) ? ` | ${T.text.recache}` : ''
    expect(shown).toBe(`${suggestLine(refactor)} | ${fillIn(T.text.reason, { reason: refactor.reason })}${marker}`)
    await type($, BUILD)
    const marker2 = rewritesCache(build, SEEN, T) ? ` | ${T.text.recache}` : ''
    expect(await bandText($, surface)).toBe(`${suggestLine(build)} | ${fillIn(T.text.reason, { reason: build.reason })}${marker2}`)
  }
  // The shipped data makes these two differ on the cache, so both arms are seen.
  expect(rewritesCache(refactor, SEEN, T)).toBe(true)
  expect(rewritesCache(build, SEEN, T)).toBe(false)
  // The engine's own band is kept beneath.
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: 'engine band' }))?.text).toBe('engine band')
  expect(await ui.find({ key: 'use' })).toBeDefined()
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
})

test('no suggestion: a short draft, a draft no rule matches, a survey up, or a pick the session already runs', async ($, on) => {
  engine(on)
  await begin($)
  await type($, 'refactor')
  expect(await bandText($)).toBe('')
  await type($, 'zzzzzzzzzzzzzzzzzzzzzzzz')
  expect(await bandText($)).toBe('')
  await type($, REFACTOR)
  const survey = await $.ui.mount(band('terminal', true))
  expect(await survey.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  await survey.unmount()
  // A draft that scores to the session's own model and effort is not suggested.
  const same = T.tiers.find(x => namesModel(x.model, SESSION_MODEL) && x.effort === SESSION_EFFORT)!
  expect(same).toBeDefined()
  const neutral = 'please explain the parser module now'
  expect(tierFor(scoreDraft(neutral, T).score, T)).toBe(same)
  await type($, neutral)
  expect(await bandText($)).toBe('')
})

test('Dismiss hides the pick until the draft earns a different one', async ($, on) => {
  engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(await bandText($)).toBe('')
  // More of the same pick stays hidden.
  await type($, REFACTOR + ' please')
  expect(await bandText($)).toBe('')
  // A different pick shows again.
  await type($, BUILD)
  expect(await bandText($)).toContain(suggestLine(pickFor(BUILD, T)!))
})

test('Use: the next prompt\'s turn runs on the pick, every request of it; the turn after goes back; nothing applies without Use', async ($, on) => {
  const world = engine(on)
  await begin($)
  // Without Use, a suggested draft runs on the session's own settings.
  await type($, REFACTOR)
  await submit($, REFACTOR)
  expect(await turn($, 't0', REFACTOR)).toBe('answer')
  expect(world.steps.at(-1)).toEqual({ model: SESSION_MODEL, effort: SESSION_EFFORT })

  await type($, REFACTOR)
  const pick = pickFor(REFACTOR, T)!
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toBe(`${chosenLine(pick)} | ${fillIn(T.text.reason, { reason: pick.reason })}`)
  }
  const sent = await submit($, REFACTOR)
  expect(sent.text).toBe(REFACTOR)
  // The band is clear after submit.
  expect(await bandText($)).toBe('')
  world.steps.length = 0
  expect(await turn($, 't1', REFACTOR, 2)).toBe(fillIn(T.text.done, { glyph: T.glyph, choice: showChoice(pick, T) }))
  expect(world.steps).toEqual([{ model: pick.model, effort: pick.effort }, { model: pick.model, effort: pick.effort }])
  world.steps.length = 0
  expect(await turn($, 't2', 'next thing')).toBe('answer')
  // Nothing outlives its turn: a late request under the finished turn's id goes out on the session's settings.
  world.steps.length = 0
  await step($, 't1')
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
})

test('Use then Cancel: nothing applies', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  const again = await $.ui.mount(band('terminal'))
  await again.press({ key: 'cancel' })
  await again.unmount()
  expect(await bandText($)).toContain(suggestLine(pickFor(REFACTOR, T)!))
  await submit($, REFACTOR)
  await turn($, 't1', REFACTOR)
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
})

test('a turn-prefix prefix wins: the suggestion hides, and a chosen pick is dropped at submit', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  await type($, '+ ' + REFACTOR)
  expect(await bandText($)).toBe('')
  await submit($, '+ ' + REFACTOR)
  expect(await turn($, 't1', '+ ' + REFACTOR)).toBe('answer')
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
  // A doubled prefix is text, and the suggestion shows.
  await type($, '++ ' + REFACTOR)
  expect(await bandText($)).toContain(suggestLine(pickFor('++ ' + REFACTOR, T)!))
})

test('only the person\'s prompts carry a pick: another origin, a command or a meta prompt leave it waiting', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  await submit($, 'from a plugin', { origin: { kind: 'plugin', name: 'x' } })
  await turn($, 'tp', 'from a plugin')
  await submit($, '/thing', { command: 'thing' })
  await submit($, 'meta', { isMeta: true })
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
  expect(await bandText($)).toContain(chosenLine(pickFor(REFACTOR, T)!))
})

test('a subagent\'s requests keep their own settings; a dropped submission leaves nothing waiting', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  let ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  world.drop = true
  await submit($, REFACTOR)
  world.drop = false
  await turn($, 't1', REFACTOR)
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])

  await type($, REFACTOR)
  ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  await submit($, REFACTOR)
  world.steps.length = 0
  await $.turn.start({ text: REFACTOR, turnId: 't2' } as never)
  await step($, 't2', 'agent-1')
  await step($, 't2')
  const pick = pickFor(REFACTOR, T)!
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT, agentId: 'agent-1' }, { model: pick.model, effort: pick.effort }])
})

test('the session\'s own requests set what the cache marker compares against', async ($, on) => {
  engine(on)
  await begin($)
  // The session now runs opus at max: a sonnet·high pick rewrites the cache (model and max).
  await $.turn.start({ text: 'warm', turnId: 'w' } as never)
  const stream = $.turn.step({ turnId: 'w', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 1 } as never)
  for await (const _ of stream) void _
  await type($, BUILD)
  expect(await bandText($)).toContain(T.text.recache)
  expect(await command($, 'explain')).toContain(fillIn(T.text.explainCacheRewrites, { current: showChoice({ model: 'claude-opus-5-5', effort: 'max' }, T) }))
})

test("a subagent's requests do not change what the cache marker compares against", async ($, on) => {
  engine(on)
  await begin($)
  await $.turn.start({ text: 'spawn', turnId: 'm' } as never)
  await step($, 'm', 'agent-9', 'claude-opus-5-5', 'max')
  await type($, BUILD)
  const build = pickFor(BUILD, T)!
  expect(rewritesCache(build, SEEN, T)).toBe(false)
  expect(await bandText($)).toBe(`${suggestLine(build)} | ${fillIn(T.text.reason, { reason: build.reason })}`)
})

test('/effort-picker off hides everything and drops a chosen pick; on brings it back; status and usage', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  const pick = pickFor(REFACTOR, T)!
  const described = `${showChoice(pick, T)} (${pick.reason})`
  expect(await command($, 'status')).toBe(fillIn(T.text.status, { state: 'on', last: described, next: described }))
  expect(await command($, '')).toBe(fillIn(T.text.status, { state: 'on', last: described, next: described }))
  expect(await command($, 'off')).toBe(T.text.off)
  expect(await bandText($)).toBe('')
  await type($, REFACTOR)
  expect(await bandText($)).toBe('')
  await submit($, REFACTOR)
  await turn($, 't1', REFACTOR)
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
  expect(await command($, 'status')).toBe(fillIn(T.text.status, { state: 'off', last: described, next: T.text.statusNone }))
  expect(await command($, 'ON')).toBe(T.text.on)
  // Off drops a chosen pick even when it is turned back on before the next prompt.
  await type($, REFACTOR)
  const again = await $.ui.mount(band('terminal'))
  await again.press({ key: 'use' })
  await again.unmount()
  await command($, 'off')
  await command($, 'on')
  world.steps.length = 0
  await submit($, REFACTOR)
  await turn($, 't3', REFACTOR)
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
  await type($, BUILD)
  expect(await bandText($)).toContain(suggestLine(pickFor(BUILD, T)!))
  expect(await command($, 'bogus')).toBe(T.text.usage)
  expect(await command($, 'haiku')).toBe(T.text.usage)
  expect(await command($, 'haiku maybe')).toBe(T.text.usage)
})

test('/effort-picker explain: nothing yet, then the scoring of the last suggestion', async ($, on) => {
  engine(on)
  await begin($)
  expect(await command($, 'explain')).toBe(T.text.explainNone)
  await type($, REFACTOR)
  expect(await command($, 'explain')).toBe(explainLines(pickFor(REFACTOR, T), SEEN, T).join('\n'))
})

test('/effort-picker ask with Haiku off (as shipped) says so and calls no model', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  expect(await command($, 'ask')).toBe(T.text.haikuOff)
  expect(world.asked).toEqual([])
})

test('Haiku on: asked only on request, its pick replaces the rules one in the band, a bad reply leaves the rules pick', async ($, on) => {
  const world = engine(on)
  await begin($)
  {
    expect(await command($, 'haiku on')).toBe(T.text.haikuEnabled)
    // Typing never asks.
    await type($, REFACTOR)
    await type($, BUILD)
    expect(world.asked).toEqual([])
    expect(await command($, 'ask')).toBe(fillIn(T.text.haikuPicked, { choice: showChoice(readHaikuReply('sonnet high', T)!, T) }))
    expect(world.asked).toEqual([{ model: T.haiku.model, prompt: haikuQuestion(BUILD, T) }])
    const h = readHaikuReply('sonnet high', T)!
    // The same text read again keeps Haiku's pick.
    await ($.prompt as unknown as { change: (e: unknown) => Promise<unknown> }).change({ text: BUILD, cursor: BUILD.length })
    expect(await bandText($)).toBe(`${suggestLine(h)} | ${fillIn(T.text.reason, { reason: T.text.haikuReason })}`)
    expect(await command($, 'explain')).toBe(explainLines(h, SEEN, T).join('\n'))
    // The band's Ask button toasts the outcome.
    world.haikuReply.text = null
    await type($, REFACTOR)
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'ask' })
    await ui.unmount()
    expect(world.toasts).toEqual([T.text.haikuFailed])
    expect(await bandText($)).toContain(suggestLine(pickFor(REFACTOR, T)!))
    // The person kept typing while Haiku was asked: the reply is for an old draft and is not shown.
    world.haikuReply.text = 'haiku low'
    let release = () => {}
    world.gate = new Promise<void>(done => (release = done))
    const asked = new Promise<void>(done => (world.onAsked = done))
    await type($, REFACTOR)
    const answer = command($, 'ask')
    await asked
    // While Haiku is out, the band says so and offers no second Ask.
    const out = await $.ui.mount(band('terminal'))
    expect((await out.find({ type: 'Text', text: T.text.asking }))?.text).toBe(T.text.asking)
    expect(await out.find({ key: 'ask' })).toBeUndefined()
    await out.unmount()
    await type($, REFACTOR + ' now')
    release()
    expect(await answer).toBe(T.text.haikuStale)
    world.gate = null
    world.onAsked = null
    expect(await bandText($)).toContain(suggestLine(pickFor(REFACTOR + ' now', T)!))
    expect(await bandText($)).not.toContain(suggestLine(readHaikuReply('haiku low', T)!))
    // Nothing typed: nothing to ask.
    await type($, '')
    expect(await command($, 'ask')).toBe(T.text.haikuNoDraft)
    expect(world.asked.length).toBe(3)
    expect(await command($, 'haiku off')).toBe(T.text.haikuDisabled)
    await type($, REFACTOR)
    expect(await command($, 'ask')).toBe(T.text.haikuOff)
    const off = await $.ui.mount(band('terminal'))
    expect(await off.find({ key: 'ask' })).toBeUndefined()
    expect(world.asked.length).toBe(3)
  }
})

test('session end forgets the draft, the chosen pick and anything waiting', async ($, on) => {
  const world = engine(on)
  await begin($)
  await type($, REFACTOR)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'use' })
  await ui.unmount()
  await submit($, REFACTOR)
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  expect(await bandText($)).toBe('')
  await turn($, 't1', REFACTOR)
  expect(world.steps).toEqual([{ model: SESSION_MODEL, effort: SESSION_EFFORT }])
})

test('stored values of an older shape are declined: the band starts clean', async ($, on) => {
  engine(on)
  on('state.get', () => ({ value: { value: { text: 'old', pick: 'opus' }, version: 0 } }) as never)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: new RegExp(T.glyph) })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'engine band' }))?.text).toBe('engine band')
})

// Unused-import guard: the Pick and Tuning types are part of the contract the tests lean on.
export type _Contract = [Pick, Tuning]
